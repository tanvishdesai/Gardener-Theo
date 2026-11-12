import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plant, Weather } from "../shared/types";
import { Greenhouse, mainCheckoutGuard } from "./agents";
import { GardenStore } from "./store";

/** A stand-in for the SDK: each user turn runs `script`, which yields messages and may ask for permission. */
function fakeQuery(script: (turn: string, canUseTool: CanUseTool, options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: Options[] = [];
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    calls.push(params.options);
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: "sess-1", model: "fake-model", cwd: params.options.cwd, permissionMode: "default", claude_code_version: "0.0.0" } as unknown as SDKMessage;
      for await (const turn of params.prompt) {
        const text = turn.message.content as string;
        yield* script(text, params.options.canUseTool!, params.options);
      }
    }
    const gen = run() as unknown as Query;
    Object.assign(gen, { interrupt: async () => undefined, setPermissionMode: async () => undefined, close: () => (gen as unknown as AsyncGenerator).return(undefined) });
    return gen;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { fn, calls };
}

const opts = (extra: object = {}) => ({ signal: new AbortController().signal, toolUseID: "tu", requestId: "rq", ...extra });
const assistant = (content: unknown[], uuid = Math.random().toString(36)) =>
  ({ type: "assistant", uuid, session_id: "sess-1", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const toolResult = (id: string, text: string, isError = false) =>
  ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } }) as unknown as SDKMessage;
const success = (result: string, total = 0.05) => ({ type: "result", subtype: "success", is_error: false, result, num_turns: 2, duration_ms: 1200, total_cost_usd: total }) as unknown as SDKMessage;

