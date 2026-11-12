import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bed } from "../shared/types";
import { countHistory, importHistory, parseSession } from "./history";
import { GardenStore } from "./store";

const FIXTURE = join(__dirname, "__fixtures__", "transcripts", "session.jsonl");
const fixture = (sid: string, cwd: string, isoDay = "2026-11-10") =>
  readFileSync(FIXTURE, "utf8").replaceAll("__SID__", sid).replaceAll("__CWD__", cwd.replace(/\\/g, "\\\\")).replaceAll("__ENTRY__", "cli").replaceAll("2026-11-10", isoDay);
const j = (o: object) => JSON.stringify(o);

describe("parseSession (back-compat)", () => {
  it("counts human turns and tools, pairs tool results, and takes cost and title", async () => {
    const s = await parseSession([
      j({ type: "permission-mode", permissionMode: "acceptEdits" }),
      j({ type: "user", uuid: "u1", cwd: "/repo", timestamp: "2026-01-01T00:00:00Z", message: { content: "fix the build" } }),
      j({ type: "assistant", uuid: "a1", message: { model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
      j({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] } }),
      j({ type: "assistant", uuid: "a2", timestamp: "2026-01-01T00:05:00Z", message: { content: [{ type: "text", text: "Fixed." }] } }),
      j({ type: "ai-title", aiTitle: "Build fix" }),
      j({ type: "cost-state", totalCostUSD: 1.25 }),
    ]);
    expect(s).toMatchObject({ cwd: "/repo", seed: "fix the build", title: "Build fix", model: "claude-x", permissionMode: "acceptEdits", turns: 1, toolCalls: 1, costUsd: 1.25, lastText: "Fixed." });
    expect(s.entries.find((e) => e.kind === "tool")?.tool).toMatchObject({ status: "error", output: "boom" });
  });
});

describe("importHistory", () => {
  let tmp: string;
  let projects: string;
  let store: GardenStore;
  // The repo itself is a plantable folder (temp dirs are not).
  const repo = process.cwd();
  const addBed = (path: string): Bed => {
    for (const b of store.beds.values()) if (b.path === path) return b;
    return store.putBed({ id: `bed-${store.beds.size}`, name: basename(path), path, createdAt: 0 });
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gardener-hist-"));
    projects = join(tmp, "projects");
    store = new GardenStore(join(tmp, "data"));
    const folder = join(projects, "C--repo");
    mkdirSync(join(folder, "s0", "subagents"), { recursive: true });
    for (let i = 0; i < 9; i++) writeFileSync(join(folder, `s${i}.jsonl`), fixture(`s${i}`, repo, `2026-11-0${i + 1}`));
    writeFileSync(join(folder, "s0", "subagents", "agent-1.jsonl"), fixture("s0", repo)); // not a session
    mkdirSync(join(projects, "tmp"));
    writeFileSync(join(projects, "tmp", "t1.jsonl"), fixture("t1", join(tmpdir(), "scratch")));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the newest 7 sessions per folder as imported plants with their journals, and skips known ones", async () => {
    expect(await importHistory(store, addBed, { projectsDir: projects })).toEqual({ added: 7 });
    const plants = [...store.plants.values()];
    expect(plants.map((p) => p.id).sort()).toEqual(["s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
    expect(store.beds.size).toBe(1);
    const p = store.plants.get("s8")!;
    expect(p).toMatchObject({ origin: "imported", plot: "bed", cwd: repo, sessionId: "s8", name: "Build fix", turns: 1, toolCalls: 1, costUsd: 1.25, permissionMode: "acceptEdits", status: "idle", live: false });
    const page = store.journalPage("s8");
    expect(page.entries.map((e) => e.kind)).toEqual(["user", "thinking", "tool", "text"]);
    expect(page.entries[2].tool).toMatchObject({ status: "error", output: "boom" });

    expect(await importHistory(store, addBed, { projectsDir: projects })).toEqual({ added: 0 });
    expect(await importHistory(store, addBed, { projectsDir: projects, perBed: 9 })).toEqual({ added: 2 });
  });

  it("counts sessions and plantable folders from the file heads", async () => {
    expect(await countHistory(projects)).toEqual({ sessions: 10, beds: 1 });
    expect(await countHistory(join(tmp, "missing"))).toEqual({ sessions: 0, beds: 0 });
  });
});
