// Lenient, incremental parser for Claude Code transcripts (~/.claude/projects/<folder>/<sessionId>.jsonl).
// The format is internal to Claude Code and changes between versions: unknown line types are ignored,
// bad lines are skipped. Shared by the history importer, the volunteer tailer and the Almanac.
import { open } from "node:fs/promises";
import { activityForTool, summarizeToolInput } from "../shared/garden";
import type { Activity, Entry, PermissionMode } from "../shared/types";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const MAX_TOOL_OUTPUT = 64 * 1024;
const CHUNK = 256 * 1024;
/** Line types (from the `{"type":"…"` prefix) worth a JSON.parse. Everything else, e.g. the huge api-request lines, is skipped unread. */
const WANTED = new Set(["user", "assistant", "system", "cost-state", "ai-title", "custom-title", "permission-mode"]);

export interface ModelCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface ParsedSummary {
  cwd?: string;
  title?: string;
  seed: string;
  model?: string;
  permissionMode: PermissionMode;
  turns: number;
  toolCalls: number;
  /** From the last cost-state line (Claude Code's own estimate); 0 when none was seen. */
  costUsd: number;
  /** Per model, from the last cost-state line; undefined when none was seen. */
  modelCosts?: Record<string, ModelCost>;
  lastText?: string;
  createdAt: number;
  updatedAt: number;
  lastActivity?: { activity: Activity; detail: string };
  /** What the session looks like it is doing, from the last lines: a turn running a tool, the model working, or resting. */
  phase: "idle" | "thinking" | "working";
  /** "cli" for a terminal, "sdk-…" for sessions an app (Terrarium included) started through the SDK. */
  entrypoint?: string;
}

