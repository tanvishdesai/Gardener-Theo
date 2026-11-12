// A simulated garden for previewing the UI in a plain browser (`npm run demo`).
// It speaks the full V2 GardenApi with scripted agents instead of Claude, and coalesces events
// every 16 ms into "batch" messages with per-plant "plant:patch" diffs, like the real main process.
// `?beds=100&plants=1000&live=30&journal=10000` swaps in the synthetic benchmark garden.
import { activityForTool, nameFromPrompt, nextSpecies, potBranch, summarizeToolInput } from "../../shared/garden";
import type {
  AskResponse,
  Bed,
  CommitMessage,
  DiffFile,
  DiffScope,
  Entry,
  GardenApi,
  GardenEvent,
  HarvestInfo,
  HookStatus,
  PendingAsk,
  PermissionMode,
  Plant,
  PoolInfo,
  Ring,
  SearchHit,
  Settings,
  SoilReport,
  SowRequest,
  UsageBucket,
  UsageReport,
  Weather,
} from "../../shared/types";
import { syntheticGarden } from "./synthetic";

let n = 0;
const uid = (p = "id") => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const now = () => Date.now();
const DAY = 86_400_000;
const GB = 1024 ** 3;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (len: number) => Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("");
/** Small stable hash for deterministic fake data per plant. */
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const clip = (s: string | undefined, max: number) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

type Step =
  | { kind: "think"; ms: number; text?: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; ms: number; output?: string; ask?: boolean }
  | { kind: "done"; text: string };

const SCRIPT: Step[] = [
  { kind: "think", ms: 1800, text: "Let me look at how the wire protocol is assembled before touching anything." },
  { kind: "tool", name: "Glob", input: { pattern: "src/**/*.ts" }, ms: 1400, output: "src/server/wire.ts\nsrc/server/thread.ts\nsrc/client/sync.ts" },
  { kind: "tool", name: "Read", input: { file_path: "src/server/wire.ts" }, ms: 2200, output: "export function encodeThread(...) {\n  …\n}" },
  { kind: "tool", name: "Grep", input: { pattern: "encodeThread", path: "src" }, ms: 1500, output: "src/server/thread.ts:41\nsrc/client/sync.ts:12" },
  { kind: "tool", name: "TodoWrite", input: { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] }, ms: 900 },
  { kind: "think", ms: 1600 },
  { kind: "tool", name: "Edit", input: { file_path: "src/server/wire.ts", old_string: "events.map(full)", new_string: "events.map(compact)" }, ms: 2400, ask: true },
  { kind: "tool", name: "Task", input: { description: "Check other callers", prompt: "Find every caller of encodeThread" }, ms: 3400, output: "Two callers, both fine." },
  { kind: "tool", name: "Bash", input: { command: "npm test -- wire", description: "Run the wire tests" }, ms: 2600, output: "✓ 14 tests passed", ask: true },
  { kind: "tool", name: "WebFetch", input: { url: "https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream" }, ms: 2000, output: "…" },
  {
    kind: "done",
    text: "Switched thread events to the compact encoding. Payload for the big fixture thread drops from 41 KB to 6 KB; wire tests pass. One thing to decide: the mobile client still asks for `full` in one place, want me to move it too?",
  },
];

const AMBIENT_TOOLS: { name: string; input: Record<string, unknown> }[] = [
  { name: "Read", input: { file_path: "src/index.ts" } },
  { name: "Grep", input: { pattern: "TODO", path: "src" } },
  { name: "Edit", input: { file_path: "src/lib/cache.ts" } },
  { name: "Bash", input: { command: "npm test" } },
  { name: "WebFetch", input: { url: "https://nodejs.org/api/fs.html" } },
  { name: "Glob", input: { pattern: "**/*.test.ts" } },
];

const FILES = ["src/server/wire.ts", "src/server/thread.ts", "src/client/sync.ts", "test/wire.test.ts", "README.md", "src/lib/compact.ts", "docs/protocol.md", "assets/logo.png"];

function soil(partial: Partial<SoilReport>): SoilReport {
  return { exists: true, isGitRepo: true, branch: "main", defaultBranch: "main", dirty: 0, ahead: 0, behind: 0, guidance: [], ci: [], tests: [], lint: [], checkedAt: now(), ...partial };
}

function makePlant(p: Partial<Plant> & Pick<Plant, "bedId" | "name" | "species" | "seed">): Plant {
  return {
    id: uid("plant"),
    origin: "sown",
    permissionMode: "default",
    status: "idle",
    live: false,
    turns: 0,
    toolCalls: 0,
    costUsd: 0,
    runners: 0,
    unread: false,
    plot: "bed",
    model: "claude-opus-5-5",
    createdAt: now() - 5e6 + n * 1000,
    updatedAt: now(),
    ...p,
  };
}

const pot = (name: string, bedId: string, extra: Partial<Plant> = {}): Partial<Plant> => {
  const branch = potBranch(name, hex(4));
  return { plot: "pot", branch, baseRef: "main", worktreePath: `~/.gardener/plots/${bedId}/${branch.slice(7)}`, potDirty: 0, ...extra };
};

