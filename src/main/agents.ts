// The greenhouse: runs one Claude Code session per plant through the Agent SDK and turns
// its message stream into plant state (status, activity, asks) and journal entries.
//
// Auth is whatever Claude Code itself uses on this machine: run `claude` once and log in with
// your Claude subscription, and every plant here uses that login. Nothing is stored by Gardener.
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { activityForTool, nameFromPrompt, nextSpecies, oneLine, summarizeToolInput } from "../shared/garden";
import type {
  Activity,
  AskQuestion,
  AskResponse,
  Entry,
  PendingAsk,
  PermissionMode,
  Plant,
  SowRequest,
} from "../shared/types";
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

interface Growing {
  query: Query;
  input: Pushable<SDKUserMessage>;
  asks: WaitingAsk[];
  openTools: Map<string, Activity>;
  /** Cost of earlier processes for this plant; the SDK reports cost per process. */
  costBase: number;
  startedBypass: boolean;
  interrupted: boolean;
  closing: boolean;
}

const GARDEN_APPEND = `You are running inside Gardener, a desktop app where the user tends several coding agents at once, drawn as plants in a garden. The user is not watching your output continuously: when you finish a turn, end with a short, plain summary of what changed and anything they must decide, so they can review it at a glance.`;

export interface AgentHooks {
  /** A turn ended (success or not): good moment to re-read the bed's soil. */
  onTurnEnd(plant: Plant): void;
  /** The plant needs the gardener (permission, question, plan, error). */
  onNeedsYou(plant: Plant, why: string): void;
  env(): Record<string, string | undefined>;
  /** Swap in a fake for tests; defaults to the Agent SDK's query(). */
  query?: typeof query;
}

const userTurn = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

export class Greenhouse {
  private growing = new Map<string, Growing>();

  constructor(
    private store: GardenStore,
    private hooks: AgentHooks,
  ) {}

