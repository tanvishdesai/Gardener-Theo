// Volunteers (PLAN D8/M6): Claude Code sessions running in a terminal, shown as plants.
// Layer 1 (always on): tail recently modified transcripts. Layer 2 (opt-in): an HTTP hook in
// ~/.claude/settings.json posting to 127.0.0.1 gives exact live state, including "waiting for permission".
//
// Ownership rules:
// - Sessions an app started through the SDK (transcript entrypoint "sdk-…", which includes Terrarium's own
//   plants) and sessions owned by a sown plant are never volunteers.
// - A session owned by an IMPORTED plant that comes alive in a terminal updates that imported plant in place
//   (live, watchedBy, status, entries) instead of creating a duplicate; it is not marked `ended` when it stops,
//   since an imported plant is already resumable. The integrator must not resume a plant while it is live && watchedBy.
import { timingSafeEqual } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { activityForTool, nameFromPrompt, nextSpecies, summarizeToolInput } from "../shared/garden";
import type { Bed, HookStatus, PendingAsk, Plant } from "../shared/types";
import { defaultProjectsDir, plantable, sessionFiles } from "./history";
import type { GardenStore } from "./store";
import { TranscriptTail } from "./transcript";

const TICK_MS = 2000;
const RECENT_MS = 10 * 60_000;
const END_MS = 15 * 60_000;
const KEEP_ENTRIES = 600;
const MAX_BODY = 4 * 1024 * 1024;
const BUSY_DETAIL = "Busy or waiting in your terminal";
const PERMISSION_TITLE = "Waiting for your permission in the terminal";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"] as const;
const TOOL_EVENTS = new Set<string>(["PreToolUse", "PostToolUse", "PermissionRequest"]);
const TOKEN_HEADER = "X-Terrarium-Token";
/** Hooks installed before the rename to Terrarium still count as ours. */
const LEGACY_TOKEN_HEADER = "X-Gardener-Token";
const tokenOf = (headers: Record<string, unknown>) => headers[TOKEN_HEADER] ?? headers[LEGACY_TOKEN_HEADER];

export interface VolunteerDeps {
  store: GardenStore;
  addBed(path: string): Bed | null;
  notify(plant: Plant, why: string): void;
  projectsDir?: string;
  settingsPath?: string;
  now?: () => number;
}

/** The payload Claude Code POSTs for each hook event (only the fields we use). */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  prompt?: string;
  model?: string;
  reason?: string;
}

interface Watch {
  sessionId: string;
  path?: string;
  tail?: TranscriptTail;
  size: number;
  /** Last sign of life: transcript mtime or hook event. */
  seen: number;
  hook: boolean;
  ended: boolean;
  ignored: boolean;
  reading: Promise<void>;
}

// ── settings.json merge ─────────────────────────────────────────────────────

