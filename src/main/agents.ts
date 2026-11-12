// The greenhouse: runs one Claude Code session per plant through the Agent SDK and turns
// its message stream into plant state (status, activity, asks), journal entries and growth rings.
//
// V2 (docs/v2/PLAN.md): memory-based admission (M2e), pots = per-plant git worktrees (M3),
// a ring per turn with before/after git checkpoints, prune back and fork (M4).
//
// Auth is whatever Claude Code itself uses on this machine: run `claude` once and log in with
// your Claude subscription, and every plant here uses that login. Nothing is stored by Gardener.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  forkSession,
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { activityForTool, nameFromPrompt, nextSpecies, oneLine, potBranch, summarizeToolInput } from "../shared/garden";
import type {
  Activity,
  AskQuestion,
  AskResponse,
  DiffFile,
  DiffScope,
  Entry,
  PendingAsk,
  PermissionMode,
  Plant,
  PruneResult,
  Ring,
  SowRequest,
  Weather,
} from "../shared/types";
import * as git from "./git";
import type { GardenStore } from "./store";

/** A minimal async queue: the SDK reads user turns from it for as long as the session lives. */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.queue.push(value);
  }

  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface WaitingAsk {
  ask: PendingAsk;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

interface OpenRing {
  n: number;
  costAtStart: number;
}

interface Growing {
  query: Query;
  input: Pushable<SDKUserMessage>;
  asks: WaitingAsk[];
  openTools: Map<string, Activity>;
  /** Cost carried from an earlier session; 0 when resuming (the SDK restores the session's own total). */
  costBase: number;
  startedBypass: boolean;
  interrupted: boolean;
  closing: boolean;
  /** Last top-level assistant message uuid: where "prune back" resumes the conversation. */
  lastAssistantUuid?: string;
  lastActive: number;
  ring?: OpenRing;
  /** Resolves when the SDK message pump ends. */
  done: Promise<void>;
}

const GARDEN_APPEND = `You are running inside Gardener, a desktop app where the user tends several coding agents at once, drawn as plants in a garden. The user is not watching your output continuously: when you finish a turn, end with a short, plain summary of what changed and anything they must decide, so they can review it at a glance.`;

const potNote = (pot: string, branch: string | undefined, bedRoot: string) =>
  `\n\nYou are working in your own git worktree at ${pot}${branch ? ` on branch ${branch}` : ""}. Only read and change files under that folder. The user's main checkout at ${bedRoot} belongs to them and to other agents: never edit it or run commands there. Earlier messages may mention other paths; ignore them for edits.`;

export interface PoolLike {
  canAdmit(): number;
  register(plantId: string, pid: number | undefined): void;
  unregister(plantId: string): void;
}

export interface AgentHooks {
  /** A turn ended (success or not), with its ring once checkpoints are captured. */
  onTurnEnd(plant: Plant, ring?: Ring): void;
  /** The plant needs the gardener (permission, question, plan, error). */
  onNeedsYou(plant: Plant, why: string): void;
  onWeather?(weather: Weather): void;
  /** Live process count changed (start, exit, queue). */
  onPoolChange?(): void;
  env(): Record<string, string | undefined>;
  /** Where pots (worktrees) are created. Without it, every plant grows in its bed. */
  plotsRoot?: string;
  pool?: PoolLike;
  idleMinutes?(): number;
  /** The packaged app must point the SDK at claude.exe outside the asar archive. */
  claudeExecutable?: string;
  /** Swap in fakes for tests; default to the Agent SDK. */
  query?: typeof query;
  forkSession?: typeof forkSession;
}

const userTurn = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

/** "Show anyway" cap for one file's diff (the default is 1 MB). */
export const FULL_DIFF_BYTES = 50 * 1024 * 1024;

const refBase = (plantId: string) => `refs/gardener/${plantId}/`;

export class Greenhouse {
  private growing = new Map<string, Growing>();
  private waiting: { plantId: string; text: string }[] = [];
  private chains = new Map<string, Promise<unknown>>();
  private cwdLocks = new Map<string, Promise<unknown>>();
  private nowSnap = new Map<string, { commit: string; at: number }>();

  constructor(
    private store: GardenStore,
    private hooks: AgentHooks,
  ) {}

  liveCount() {
    return this.growing.size;
  }

  queuedCount() {
    return this.waiting.length;
  }

  isLive(plantId: string) {
    return this.growing.has(plantId);
  }

  /** Run `fn` after everything already queued for this plant (turn starts, ring captures, prunes). */
  private chain<T>(plantId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(plantId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      plantId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Serialize git work per working tree (capture, diff, restore). */
  private withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const key = normalize(cwd).toLowerCase();
    const prev = this.cwdLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.cwdLocks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private cwdOf(plant: Plant): string {
    return plant.cwd ?? this.store.beds.get(plant.bedId)?.path ?? "";
  }

  // ── sowing ────────────────────────────────────────────────────────────────

  sow(req: SowRequest, opts: { sessionId?: string; base?: string; name?: string } = {}): Plant {
    const bed = this.store.beds.get(req.bedId);
    if (!bed) throw new Error("That bed no longer exists");
    const siblings = [...this.store.plants.values()].filter((p) => p.bedId === bed.id);
    const now = Date.now();
    const pot = (req.plot ?? "bed") === "pot" && !!this.hooks.plotsRoot;
    const plant: Plant = {
      id: randomUUID(),
      bedId: bed.id,
      name: opts.name ?? (req.name?.trim() || nameFromPrompt(req.prompt)),
      species: req.species ?? nextSpecies(siblings.map((p) => p.species)),
      seed: req.prompt,
      origin: "sown",
      plot: pot ? "pot" : "bed",
      cwd: pot ? undefined : bed.path,
      sessionId: opts.sessionId,
      model: req.model || undefined,
      permissionMode: req.permissionMode,
      status: pot ? "thinking" : "idle",
      activityDetail: pot ? "Preparing the pot · git worktree add" : undefined,
      ...(pot ? { potPending: true } : {}),
      live: false,
      turns: 0,
      toolCalls: 0,
      costUsd: 0,
      runners: 0,
      unread: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putPlant(plant);
    if (pot) {
      void this.chain(plant.id, async () => {
        try {
          await this.preparePot(plant.id, opts.base ?? req.baseRef, req.fromOrigin);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.entry(plant.id, { kind: "error", text: `Could not prepare the pot (git worktree): ${msg}` });
          const next = this.store.updatePlant(plant.id, { status: "error", error: `Could not prepare the pot: ${oneLine(msg, 200)}`, activityDetail: undefined });
          if (next) this.hooks.onNeedsYou(next, "could not prepare its pot");
          throw err;
        }
      }).then(
        () => {
          if (req.prompt.trim()) void this.send(plant.id, req.prompt);
          else this.store.updatePlant(plant.id, { status: "idle", activityDetail: undefined });
        },
        () => undefined,
      );
    } else if (req.prompt.trim()) {
      void this.send(plant.id, req.prompt);
    }
    return plant;
  }

  /** Create the plant's worktree (deterministic path under plotsRoot) and run the bed's pot setup. */
  private async preparePot(plantId: string, base?: string, fromOrigin?: boolean) {
    const plant = this.store.plants.get(plantId);
    const bed = plant && this.store.beds.get(plant.bedId);
    if (!plant || !bed || !this.hooks.plotsRoot) throw new Error("That plant or bed is gone");
    const common = await git.commonDir(bed.path);
    if (!common) throw new Error(`${bed.path} is not a git repository`);
    const branch = potBranch(plant.name, randomBytes(2).toString("hex"));
    const path = git.potPath(this.hooks.plotsRoot, basename(bed.path), common, branch);
    const made = await git.createWorktree({ repo: bed.path, path, branch, base, fromOrigin });
    this.store.updatePlant(plantId, { worktreePath: made.path, cwd: made.path, branch: made.branch, baseRef: made.baseSha, activityDetail: "Preparing the pot · setup" });
    this.entry(plantId, { kind: "system", text: `Potted in its own worktree: ${made.path} on branch ${made.branch} (from ${made.baseSha.slice(0, 8)})` });
    await this.potSetup(plantId, bed.path, made.path);
    this.store.updatePlant(plantId, { potPending: undefined });
  }

  /** Finish a pot whose preparation was interrupted (app closed during worktree add or setup). */
  private async finishPot(plantId: string) {
    const plant = this.store.plants.get(plantId);
    const bed = plant && this.store.beds.get(plant.bedId);
    if (!plant || !bed) return;
    if (!plant.worktreePath || !existsSync(plant.worktreePath)) {
      if (plant.worktreePath && plant.branch) {
        await git.ensureWorktree({ repo: bed.path, path: plant.worktreePath, branch: plant.branch, base: plant.baseRef });
      } else {
        this.entry(plantId, { kind: "system", text: "Finishing the pot that was interrupted: creating its worktree." });
        await this.preparePot(plantId, plant.baseRef);
        return;
      }
    }
    this.entry(plantId, { kind: "system", text: "Finishing the pot that was interrupted: running its setup again." });
    await this.potSetup(plantId, bed.path, plant.worktreePath!);
    this.store.updatePlant(plantId, { potPending: undefined });
  }

  /** Optional per-repo `gardener.json`: { "pot": { "copy": [".env"], "setup": "npm ci", "async": false } }. */
  private async potSetup(plantId: string, bedRoot: string, pot: string) {
    let cfg: { pot?: { copy?: string[]; setup?: string; async?: boolean } } = {};
    try {
      cfg = JSON.parse(await readFile(join(bedRoot, "gardener.json"), "utf8"));
    } catch {
      return;
    }
    for (const rel of cfg.pot?.copy ?? []) {
      if (isAbsolute(rel) || normalize(rel).startsWith("..")) continue;
      const from = join(bedRoot, rel);
      if (!existsSync(from)) continue;
      await mkdir(dirname(join(pot, rel)), { recursive: true });
      await copyFile(from, join(pot, rel)).catch(() => undefined);
    }
    const cmd = cfg.pot?.setup?.trim();
    if (!cmd) return;
    const run = new Promise<void>((resolve) => {
      const started = Date.now();
      const child = spawn(cmd, { cwd: pot, shell: true, windowsHide: true, env: { ...this.hooks.env(), CI: "1" } });
      let tail = "";
      const keep = (d: Buffer) => {
        tail = (tail + d.toString("utf8")).slice(-16_000);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      const timer = setTimeout(() => child.kill(), 10 * 60_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        const secs = Math.round((Date.now() - started) / 1000);
        this.entry(plantId, {
          kind: code === 0 ? "system" : "error",
          text: code === 0 ? `Prepared the pot: \`${cmd}\` finished in ${secs}s` : `Pot setup \`${cmd}\` failed (exit ${code}):\n${tail.slice(-2000)}`,
        });
        resolve();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.entry(plantId, { kind: "error", text: `Pot setup \`${cmd}\` could not start: ${err.message}` });
        resolve();
      });
    });
    if (!cfg.pot?.async) await run;
  }

  // ── turns ─────────────────────────────────────────────────────────────────

  async send(plantId: string, text: string): Promise<void> {
    const plant = this.store.plants.get(plantId);
    if (!plant) throw new Error("That plant is gone");
    if (plant.origin === "volunteer") throw new Error("This session is running in a terminal. Reply there, or adopt it here once it has ended.");
    if (plant.watchedBy && plant.live && !this.growing.has(plantId)) throw new Error("This session is running in a terminal right now. Reply there; Gardener can continue it once it ends.");
    const body = text.trim();
    if (!body) return;
    this.entry(plantId, { kind: "user", text: body });

    const g = this.growing.get(plantId);
    if (g && g.asks.length > 0) {
      // Replying in chat while something is pending means "no, do this instead".
      for (const w of g.asks.splice(0)) w.resolve({ behavior: "deny", message: `The user replied instead of answering: ${body}` });
      this.store.updatePlant(plantId, { ask: undefined, status: "thinking", activity: "think", activityDetail: undefined });
      return;
    }

    this.store.updatePlant(plantId, { status: "thinking", activity: "think", activityDetail: undefined, error: undefined, unread: false });
    return this.chain(plantId, () => this.beginTurn(plantId, body));
  }

  private async beginTurn(plantId: string, body: string) {
    const plant = this.store.plants.get(plantId);
    if (!plant) return;
    let g = this.growing.get(plantId);
    if (!g) {
      if (this.hooks.pool && this.hooks.pool.canAdmit() <= 0) {
        this.waiting.push({ plantId, text: body });
        this.store.updatePlant(plantId, { queued: true, status: "idle", activity: undefined, activityDetail: "Waiting for a free pot · memory is full" });
        this.hooks.onPoolChange?.();
        return;
      }
      if (plant.plot === "pot" && plant.potPending) {
        this.store.updatePlant(plantId, { activityDetail: "Finishing the pot · setup was interrupted" });
        await this.finishPot(plantId);
      } else if (plant.plot === "pot" && plant.worktreePath && !existsSync(plant.worktreePath)) {
        const bed = this.store.beds.get(plant.bedId);
        if (bed && plant.branch) await git.ensureWorktree({ repo: bed.path, path: plant.worktreePath, branch: plant.branch, base: plant.baseRef });
      }
      g = this.start(this.store.plants.get(plantId)!);
    }
    if (!g.ring) await this.openRing(plantId, g, body);
    g.lastActive = Date.now();
    g.input.push(userTurn(body));
  }

  /** Admit queued plants while memory allows. Call after a process exits or memory frees up. */
  drain() {
    while (this.waiting.length && (!this.hooks.pool || this.hooks.pool.canAdmit() > 0)) {
      const next = this.waiting.shift()!;
      if (!this.store.plants.has(next.plantId)) continue;
      this.store.updatePlant(next.plantId, { queued: false, status: "thinking", activity: "think", activityDetail: undefined });
      void this.chain(next.plantId, () => this.beginTurn(next.plantId, next.text));
    }
    this.hooks.onPoolChange?.();
  }

  private start(plant: Plant): Growing {
    const bed = this.store.beds.get(plant.bedId);
    if (!bed) throw new Error("That bed no longer exists");
    const input = new Pushable<SDKUserMessage>();
    const bypass = plant.permissionMode === "bypassPermissions";
    const canUseTool: CanUseTool = (toolName, toolInput, opts) => this.ask(plant.id, toolName, toolInput, opts);
    const run = this.hooks.query ?? query;
    const cwd = this.cwdOf(plant);
    const pot = plant.plot === "pot" && plant.worktreePath ? plant.worktreePath : undefined;
    const options: Options = {
      cwd,
      ...(plant.sessionId ? { resume: plant.sessionId } : {}),
      ...(plant.sessionId && plant.resumeAt ? { resumeSessionAt: plant.resumeAt } : {}),
      permissionMode: plant.permissionMode,
      ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(plant.model ? { model: plant.model } : {}),
      canUseTool,
      ...(this.hooks.claudeExecutable ? { pathToClaudeCodeExecutable: this.hooks.claudeExecutable } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: GARDEN_APPEND + (pot ? potNote(pot, plant.branch, bed.path) : "") },
      env: this.hooks.env(),
      stderr: (data) => {
        if (process.env.GARDENER_DEBUG) console.error(`[claude ${plant.name}]`, data);
      },
      ...(pot
        ? {
            projectConfigRoot: bed.path,
            settings: { permissions: { blockWritesOutsideWorkingDirectories: true } },
            hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [mainCheckoutGuard(bed.path, pot)] }] },
          }
        : {}),
      ...(this.hooks.pool ? { spawnClaudeCodeProcess: (o: SpawnOptions) => this.spawnTracked(plant.id, plant.name, o) } : {}),
    };
    const q = run({ prompt: input, options });
    let finish!: () => void;
    const g: Growing = {
      query: q,
      input,
      asks: [],
      openTools: new Map(),
      costBase: plant.sessionId ? 0 : plant.costUsd,
      startedBypass: bypass,
      interrupted: false,
      closing: false,
      lastActive: Date.now(),
      done: new Promise<void>((r) => (finish = r)),
    };
    this.growing.set(plant.id, g);
    this.store.updatePlant(plant.id, { live: true, queued: false });
    this.hooks.onPoolChange?.();
    void this.pump(plant.id, g).finally(() => finish());
    return g;
  }

  /** Our own spawn of the Claude Code process, so the pool knows its pid and can measure its memory. */
  private spawnTracked(plantId: string, name: string, o: SpawnOptions): SpawnedProcess {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.hooks.pool?.register(plantId, child.pid);
    child.stderr?.on("data", (d: Buffer) => {
      if (process.env.GARDENER_DEBUG) console.error(`[claude ${name}]`, d.toString("utf8"));
    });
    child.on("exit", () => this.hooks.pool?.unregister(plantId));
    return child as unknown as SpawnedProcess;
  }

  private async pump(plantId: string, g: Growing) {
    let failure: string | undefined;
    try {
      for await (const msg of g.query) this.handle(plantId, g, msg);
    } catch (err) {
      if (!g.closing) failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.growing.get(plantId) === g) this.growing.delete(plantId);
      for (const w of g.asks.splice(0)) w.resolve({ behavior: "deny", message: "Session closed" });
      const plant = this.store.plants.get(plantId);
      if (plant) {
        const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
        const patch: Partial<Plant> = { live: false, runners: 0, ask: undefined };
        if (failure) {
          patch.status = "error";
          patch.error = failure;
          this.entry(plantId, { kind: "error", text: failure });
        } else if (busy) {
          patch.status = g.closing ? "idle" : "error";
          if (!g.closing) patch.error = "Claude Code stopped unexpectedly.";
        }
        const next = this.store.updatePlant(plantId, patch);
        if (g.ring) {
          const open = g.ring;
          g.ring = undefined;
          void this.chain(plantId, () => this.closeRing(plantId, open, false));
        }
        if (next && patch.status === "error") this.hooks.onNeedsYou(next, next.error ?? "wilted");
      }
      this.store.flush();
      this.drain();
    }
  }

  private handle(plantId: string, g: Growing, msg: SDKMessage) {
    const plant = this.store.plants.get(plantId);
    if (!plant) return;
    g.lastActive = Date.now();
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          const mode = isMode(msg.permissionMode) ? msg.permissionMode : plant.permissionMode;
          this.store.updatePlant(plantId, { sessionId: msg.session_id, model: msg.model, permissionMode: mode, resumeAt: undefined });
          if (!plant.sessionId) {
            this.entry(plantId, { kind: "system", text: `Rooted in ${msg.cwd} · ${msg.model} · Claude Code ${msg.claude_code_version}` });
          }
        } else if (msg.subtype === "status") {
          const patch: Partial<Plant> = {};
          if (msg.status === "compacting") patch.activityDetail = "Composting old context";
          if (msg.permissionMode && isMode(msg.permissionMode)) patch.permissionMode = msg.permissionMode;
          if (Object.keys(patch).length) this.store.updatePlant(plantId, patch);
        } else if (msg.subtype === "api_retry") {
          this.store.updatePlant(plantId, { activityDetail: `Waiting out the weather (retry ${msg.attempt}/${msg.max_retries}: ${msg.error})` });
        }
        return;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        const status: Weather["status"] = info.status === "rejected" ? "rain" : info.status === "allowed_warning" || (info.utilization ?? 0) >= 0.75 ? "clouds" : "clear";
        this.hooks.onWeather?.({ status, utilization: info.utilization, resetsAt: info.resetsAt, limitType: info.rateLimitType, at: Date.now() });
        return;
      }
      case "auth_status": {
        if (msg.error) this.entry(plantId, { kind: "error", text: `Login problem: ${msg.error}` });
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) {
          // A runner (subagent) is working; show what it touches without flooding the journal.
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              this.store.updatePlant(plantId, { activityDetail: this.tidy(plantId, `runner: ${block.name} ${summarizeToolInput(block.name, block.input)}`).slice(0, 160) });
            }
          }
          return;
        }
        if (!g.ring) {
          // A queued follow-up started a new turn after the last ring closed: it begins where that ring ended.
          const prev = this.lastRing(plantId);
          g.ring = { n: prev + 1, costAtStart: plant.costUsd };
          const after = prev ? this.store.ringMeta(plantId, prev).ckptAfter : undefined;
          this.store.putRing({ plantId, n: prev + 1, prompt: "(follow-up)", startedAt: Date.now(), checkpoint: after ? "ready" : "none" }, { ckptBefore: after });
        }
        g.lastAssistantUuid = msg.uuid;
        if (msg.error) this.entry(plantId, { kind: "error", text: assistantErrorText(msg.error) });
        msg.message.content.forEach((block, i) => {
          const id = `${msg.uuid}:${i}`;
          if (block.type === "text" && block.text.trim()) {
            this.entry(plantId, { id, kind: "text", text: block.text });
            this.store.updatePlant(plantId, { lastText: block.text });
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            this.entry(plantId, { id, kind: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            const activity = activityForTool(block.name);
            const summary = this.tidy(plantId, summarizeToolInput(block.name, block.input));
            g.openTools.set(block.id, activity);
            this.entry(plantId, { id: `tool:${block.id}`, kind: "tool", text: block.name, tool: { id: block.id, name: block.name, summary, activity, status: "running" } });
            const current = this.store.plants.get(plantId)!;
            const patch: Partial<Plant> = {
              status: current.status === "waiting" ? "waiting" : "working",
              activity,
              activityDetail: summary,
              toolCalls: current.toolCalls + 1,
            };
            if (activity === "delegate" && (block.name === "Task" || block.name === "Agent")) patch.runners = current.runners + 1;
            if (block.name === "TodoWrite") patch.todos = todoProgress(block.input);
            this.store.updatePlant(plantId, patch);
          }
        });
        return;
      }
      case "user": {
        if ("isReplay" in msg && msg.isReplay) return;
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const existing = this.store.findEntry(plantId, `tool:${block.tool_use_id}`);
          if (existing?.tool) {
            this.store.upsertEntry({ ...existing, tool: { ...existing.tool, status: block.is_error ? "error" : "ok", output: toolOutputText(block.content) } });
          }
          const activity = g.openTools.get(block.tool_use_id);
          g.openTools.delete(block.tool_use_id);
          const current = this.store.plants.get(plantId)!;
          const patch: Partial<Plant> = {};
          if (activity === "delegate" && current.runners > 0 && existing?.tool && existing.tool.name !== "SendMessage") patch.runners = current.runners - 1;
          if (g.openTools.size === 0 && current.status !== "waiting") {
            patch.status = "thinking";
            patch.activity = "think";
            patch.activityDetail = undefined;
          }
          if (Object.keys(patch).length) this.store.updatePlant(plantId, patch);
        }
        return;
      }
      case "result": {
        g.openTools.clear();
        const current = this.store.plants.get(plantId)!;
        const ok = msg.subtype === "success" && !msg.is_error;
        // total_cost_usd is the session's running total (restored on resume), so it replaces, never adds.
        const costUsd = Math.max(current.costUsd, g.costBase + (msg.total_cost_usd ?? 0));
        const base: Partial<Plant> = { turns: current.turns + 1, costUsd, runners: 0, activity: undefined, activityDetail: undefined, ask: undefined };
        const secs = Math.round(msg.duration_ms / 1000);
        const ring = g.ring;
        g.ring = undefined;
        const interrupted = g.interrupted;
        if (interrupted) {
          g.interrupted = false;
          this.store.updatePlant(plantId, { ...base, status: "idle", turns: current.turns });
          this.entry(plantId, { kind: "system", text: "Paused by you." });
        } else if (ok) {
          const text = msg.subtype === "success" ? msg.result : "";
          this.store.updatePlant(plantId, { ...base, status: "idle", unread: true, error: undefined, lastText: text || current.lastText });
          this.entry(plantId, { kind: "result", text: `Bloomed after ${msg.num_turns} step${msg.num_turns === 1 ? "" : "s"} · ${secs}s · $${costUsd.toFixed(2)} so far` });
        } else {
          const why = msg.subtype === "success" ? msg.result || "The turn ended with an error." : msg.errors?.join("\n") || humanizeSubtype(msg.subtype);
          const next = this.store.updatePlant(plantId, { ...base, status: "error", error: why });
          this.entry(plantId, { kind: "error", text: why });
          if (next) this.hooks.onNeedsYou(next, "wilted");
        }
        this.store.flush();
        if (ring) void this.chain(plantId, () => this.closeRing(plantId, ring, ok && !interrupted, g.lastAssistantUuid));
        else {
          const p = this.store.plants.get(plantId);
          if (p) this.hooks.onTurnEnd(p);
        }
        return;
      }
      default:
        return;
    }
  }

  // ── rings (M4) ────────────────────────────────────────────────────────────

  private lastRing(plantId: string): number {
    return this.store.rings(plantId).reduce((m, r) => Math.max(m, r.n), 0);
  }

  private async capture(plant: Plant, n: number, which: "before" | "after" | "now") {
    const cwd = this.cwdOf(plant);
    if (!cwd || !existsSync(cwd)) return { skipped: "the folder is missing" } as const;
    try {
      return await this.withCwd(cwd, () => git.snapshot(cwd, which === "now" ? `${refBase(plant.id)}now` : `${refBase(plant.id)}${n}/${which}`, `gardener: ${plant.name} ring ${n} ${which}`));
    } catch (err) {
      return { skipped: err instanceof Error ? err.message : String(err) } as const;
    }
  }

  private async openRing(plantId: string, g: Growing, prompt: string) {
    const plant = this.store.plants.get(plantId)!;
    const n = this.lastRing(plantId) + 1;
    g.ring = { n, costAtStart: plant.costUsd };
    const snap = await this.capture(plant, n, "before");
    const ring: Ring = {
      plantId,
      n,
      prompt: oneLine(prompt, 300),
      startedAt: Date.now(),
      checkpoint: "commit" in snap ? "ready" : "skipped",
      ...("skipped" in snap ? { checkpointNote: snap.skipped } : {}),
    };
    this.store.putRing(ring, { ckptBefore: "commit" in snap ? snap.commit : undefined });
  }

  private async closeRing(plantId: string, open: OpenRing, ok: boolean, assistantUuid?: string) {
    const plant = this.store.plants.get(plantId);
    if (!plant) return;
    const meta = this.store.ringMeta(plantId, open.n);
    const prev = this.store.ring(plantId, open.n);
    const snap = await this.capture(plant, open.n, "after");
    const cwd = this.cwdOf(plant);
    let diff: Ring["diff"];
    if (meta.ckptBefore && "commit" in snap) {
      try {
        const files = await this.withCwd(cwd, () => git.diffFiles(cwd, meta.ckptBefore!, snap.commit));
        diff = { files: files.length, insertions: sum(files, "insertions"), deletions: sum(files, "deletions") };
      } catch {
        diff = undefined;
      }
    }
    const now = this.store.plants.get(plantId) ?? plant;
    const ring = this.store.updateRing(
      plantId,
      open.n,
      {
        endedAt: Date.now(),
        ok,
        costUsd: Math.max(0, now.costUsd - open.costAtStart),
        diff,
        checkpoint: diff ? "ready" : prev?.checkpoint === "ready" && !("commit" in snap) ? "skipped" : (prev?.checkpoint ?? "none"),
        ...("skipped" in snap && !prev?.checkpointNote ? { checkpointNote: snap.skipped } : {}),
      },
      { ckptAfter: "commit" in snap ? snap.commit : undefined, assistantUuid },
    );
    const patch: Partial<Plant> = { ring: open.n, lastDiff: diff && diff.files > 0 ? diff : now.lastDiff };
    if (now.plot === "pot" && cwd) {
      try {
        patch.potDirty = await git.dirtyCount(cwd);
        patch.unpushed = await git.unpushedCount(cwd);
      } catch {
        // git not ready; leave as is
      }
    }
    const updated = this.store.updatePlant(plantId, patch);
    if (updated) this.hooks.onTurnEnd(updated, ring);
  }

  private async scopeRefs(plant: Plant, scope: DiffScope): Promise<{ from: string; to: string }> {
    if (scope.kind === "turn") {
      const meta = this.store.ringMeta(plant.id, scope.n);
      const from = meta.ckptBefore ?? (scope.n > 1 ? this.store.ringMeta(plant.id, scope.n - 1).ckptAfter : undefined);
      if (!from || !meta.ckptAfter) throw new Error(`Ring ${scope.n} has no checkpoints to compare.`);
      return { from, to: meta.ckptAfter };
    }
    const cached = this.nowSnap.get(plant.id);
    let to = cached && Date.now() - cached.at < 5000 ? cached.commit : undefined;
    if (!to) {
      const snap = await this.capture(plant, 0, "now");
      if (!("commit" in snap)) throw new Error(`Could not read the working tree: ${snap.skipped}`);
      to = snap.commit;
      this.nowSnap.set(plant.id, { commit: to, at: Date.now() });
    }
    if (scope.kind === "uncommitted") return { from: "HEAD", to };
    const first = this.store.rings(plant.id)[0];
    const from = plant.plot === "pot" && plant.baseRef ? plant.baseRef : first ? this.store.ringMeta(plant.id, first.n).ckptBefore : undefined;
    if (!from) throw new Error("Nothing to compare yet: this plant has no starting checkpoint.");
    return { from, to };
  }

  async diffFiles(plantId: string, scope: DiffScope): Promise<DiffFile[]> {
    const plant = this.mustPlant(plantId);
    const { from, to } = await this.scopeRefs(plant, scope);
    const cwd = this.cwdOf(plant);
    return this.withCwd(cwd, () => git.diffFiles(cwd, from, to));
  }

  async diffFile(plantId: string, scope: DiffScope, path: string, opts: { full?: boolean } = {}): Promise<string> {
    const plant = this.mustPlant(plantId);
    const { from, to } = await this.scopeRefs(plant, scope);
    const cwd = this.cwdOf(plant);
    return this.withCwd(cwd, () => git.diffPatch(cwd, from, to, path, opts.full ? FULL_DIFF_BYTES : undefined));
  }

  /** Prune back to ring k (0 = before the first ring): files (when safe) and conversation. */
  pruneTo(plantId: string, k: number): Promise<PruneResult> {
    return this.chain(plantId, async () => {
      const plant = this.mustPlant(plantId);
      const rings = this.store.rings(plantId).filter((r) => !r.pruned);
      if (k > 0 && !rings.some((r) => r.n === k)) throw new Error(`There is no ring ${k} to prune back to.`);
      await this.closeAndWait(plantId);
      const first = rings[0];
      const target = k === 0 ? (first ? this.store.ringMeta(plantId, first.n).ckptBefore : undefined) : this.store.ringMeta(plantId, k).ckptAfter;
      const othersLive = plant.plot === "bed" && [...this.store.plants.values()].some((p) => p.bedId === plant.bedId && p.id !== plantId && (p.live || this.growing.has(p.id)));
      const cwd = this.cwdOf(plant);
      const notes: string[] = [];
      let filesRestored = false;
      if (!target) notes.push("That ring has no checkpoint, so files were left alone.");
      else if (othersLive) notes.push("Other plants are growing in this bed's shared working tree, so files were left alone; only the conversation was pruned.");
      else {
        await this.withCwd(cwd, () => git.restoreTo(cwd, target));
        filesRestored = true;
        notes.push(`Files restored to the ${k === 0 ? "start of the first ring" : `end of ring ${k}`} (ignored files such as node_modules or .env are never touched).`);
      }
      let conversationRewound = false;
      const patch: Partial<Plant> = { ring: k, turns: k, lastDiff: undefined, status: "idle", error: undefined, unread: false };
      if (k === 0) {
        patch.sessionId = undefined;
        patch.resumeAt = undefined;
        conversationRewound = true;
        notes.push("The conversation starts fresh on your next message.");
      } else {
        const uuid = this.store.ringMeta(plantId, k).assistantUuid;
        if (uuid && plant.sessionId) {
          patch.resumeAt = uuid;
          conversationRewound = true;
          notes.push(`The conversation continues from the end of ring ${k} on your next message.`);
        } else notes.push("The conversation could not be rewound (no message id was recorded for that ring).");
      }
      this.store.pruneRingsAfter(plantId, k);
      this.store.updatePlant(plantId, patch);
      this.nowSnap.delete(plantId);
      const note = notes.join(" ");
      this.entry(plantId, { kind: "system", text: `Pruned back to ${k === 0 ? "before the first ring" : `ring ${k}`}. ${note}` });
      return { filesRestored, conversationRewound, note };
    });
  }

  /** Grow a new potted plant from ring k: forked conversation + a pot started from that ring's checkpoint. */
  async forkAt(plantId: string, k: number): Promise<Plant> {
    const plant = this.mustPlant(plantId);
    const meta = this.store.ringMeta(plantId, k);
    if (!meta.ckptAfter) throw new Error(`Ring ${k} has no checkpoint to grow from.`);
    if (!this.hooks.plotsRoot) throw new Error("Pots are not available here.");
    let sessionId: string | undefined;
    if (plant.sessionId && meta.assistantUuid) {
      const fork = await (this.hooks.forkSession ?? forkSession)(plant.sessionId, { upToMessageId: meta.assistantUuid, dir: this.cwdOf(plant), title: `${plant.name} (from ring ${k})` });
      sessionId = fork.sessionId;
    }
    const child = this.sow(
      { bedId: plant.bedId, prompt: "", permissionMode: plant.permissionMode, model: plant.model, species: plant.species, plot: "pot" },
      { sessionId, base: meta.ckptAfter, name: `${plant.name} · ring ${k}` },
    );
    this.store.updatePlant(child.id, { seed: plant.seed, costUsd: 0 });
    this.entry(child.id, { kind: "system", text: `Grown from ring ${k} of "${plant.name}"${sessionId ? " with its conversation up to that point" : " (conversation not forked: no session id recorded)"}.` });
    return this.store.plants.get(child.id)!;
  }

  // ── asks ──────────────────────────────────────────────────────────────────

  private ask(plantId: string, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const g = this.growing.get(plantId);
    if (!g) return Promise.resolve({ behavior: "deny", message: "Session closed" });
    const kind: PendingAsk["kind"] = toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
    const ask: PendingAsk = {
      id: randomUUID(),
      kind,
      toolName,
      title: kind === "question" ? "A question for you" : kind === "plan" ? "A plan, waiting for your approval" : (opts.title ?? this.tidy(plantId, askTitle(toolName, input, opts.displayName))),
      detail: this.tidy(plantId, detailFor(toolName, input)),
      reason: opts.decisionReason,
      canAlwaysAllow: (opts.suggestions?.length ?? 0) > 0,
      questions: kind === "question" ? parseQuestions(input) : undefined,
      plan: kind === "plan" && typeof input.plan === "string" ? input.plan : undefined,
      createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      const waiting: WaitingAsk = { ask, input, suggestions: opts.suggestions, resolve };
      g.asks.push(waiting);
      opts.signal.addEventListener("abort", () => {
        const i = g.asks.indexOf(waiting);
        if (i >= 0) {
          g.asks.splice(i, 1);
          resolve({ behavior: "deny", message: "Cancelled" });
          this.showNextAsk(plantId, g);
        }
      });
      if (g.asks.length === 1) {
        const next = this.store.updatePlant(plantId, { status: "waiting", ask });
        this.store.flush();
        if (next) this.hooks.onNeedsYou(next, ask.title);
      }
    });
  }

  private showNextAsk(plantId: string, g: Growing) {
    const next = g.asks[0]?.ask;
    if (next) this.store.updatePlant(plantId, { status: "waiting", ask: next });
    else {
      const p = this.store.plants.get(plantId);
      if (p?.status === "waiting") this.store.updatePlant(plantId, { status: "working", ask: undefined });
    }
  }

  answer(plantId: string, askId: string, response: AskResponse) {
    const g = this.growing.get(plantId);
    if (!g) {
      this.store.updatePlant(plantId, { ask: undefined, status: "idle" });
      return;
    }
    const i = g.asks.findIndex((w) => w.ask.id === askId);
    if (i < 0) return;
    const [w] = g.asks.splice(i, 1);
    g.lastActive = Date.now();
    if (response.behavior === "allow") {
      const updatedInput = response.answers ? { ...w.input, answers: response.answers } : w.input;
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (response.mode) updatedPermissions = [{ type: "setMode", mode: response.mode, destination: "session" }];
      else if (response.always && w.suggestions?.length) updatedPermissions = w.suggestions;
      w.resolve({ behavior: "allow", updatedInput, ...(updatedPermissions ? { updatedPermissions } : {}) });
      if (response.mode) this.store.updatePlant(plantId, { permissionMode: response.mode });
      const verb = w.ask.kind === "question" ? "Answered" : w.ask.kind === "plan" ? "Approved the plan" : response.always ? "Always allowed" : "Allowed";
      this.entry(plantId, {
        kind: "system",
        text: w.ask.kind === "question" ? `${verb}: ${Object.values(response.answers ?? {}).join("; ")}` : `${verb} ${w.ask.kind === "plan" ? "" : w.ask.toolName}`.trim(),
      });
    } else {
      w.resolve({ behavior: "deny", message: response.message?.trim() || "The user declined this. Ask before trying something similar." });
      this.entry(plantId, { kind: "system", text: `Declined ${w.ask.toolName}${response.message ? `: ${response.message}` : ""}` });
    }
    this.showNextAsk(plantId, g);
  }

  // ── control ───────────────────────────────────────────────────────────────

  async interrupt(plantId: string) {
    const g = this.growing.get(plantId);
    if (!g) {
      const qi = this.waiting.findIndex((w) => w.plantId === plantId);
      if (qi >= 0) {
        this.waiting.splice(qi, 1);
        this.store.updatePlant(plantId, { queued: false, status: "idle", activityDetail: undefined });
        this.hooks.onPoolChange?.();
      }
      return;
    }
    g.interrupted = true;
    for (const w of g.asks.splice(0)) w.resolve({ behavior: "deny", message: "Interrupted by the user", interrupt: true });
    this.store.updatePlant(plantId, { ask: undefined });
    try {
      await g.query.interrupt();
    } catch {
      this.close(plantId);
    }
  }

  async setMode(plantId: string, mode: PermissionMode) {
    this.store.updatePlant(plantId, { permissionMode: mode });
    const g = this.growing.get(plantId);
    if (!g) return;
    if (mode === "bypassPermissions" && !g.startedBypass) {
      // Bypass has to be allowed when the process starts; the next message resumes in the new mode.
      const p = this.store.plants.get(plantId);
      if (p && (p.status === "idle" || p.status === "error")) this.close(plantId);
      return;
    }
    try {
      await g.query.setPermissionMode(mode);
    } catch (err) {
      console.error("[gardener] setPermissionMode failed", err);
    }
  }

  close(plantId: string) {
    const g = this.growing.get(plantId);
    if (!g) return;
    g.closing = true;
    g.input.end();
    try {
      g.query.close();
    } catch {
      // already gone
    }
  }

  private async closeAndWait(plantId: string) {
    const g = this.growing.get(plantId);
    if (!g) return;
    this.close(plantId);
    await Promise.race([g.done, new Promise((r) => setTimeout(r, 5000))]);
  }

  /** Close processes of plants idle longer than the setting (they resume on the next message). */
  reapIdle(now = Date.now()) {
    const limit = (this.hooks.idleMinutes?.() ?? 30) * 60_000;
    for (const [id, g] of this.growing) {
      const p = this.store.plants.get(id);
      if (!p || g.asks.length || g.ring || p.status === "thinking" || p.status === "working" || p.status === "waiting") continue;
      if (now - g.lastActive > limit) this.close(id);
    }
  }

  /** Memory pressure: close the plant that has been idle longest. Returns false when every live plant is busy. */
  reapOne(): boolean {
    let best: [string, number] | undefined;
    for (const [id, g] of this.growing) {
      const p = this.store.plants.get(id);
      const busy = !p || g.asks.length > 0 || !!g.ring || p.status === "thinking" || p.status === "working" || p.status === "waiting";
      if (!busy && (!best || g.lastActive < best[1])) best = [id, g.lastActive];
    }
    if (!best) return false;
    this.entry(best[0], { kind: "system", text: "Rested to free memory for other plants; it picks up where it left off on your next message." });
    this.close(best[0]);
    return true;
  }

  async uproot(plantId: string, opts: { deleteBranch?: boolean } = {}) {
    const plant = this.store.plants.get(plantId);
    this.waiting = this.waiting.filter((w) => w.plantId !== plantId);
    await this.closeAndWait(plantId);
    const bed = plant && this.store.beds.get(plant.bedId);
    if (plant && bed) {
      try {
        if (plant.plot === "pot" && plant.worktreePath) await git.removeWorktree(bed.path, plant.worktreePath, { deleteBranch: opts.deleteBranch ? plant.branch : undefined });
        await git.deleteRefs(bed.path, refBase(plantId));
      } catch (err) {
        console.error("[gardener] uproot cleanup failed", err);
      }
    }
    this.store.deletePlant(plantId);
  }

  closeBed(bedId: string) {
    for (const p of this.store.plants.values()) if (p.bedId === bedId) this.close(p.id);
  }

  shutdown() {
    for (const id of [...this.growing.keys()]) this.close(id);
  }

  private mustPlant(plantId: string): Plant {
    const p = this.store.plants.get(plantId);
    if (!p) throw new Error("That plant is gone");
    return p;
  }

  /** Show paths relative to the plant's folder, so cards read "src/x.ts" instead of a long absolute path. */
  private tidy(plantId: string, text: string): string {
    const plant = this.store.plants.get(plantId);
    const root = plant ? this.cwdOf(plant) : undefined;
    if (!root) return text;
    return text.split(`${root}/`).join("").split(`${root}\\`).join("");
  }

  private entry(plantId: string, e: Omit<Entry, "id" | "plantId" | "ts"> & { id?: string }) {
    const existing = e.id ? this.store.findEntry(plantId, e.id) : undefined;
    this.store.upsertEntry({ id: e.id ?? randomUUID(), plantId, ts: existing?.ts ?? Date.now(), kind: e.kind, text: e.text, tool: e.tool });
  }
}

