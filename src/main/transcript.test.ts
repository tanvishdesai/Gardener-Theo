import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptParser, TranscriptTail } from "./transcript";

const FIXTURE = join(__dirname, "__fixtures__", "transcripts", "session.jsonl");
const fixture = (sid = "S", cwd = "/repo", entry = "cli") => readFileSync(FIXTURE, "utf8").replaceAll("__SID__", sid).replaceAll("__CWD__", cwd.replace(/\\/g, "\\\\")).replaceAll("__ENTRY__", entry);
const j = (o: object) => JSON.stringify(o);

describe("TranscriptParser", () => {
  it("summarizes a session: skips meta, command echoes, sidechains, bad and unwanted lines; last cost-state wins", () => {
    const p = new TranscriptParser("S");
    for (const l of fixture().split("\n")) p.push(l);
    expect(p.summary).toMatchObject({
      cwd: "/repo",
      seed: "fix the build",
      title: "Build fix",
      model: "claude-opus-5-5",
      permissionMode: "acceptEdits",
      turns: 1,
      toolCalls: 1,
      costUsd: 1.25,
      lastText: "Fixed.",
      phase: "idle",
      entrypoint: "cli",
    });
    expect(p.summary.modelCosts?.["claude-haiku-5-5"].costUSD).toBe(0.05);
    expect(p.summary.updatedAt - p.summary.createdAt).toBe(5 * 60_000 + 1000);
    const entries = p.takeEntries();
    expect(entries.map((e) => e.kind)).toEqual(["user", "thinking", "tool", "text"]);
    expect(entries.find((e) => e.kind === "tool")?.tool).toMatchObject({ name: "Bash", summary: "npm test", activity: "run", status: "error", output: "boom" });
    expect(p.takeEntries()).toEqual([]);
  });

  it("dedupes usage by message id + request id, keeping the final (largest) counts, sidechains included", () => {
    const p = new TranscriptParser("S");
    for (const l of fixture().split("\n")) p.push(l);
    const u = p.takeUsage();
    expect(u.map((r) => r.messageId)).toEqual(["msg_1", "msg_side", "msg_2"]);
    expect(u[0]).toMatchObject({ sessionId: "S", model: "claude-opus-5-5", input: 10, output: 50, cacheRead: 1000, cacheWrite: 200, requestId: "req_1" });
    expect(p.takeUsage()).toEqual([]);
    // A later streamed copy with more output comes back once, updated.
    p.push(j({ type: "assistant", requestId: "req_2", message: { id: "msg_2", model: "claude-opus-5-5", content: [], usage: { input_tokens: 20, output_tokens: 31 } } }));
    expect(p.takeUsage()).toMatchObject([{ messageId: "msg_2", output: 31, cacheRead: 2000 }]);
  });

  it("pairs a tool with its result later, reporting the tool entry again, and tracks the phase", () => {
    const p = new TranscriptParser("S");
    p.push(j({ type: "user", uuid: "u1", message: { content: "go" } }));
    expect(p.summary.phase).toBe("thinking");
    p.push(j({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }] } }));
    expect(p.pendingTools).toBe(1);
    expect(p.summary).toMatchObject({ phase: "working", lastActivity: { activity: "search", detail: "/x/" } });
    expect(p.takeEntries()).toMatchObject([{ kind: "user" }, { id: "tool:t1", tool: { status: "running" } }]);
    p.push(j({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] } }));
    expect(p.pendingTools).toBe(0);
    expect(p.summary.phase).toBe("thinking");
    expect(p.takeEntries()).toMatchObject([{ id: "tool:t1", tool: { status: "ok", output: "a\nb" } }]);
    p.push(j({ type: "user", uuid: "i1", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    expect(p.summary).toMatchObject({ phase: "idle", turns: 1 });
  });

  it("keeps up to 64 KB of a tool result", () => {
    const p = new TranscriptParser("S");
    p.push(j({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));
    p.push(j({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(100_000) }] } }));
    expect(p.takeEntries().at(-1)?.tool?.output?.length).toBe(64 * 1024);
  });

  it("summary mode keeps no entries; usage mode parses only usage", () => {
    const s = new TranscriptParser("S", "summary");
    const u = new TranscriptParser("S", "usage");
    for (const l of fixture().split("\n")) {
      s.push(l);
      u.push(l);
    }
    expect(s.takeEntries()).toEqual([]);
    expect(s.summary).toMatchObject({ turns: 1, toolCalls: 1, title: "Build fix" });
    expect(u.takeUsage()).toHaveLength(3);
    expect(u.summary).toMatchObject({ turns: 0, costUsd: 1.25, cwd: "/repo" });
  });
});

describe("TranscriptTail", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const mk = () => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-tail-"));
    return join(dir, "S.jsonl");
  };

  it("leaves a partial last line for the next read", async () => {
    const f = mk();
    const line = j({ type: "user", uuid: "u1", message: { content: "hello there" } });
    writeFileSync(f, line.slice(0, 20));
    const t = new TranscriptTail(f, "S");
    expect(await t.read()).toEqual({ lines: 0 });
    expect(t.offset).toBe(0);
    appendFileSync(f, `${line.slice(20)}\r\n`);
    expect(await t.read()).toEqual({ lines: 1 });
    expect(t.parser.summary.seed).toBe("hello there");
    expect(t.offset).toBe(Buffer.byteLength(line) + 2);
    expect(await t.read()).toEqual({ lines: 0 });
  });

  it("reads lines larger than a chunk and skips huge unwanted lines", async () => {
    const f = mk();
    const big = "é".repeat(200_000); // multi-byte characters straddling chunk edges
    writeFileSync(
      f,
      [
        `{"type":"api-request-blob","data":"${"z".repeat(600_000)}"}`,
        j({ type: "user", uuid: "u1", message: { content: big } }),
        j({ type: "ai-title", aiTitle: "T" }),
        "",
      ].join("\n"),
    );
    const t = new TranscriptTail(f, "S");
    expect(await t.read()).toEqual({ lines: 3 });
    expect(t.parser.summary).toMatchObject({ seed: big, title: "T" });
  });

  it("restarts from 0 with a fresh parser when the file shrinks", async () => {
    const f = mk();
    const prompt = (t: string) => `${j({ type: "user", uuid: t, message: { content: t } })}\n`;
    writeFileSync(f, prompt("one") + prompt("two"));
    const t = new TranscriptTail(f, "S");
    await t.read();
    expect(t.parser.summary.turns).toBe(2);
    writeFileSync(f, prompt("new"));
    await t.read();
    expect(t.parser.summary).toMatchObject({ turns: 1, seed: "new" });
  });
});