export interface UsageLine {
  messageId: string;
  requestId: string;
  sessionId: string;
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type ParsedEntry = Omit<Entry, "plantId">;

/**
 * - "full": summary, entries and usage (live tailing).
 * - "summary": summary only; skips tool results (the bulk of a transcript) and keeps no entries.
 * - "usage": usage and cost-state only; JSON-parses nothing but assistant and cost-state lines.
 */
export type ParseMode = "full" | "summary" | "usage";

/** A prompt the human typed (not a tool result, slash-command echo, interrupt marker or injected meta message). */
function humanText(d: any): string | undefined {
  if (d.isMeta || d.isSidechain) return undefined;
  const c = d.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && !c.some((b) => b?.type === "tool_result") ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  const t = text.trimStart();
  if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) return undefined;
  return text;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class TranscriptParser {
  private s: ParsedSummary = { seed: "", permissionMode: "default", turns: 0, toolCalls: 0, costUsd: 0, createdAt: 0, updatedAt: 0, phase: "idle" };
  private aiTitle?: string;
  private customTitle?: string;
  /** tool_use id → its entry, until the result arrives. */
  private tools = new Map<string, ParsedEntry>();
  /** tool_use ids still counted as running (cleared when the human starts a new turn or interrupts). */
  private pending = new Set<string>();
  private dirty = new Map<string, ParsedEntry>();
  private usage = new Map<string, UsageLine>();
  private dirtyUsage = new Set<string>();

  /** `maxEntries` bounds the entries held between takeEntries() calls (oldest dropped): a rolling window for big files. */
  constructor(
    readonly sessionId: string,
    readonly mode: ParseMode = "full",
    private maxEntries = Infinity,
  ) {}

  /** Cheap pre-check on the first bytes of a line: false means skip it without decoding or parsing. */
  wants(head: string): boolean {
    const t = /^\{"type":"([\w-]+)"/.exec(head)?.[1];
    if (this.mode === "usage") return t ? t === "cost-state" || t === "assistant" : true;
    return t ? WANTED.has(t) : true;
  }

  push(line: string) {
    if (!line || !this.wants(line.slice(0, 80))) return;
    if (this.mode === "usage" && !line.startsWith('{"type":"cost-state"') && !line.includes('"type":"assistant"')) return;
    // Tool results are most of a transcript's bytes and nothing in a summary needs them.
    if (this.mode === "summary" && line.includes('"type":"tool_result"')) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (!d || typeof d !== "object") return;
    const s = this.s;
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) || 0 : 0;
    if (ts) {
      s.createdAt ||= ts;
      s.updatedAt = Math.max(s.updatedAt, ts);
    }
    if (!s.cwd && typeof d.cwd === "string") s.cwd = d.cwd;
    if (!s.entrypoint && typeof d.entrypoint === "string") s.entrypoint = d.entrypoint;
    switch (d.type) {
      case "custom-title":
        if (typeof d.customTitle === "string") this.customTitle = d.customTitle;
        break;
      case "ai-title":
        if (typeof d.aiTitle === "string") this.aiTitle = d.aiTitle;
        break;
      case "cost-state":
        s.costUsd = num(d.totalCostUSD);
        s.modelCosts = {};
        for (const [m, u] of Object.entries((d.modelUsage ?? {}) as Record<string, any>)) {
          s.modelCosts[m] = {
            inputTokens: num(u?.inputTokens),
            outputTokens: num(u?.outputTokens),
            cacheReadInputTokens: num(u?.cacheReadInputTokens),
            cacheCreationInputTokens: num(u?.cacheCreationInputTokens),
            costUSD: num(u?.costUSD),
          };
        }
        break;
      case "permission-mode":
        if (MODES.includes(d.permissionMode)) s.permissionMode = d.permissionMode;
        break;
      case "system":
        if (d.subtype === "turn_duration" && !d.isSidechain) this.rest();
        break;
      case "user":
        this.user(d, ts);
        break;
      case "assistant":
        this.assistant(d, ts);
        break;
    }
    s.title = this.customTitle || this.aiTitle;
  }

  private rest() {
    this.pending.clear();
    this.s.phase = "idle";
  }

  private user(d: any, ts: number) {
    const s = this.s;
    const text = humanText(d);
    if (text) {
      s.seed ||= text;
      s.turns++;
      this.pending.clear();
      s.phase = "thinking";
      s.lastActivity = { activity: "think", detail: "" };
      this.emit({ id: String(d.uuid ?? `u:${ts}:${s.turns}`), ts, kind: "user", text });
      return;
    }
    if (d.isSidechain || !Array.isArray(d.message?.content)) {
      if (!d.isSidechain && typeof d.message?.content === "string" && d.message.content.trimStart().startsWith("[Request interrupted")) this.rest();
      return;
    }
    for (const b of d.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.startsWith("[Request interrupted")) this.rest();
      if (b?.type !== "tool_result") continue;
      this.pending.delete(b.tool_use_id);
      const t = this.tools.get(b.tool_use_id);
      if (!t?.tool) continue;
      this.tools.delete(b.tool_use_id);
      const out = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
      t.tool = { ...t.tool, status: b.is_error ? "error" : "ok", output: out.length > MAX_TOOL_OUTPUT ? out.slice(0, MAX_TOOL_OUTPUT) : out };
      this.emit(t);
    }
    if (s.phase === "working" && this.pending.size === 0) s.phase = "thinking";
  }