function ourGroup(event: string, port: number, token: string) {
  return {
    ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
    hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook`, headers: { [TOKEN_HEADER]: token }, timeout: 2 }],
  };
}

/** The exact fragment Terrarium merges into settings.json. */
export function hookFragment(port: number, token: string) {
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [ourGroup(e, port, token)]])) };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function isOurs(h: any): boolean {
  return h?.type === "http" && typeof h.url === "string" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/hook$/.test(h.url) && isObj(h.headers) && tokenOf(h.headers) !== undefined;
}

/** Remove Terrarium's hooks (and the groups, event arrays and `hooks` object left empty by that). Returns whether anything changed. */
function strip(settings: Record<string, any>): boolean {
  if (!isObj(settings.hooks)) return false;
  let changed = false;
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups) || !groups.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs))) continue;
    changed = true;
    const kept = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) kept.push(g);
      else {
        const rest = g.hooks.filter((h: any) => !isOurs(h));
        if (rest.length) kept.push({ ...g, hooks: rest });
      }
    }
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (changed && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

function ourHook(settings: unknown): { port: number; token: string } | null {
  if (!isObj(settings) || !isObj(settings.hooks)) return null;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const h = isObj(g) && Array.isArray(g.hooks) ? g.hooks.find(isOurs) : undefined;
      if (h) return { port: Number(new URL(h.url).port || 80), token: String(tokenOf(h.headers)) };
    }
  }
  return null;
}

function installedEverywhere(settings: unknown): boolean {
  if (!isObj(settings) || !isObj(settings.hooks)) return false;
  return HOOK_EVENTS.every((e) => Array.isArray(settings.hooks[e]) && settings.hooks[e].some((g: any) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs)));
}

/** Serialize in the file's own style: indentation, line endings and trailing newline. */
function serialize(obj: unknown, like?: string): string {
  const indent = like ? (/^([ \t]+)"/m.exec(like)?.[1] ?? "  ") : "  ";
  const eol = like?.includes("\r\n") ? "\r\n" : "\n";
  const trailing = like === undefined || /\r?\n$/.test(like);
  return JSON.stringify(obj, null, indent).replace(/\n/g, eol) + (trailing ? eol : "");
}

async function atomicWrite(path: string, text: string) {
  const tmp = `${path}.terrarium-tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

// ── the watcher ─────────────────────────────────────────────────────────────

export class Volunteers {
  private watches = new Map<string, Watch>();
  private timer: NodeJS.Timeout | null = null;
  private fsWatcher: FSWatcher | null = null;
  private hint: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private server: Server | null = null;
  private port = 47823;
  private token = "<token>";
  readonly projectsDir: string;
  readonly settingsPath: string;
  private now: () => number;

  constructor(private deps: VolunteerDeps) {
    this.projectsDir = deps.projectsDir ?? defaultProjectsDir();
    this.settingsPath = deps.settingsPath ?? join(homedir(), ".claude", "settings.json");
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.tick();
    // Volunteers left un-ended by a crash or a quit while their session was alive: end them now.
    for (const p of this.deps.store.plants.values()) {
      if (p.origin === "volunteer" && !p.ended && p.sessionId && !this.watches.has(p.sessionId)) {
        this.deps.store.updatePlant(p.id, { ended: true, live: false, status: "idle", activity: undefined, activityDetail: undefined, ask: undefined });
      }
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    try {
      // On Windows fs.watch misses events: it is only a hint to look sooner; the poll is the source of truth.
      this.fsWatcher = watch(this.projectsDir, { recursive: true }, () => {
        this.hint ??= setTimeout(() => {
          this.hint = null;
          void this.tick();
        }, 150);
      });
      this.fsWatcher.on("error", () => this.fsWatcher?.close());
    } catch {
      // no projects dir yet; the poll still finds it once it exists
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.hint) clearTimeout(this.hint);
    this.timer = this.hint = null;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.server?.close();
    this.server = null;
  }

  adoptable(plantId: string): boolean {
    const p = this.deps.store.plants.get(plantId);
    return p?.origin === "volunteer" && p.ended === true;
  }

  /** One poll: find transcripts modified recently, read what's new, end sessions that went quiet. */
  tick(): Promise<void> {
    this.ticking ??= this.doTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async doTick() {
    const now = this.now();
    // ponytail: stats every transcript every 2 s; fine for thousands of files, narrow with the fs.watch hint if it ever isn't.
    const files = await sessionFiles(this.projectsDir);
    const paths = new Map(files.map((f) => [f.path, f.sessionId]));
    for (const w of this.watches.values()) if (w.path && !paths.has(w.path)) paths.set(w.path, w.sessionId);
    await Promise.all(
      [...paths].map(async ([path, sessionId]) => {
        const known = this.watches.get(sessionId);
        if (known?.ignored) return;
        let st;
        try {
          st = await stat(path);
        } catch {
          return;
        }
        if (!known && now - st.mtimeMs > RECENT_MS) return;
        const w = known ?? this.watch(sessionId);
        w.path ??= path;
        w.seen = Math.max(w.seen, st.mtimeMs);
        if (st.size !== w.size) {
          w.size = st.size;
          await this.read(w);
        }
      }),
    );
    for (const w of this.watches.values()) if (!w.ignored && !w.ended && now - w.seen > END_MS) this.end(w);
  }

  private watch(sessionId: string): Watch {
    const w: Watch = { sessionId, size: -1, seen: this.now(), hook: false, ended: false, ignored: false, reading: Promise.resolve() };
    this.watches.set(sessionId, w);
    return w;
  }

  /** Non-volunteer plant that owns this session, if any. */
  private owner(sessionId: string): Plant | undefined {
    for (const p of this.deps.store.plants.values()) if (p.sessionId === sessionId && p.origin !== "volunteer") return p;
    return undefined;
  }

  private ignore(w: Watch) {
    w.ignored = true;
    const id = `vol-${w.sessionId}`;
    if (this.deps.store.plants.has(id)) this.deps.store.deletePlant(id);
  }

  private plantOf(w: Watch): Plant | undefined {
    return this.owner(w.sessionId) ?? this.deps.store.plants.get(`vol-${w.sessionId}`);
  }

  /** The plant for this session, created as a volunteer when needed. Undefined when it isn't (or can't yet be) a volunteer. */
  private ensurePlant(w: Watch, cwd: string | undefined): Plant | undefined {
    const { store } = this.deps;
    const owner = this.owner(w.sessionId);
    if (owner?.origin === "sown") {
      this.ignore(w);
      return undefined;
    }
    if (owner) return owner;
    const id = `vol-${w.sessionId}`;
    const existing = store.plants.get(id);
    if (existing) return existing;
    if (!cwd || !plantable(cwd)) return undefined;
    const bed = this.deps.addBed(cwd);
    if (!bed) return undefined;
    const s = w.tail?.parser.summary;
    const now = this.now();
    const plant: Plant = {
      id,
      bedId: bed.id,
      name: s?.title || (s?.seed ? nameFromPrompt(s.seed) : "Volunteer"),
      species: nextSpecies([...store.plants.values()].filter((p) => p.bedId === bed.id).map((p) => p.species)),
      seed: s?.seed ?? "",
      origin: "volunteer",
      sessionId: w.sessionId,
      model: s?.model,
      permissionMode: s?.permissionMode ?? "default",
      status: "idle",
      live: true,
      turns: s?.turns ?? 0,
      toolCalls: s?.toolCalls ?? 0,
      costUsd: s?.costUsd ?? 0,
      runners: 0,
      unread: false,
      plot: "bed",
      cwd,
      ended: false,
      watchedBy: w.hook ? "hook" : "transcript",
      createdAt: s?.createdAt || now,
      updatedAt: now,
    };
    store.putPlant(plant);
    return plant;
  }

  /** Apply only the fields that actually changed. */
  private patch(p: Plant, patch: Partial<Plant>): Plant {
    const diff: Partial<Plant> = {};
    for (const [k, v] of Object.entries(patch) as [keyof Plant, unknown][]) {
      const cur = p[k];
      if (cur === v || (typeof v === "object" && v !== null && JSON.stringify(cur) === JSON.stringify(v))) continue;
      (diff as Record<string, unknown>)[k] = v;
    }
    return Object.keys(diff).length ? (this.deps.store.updatePlant(p.id, diff) ?? p) : p;
  }

  private read(w: Watch): Promise<void> {
    w.reading = w.reading.then(() => this.doRead(w)).catch((err) => console.error("[terrarium] volunteer read failed", err));
    return w.reading;
  }

  private async doRead(w: Watch) {
    if (!w.path || w.ignored) return;
    w.tail ??= new TranscriptTail(w.path, w.sessionId, { maxEntries: KEEP_ENTRIES });
    let lines: number;
    try {
      ({ lines } = await w.tail.read());
    } catch {
      return; // gone or locked; the next tick retries
    }
    const parser = w.tail.parser;
    const s = parser.summary;
    if (s.entrypoint?.startsWith("sdk")) return this.ignore(w);
    if (!lines) return;
    w.seen = Math.max(w.seen, this.now());
    const plant = this.ensurePlant(w, s.cwd);
    if (!plant) return;
    for (const e of parser.takeEntries()) this.deps.store.upsertEntry({ ...e, plantId: plant.id });
    const vol = plant.origin === "volunteer";
    w.ended = false;
    const patch: Partial<Plant> = {
      seed: plant.seed || s.seed,
      model: s.model ?? plant.model,
      permissionMode: s.permissionMode,
      turns: s.turns,
      toolCalls: s.toolCalls,
      lastText: s.lastText ?? plant.lastText,
      live: true,
      watchedBy: w.hook ? "hook" : "transcript",
      ...(vol ? { ended: false, name: s.title || (s.seed ? nameFromPrompt(s.seed) : plant.name) } : {}),
      ...(s.modelCosts ? { costUsd: s.costUsd } : {}),
    };
    // With the hook, its events own the live state; the transcript only fills in the journal and counters.
    if (!w.hook) {
      const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
      if (s.phase === "working") Object.assign(patch, { status: "working", activity: s.lastActivity?.activity ?? "other", activityDetail: BUSY_DETAIL });
      else if (s.phase === "thinking") Object.assign(patch, { status: "thinking", activity: "think", activityDetail: undefined });
      else Object.assign(patch, { status: "idle", activity: undefined, activityDetail: undefined, ...(busy ? { unread: true } : {}) });
    }
    this.patch(plant, patch);
  }

  private end(w: Watch) {
    w.ended = true;
    const p = this.plantOf(w);
    if (!p || p.origin === "sown") return;
    this.patch(p, {
      live: false,
      status: "idle",
      activity: undefined,
      activityDetail: undefined,
      ask: undefined,
      ...(p.origin === "volunteer" ? { ended: true } : { watchedBy: undefined }),
    });
  }

  // ── Layer 2: hook events ──────────────────────────────────────────────────

  /** Map one hook event to plant state. Exposed for tests; the HTTP server calls it. */
  handleHook(h: HookPayload) {
    const sid = h.session_id;
    if (!sid) return;
    if (this.owner(sid)?.origin === "sown") return;
    const w = this.watches.get(sid) ?? this.watch(sid);
    if (w.ignored) return;
    w.hook = true;
    w.seen = this.now();
    if (!w.path && h.transcript_path) w.path = h.transcript_path;
    const plant = this.ensurePlant(w, h.cwd);
    if (!plant) return;
    const clear = { ask: undefined };
    const live = { live: true, watchedBy: "hook" as const, ...(plant.origin === "volunteer" ? { ended: false } : {}) };
    w.ended = false;
    const why = (ask: PendingAsk) => {
      if (plant.status === "waiting") return; // PermissionRequest and its Notification describe the same prompt
      const next = this.patch(plant, { ...live, status: "waiting", ask, activityDetail: ask.title });
      this.deps.notify(next, ask.title);
    };
    switch (h.hook_event_name) {
      case "SessionStart":
        this.patch(plant, { ...live, ...clear, status: "idle", ...(h.model ? { model: h.model } : {}) });
        break;
      case "UserPromptSubmit":
        this.patch(plant, { ...live, ...clear, status: "thinking", activity: "think", activityDetail: undefined, seed: plant.seed || (h.prompt ?? "") });
        break;
      case "PreToolUse": {
        const name = h.tool_name ?? "tool";
        this.patch(plant, { ...live, ...clear, status: "working", activity: activityForTool(name), activityDetail: summarizeToolInput(name, h.tool_input) });
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure":
        this.patch(plant, { ...live, ...clear, status: "thinking", activity: "think", activityDetail: undefined });
        break;
      case "PermissionRequest":
        why({ id: `hook-${this.now()}`, kind: "permission", toolName: h.tool_name ?? "", title: PERMISSION_TITLE, detail: h.tool_name ? summarizeToolInput(h.tool_name, h.tool_input) : "", canAlwaysAllow: false, createdAt: this.now() });
        break;
      case "Notification":
        if (h.notification_type === "permission_prompt") {
          why({ id: `hook-${this.now()}`, kind: "permission", toolName: "", title: PERMISSION_TITLE, detail: h.message ?? "", canAlwaysAllow: false, createdAt: this.now() });
        } else if (h.notification_type === "idle_prompt") {
          this.patch(plant, { ...live, ...clear, status: "idle", activity: undefined, activityDetail: undefined, unread: true });
        } else if (h.notification_type === "agent_needs_input") {
          why({ id: `hook-${this.now()}`, kind: "question", toolName: "", title: "Waiting for you in your terminal", detail: h.message ?? "", canAlwaysAllow: false, questions: [], createdAt: this.now() });
        }
        break;
      case "Stop":
        this.patch(plant, { ...live, ...clear, status: "idle", activity: undefined, activityDetail: undefined, unread: true });
        break;
      case "SessionEnd":
        this.end(w);
        return;
    }
    // Pull the journal along right away rather than on the next poll.
    if (w.path) void this.read(w);
  }

  /** Start the hook receiver on 127.0.0.1 only. False when the port can't be bound (the caller warns: something else would receive the events). */
  listen(port: number, token: string): Promise<boolean> {
    this.port = port;
    this.token = token;
    const want = Buffer.from(token);
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook") {
        res.writeHead(404).end();
        req.resume();
        return;
      }
      const got = Buffer.from(String(req.headers[TOKEN_HEADER.toLowerCase()] ?? req.headers[LEGACY_TOKEN_HEADER.toLowerCase()] ?? ""));
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        res.writeHead(403).end();
        req.resume();
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) parts.push(c);
      });
      req.on("end", () => {
        // Always an empty 2xx: a JSON body would be read by Claude Code as a decision.
        res.writeHead(204).end();
        if (size > MAX_BODY) return;
        try {
          this.handleHook(JSON.parse(Buffer.concat(parts).toString("utf8")) as HookPayload);
        } catch (err) {
          if (!(err instanceof SyntaxError)) console.error("[terrarium] hook event failed", err);
        }
      });
    });
    return new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        this.server?.close();
        this.server = server;
        resolve(true);
      });
    });
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  /** Port and token of the hook already in settings.json, so Terrarium can listen with them after a restart. */
  async installedHook(): Promise<{ port: number; token: string } | null> {
    try {
      return ourHook(JSON.parse(await readFile(this.settingsPath, "utf8")));
    } catch {
      return null;
    }
  }

  // ── Layer 2: settings.json ────────────────────────────────────────────────

  private result(installed: boolean, note?: string): HookStatus {
    return { installed, preview: JSON.stringify(hookFragment(this.port, this.token), null, 2), settingsPath: this.settingsPath, listening: this.listening, ...(note ? { note } : {}) };
  }

  /** Reads settings.json. `text` undefined = no file. Throws a plain message on invalid JSON. */
  private async load(): Promise<{ text?: string; obj: Record<string, any> }> {
    let text: string;
    try {
      text = await readFile(this.settingsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { obj: {} };
      throw new Error(`Could not read ${this.settingsPath}: ${(err as Error).message}`);
    }
    let obj: unknown;
    try {
      obj = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
      throw new Error(`${this.settingsPath} is not valid JSON, so Terrarium left it untouched. Fix it and try again.`);
    }
    if (!isObj(obj)) throw new Error(`${this.settingsPath} is not a JSON object, so Terrarium left it untouched.`);
    return { text, obj };
  }

  async status(): Promise<HookStatus> {
    try {
      const { obj } = await this.load();
      const ours = ourHook(obj);
      const note = ours && (ours.port !== this.port || (this.token !== "<token>" && ours.token !== this.token)) ? `The hook in settings.json points at port ${ours.port}; reinstall it to update.` : undefined;
      return this.result(installedEverywhere(obj), note);
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
  }

  async install(port: number, token: string): Promise<HookStatus> {
    this.port = port;
    this.token = token;
    let loaded;
    try {
      loaded = await this.load();
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
    const { text, obj } = loaded;
    if (obj.hooks !== undefined && !isObj(obj.hooks)) return this.result(false, `"hooks" in ${this.settingsPath} is not an object, so Terrarium left it untouched.`);
    for (const e of HOOK_EVENTS) if (isObj(obj.hooks) && obj.hooks[e] !== undefined && !Array.isArray(obj.hooks[e])) return this.result(false, `"hooks.${e}" in ${this.settingsPath} is not a list, so Terrarium left it untouched.`);
    strip(obj); // an older install (another port or token) is replaced, not duplicated
    obj.hooks ??= {};
    for (const e of HOOK_EVENTS) (obj.hooks[e] ??= []).push(ourGroup(e, port, token));
    const next = serialize(obj, text);
    if (next === text) return this.result(true);
    const backup = `${this.settingsPath}.terrarium-backup`;
    if (text !== undefined && !existsSync(backup) && !existsSync(`${this.settingsPath}.gardener-backup`)) await writeFile(backup, text, "utf8");
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await atomicWrite(this.settingsPath, next);
    return this.result(true);
  }

  async uninstall(): Promise<HookStatus> {
    let loaded;
    try {
      loaded = await this.load();
    } catch (err) {
      return this.result(false, (err as Error).message);
    }
    const { text, obj } = loaded;
    if (text === undefined || !strip(obj)) return this.result(false);
    const backup = [`${this.settingsPath}.terrarium-backup`, `${this.settingsPath}.gardener-backup`].find((f) => existsSync(f)) ?? "";
    let backupText: string | undefined;
    try {
      backupText = await readFile(backup, "utf8");
    } catch {
      // none: Terrarium created the file, or the backup was removed
    }
    let same = false;
    try {
      same = backupText !== undefined && JSON.stringify(JSON.parse(backupText.replace(/^﻿/, ""))) === JSON.stringify(obj);
    } catch {
      // unreadable backup: fall back to re-serializing
    }
    if (same) await atomicWrite(this.settingsPath, backupText!); // byte-equal to before the install
    else if (backupText === undefined && Object.keys(obj).length === 0) await unlink(this.settingsPath); // we created it
    else await atomicWrite(this.settingsPath, serialize(obj, text));
    return this.result(false);
  }
}