function seedGarden() {
  const beds: Bed[] = [
    { id: "bed-t3", name: "t3code", path: "~/code/t3code", createdAt: now() - 9e6, gridX: 1, gridY: 0, stakeCommand: "npm run typecheck" },
    { id: "bed-garden", name: "gardener", path: "~/code/gardener", createdAt: now() - 8e6, gridX: 1, gridY: 1 },
    { id: "bed-site", name: "marketing-site", path: "~/code/marketing-site", createdAt: now() - 7e6, gridX: 0, gridY: 1 },
  ];
  const soilMap: Record<string, SoilReport> = {
    "bed-t3": soil({
      branch: "theo/wire-v2",
      dirty: 7,
      ahead: 2,
      guidance: ["AGENTS.md", "CLAUDE.md"],
      ci: [".github/workflows"],
      tests: ["npm test"],
      lint: ["oxlint", ".prettierrc"],
      stakeCandidates: ["npm run typecheck", "npm test", "npm run lint"],
      health: 86,
    }),
    "bed-garden": soil({ branch: "main", dirty: 2, guidance: ["CLAUDE.md"], tests: ["vitest.config.ts"], stakeCandidates: ["npm run typecheck", "npm test"], health: 58 }),
    "bed-site": soil({ branch: "redesign", lint: [".prettierrc"], stakeCandidates: ["npm run build"], health: 31 }),
  };
  const plants: Plant[] = [
    makePlant({
      bedId: "bed-t3",
      name: "Compact wire protocol",
      species: "sunflower",
      seed: "Shrink the thread payload",
      status: "working",
      activity: "edit",
      activityDetail: "src/server/wire.ts",
      live: true,
      turns: 5,
      ring: 5,
      toolCalls: 61,
      costUsd: 1.92,
      todos: { done: 2, total: 5 },
      lastDiff: { files: 3, insertions: 42, deletions: 7 },
      ...pot("Compact wire protocol", "bed-t3", { potDirty: 3 }),
    }),
    makePlant({ bedId: "bed-t3", name: "Delete useless tests", species: "tulip", seed: "Find and remove tests that never catch anything", status: "waiting", live: true, turns: 3, ring: 3, toolCalls: 22, costUsd: 0.71 }),
    makePlant({
      bedId: "bed-t3",
      name: "Thread transfer check",
      species: "lavender",
      seed: "Add a CI check for thread payload size",
      turns: 9,
      ring: 9,
      toolCalls: 140,
      costUsd: 4.1,
      unread: true,
      lastText: "Added the thread transfer impact action. It posts the payload diff on every PR and fails on >10% regressions.",
      lastDiff: { files: 2, insertions: 118, deletions: 4 },
      stake: { status: "passing", command: "npm run typecheck", summary: "no errors", turn: 9, at: now() - 60_000 },
      pr: { number: 412, url: "https://github.com/example/t3code/pull/412", state: "open", checks: "passing", review: "review_required", checkedAt: now() },
      ...pot("Thread transfer check", "bed-t3"),
    }),
    makePlant({
      bedId: "bed-t3",
      name: "Investigate flaky reconnect",
      species: "rose",
      seed: "Why does reconnect flake on mobile",
      status: "working",
      activity: "delegate",
      activityDetail: "runner: Grep reconnect",
      runners: 2,
      live: true,
      turns: 2,
      ring: 2,
      toolCalls: 17,
      costUsd: 0.5,
      stake: { status: "failing", command: "npm run typecheck", summary: "3 errors", turn: 2, at: now() - 120_000 },
      ...pot("Investigate flaky reconnect", "bed-t3", { potDirty: 5 }),
    }),
    makePlant({ bedId: "bed-t3", name: "Bump React", species: "poppy", seed: "Upgrade React to 19.3", queued: true, turns: 1, ring: 1, toolCalls: 6, costUsd: 0.12 }),
    makePlant({
      bedId: "bed-t3",
      name: "Terminal: fix lint",
      species: "daisy",
      seed: "fix the lint errors in src/client",
      origin: "volunteer",
      watchedBy: "transcript",
      status: "working",
      activity: "run",
      activityDetail: "npx oxlint src/client",
      live: true,
      turns: 2,
      toolCalls: 11,
      costUsd: 0.2,
      cwd: "~/code/t3code",
    }),
    makePlant({ bedId: "bed-garden", name: "Plan sync engine port", species: "daisy", seed: "Plan moving the custom sync engine to Convex", status: "waiting", permissionMode: "plan", live: true, turns: 1, ring: 1, toolCalls: 30, costUsd: 0.9 }),
    makePlant({ bedId: "bed-garden", name: "Rewrite bed layout", species: "poppy", seed: "Make beds wrap nicely on small windows", status: "thinking", activity: "think", live: true, turns: 4, ring: 4, toolCalls: 33, costUsd: 0.88, ...pot("Rewrite bed layout", "bed-garden") }),
    makePlant({ bedId: "bed-garden", name: "Fix soil polling", species: "sunflower", seed: "Soil polling runs git too often", status: "error", error: "Hit a usage limit. The plant will need to wait for the next window.", turns: 2, ring: 2, toolCalls: 12, costUsd: 0.3 }),
    makePlant({ bedId: "bed-garden", name: "Terminal: README pass", species: "lavender", seed: "tighten the README", origin: "volunteer", watchedBy: "hook", ended: true, turns: 3, toolCalls: 19, costUsd: 0.44, cwd: "~/code/gardener", pinned: true }),
    makePlant({ bedId: "bed-site", name: "Hero section copy", species: "tulip", seed: "Draft new hero copy", turns: 0 }),
    makePlant({ bedId: "bed-site", name: "Survey the bed", species: "daisy", seed: "Give me a tour", status: "working", activity: "read", activityDetail: "src/pages/index.astro", live: true, toolCalls: 4, costUsd: 0.04, permissionMode: "plan" }),
  ];
  // Old, finished plants: they live in the Seed Catalogue, not the ground.
  const OLD = ["Fix date parsing", "Add retry to uploads", "Remove dead feature flags", "Document the wire format", "Speed up cold start", "Port settings page", "Clean up error toasts", "Test the rate limiter"];
  for (let i = 0; i < 24; i++) {
    const name = `${OLD[i % OLD.length]}${i >= OLD.length ? ` (${Math.floor(i / OLD.length) + 1})` : ""}`;
    const bedId = ["bed-t3", "bed-t3", "bed-garden", "bed-site"][i % 4];
    const old = now() - (10 + i * 2) * DAY;
    plants.push(
      makePlant({
        bedId,
        name,
        species: (["sunflower", "tulip", "daisy", "rose", "lavender", "poppy"] as const)[i % 6],
        seed: name,
        turns: 2 + (i % 7),
        ring: 2 + (i % 7),
        toolCalls: 20 + i * 3,
        costUsd: 0.3 + i * 0.11,
        createdAt: old - DAY,
        updatedAt: old,
        lastText: "Done. Tests pass.",
        archivedAt: i % 5 === 0 ? old : undefined,
        pr: i % 5 === 0 ? { number: 300 + i, url: `https://github.com/example/repo/pull/${300 + i}`, state: "merged", checks: "passing", checkedAt: old } : undefined,
        ...(i % 3 === 0 ? pot(name, bedId) : {}),
      }),
    );
  }
  return { beds, soil: soilMap, plants };
}