  private assistant(d: any, ts: number) {
    const s = this.s;
    const m = d.message;
    if (!m || typeof m !== "object") return;
    const model = typeof m.model === "string" && m.model !== "<synthetic>" ? m.model : undefined;
    // Usage counts sidechains too (subagents are billed); each API response is repeated on every line it was split into.
    if (this.mode !== "summary" && model && m.usage && typeof m.id === "string") {
      const key = `${m.id}:${d.requestId ?? ""}`;
      const u = m.usage;
      const prev = this.usage.get(key);
      // Streamed copies of one response carry growing output counts: keep the largest of each.
      const row: UsageLine = {
        messageId: m.id,
        requestId: typeof d.requestId === "string" ? d.requestId : "",
        sessionId: this.sessionId,
        ts: prev?.ts || ts,
        model,
        input: Math.max(prev?.input ?? 0, num(u.input_tokens)),
        output: Math.max(prev?.output ?? 0, num(u.output_tokens)),
        cacheRead: Math.max(prev?.cacheRead ?? 0, num(u.cache_read_input_tokens)),
        cacheWrite: Math.max(prev?.cacheWrite ?? 0, num(u.cache_creation_input_tokens)),
      };
      if (!prev || row.input !== prev.input || row.output !== prev.output || row.cacheRead !== prev.cacheRead || row.cacheWrite !== prev.cacheWrite) {
        this.usage.set(key, row);
        this.dirtyUsage.add(key);
      }
    }
    if (this.mode === "usage" || d.isSidechain || !Array.isArray(m.content)) return;
    if (model) s.model = model;
    m.content.forEach((b: any, i: number) => {
      const id = `${d.uuid}:${i}`;
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        s.lastText = b.text;
        this.emit({ id, ts, kind: "text", text: b.text });
        if ((m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence") && this.pending.size === 0) s.phase = "idle";
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        this.emit({ id, ts, kind: "thinking", text: b.thinking });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        s.toolCalls++;
        const name = String(b.name ?? "tool");
        const summary = summarizeToolInput(name, b.input);
        const e: ParsedEntry = { id: `tool:${b.id}`, ts, kind: "tool", text: name, tool: { id: b.id, name, summary, activity: activityForTool(name), status: "running" } };
        s.lastActivity = { activity: activityForTool(name), detail: summary };
        s.phase = "working";
        this.pending.add(b.id);
        if (this.mode === "full") this.tools.set(b.id, e);
        this.emit(e);
      }
    });
  }

  private emit(e: ParsedEntry) {
    if (this.mode !== "full") return;
    this.dirty.delete(e.id); // re-insert so an updated tool moves after what it follows
    this.dirty.set(e.id, e);
    if (this.dirty.size > this.maxEntries) this.dirty.delete(this.dirty.keys().next().value!);
  }

  get summary(): ParsedSummary {
    return this.s;
  }

  get pendingTools(): number {
    return this.pending.size;
  }

  /** Entries new or updated since the last call (a tool entry comes back when its result arrives). */
  takeEntries(): ParsedEntry[] {
    const out = [...this.dirty.values()];
    this.dirty.clear();
    return out;
  }

  /** Usage rows (one per API response) new or grown since the last call. */
  takeUsage(): UsageLine[] {
    const out = [...this.dirtyUsage].map((k) => this.usage.get(k)!);
    this.dirtyUsage.clear();
    return out;
  }
}

/** Reads a growing transcript from a byte offset. A partial last line is left for the next read; a file that shrank is re-read from 0. */
export class TranscriptTail {
  /** End of the last complete line read. */
  offset = 0;
  private p: TranscriptParser;

  constructor(
    readonly path: string,
    readonly sessionId: string,
    private opts: { mode?: ParseMode; maxEntries?: number } = {},
  ) {
    this.p = new TranscriptParser(sessionId, opts.mode, opts.maxEntries);
  }

  get parser(): TranscriptParser {
    return this.p;
  }

  async read(): Promise<{ lines: number }> {
    const fh = await open(this.path, "r");
    let lines = 0;
    try {
      const { size } = await fh.stat();
      if (size < this.offset) {
        // ponytail: shrink = rotated/rewritten. A replacement at least as large as what we read goes unnoticed; compare a head hash if that ever happens.
        this.offset = 0;
        this.p = new TranscriptParser(this.sessionId, this.opts.mode, this.opts.maxEntries);
      }
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = this.offset;
      let parts: Buffer[] = [];
      let partLen = 0;
      let checked = false;
      let skip = false;
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
        if (!bytesRead) break;
        const chunk = buf.subarray(0, bytesRead);
        let i = 0;
        while (i < bytesRead) {
          const nl = chunk.indexOf(10, i);
          const end = nl < 0 ? bytesRead : nl;
          if (!skip && end > i) {
            parts.push(Buffer.from(chunk.subarray(i, end)));
            partLen += end - i;
          }
          if (!skip && !checked && (partLen >= 80 || nl >= 0)) {
            checked = true;
            const head = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).subarray(0, 80).toString("latin1");
            if (!this.p.wants(head)) {
              skip = true;
              parts = [];
              partLen = 0;
            }
          }
          if (nl < 0) break;
          if (!skip && partLen) {
            let line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this.p.push(line);
          }
          lines++;
          parts = [];
          partLen = 0;
          checked = false;
          skip = false;
          i = nl + 1;
          this.offset = pos + i;
        }
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    return { lines };
  }
}
