// Imports past Claude Code CLI sessions (~/.claude/projects/*/*.jsonl) as plants (the backfill, PLAN M6).
// Streams each file twice: a cheap first pass for summaries, then entries for the sessions it keeps,
// so nothing holds every session's journal in memory. Imported plants keep their sessionId (plant id = sessionId),
// so messaging one resumes that session.
import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { nameFromPrompt, nextSpecies } from "../shared/garden";
import type { Bed, Entry, Plant } from "../shared/types";
import type { GardenStore } from "./store";
import { TranscriptParser, TranscriptTail, type ParsedSummary } from "./transcript";

const PER_BED = 7;
/** Journal entries kept per imported session (the newest). */
const KEEP_ENTRIES = 600;

export const defaultProjectsDir = () => join(homedir(), ".claude", "projects");

/** Folders not worth a bed: gone, temp dirs, system dirs, drive roots. */
export function plantable(cwd: string) {
  const p = resolve(cwd);
  const low = p.toLowerCase();
  return existsSync(p) && dirname(p) !== p && !low.startsWith(tmpdir().toLowerCase()) && !low.includes(join("windows", "system32"));
}

/** Top-level session transcripts: <root>/<folder>/<sessionId>.jsonl (subagent files in <sessionId>/subagents are not sessions). */
export async function sessionFiles(root: string): Promise<{ path: string; sessionId: string }[]> {
  const out: { path: string; sessionId: string }[] = [];
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(join(root, d.name));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".jsonl")) out.push({ path: join(root, d.name, f), sessionId: basename(f, ".jsonl") });
  }
  return out;
}

/** Back-compat helper (tests): parse a whole session from its lines. */
export async function parseSession(lines: AsyncIterable<string> | Iterable<string>): Promise<ParsedSummary & { entries: Omit<Entry, "plantId">[] }> {
  const p = new TranscriptParser("");
  for await (const line of lines) p.push(line);
  return { ...p.summary, entries: p.takeEntries() };
}

export async function importHistory(store: GardenStore, addBed: (path: string) => Bed | null, opts: { perBed?: number; projectsDir?: string } = {}): Promise<{ added: number }> {
  const root = opts.projectsDir ?? defaultProjectsDir();
  const perBedMax = opts.perBed ?? PER_BED;
  const known = new Set([...store.plants.values()].map((p) => p.sessionId));
  const okCwd = new Map<string, boolean>();

  // Pass 1: summaries only.
  const found: { path: string; sessionId: string; s: ParsedSummary }[] = [];
  for (const f of await sessionFiles(root)) {
    if (known.has(f.sessionId)) continue;
    const tail = new TranscriptTail(f.path, f.sessionId, { mode: "summary" });
    try {
      await tail.read();
    } catch {
      continue;
    }
    const s = tail.parser.summary;
    if (!s.cwd || s.turns === 0) continue;
    if (!okCwd.has(s.cwd)) okCwd.set(s.cwd, plantable(s.cwd));
    if (okCwd.get(s.cwd)) found.push({ ...f, s });
  }

  // Newest first, then the most recent few per folder so busy repos don't swamp the garden.
  found.sort((a, b) => b.s.updatedAt - a.s.updatedAt);
  const perBed = new Map<string, number>();
  let added = 0;
  for (const f of found) {
    const bed = addBed(f.s.cwd!);
    if (!bed) continue;
    const n = perBed.get(bed.id) ?? [...store.plants.values()].filter((p) => p.bedId === bed.id).length;
    if (n >= perBedMax) continue;
    perBed.set(bed.id, n + 1);

    // Pass 2: entries for this session only (newest KEEP_ENTRIES).
    const tail = new TranscriptTail(f.path, f.sessionId, { maxEntries: KEEP_ENTRIES });
    try {
      await tail.read();
    } catch {
      continue;
    }
    const s = tail.parser.summary;
    const siblings = [...store.plants.values()].filter((p) => p.bedId === bed.id);
    const plant: Plant = {
      id: f.sessionId,
      bedId: bed.id,
      name: s.title || nameFromPrompt(s.seed),
      species: nextSpecies(siblings.map((p) => p.species)),
      seed: s.seed,
      origin: "imported",
      sessionId: f.sessionId,
      model: s.model,
      permissionMode: s.permissionMode,
      status: "idle",
      live: false,
      turns: s.turns,
      toolCalls: s.toolCalls,
      costUsd: s.costUsd,
      runners: 0,
      unread: false,
      lastText: s.lastText,
      plot: "bed",
      cwd: s.cwd,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
    store.putPlant(plant);
    // A tool still "running" at the end of an old transcript was cut off; don't draw it as alive.
    const entries = tail.parser.takeEntries().map((e) => (e.tool?.status === "running" ? { ...e, tool: { ...e.tool, status: "ok" as const } } : e));
    store.importEntries(plant.id, entries);
    store.flush();
    added++;
  }
  console.log(`[gardener] imported ${added} Claude Code sessions from ${root}`);
  return { added };
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;

/** For the first-run screen: how many sessions exist, and how many distinct folders they would become beds for. Reads only each file's first 64 KB. */
export async function countHistory(projectsDir = defaultProjectsDir()): Promise<{ sessions: number; beds: number }> {
  const files = await sessionFiles(projectsDir);
  const cwds = new Set<string>();
  const buf = Buffer.allocUnsafe(64 * 1024);
  for (const f of files) {
    let head = "";
    try {
      const fh = await open(f.path, "r");
      try {
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const m = CWD_RE.exec(head);
    if (!m) continue;
    try {
      const cwd = JSON.parse(`"${m[1]}"`) as string;
      cwds.add(process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd));
    } catch {
      // malformed escape; skip
    }
  }
  let beds = 0;
  for (const c of cwds) if (plantable(c)) beds++;
  return { sessions: files.length, beds };
}