  sow(req: SowRequest): Plant {
    const bed = this.store.beds.get(req.bedId);
    if (!bed) throw new Error("That bed no longer exists");
    const siblings = [...this.store.plants.values()].filter((p) => p.bedId === bed.id);
    const now = Date.now();
    const plant: Plant = {
      id: randomUUID(),
      bedId: bed.id,
      name: req.name?.trim() || nameFromPrompt(req.prompt),
      species: req.species ?? nextSpecies(siblings.map((p) => p.species)),
      seed: req.prompt,
      model: req.model || undefined,
      permissionMode: req.permissionMode,
      status: "idle",
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
    if (req.prompt.trim()) this.send(plant.id, req.prompt);
    return plant;
  }

  send(plantId: string, text: string) {
    const plant = this.store.plants.get(plantId);
    if (!plant) throw new Error("That plant is gone");
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

    this.store.updatePlant(plantId, {
      status: "thinking",
      activity: "think",
      activityDetail: undefined,
      error: undefined,
      unread: false,
    });
    const session = g ?? this.start(plant);
    session.input.push(userTurn(body));
  }

  private start(plant: Plant): Growing {
    const bed = this.store.beds.get(plant.bedId);
    if (!bed) throw new Error("That bed no longer exists");
    const input = new Pushable<SDKUserMessage>();
    const bypass = plant.permissionMode === "bypassPermissions";
    const canUseTool: CanUseTool = (toolName, toolInput, opts) => this.ask(plant.id, toolName, toolInput, opts);
    const run = this.hooks.query ?? query;
    const q = run({
      prompt: input,
      options: {
        cwd: bed.path,
        ...(plant.sessionId ? { resume: plant.sessionId } : {}),
        permissionMode: plant.permissionMode,
        ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
        ...(plant.model ? { model: plant.model } : {}),
        canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code", append: GARDEN_APPEND },
        env: this.hooks.env(),
        stderr: (data) => {
          if (process.env.GARDENER_DEBUG) console.error(`[claude ${plant.name}]`, data);
        },
      },
    });
    const g: Growing = {
      query: q,
      input,
      asks: [],
      openTools: new Map(),
      costBase: plant.costUsd,
      startedBypass: bypass,
      interrupted: false,
      closing: false,
    };
    this.growing.set(plant.id, g);
    this.store.updatePlant(plant.id, { live: true });
    void this.pump(plant.id, g);
    return g;
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
        if (next && patch.status === "error") this.hooks.onNeedsYou(next, next.error ?? "wilted");
      }
    }
  }

  private handle(plantId: string, g: Growing, msg: SDKMessage) {
    const plant = this.store.plants.get(plantId);
    if (!plant) return;
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          const mode = isMode(msg.permissionMode) ? msg.permissionMode : plant.permissionMode;
          this.store.updatePlant(plantId, { sessionId: msg.session_id, model: msg.model, permissionMode: mode });
          if (!plant.sessionId) {
            this.entry(plantId, {
              kind: "system",
              text: `Rooted in ${msg.cwd} · ${msg.model} · Claude Code ${msg.claude_code_version}`,
            });
          }
        } else if (msg.subtype === "status") {
          const patch: Partial<Plant> = {};
          if (msg.status === "compacting") patch.activityDetail = "Composting old context";
          if (msg.permissionMode && isMode(msg.permissionMode)) patch.permissionMode = msg.permissionMode;
          if (Object.keys(patch).length) this.store.updatePlant(plantId, patch);
        } else if (msg.subtype === "api_retry") {
          this.store.updatePlant(plantId, {
            activityDetail: `Waiting out the weather (retry ${msg.attempt}/${msg.max_retries}: ${msg.error})`,
          });
        }
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
              this.store.updatePlant(plantId, {
                activityDetail: this.tidy(plantId, `runner: ${block.name} ${summarizeToolInput(block.name, block.input)}`).slice(0, 160),
              });
            }
          }
          return;
        }
        if (msg.error) {
          this.entry(plantId, { kind: "error", text: assistantErrorText(msg.error) });
        }
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
            this.entry(plantId, {
              id: `tool:${block.id}`,
              kind: "tool",
              text: block.name,
              tool: { id: block.id, name: block.name, summary, activity, status: "running" },
            });
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
            this.store.upsertEntry({
              ...existing,
              tool: { ...existing.tool, status: block.is_error ? "error" : "ok", output: toolOutputText(block.content) },
            });
          }
          const activity = g.openTools.get(block.tool_use_id);
          g.openTools.delete(block.tool_use_id);
          const current = this.store.plants.get(plantId)!;
          const patch: Partial<Plant> = {};
          if (activity === "delegate" && current.runners > 0 && existing?.tool && existing.tool.name !== "SendMessage") {
            patch.runners = current.runners - 1;
          }
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
        const base: Partial<Plant> = {
          turns: current.turns + 1,
          costUsd: g.costBase + (msg.total_cost_usd ?? 0),
          runners: 0,
          activity: undefined,
          activityDetail: undefined,
          ask: undefined,
        };
        const secs = Math.round(msg.duration_ms / 1000);
        let next: Plant | undefined;
        if (g.interrupted) {
          g.interrupted = false;
          next = this.store.updatePlant(plantId, { ...base, status: "idle", turns: current.turns });
          this.entry(plantId, { kind: "system", text: "Paused by you." });
        } else if (ok) {
          const text = msg.subtype === "success" ? msg.result : "";
          next = this.store.updatePlant(plantId, {
            ...base,
            status: "idle",
            unread: true,
            error: undefined,
            lastText: text || current.lastText,
          });
          this.entry(plantId, {
            kind: "result",
            text: `Bloomed after ${msg.num_turns} step${msg.num_turns === 1 ? "" : "s"} · ${secs}s · $${(base.costUsd ?? 0).toFixed(2)} so far`,
          });
        } else {
          const why =
            msg.subtype === "success"
              ? msg.result || "The turn ended with an error."
              : msg.errors?.join("\n") || humanizeSubtype(msg.subtype);
          next = this.store.updatePlant(plantId, { ...base, status: "error", error: why });
          this.entry(plantId, { kind: "error", text: why });
          if (next) this.hooks.onNeedsYou(next, "wilted");
        }
        if (next) this.hooks.onTurnEnd(next);
        return;
      }
      default:
        return;
    }
  }

  private ask(
    plantId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const g = this.growing.get(plantId);
    if (!g) return Promise.resolve({ behavior: "deny", message: "Session closed" });
    const kind: PendingAsk["kind"] =
      toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
    const ask: PendingAsk = {
      id: randomUUID(),
      kind,
      toolName,
      title:
        kind === "question"
          ? "A question for you"
          : kind === "plan"
            ? "A plan, waiting for your approval"
            : opts.title ?? this.tidy(plantId, askTitle(toolName, input, opts.displayName)),
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
    if (response.behavior === "allow") {
      const updatedInput = response.answers ? { ...w.input, answers: response.answers } : w.input;
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (response.mode) updatedPermissions = [{ type: "setMode", mode: response.mode, destination: "session" }];
      else if (response.always && w.suggestions?.length) updatedPermissions = w.suggestions;
      w.resolve({ behavior: "allow", updatedInput, ...(updatedPermissions ? { updatedPermissions } : {}) });
      if (response.mode) this.store.updatePlant(plantId, { permissionMode: response.mode });
      const verb = w.ask.kind === "question" ? "Answered" : w.ask.kind === "plan" ? "Approved the plan" : response.always ? "Always allowed" : "Allowed";
      this.entry(plantId, { kind: "system", text: w.ask.kind === "question" ? `${verb}: ${Object.values(response.answers ?? {}).join("; ")}` : `${verb} ${w.ask.kind === "plan" ? "" : w.ask.toolName}`.trim() });
    } else {
      w.resolve({ behavior: "deny", message: response.message?.trim() || "The user declined this. Ask before trying something similar." });
      this.entry(plantId, {
        kind: "system",
        text: `Declined ${w.ask.toolName}${response.message ? `: ${response.message}` : ""}`,
      });
    }
    this.showNextAsk(plantId, g);
  }

  async interrupt(plantId: string) {
    const g = this.growing.get(plantId);
    if (!g) return;
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

  uproot(plantId: string) {
    this.close(plantId);
    this.store.deletePlant(plantId);
  }

  closeBed(bedId: string) {
    for (const p of this.store.plants.values()) if (p.bedId === bedId) this.close(p.id);
  }

  shutdown() {
    for (const id of [...this.growing.keys()]) this.close(id);
  }

  /** Show paths relative to the bed, so cards read "src/x.ts" instead of a long absolute path. */
  private tidy(plantId: string, text: string): string {
    const bedId = this.store.plants.get(plantId)?.bedId;
    const root = bedId ? this.store.beds.get(bedId)?.path : undefined;
    if (!root) return text;
    return text.split(`${root}/`).join("").split(`${root}\\`).join("");
  }

  private entry(plantId: string, e: Omit<Entry, "id" | "plantId" | "ts"> & { id?: string }) {
    const existing = e.id ? this.store.findEntry(plantId, e.id) : undefined;
    this.store.upsertEntry({ id: e.id ?? randomUUID(), plantId, ts: existing?.ts ?? Date.now(), kind: e.kind, text: e.text, tool: e.tool });
  }
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
      ? q.options.map((o: Record<string, unknown>) => ({
          label: String(o.label ?? ""),
          description: typeof o.description === "string" ? o.description : undefined,
        }))
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

function toolOutputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : ""))
      .join("\n");
  }
  return "";
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