/** Defense in depth for pots: refuse shell commands that name the user's main checkout. Not a sandbox. */
export function mainCheckoutGuard(bedRoot: string, pot: string): HookCallback {
  const variants = (p: string) => {
    const n = normalize(p).replace(/[\\/]+$/, "");
    return [n, n.replace(/\\/g, "/")].map((s) => s.toLowerCase());
  };
  const bed = variants(bedRoot);
  const potV = variants(pot);
  return async (input) => {
    const command = String((input as { tool_input?: { command?: unknown } }).tool_input?.command ?? "").toLowerCase();
    const mentions = bed.some((b) => {
      let i = command.indexOf(b);
      while (i >= 0) {
        const rest = command.slice(i);
        if (!potV.some((p) => rest.startsWith(p))) return true;
        i = command.indexOf(b, i + 1);
      }
      return false;
    });
    if (!mentions) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `This plant works in its own worktree at ${pot}. Run commands there, not in the main checkout at ${bedRoot}.`,
      },
    };
  };
}

function sum(files: DiffFile[], k: "insertions" | "deletions") {
  return files.reduce((s, f) => s + f[k], 0);
}

function isMode(m: unknown): m is PermissionMode {
  return m === "default" || m === "acceptEdits" || m === "plan" || m === "bypassPermissions";
}