export function createDemo(): GardenApi {
  const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const num = (k: string, d: number) => (q.has(k) ? Math.max(0, Number(q.get(k)) || 0) : d);
  const synthetic = q.has("beds") || q.has("plants");
  const journalLen = num("journal", synthetic ? 60 : 0);
  const seeded = synthetic ? syntheticGarden({ beds: num("beds", 100), plants: num("plants", 1000), live: num("live", 30), journal: journalLen }) : seedGarden();

  const beds = new Map(seeded.beds.map((b) => [b.id, b]));
  const plants = new Map(seeded.plants.map((p) => [p.id, p]));
  const soilMap = seeded.soil;
  const journals = new Map<string, Entry[]>();
  const openJournals = new Set<string>();
  const ringsOf = new Map<string, Ring[]>();
  const fullOutputs = new Map<string, number>(); // entry id -> fake byte size
  const listeners = new Set<(e: GardenEvent) => void>();
  const runs = new Map<string, { step: number; timer?: ReturnType<typeof setTimeout>; resume?: (r: AskResponse) => void; prompt: string; startedAt: number }>();
  const qWeather = q.get("weather");
  let weather: Weather | undefined =
    qWeather === "clear"
      ? undefined
      : qWeather === "rain"
        ? { status: "rain", utilization: 1, resetsAt: now() + 2 * 3600_000, limitType: "five_hour", at: now() }
        : { status: "clouds", utilization: 0.82, resetsAt: now() + 2 * 3600_000, limitType: "five_hour", at: now() };
  let settings: Settings = { idleMinutes: 30, hookInstalled: false, hookPort: 47821, onboarded: !q.has("firstrun"), wakeOnRedStake: true };

  // ---------- events, coalesced per 16 ms ----------
  let pending: GardenEvent[] = [];
  const patchAt = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    const events = pending;
    pending = [];
    patchAt.clear();
    flushTimer = undefined;
    if (!events.length) return;
    const out: GardenEvent = events.length === 1 ? events[0] : { type: "batch", events };
    listeners.forEach((l) => l(out));
  };
  const emit = (e: GardenEvent) => {
    if (e.type === "plant:patch") {
      const i = patchAt.get(e.id);
      const queued = i === undefined ? undefined : pending[i];
      if (queued?.type === "plant:patch") queued.patch = { ...queued.patch, ...e.patch };
      else if (queued?.type === "plant") queued.plant = { ...queued.plant, ...e.patch };
      else {
        patchAt.set(e.id, pending.length);
        pending.push({ type: "plant:patch", id: e.id, patch: { ...e.patch } });
      }
    } else {
      if (e.type === "plant") patchAt.set(e.plant.id, pending.length);
      if (e.type === "plant:removed") patchAt.delete(e.id);
      pending.push(e);
    }
    flushTimer ??= setTimeout(flush, 16);
  };

  const shell = (p: Plant): Plant => ({ ...p, seed: clip(p.seed, 200)!, lastText: clip(p.lastText, 240) });

  const pool = (): PoolInfo => {
    const live = [...plants.values()].filter((p) => p.live).length;
    const queued = [...plants.values()].filter((p) => p.queued).length;
    const perProcessBytes = 0.6 * GB;
    const totalBytes = 16 * GB;
    const freeBytes = Math.max(1.4 * GB, 9.7 * GB - live * perProcessBytes);
    const floor = 2.4 * GB;
    const ceiling = Math.floor((totalBytes - 4 * GB) / perProcessBytes);
    let canAdmit = Math.max(0, Math.min(ceiling - live, Math.floor((freeBytes - floor) / perProcessBytes)));
    if (settings.maxLive !== undefined) canAdmit = Math.max(0, Math.min(canAdmit, settings.maxLive - live));
    return { live, canAdmit, ceiling, freeBytes, totalBytes, perProcessBytes, queued, userMax: settings.maxLive };
  };

  const update = (id: string, patch: Partial<Plant>) => {
    const p = plants.get(id);
    if (!p) return;
    const next = { ...p, ...patch, updatedAt: now() };
    plants.set(id, next);
    emit({ type: "plant:patch", id, patch: { ...patch, updatedAt: next.updatedAt } });
    if ("live" in patch && patch.live !== p.live) emit({ type: "pool", pool: pool() });
    return next;
  };

  // ---------- journals ----------
  const fakeHistory = (p: Plant, count: number): Entry[] => {
    const out: Entry[] = [];
    const span = Math.max(60_000, p.updatedAt - p.createdAt);
    const push = (e: Omit<Entry, "plantId" | "seq" | "ts">) => out.push({ ...e, plantId: p.id, seq: out.length + 1, ts: p.createdAt + Math.floor((out.length / Math.max(1, count)) * span) });
    push({ id: `${p.id}:sys`, kind: "system", text: `Rooted in ${p.worktreePath ?? beds.get(p.bedId)?.path} · ${p.model ?? "claude"} · Claude Code (demo)` });
    let turn = 0;
    while (out.length < count) {
      const k = out.length;
      if (k === 1 || k % 40 === 0) {
        turn++;
        push({ id: `${p.id}:u${k}`, kind: "user", text: turn === 1 ? p.seed : `Follow-up ${turn}: also cover the edge case where the list is empty.` });
        continue;
      }
      if (k % 40 === 39) {
        push({ id: `${p.id}:r${k}`, kind: "result", text: `Bloomed after ${38} steps · 41s · $${(0.1 * turn).toFixed(2)} so far` });
        continue;
      }
      if (k % 7 === 0) {
        push({ id: `${p.id}:t${k}`, kind: "text", text: `Step ${k}: checked the **${FILES[k % FILES.length]}** module.\n\n- kept the public API\n- moved \`parse\` behind a flag` });
        continue;
      }
      if (k % 11 === 0) {
        push({ id: `${p.id}:th${k}`, kind: "thinking", text: "The cache is keyed by path, so a rename would orphan it. Better to key by inode." });
        continue;
      }
      const t = AMBIENT_TOOLS[k % AMBIENT_TOOLS.length];
      const id = `${p.id}:tool${k}`;
      const big = k % 50 === 5;
      if (big) fullOutputs.set(id, 600_000 + (k % 7) * 100_000);
      push({
        id,
        kind: "tool",
        text: t.name,
        tool: {
          id: `tool${k}`,
          name: t.name,
          summary: summarizeToolInput(t.name, t.input),
          activity: activityForTool(t.name),
          status: k % 31 === 0 ? "error" : "ok",
          output: big ? fakeOutput(4096) : `ok (${k})`,
          outputTruncated: big || undefined,
          outputBytes: big ? fullOutputs.get(id) : undefined,
        },
      });
    }
    return out;
  };

  const journal = (id: string): Entry[] => {
    let j = journals.get(id);
    if (!j) {
      const p = plants.get(id);
      j = p ? (journalLen > 0 || p.turns >= 5 ? fakeHistory(p, journalLen || p.turns * 40) : introEntries(p)) : [];
      journals.set(id, j);
    }
    return j;
  };
  const introEntries = (p: Plant): Entry[] => {
    const list: Entry[] = [];
    const add = (kind: Entry["kind"], text: string) => list.push({ id: `${p.id}:i${list.length}`, plantId: p.id, seq: list.length + 1, ts: p.createdAt + list.length * 1000, kind, text });
    add("system", `Rooted in ${p.worktreePath ?? p.cwd ?? beds.get(p.bedId)?.path} · ${p.model ?? "claude"} · Claude Code (demo)`);
    add("user", p.seed);
    if (p.turns > 0) add("text", p.lastText ?? "Looked around the bed and made a first pass.");
    if (p.unread) add("result", `Bloomed after 12 steps · 94s · $${p.costUsd.toFixed(2)} so far`);
    if (p.status === "error") add("error", p.error ?? "Wilted");
    return list;
  };
  const entry = (plantId: string, e: Omit<Entry, "plantId" | "ts" | "id" | "seq"> & { id?: string }) => {
    const j = journals.get(plantId);
    if (!j) return; // not generated yet; its history will be generated when opened
    const id = e.id ?? uid("e");
    const i = j.findIndex((x) => x.id === id);
    const full: Entry = i >= 0 ? { ...j[i], ...e, id } : { ...e, id, plantId, ts: now(), seq: (j[j.length - 1]?.seq ?? 0) + 1 };
    if (i >= 0) j[i] = full;
    else j.push(full);
    if (openJournals.has(plantId)) emit({ type: "entry", entry: full });
  };
  const page = (list: Entry[], end: number, limit: number) => ({ entries: list.slice(Math.max(0, end - limit), end), hasMore: end - limit > 0 });

  // ---------- rings and diffs ----------
  const rings = (p: Plant): Ring[] => {
    let r = ringsOf.get(p.id);
    if (!r) {
      const h = hash(p.id);
      r = Array.from({ length: p.turns }, (_, i) => {
        const files = 1 + ((h >> i) % 4);
        const started = p.createdAt + i * 600_000;
        return {
          plantId: p.id,
          n: i + 1,
          prompt: i === 0 ? p.seed : `Follow-up ${i + 1}`,
          startedAt: started,
          endedAt: started + 90_000,
          ok: true,
          costUsd: 0.1 + (i % 3) * 0.07,
          diff: (h >> i) % 5 === 0 ? undefined : { files, insertions: 4 + ((h >> (i + 1)) % 90), deletions: (h >> (i + 2)) % 30 },
          checkpoint: (h >> i) % 5 === 0 ? "skipped" : "ready",
          checkpointNote: (h >> i) % 5 === 0 ? "No files changed in this turn" : undefined,
          pruned: p.ring !== undefined && i + 1 > p.ring,
          stake: beds.get(p.bedId)?.stakeCommand ? { status: (h >> i) % 6 === 0 ? "failing" : "passing", command: beds.get(p.bedId)!.stakeCommand!, turn: i + 1, at: started + 95_000 } : undefined,
        } satisfies Ring;
      });
      ringsOf.set(p.id, r);
    }
    return r;
  };
  const filesFor = (plantId: string, scope: DiffScope): DiffFile[] => {
    const h = hash(plantId + JSON.stringify(scope));
    const count = scope.kind === "sown" ? 5 : 1 + (h % 4);
    return Array.from({ length: count }, (_, i) => {
      const path = FILES[(h + i * 3) % FILES.length];
      const status: DiffFile["status"] = path.endsWith(".png") ? "binary" : i === 1 && h % 3 === 0 ? "added" : i === 2 && h % 4 === 0 ? "deleted" : "modified";
      return { path, status, insertions: status === "deleted" || status === "binary" ? 0 : 3 + ((h >> i) % 40), deletions: status === "added" || status === "binary" ? 0 : (h >> (i + 2)) % 12 };
    }).filter((f, i, all) => all.findIndex((x) => x.path === f.path) === i);
  };
  const patchFor = (file: DiffFile): string => {
    const a = `a/${file.path}`;
    const b = `b/${file.path}`;
    const head = [`diff --git ${a} ${b}`];
    if (file.status === "binary") return [...head, `Binary files ${a} and ${b} differ`, ""].join("\n");
    if (file.status === "added") {
      const lines = Array.from({ length: file.insertions }, (_, i) => `+export const step${i} = ${i}; // new`);
      return [...head, "new file mode 100644", "index 0000000..1a2b3c4", "--- /dev/null", `+++ ${b}`, `@@ -0,0 +1,${lines.length} @@`, ...lines, ""].join("\n");
    }
    if (file.status === "deleted") {
      const lines = Array.from({ length: Math.max(1, file.deletions) }, (_, i) => `-const legacy${i} = require("./old");`);
      return [...head, "deleted file mode 100644", "index 4d5e6f7..0000000", `--- ${a}`, "+++ /dev/null", `@@ -1,${lines.length} +0,0 @@`, ...lines, ""].join("\n");
    }
    const del = Math.max(1, Math.min(file.deletions, 6));
    const ins = Math.max(1, Math.min(file.insertions, 9));
    const body = [
      " import { encode } from \"./codec\";",
      " ",
      " export function encodeThread(thread: Thread) {",
      ...Array.from({ length: del }, (_, i) => `-  const events${i} = thread.events.map(full);`),
      ...Array.from({ length: ins }, (_, i) => `+  const events${i} = thread.events.map(compact); // smaller payload`),
      "   return encode(events0);",
      " }",
    ];
    return [...head, "index 3f2a1c0..9b8e7d4 100644", `--- ${a}`, `+++ ${b}`, `@@ -12,${5 + del} +12,${5 + ins} @@ export function encodeThread(`, ...body, ""].join("\n");
  };

  // ---------- the scripted agent ----------
  const askFor = (p: Plant, ask: PendingAsk) => update(p.id, { status: "waiting", ask });
  for (const p of plants.values()) {
    if (p.status !== "waiting" || p.ask) continue;
    if (p.permissionMode === "plan") {
      askFor(p, {
        id: uid("ask"),
        kind: "plan",
        toolName: "ExitPlanMode",
        title: "A plan, waiting for your approval",
        detail: "",
        canAlwaysAllow: false,
        createdAt: now() - 240_000,
        plan: "## Port the sync engine to Convex\n\n1. Model threads, messages and attachments as Convex tables.\n2. Replace the hand-rolled websocket diffing with `useQuery` subscriptions.\n3. Keep the old engine behind a flag for one release; dual-write during the window.\n4. Delete `src/sync/*` once the flag has been on for a week with no regressions.\n\nRisk: attachment uploads, which currently stream through the sync socket.",
      });
    } else {
      askFor(p, {
        id: uid("ask"),
        kind: "permission",
        toolName: "Bash",
        title: "Claude wants to run a command",
        detail: "Delete 212 test files that only assert mocks were called\n\n$ git rm $(cat /tmp/useless-tests.txt)",
        reason: "Bash commands that delete files need approval",
        canAlwaysAllow: true,
        createdAt: now() - 600_000,
      });
    }
  }

  function finishTurn(plantId: string, text: string) {
    const cur = plants.get(plantId)!;
    const run = runs.get(plantId);
    const turn = cur.turns + 1;
    const diff = { files: 2, insertions: 12 + (turn % 30), deletions: turn % 7 };
    entry(plantId, { kind: "text", text });
    entry(plantId, { kind: "result", text: `Bloomed after ${SCRIPT.length} steps · 26s · $${(cur.costUsd + 0.42).toFixed(2)} so far` });
    const ring: Ring = { plantId, n: turn, prompt: run?.prompt ?? "", startedAt: run?.startedAt ?? now() - 26_000, endedAt: now(), ok: true, costUsd: 0.42, diff, checkpoint: "ready" };
    rings(cur).push(ring);
    if (openJournals.has(plantId)) emit({ type: "ring", ring });
    update(plantId, {
      status: "idle",
      activity: undefined,
      activityDetail: undefined,
      turns: turn,
      ring: turn,
      costUsd: cur.costUsd + 0.42,
      unread: true,
      lastText: text,
      lastDiff: diff,
      potDirty: cur.plot === "pot" ? (cur.potDirty ?? 0) + diff.files : cur.potDirty,
      todos: { done: 3, total: 3 },
    });
    runs.delete(plantId);
    if (beds.get(cur.bedId)?.stakeCommand) void api.runStake(plantId);
  }

  function runStep(plantId: string) {
    const run = runs.get(plantId);
    const p = plants.get(plantId);
    if (!run || !p) return;
    const step = SCRIPT[run.step % SCRIPT.length];
    run.step++;
    const next = (ms: number) => (run.timer = setTimeout(() => runStep(plantId), ms));
    switch (step.kind) {
      case "think":
        update(plantId, { status: "thinking", activity: "think", activityDetail: undefined });
        if (step.text) entry(plantId, { kind: "text", text: step.text });
        next(step.ms);
        return;
      case "tool": {
        const needsAsk = step.ask && p.permissionMode === "default";
        const toolId = uid("tool");
        const activity = activityForTool(step.name);
        const summary = summarizeToolInput(step.name, step.input);
        const go = () => {
          const cur = plants.get(plantId)!;
          entry(plantId, { id: `tool:${toolId}`, kind: "tool", text: step.name, tool: { id: toolId, name: step.name, summary, activity, status: "running" } });
          update(plantId, {
            status: "working",
            activity,
            activityDetail: summary,
            toolCalls: cur.toolCalls + 1,
            ask: undefined,
            runners: activity === "delegate" ? 1 : cur.runners,
            todos: step.name === "TodoWrite" ? { done: 1, total: 3 } : cur.todos,
          });
          run.timer = setTimeout(() => {
            entry(plantId, { id: `tool:${toolId}`, kind: "tool", text: step.name, tool: { id: toolId, name: step.name, summary, activity, status: "ok", output: step.output } });
            update(plantId, { runners: 0 });
            runStep(plantId);
          }, step.ms);
        };
        if (!needsAsk) return go();
        askFor(p, {
          id: uid("ask"),
          kind: "permission",
          toolName: step.name,
          title: step.name === "Bash" ? "Claude wants to run a command" : `Claude wants to edit ${String(step.input.file_path)}`,
          detail: step.name === "Bash" ? `${step.input.description}\n\n$ ${step.input.command}` : `${step.input.file_path}\n\n- ${step.input.old_string}\n+ ${step.input.new_string}`,
          canAlwaysAllow: true,
          createdAt: now(),
        });
        run.resume = (r) => {
          run.resume = undefined;
          if (r.behavior === "allow") go();
          else {
            entry(plantId, { kind: "text", text: "Understood, I'll leave that alone." });
            update(plantId, { ask: undefined });
            runStep(plantId);
          }
        };
        return;
      }
      case "done":
        finishTurn(plantId, step.text);
        return;
    }
  }

  function start(plantId: string, prompt: string) {
    const existing = runs.get(plantId);
    if (existing?.timer) clearTimeout(existing.timer);
    runs.set(plantId, { step: 0, prompt, startedAt: now() });
    update(plantId, { status: "thinking", activity: "think", live: true, queued: false, unread: false, error: undefined });
    setTimeout(() => runStep(plantId), 900);
  }

  // Keep the live plants that are not scripted looking busy: fake tool calls stream in.
  const ambient = ["read", "search", "edit", "run", "web", "think"] as const;
  setInterval(() => {
    for (const p of plants.values()) {
      if (runs.has(p.id) || !p.live || (p.status !== "working" && p.status !== "thinking")) continue;
      if (Math.random() < 0.55) continue;
      const a = ambient[Math.floor(Math.random() * ambient.length)];
      if (a === "think") {
        update(p.id, { status: "thinking", activity: "think", activityDetail: undefined });
        continue;
      }
      const t = AMBIENT_TOOLS[Math.floor(Math.random() * AMBIENT_TOOLS.length)];
      const summary = summarizeToolInput(t.name, t.input);
      const activity = activityForTool(t.name);
      const id = uid("tool");
      update(p.id, { status: "working", activity, activityDetail: summary, toolCalls: p.toolCalls + 1 });
      entry(p.id, { id: `tool:${id}`, kind: "tool", text: t.name, tool: { id, name: t.name, summary, activity, status: "running" } });
      setTimeout(() => entry(p.id, { id: `tool:${id}`, kind: "tool", text: t.name, tool: { id, name: t.name, summary, activity, status: "ok", output: `ok · ${summary}` } }), 600);
    }
  }, 1400);

  const fakeOutput = (bytes: number) => {
    const lines: string[] = [];
    let size = 0;
    for (let i = 1; size < bytes; i++) {
      const l = `${String(i).padStart(6)}  PASS  test/suite-${i % 97}.test.ts > handles case ${i} (${i % 13}ms)`;
      lines.push(l);
      size += l.length + 1;
    }
    return lines.join("\n");
  };

  const hookStatus = (): HookStatus => ({
    installed: settings.hookInstalled,
    preview: JSON.stringify(
      { hooks: { Notification: [{ hooks: [{ type: "command", command: `curl -s -X POST http://127.0.0.1:${settings.hookPort}/hook -d @-` }] }], Stop: [{ hooks: [{ type: "command", command: `curl -s -X POST http://127.0.0.1:${settings.hookPort}/hook -d @-` }] }] } },
      null,
      2,
    ),
    settingsPath: "~/.claude/settings.json",
    listening: settings.hookInstalled,
    note: settings.hookInstalled ? undefined : "Not installed. Terminal sessions are watched through their transcripts, which can't tell when they wait on you.",
  });

  const usageReport = (days: number): UsageReport => {
    const buckets: UsageBucket[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now() - i * DAY);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const h = hash(day);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const cost = weekend ? (h % 300) / 100 : 3 + (h % 1800) / 100;
      buckets.push({ day, costUsd: Math.round(cost * 100) / 100, inputTokens: Math.round(cost * 90_000), outputTokens: Math.round(cost * 14_000), cacheReadTokens: Math.round(cost * 600_000), cacheWriteTokens: Math.round(cost * 40_000) });
    }
    const total = buckets.reduce((s, b) => s + b.costUsd, 0);
    const bedRows = [...beds.values()].slice(0, 12).map((b, i) => ({ key: b.id, label: b.name, costUsd: Math.round((total / (i + 2)) * 100) / 100, tokens: Math.round((total / (i + 2)) * 700_000) }));
    const plantRows = [...plants.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 15)
      .map((p) => ({ key: p.id, label: p.name, costUsd: p.costUsd, tokens: Math.round(p.costUsd * 700_000), turns: p.turns }));
    const input = buckets.reduce((s, b) => s + b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens, 0);
    return {
      days: buckets,
      byBed: bedRows,
      byModel: [
        { key: "claude-opus-5-5", label: "Opus 5.5", costUsd: Math.round(total * 0.71 * 100) / 100, tokens: Math.round(total * 500_000) },
        { key: "claude-sonnet-5", label: "Sonnet 5", costUsd: Math.round(total * 0.26 * 100) / 100, tokens: Math.round(total * 300_000) },
        { key: "claude-haiku-5", label: "Haiku 5", costUsd: Math.round(total * 0.03 * 100) / 100, tokens: Math.round(total * 90_000) },
      ],
      byPlant: plantRows,
      totalCostUsd: Math.round(total * 100) / 100,
      cacheHitRatio: buckets.reduce((s, b) => s + b.cacheReadTokens, 0) / Math.max(1, input),
      estimated: true,
      scannedAt: now(),
    };
  };

  const addPlant = (p: Plant) => {
    plants.set(p.id, p);
    emit({ type: "plant", plant: shell(p) });
    return p;
  };

  const api: GardenApi = {
    async snapshot() {
      return { beds: [...beds.values()], plants: [...plants.values()].map(shell), soil: soilMap, pool: pool(), weather, settings, demo: true };
    },

    // ----- journal -----
    async openJournal(plantId, limit = 200) {
      openJournals.add(plantId);
      const list = journal(plantId);
      await wait(40);
      return page(list, list.length, limit);
    },
    async journalPage(plantId, beforeSeq, limit = 200) {
      const list = journal(plantId);
      let end = list.length;
      while (end > 0 && (list[end - 1].seq ?? 0) >= beforeSeq) end--;
      await wait(60);
      return page(list, end, limit);
    },
    async closeJournal(plantId) {
      openJournals.delete(plantId);
    },
    async toolOutput(_plantId, entryId) {
      await wait(150);
      return fakeOutput(fullOutputs.get(entryId) ?? 8192);
    },
    async search(query) {
      const ql = query.trim().toLowerCase();
      if (ql.length < 2) return [];
      const hits: SearchHit[] = [];
      const snip = (text: string) => {
        const i = text.toLowerCase().indexOf(ql);
        return `${i > 30 ? "…" : ""}${text.slice(Math.max(0, i - 30), i + ql.length + 50).replace(/\s+/g, " ")}`;
      };
      for (const p of plants.values()) {
        if (p.seed.toLowerCase().includes(ql)) hits.push({ plantId: p.id, bedId: p.bedId, title: p.name, snippet: snip(p.seed) });
        if (hits.length >= 40) break;
      }
      for (const [pid, list] of journals) {
        const p = plants.get(pid);
        if (!p) continue;
        for (let i = list.length - 1; i >= 0 && hits.length < 40; i--) {
          if (list[i].text.toLowerCase().includes(ql)) {
            hits.push({ plantId: pid, bedId: p.bedId, entryId: list[i].id, title: `${p.name} · journal`, snippet: snip(list[i].text) });
            break;
          }
        }
      }
      await wait(80);
      return hits;
    },

    // ----- beds -----
    async pickDirectory() {
      const name = prompt("Demo: name a folder to plant a bed in", "~/code/new-project");
      return name || null;
    },
    async addBed(path) {
      const taken = new Set([...beds.values()].map((b) => `${b.gridX},${b.gridY}`));
      let x = 2;
      while (taken.has(`${x},0`)) x++;
      const bed: Bed = { id: uid("bed"), name: path.split("/").filter(Boolean).pop() ?? path, path, createdAt: now(), gridX: x, gridY: 0 };
      beds.set(bed.id, bed);
      soilMap[bed.id] = soil({ branch: "main", stakeCandidates: ["npm test"], health: 20 });
      emit({ type: "bed", bed });
      emit({ type: "soil", bedId: bed.id, report: soilMap[bed.id] });
      return bed;
    },
    async removeBed(id) {
      for (const p of [...plants.values()]) if (p.bedId === id) await api.uproot(p.id);
      beds.delete(id);
      emit({ type: "bed:removed", id });
    },
    async refreshSoil(bedId) {
      if (!soilMap[bedId]) return;
      soilMap[bedId] = { ...soilMap[bedId], checkedAt: now() };
      emit({ type: "soil", bedId, report: soilMap[bedId] });
    },
    async setStake(bedId, command) {
      const b = beds.get(bedId);
      if (!b) return;
      const next = { ...b, stakeCommand: command ?? undefined };
      beds.set(bedId, next);
      emit({ type: "bed", bed: next });
    },
    async soilHistory(bedId) {
      const base = soilMap[bedId]?.health ?? 50;
      return Array.from({ length: 30 }, (_, i) => {
        const d = new Date(now() - (29 - i) * DAY);
        const h = hash(bedId + i);
        return { day: d.toISOString().slice(0, 10), health: Math.max(0, Math.min(100, Math.round(base - (29 - i) * 0.8 + (h % 15) - 7))) };
      });
    },

    // ----- plants -----
    async sow(req: SowRequest) {
      const siblings = [...plants.values()].filter((p) => p.bedId === req.bedId);
      const name = req.name?.trim() || nameFromPrompt(req.prompt);
      const plot = req.plot ?? (soilMap[req.bedId]?.isGitRepo ? "pot" : "bed");
      const plant = makePlant({
        id: uid("plant"),
        bedId: req.bedId,
        name,
        species: req.species ?? nextSpecies(siblings.map((p) => p.species)),
        seed: req.prompt,
        model: req.model || "claude-opus-5-5",
        permissionMode: req.permissionMode,
        createdAt: now(),
        ...(plot === "pot" ? pot(name, req.bedId, { baseRef: req.fromOrigin ? `origin/${req.baseRef ?? "main"}` : (req.baseRef ?? soilMap[req.bedId]?.branch ?? "main") }) : { plot: "bed" }),
      });
      addPlant(plant);
      journals.set(plant.id, introEntries(plant).slice(0, 1));
      if (req.prompt.trim()) await api.send(plant.id, req.prompt);
      return plant;
    },
    async send(plantId, text) {
      journal(plantId);
      entry(plantId, { kind: "user", text });
      const run = runs.get(plantId);
      if (run?.resume) {
        run.resume({ behavior: "deny", message: text });
        return;
      }
      if (pool().canAdmit === 0 && !plants.get(plantId)?.live) {
        update(plantId, { queued: true });
        entry(plantId, { kind: "system", text: "Waiting for a free pot · memory is full. It starts by itself when another plant's process closes." });
        setTimeout(() => start(plantId, text), 6000);
        return;
      }
      start(plantId, text);
    },
    async interrupt(plantId) {
      const run = runs.get(plantId);
      if (run?.timer) clearTimeout(run.timer);
      runs.delete(plantId);
      entry(plantId, { kind: "system", text: "Paused by you." });
      update(plantId, { status: "idle", activity: undefined, ask: undefined, runners: 0 });
    },
    async answer(plantId, askId, response) {
      const p = plants.get(plantId);
      if (!p?.ask || p.ask.id !== askId) return;
      const ask = p.ask;
      entry(plantId, { kind: "system", text: response.behavior === "allow" ? `Allowed ${ask.toolName}` : `Declined ${ask.toolName}` });
      if (response.behavior === "allow" && response.mode) update(plantId, { permissionMode: response.mode });
      const run = runs.get(plantId);
      if (run?.resume) return run.resume(response);
      // Pre-seeded asks: approving starts the scripted run part-way, declining rests the plant.
      if (response.behavior === "allow") {
        update(plantId, { ask: undefined });
        runs.set(plantId, { step: 5, prompt: p.seed, startedAt: now() });
        runStep(plantId);
      } else update(plantId, { ask: undefined, status: "idle" });
    },
    async setMode(plantId, mode: PermissionMode) {
      update(plantId, { permissionMode: mode });
    },
    async markRead(plantId) {
      if (plants.get(plantId)?.unread) update(plantId, { unread: false });
    },
    async setPinned(plantId, pinned) {
      update(plantId, { pinned });
    },
    async uproot(plantId) {
      const run = runs.get(plantId);
      if (run?.timer) clearTimeout(run.timer);
      runs.delete(plantId);
      const wasLive = plants.get(plantId)?.live;
      plants.delete(plantId);
      journals.delete(plantId);
      openJournals.delete(plantId);
      emit({ type: "plant:removed", id: plantId });
      if (wasLive) emit({ type: "pool", pool: pool() });
    },
    async adopt(plantId) {
      const p = plants.get(plantId);
      if (!p || p.origin !== "volunteer" || !p.ended) throw new Error("Only a volunteer whose terminal session has ended can be adopted.");
      update(plantId, { origin: "sown", ended: false, watchedBy: undefined });
      entry(plantId, { kind: "system", text: "Adopted from the terminal. Messages you send now resume the same Claude Code session." });
    },
    async reveal() {},

    // ----- rings, diffs, pruning -----
    async rings(plantId) {
      const p = plants.get(plantId);
      return p ? [...rings(p)] : [];
    },
    async diffFiles(plantId, scope) {
      await wait(60);
      return filesFor(plantId, scope);
    },
    async diffFile(plantId, scope, path) {
      await wait(40);
      const f = filesFor(plantId, scope).find((x) => x.path === path);
      if (!f) throw new Error(`${path} did not change in this scope.`);
      return patchFor(f);
    },
    async pruneTo(plantId, ring) {
      const p = plants.get(plantId);
      if (!p) throw new Error("No such plant.");
      const list = rings(p);
      for (const r of list) {
        const pruned = r.n > ring;
        if (r.pruned !== pruned) {
          r.pruned = pruned;
          if (openJournals.has(plantId)) emit({ type: "ring", ring: { ...r } });
        }
      }
      const others = [...plants.values()].some((x) => x.id !== plantId && x.bedId === p.bedId && x.live);
      const filesRestored = p.plot === "pot" || !others;
      update(plantId, { ring, lastDiff: list[ring - 1]?.diff });
      entry(plantId, { kind: "system", text: `Pruned back to ring ${ring}.` });
      return {
        filesRestored,
        conversationRewound: true,
        note: filesRestored
          ? `Files are back to how they were after ring ${ring}, and the conversation continues from there. Later rings are kept, greyed out.`
          : "The conversation was rewound, but files were left alone: other plants are growing in this bed's working tree and restoring files would undo their work too.",
      };
    },
    async forkAt(plantId, ring) {
      const p = plants.get(plantId);
      if (!p) throw new Error("No such plant.");
      const name = `${p.name} · from ring ${ring}`;
      const fork = addPlant(makePlant({ bedId: p.bedId, name, species: p.species, seed: p.seed, turns: ring, ring, createdAt: now(), ...pot(name, p.bedId, { baseRef: `${p.branch ?? "main"}@ring${ring}` }) }));
      journals.set(fork.id, introEntries(fork));
      return fork;
    },

    // ----- harvest -----
    async harvestInfo(plantId) {
      const p = plants.get(plantId);
      if (!p) throw new Error("No such plant.");
      const s = soilMap[p.bedId];
      const branch = p.branch ?? s?.branch;
      await wait(80);
      return {
        isGitRepo: !!s?.isGitRepo,
        branch,
        base: p.baseRef ?? s?.defaultBranch ?? "main",
        onDefaultBranch: branch === (s?.defaultBranch ?? "main"),
        files: (p.potDirty ?? 0) > 0 || p.plot === "bed" ? filesFor(plantId, { kind: "uncommitted" }) : [],
        unpushed: p.unpushed ?? 0,
        hasRemote: true,
        remoteUrl: `https://github.com/example/${beds.get(p.bedId)?.name ?? "repo"}`,
        ghReady: true,
        pr: p.pr,
      } satisfies HarvestInfo;
    },
    async commitMessage(plantId): Promise<CommitMessage> {
      const p = plants.get(plantId);
      await wait(400);
      return { subject: p?.name ?? "Update", body: p?.lastText ? clip(p.lastText, 400)! : "Changes grown by a Gardener plant." };
    },
    async commit(plantId, message) {
      const p = plants.get(plantId);
      if (!p) throw new Error("No such plant.");
      if (!message.subject.trim()) throw new Error("A commit needs a subject line.");
      await wait(300);
      update(plantId, { potDirty: 0, unpushed: (p.unpushed ?? 0) + 1 });
      entry(plantId, { kind: "system", text: `Committed: ${message.subject}` });
      return { sha: hex(7) };
    },
    async push(plantId) {
      await wait(600);
      update(plantId, { unpushed: 0 });
      entry(plantId, { kind: "system", text: "Pushed to origin." });
    },
    async openPullRequest(plantId, pr) {
      const p = plants.get(plantId);
      if (!p) throw new Error("No such plant.");
      await wait(700);
      const number = 400 + (hash(plantId) % 500);
      const url = `https://github.com/example/${beds.get(p.bedId)?.name ?? "repo"}/pull/${number}`;
      update(plantId, { pr: { number, url, state: "open", checks: "pending", review: "review_required", checkedAt: now() } });
      entry(plantId, { kind: "system", text: `Opened pull request #${number}: ${pr.title}` });
      setTimeout(() => {
        const cur = plants.get(plantId);
        if (cur?.pr) update(plantId, { pr: { ...cur.pr, checks: "passing", checkedAt: now() } });
      }, 4000);
      return { url, viaBrowser: false };
    },
    async runStake(plantId) {
      const p = plants.get(plantId);
      const command = p && beds.get(p.bedId)?.stakeCommand;
      if (!p || !command) throw new Error("This bed has no stake. Pick a check command in the bed's panel.");
      update(plantId, { stake: { status: "running", command, turn: p.turns, at: now() } });
      setTimeout(() => {
        const ok = Math.random() < 0.7;
        update(plantId, { stake: { status: ok ? "passing" : "failing", command, summary: ok ? "no errors" : "3 failures", turn: p.turns, at: now() } });
      }, 2500);
    },

    // ----- almanac, settings, volunteers -----
    async usage(days) {
      await wait(200);
      return usageReport(days);
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch };
      emit({ type: "settings", settings });
      emit({ type: "pool", pool: pool() });
      return settings;
    },
    async hookStatus() {
      return hookStatus();
    },
    async installHook() {
      await api.setSettings({ hookInstalled: true });
      return hookStatus();
    },
    async uninstallHook() {
      await api.setSettings({ hookInstalled: false });
      return hookStatus();
    },
    async firstRunCheck() {
      await wait(300);
      return { git: { ok: true, version: "2.47.1" }, claude: { ok: true, note: "Logged in with a Claude subscription" }, gh: { ok: false, note: "gh is installed but not logged in. Run gh auth login." }, historySessions: 214, historyBeds: 9 };
    },
    async importHistory() {
      const bed = [...beds.values()][0];
      if (!bed) return { added: 0 };
      const names = ["Old: migrate to pnpm", "Old: fix CI cache", "Old: write onboarding doc"];
      for (const [i, name] of names.entries()) {
        const at = now() - (20 + i) * DAY;
        addPlant(makePlant({ bedId: bed.id, name, species: "daisy", seed: name, origin: "imported", turns: 3, toolCalls: 25, costUsd: 0.6, createdAt: at, updatedAt: at }));
      }
      return { added: names.length };
    },
    async diagnostics() {
      return [
        "Gardener demo diagnostics",
        `beds: ${beds.size}`,
        `plants: ${plants.size} (${pool().live} live)`,
        `journals in memory: ${journals.size}, open: ${[...openJournals].join(", ") || "none"}`,
        `settings: ${JSON.stringify(settings)}`,
        `user agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
      ].join("\n");
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // Weather drifts in the demo so the sky and top bar have something to show.
  if (!qWeather)
    setInterval(() => {
      if (!weather) return;
      const u = Math.min(1, (weather.utilization ?? 0.8) + 0.01);
      weather = { ...weather, status: u >= 1 ? "rain" : "clouds", utilization: u, at: now() };
      emit({ type: "weather", weather });
    }, 30_000);

  return api;
}