async function until(store: GardenStore, id: string, pred: (p: Plant) => boolean) {
  for (let i = 0; i < 400; i++) {
    const p = store.plants.get(id)!;
    if (pred(p)) return p;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out; plant is ${JSON.stringify(store.plants.get(id))}`);
}

const base = { onTurnEnd() {}, onNeedsYou() {}, env: () => ({}) };

/** Git marks object files read-only, which rmSync can't delete on Windows: make them writable first. */
function rmRepo(dir: string) {
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue; // 0o666 on a directory drops its x bit, so POSIX rm then fails with EACCES
    try {
      chmodSync(join(e.parentPath, e.name), 0o666);
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("Greenhouse", () => {
  let dir: string;
  let store: GardenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-test-"));
    store = new GardenStore(dir);
    store.putBed({ id: "bed", name: "repo", path: "/work/repo", createdAt: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grows through a permission request to a bloom", async () => {
    const { fn, calls } = fakeQuery(async function* (_turn, canUseTool) {
      yield assistant([{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/repo/a.txt", content: "hi" } }]);
      const decision = await canUseTool("Write", { file_path: "/work/repo/a.txt", content: "hi" }, opts({ suggestions: [] }));
      yield toolResult("t1", decision?.behavior === "allow" ? "ok" : "denied", decision?.behavior !== "allow");
      yield assistant([{ type: "text", text: "Wrote a.txt" }]);
      yield success("Wrote a.txt");
    });
    const gh = new Greenhouse(store, { ...base, query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "write a file", permissionMode: "default" });

    const waiting = await until(store, plant.id, (p) => p.status === "waiting");
    expect(calls[0].cwd).toBe("/work/repo");
    expect(waiting.ask).toMatchObject({ kind: "permission", toolName: "Write", title: "Wants to write a.txt" });
    expect(waiting.ask!.detail.startsWith("a.txt")).toBe(true);
    expect(waiting.activity).toBe("edit");

    gh.answer(plant.id, waiting.ask!.id, { behavior: "allow" });
    const done = await until(store, plant.id, (p) => p.status === "idle" && p.turns === 1);
    expect(done).toMatchObject({ unread: true, sessionId: "sess-1", toolCalls: 1, lastText: "Wrote a.txt", ask: undefined, origin: "sown", plot: "bed" });
    const tool = store.journalPage(plant.id).entries.find((e) => e.kind === "tool")!;
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
    const gh = new Greenhouse(store, { ...base, query: fn });
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
    const gh = new Greenhouse(store, { ...base, query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "clean", permissionMode: "default" });
    await until(store, plant.id, (p) => p.status === "waiting");
    await gh.send(plant.id, "use git clean instead");
    await until(store, plant.id, (p) => p.status === "idle");
    expect(denial).toContain("use git clean instead");
  });

  it("wilts on a failed turn and tells the gardener", async () => {
    const needs: string[] = [];
    const { fn } = fakeQuery(async function* () {
      yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], num_turns: 9, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
    });
    const gh = new Greenhouse(store, { ...base, onNeedsYou: (_p, why) => needs.push(why), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "loop forever", permissionMode: "default" });
    const p = await until(store, plant.id, (x) => x.status === "error");
    expect(p.error).toBe("Ran out of turns.");
    expect(needs).toEqual(["wilted"]);
  });

  it("does not double-count cost when a session is resumed", async () => {
    // The SDK's total_cost_usd is the session's running total (restored on resume).
    const { fn } = fakeQuery(async function* () {
      yield success("ok", 1.5);
    });
    store.putPlant({ ...plantFixture(), sessionId: "sess-1", costUsd: 1.2 });
    const gh = new Greenhouse(store, { ...base, query: fn });
    await gh.send("p", "again");
    const p = await until(store, "p", (x) => x.turns === 1);
    expect(p.costUsd).toBeCloseTo(1.5);
  });

  it("turns rate_limit_event into weather: clear, clouds near the limit, rain when rejected", async () => {
    const infos = [
      { status: "allowed", utilization: 0.3, rateLimitType: "five_hour" },
      { status: "allowed", utilization: 0.8, rateLimitType: "five_hour" },
      { status: "allowed_warning", rateLimitType: "seven_day" },
      { status: "rejected", utilization: 1, resetsAt: 1_800_000_000, rateLimitType: "five_hour" },
    ];
    const { fn } = fakeQuery(async function* () {
      for (const info of infos) yield { type: "rate_limit_event", rate_limit_info: info } as unknown as SDKMessage;
      yield success("ok");
    });
    const seen: Weather[] = [];
    const gh = new Greenhouse(store, { ...base, query: fn, onWeather: (w) => seen.push(w) });
    const plant = gh.sow({ bedId: "bed", prompt: "go", permissionMode: "default" });
    await until(store, plant.id, (p) => p.turns === 1);
    expect(seen.map((w) => w.status)).toEqual(["clear", "clouds", "clouds", "rain"]);
    expect(seen[3]).toMatchObject({ resetsAt: 1_800_000_000, limitType: "five_hour", utilization: 1 });
  });

  it("keeps tool output beyond 64 KB for \"show full output\"", async () => {
    const big = "line\n".repeat(40_000); // 200 KB
    const { fn } = fakeQuery(async function* () {
      yield assistant([{ type: "tool_use", id: "big", name: "Bash", input: { command: "cat big.log" } }]);
      yield toolResult("big", big);
      yield success("ok");
    });
    const gh = new Greenhouse(store, { ...base, query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "read the log", permissionMode: "default" });
    await until(store, plant.id, (p) => p.turns === 1);
    expect(store.toolOutput(plant.id, "tool:big")).toBe(big);
  });

  it("finishes an interrupted pot before the next turn runs", async () => {
    const pot = mkdtempSync(join(tmpdir(), "terrarium-pot-"));
    const { fn, calls } = fakeQuery(async function* () {
      yield success("ok");
    });
    store.putPlant({ ...plantFixture(), plot: "pot", worktreePath: pot, cwd: pot, potPending: true, status: "error", error: "interrupted" });
    const gh = new Greenhouse(store, { ...base, query: fn });
    await gh.send("p", "carry on");
    const p = await until(store, "p", (x) => x.turns === 1);
    expect(p.potPending).toBeUndefined();
    expect(calls[0].cwd).toBe(pot);
    expect(store.journalPage("p").entries.some((e) => /interrupted: running its setup again/.test(e.text))).toBe(true);
    rmRepo(pot);
  });

  it("queues a plant when memory is full and starts it when the pool frees up", async () => {
    let room = 0;
    const { fn, calls } = fakeQuery(async function* () {
      yield success("ok");
    });
    const gh = new Greenhouse(store, { ...base, query: fn, pool: { canAdmit: () => room, register() {}, unregister() {} } });
    const plant = gh.sow({ bedId: "bed", prompt: "wait your turn", permissionMode: "default" });
    const queued = await until(store, plant.id, (p) => !!p.queued);
    expect(queued.activityDetail).toMatch(/free pot/);
    expect(calls).toHaveLength(0);
    room = 1;
    gh.drain();
    await until(store, plant.id, (p) => p.turns === 1 && !p.queued);
    expect(calls).toHaveLength(1);
  });

  it("closes the longest-idle plant under memory pressure and never a busy one", async () => {
    const { fn } = fakeQuery(async function* () {
      yield success("ok");
    });
    const gh = new Greenhouse(store, { ...base, query: fn });
    const a = gh.sow({ bedId: "bed", prompt: "a", permissionMode: "default" });
    await until(store, a.id, (p) => p.turns === 1);
    expect(gh.liveCount()).toBe(1);
    expect(gh.reapOne()).toBe(true);
    await until(store, a.id, (p) => !p.live);
    expect(gh.reapOne()).toBe(false);
  });
});

function plantFixture(over: Partial<Plant> = {}): Plant {
  return {
    id: "p",
    bedId: "bed",
    name: "p",
    species: "rose",
    seed: "s",
    origin: "sown",
    plot: "bed",
    permissionMode: "default",
    status: "idle",
    live: false,
    turns: 0,
    toolCalls: 0,
    costUsd: 0,
    runners: 0,
    unread: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("Greenhouse rings (real git)", () => {
  let dir: string;
  let repo: string;
  let store: GardenStore;
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-rings-"));
    repo = mkdtempSync(join(tmpdir(), "terrarium-repo-"));
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "T");
    g("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    store = new GardenStore(dir);
    store.putBed({ id: "bed", name: "repo", path: repo, createdAt: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmRepo(repo);
  });

  it("records a ring per turn with its diff, then prunes files and conversation back", async () => {
    let turn = 0;
    const { fn, calls } = fakeQuery(async function* () {
      turn++;
      // Changes made "by a shell command" (not an Edit tool) must still show up.
      writeFileSync(join(repo, "a.txt"), turn === 1 ? "one\ntwo\n" : "one\ntwo\nthree\n");
      if (turn === 2) writeFileSync(join(repo, "new.txt"), "fresh\n");
      yield assistant([{ type: "text", text: `turn ${turn}` }], `uuid-${turn}`);
      yield success("ok");
    });
    const ends: number[] = [];
    const gh = new Greenhouse(store, { ...base, onTurnEnd: (_p, r) => r && ends.push(r.n), query: fn });
    const plant = gh.sow({ bedId: "bed", prompt: "first", permissionMode: "default" });
    await until(store, plant.id, (p) => p.ring === 1);
    await gh.send(plant.id, "second");
    await until(store, plant.id, (p) => p.ring === 2);
    expect(ends).toEqual([1, 2]);

    const rings = store.rings(plant.id);
    expect(rings.map((r) => [r.n, r.checkpoint, r.diff?.files])).toEqual([
      [1, "ready", 1],
      [2, "ready", 2],
    ]);
    expect((await gh.diffFiles(plant.id, { kind: "turn", n: 2 })).map((f) => f.path).sort()).toEqual(["a.txt", "new.txt"]);
    expect(await gh.diffFile(plant.id, { kind: "turn", n: 1 }, "a.txt")).toContain("+two");

    const result = await gh.pruneTo(plant.id, 1);
    expect(result).toMatchObject({ filesRestored: true, conversationRewound: true });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(() => readFileSync(join(repo, "new.txt"))).toThrow();
    expect(store.plants.get(plant.id)).toMatchObject({ ring: 1, resumeAt: "uuid-1" });
    expect(store.rings(plant.id).find((r) => r.n === 2)?.pruned).toBe(true);

    await gh.send(plant.id, "try again");
    await until(store, plant.id, (p) => p.ring === 3);
    expect(calls.at(-1)).toMatchObject({ resume: "sess-1", resumeSessionAt: "uuid-1" });
  }, 30_000);
});

describe("mainCheckoutGuard", () => {
  const guard = mainCheckoutGuard("C:\\work\\repo", "C:\\Users\\me\\AppData\\Terrarium\\plots\\repo\\fix-1");
  const run = (command: string) => guard({ tool_input: { command } } as never, undefined, { signal: new AbortController().signal });

  it("refuses commands that name the main checkout", async () => {
    expect(await run("cd C:\\work\\repo && npm test")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await run("cat c:/work/repo/src/a.ts")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("allows commands inside the pot or that mention neither", async () => {
    expect(await run("npm test")).toEqual({});
    expect(await run("ls C:\\Users\\me\\AppData\\Terrarium\\plots\\repo\\fix-1\\src")).toEqual({});
  });
});