function todoProgress(input: unknown): Plant["todos"] {
  const todos = (input as { todos?: { status?: string }[] })?.todos;
  if (!Array.isArray(todos)) return undefined;
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}

function parseQuestions(input: Record<string, unknown>): AskQuestion[] {
  const qs = input.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ""),
    header: typeof q.header === "string" ? q.header : undefined,
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? q.options.map((o: Record<string, unknown>) => ({ label: String(o.label ?? ""), description: typeof o.description === "string" ? o.description : undefined }))
      : [],
  }));
}

function askTitle(toolName: string, input: Record<string, unknown>, displayName?: string): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const file = s(input.file_path) || s(input.notebook_path);
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return "Wants to run a command";
    case "Write":
      return `Wants to write ${file || "a file"}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Wants to edit ${file || "a file"}`;
    case "WebFetch":
      try {
        return `Wants to fetch ${new URL(s(input.url)).host}`;
      } catch {
        return "Wants to fetch a web page";
      }
    case "WebSearch":
      return "Wants to search the web";
    default:
      return `Wants to use ${displayName ?? toolName}`;
  }
}

function detailFor(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (toolName) {
    case "Bash":
      return [s(input.description), s(input.command)].filter(Boolean).join("\n\n$ ").replace(/^\$ /, "$ ");
    case "Edit":
      return `${s(input.file_path)}\n\n- ${clip(s(input.old_string), 800).replace(/\n/g, "\n- ")}\n+ ${clip(s(input.new_string), 800).replace(/\n/g, "\n+ ")}`;
    case "MultiEdit":
      return `${s(input.file_path)} (${Array.isArray(input.edits) ? input.edits.length : 0} edits)`;
    case "Write":
      return `${s(input.file_path)}\n\n${clip(s(input.content), 1200)}`;
    case "WebFetch":
      return `${s(input.url)}\n\n${s(input.prompt)}`;
    default: {
      const summary = summarizeToolInput(toolName, input);
      try {
        const json = JSON.stringify(input, null, 2);
        return json.length < 1200 ? json : summary;
      } catch {
        return summary;
      }
    }
  }
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n…` : s;
}

/** Matches the store's blob cap: the journal keeps a 4 KB preview, "show full output" gets up to 5 MB. */
const MAX_TOOL_OUTPUT = 5 * 1024 * 1024;

function toolOutputText(content: unknown): string {
  const MAX = MAX_TOOL_OUTPUT;
  let out = "";
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) {
    out = content.map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : c?.type === "image" ? "[image]" : "")).join("\n");
  }
  return out.length > MAX ? `${out.slice(0, MAX)}\n…` : out;
}

function humanizeSubtype(subtype: string) {
  switch (subtype) {
    case "error_max_turns":
      return "Ran out of turns.";
    case "error_max_budget_usd":
      return "Ran out of budget.";
    default:
      return "Something went wrong during the turn.";
  }
}

function assistantErrorText(err: string) {
  switch (err) {
    case "authentication_failed":
      return "Claude Code is not logged in. Run `claude` in a terminal and log in with your Claude account, then try again.";
    case "rate_limit":
      return "Hit a usage limit. The plant will need to wait for the next window.";
    case "billing_error":
      return "Billing problem with this Claude account.";
    case "overloaded":
      return "Claude is overloaded right now.";
    default:
      return `Claude reported: ${oneLine(err, 120)}`;
  }
}
