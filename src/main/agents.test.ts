import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plant } from "../shared/types";
import { Greenhouse } from "./agents";
import { GardenStore } from "./store";

/** A stand-in for the SDK: each user turn runs `script`, which yields messages and may ask for permission. */
function fakeQuery(script: (turn: string, canUseTool: CanUseTool) => AsyncGenerator<SDKMessage>) {
  const calls: Options[] = [];
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    calls.push(params.options);
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: "sess-1", model: "fake-model", cwd: params.options.cwd, permissionMode: "default", claude_code_version: "0.0.0" } as unknown as SDKMessage;
      for await (const turn of params.prompt) {
        const text = turn.message.content as string;
        yield* script(text, params.options.canUseTool!);
      }
    }
    const gen = run() as unknown as Query;
    Object.assign(gen, { interrupt: async () => undefined, setPermissionMode: async () => undefined, close: () => undefined });
    return gen;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { fn, calls };
}

const opts = (extra: object = {}) => ({ signal: new AbortController().signal, toolUseID: "tu", requestId: "rq", ...extra });
const assistant = (content: unknown[], uuid = Math.random().toString(36)) =>
  ({ type: "assistant", uuid, session_id: "sess-1", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const toolResult = (id: string, text: string, isError = false) =>
  ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } }) as unknown as SDKMessage;
const success = (result: string) =>
  ({ type: "result", subtype: "success", is_error: false, result, num_turns: 2, duration_ms: 1200, total_cost_usd: 0.05 }) as unknown as SDKMessage;

async function until(store: GardenStore, id: string, pred: (p: Plant) => boolean) {
  for (let i = 0; i < 200; i++) {
    const p = store.plants.get(id)!;
    if (pred(p)) return p;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out; plant is ${JSON.stringify(store.plants.get(id))}`);
}

describe("Greenhouse", () => {
  let dir: string;
  let store: GardenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-test-"));
    store = new GardenStore(dir);
    store.putBed({ id: "bed", name: "repo", path: "/work/repo", createdAt: 0 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("grows through a permission request to a bloom", async () => {
    const { fn, calls } = fakeQuery(async function* (_turn, canUseTool) {
      yield assistant([{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/repo/a.txt", content: "hi" } }]);
      const decision = await canUseTool("Write", { file_path: "/work/repo/a.txt", content: "hi" }, opts({ suggestions: [] }));
      yield toolResult("t1", decision?.behavior === "allow" ? "ok" : "denied", decision?.behavior !== "allow");
      yield assistant([{ type: "text", text: "Wrote a.txt" }]);
      yield success("Wrote a.txt");
    });
    const gh = new Greenhouse(store, { onTurnEnd() {}, onNeedsYou() {}, env: () => ({}), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "write a file", permissionMode: "default" });

    const waiting = await until(store, plant.id, (p) => p.status === "waiting");
    expect(calls[0].cwd).toBe("/work/repo");
    expect(waiting.ask).toMatchObject({ kind: "permission", toolName: "Write", title: "Wants to write a.txt" });
    expect(waiting.ask!.detail.startsWith("a.txt")).toBe(true);
    expect(waiting.activity).toBe("edit");

    gh.answer(plant.id, waiting.ask!.id, { behavior: "allow" });
    const done = await until(store, plant.id, (p) => p.status === "idle" && p.turns === 1);
    expect(done).toMatchObject({ unread: true, sessionId: "sess-1", toolCalls: 1, lastText: "Wrote a.txt", ask: undefined });
    const tool = store.entries(plant.id).find((e) => e.kind === "tool")!;
    expect(tool.tool).toMatchObject({ name: "Write", status: "ok", summary: "a.txt" });
  });

  it("passes answers back for AskUserQuestion", async () => {
    let received: Record<string, unknown> | undefined;
    const { fn } = fakeQuery(async function* (_turn, canUseTool) {
      const input = { questions: [{ question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] }] };
      const r = await canUseTool("AskUserQuestion", input, opts());
      received = r?.behavior === "allow" ? r.updatedInput : undefined;
      yield success("ok");
    });
    const gh = new Greenhouse(store, { onTurnEnd() {}, onNeedsYou() {}, env: () => ({}), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "pick a db", permissionMode: "default" });
    const waiting = await until(store, plant.id, (p) => p.status === "waiting");
    expect(waiting.ask?.kind).toBe("question");
    expect(waiting.ask?.questions?.[0].options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    gh.answer(plant.id, waiting.ask!.id, { behavior: "allow", answers: { "Which db?": "SQLite" } });
    await until(store, plant.id, (p) => p.status === "idle");
    expect(received?.answers).toEqual({ "Which db?": "SQLite" });
  });

  it("treats a chat reply during a pending ask as a denial with that message", async () => {
    let denial: string | undefined;
    const { fn } = fakeQuery(async function* (_turn, canUseTool) {
      const r = await canUseTool("Bash", { command: "rm -rf build" }, opts());
      denial = r?.behavior === "deny" ? r.message : undefined;
      yield success("ok");
    });
    const gh = new Greenhouse(store, { onTurnEnd() {}, onNeedsYou() {}, env: () => ({}), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "clean", permissionMode: "default" });
    await until(store, plant.id, (p) => p.status === "waiting");
    gh.send(plant.id, "use git clean instead");
    await until(store, plant.id, (p) => p.status === "idle");
    expect(denial).toContain("use git clean instead");
  });

  it("wilts on a failed turn and tells the gardener", async () => {
    const needs: string[] = [];
    const { fn } = fakeQuery(async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], num_turns: 9, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
    });
    const gh = new Greenhouse(store, { onTurnEnd() {}, onNeedsYou: (_p, why) => needs.push(why), env: () => ({}), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "loop forever", permissionMode: "default" });
    const p = await until(store, plant.id, (x) => x.status === "error");
    expect(p.error).toBe("Ran out of turns.");
    expect(needs).toEqual(["wilted"]);
  });
});
