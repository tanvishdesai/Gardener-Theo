import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plant } from "../shared/types";
import { runCommand, StakeRunner, summarize } from "./stakes";
import { GardenStore } from "./store";

const plant = (over: Partial<Plant> = {}): Plant => ({
  id: "p1",
  bedId: "b1",
  name: "p1",
  species: "tulip",
  seed: "",
  origin: "sown",
  plot: "bed",
  permissionMode: "default",
  status: "idle",
  live: false,
  turns: 1,
  toolCalls: 0,
  costUsd: 0,
  runners: 0,
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("summarize", () => {
  const r = (code: number, output: string) => ({ code, output, timedOut: false });
  it("reads test runner totals, tsc errors, or falls back to the exit code", () => {
    expect(summarize(r(0, ""), 1000)).toBe("passed");
    expect(summarize(r(1, " Test Files  1 failed | 2 passed (3)\n      Tests  3 failed | 9 passed (12)\n"), 1000)).toBe("3 failures");
    expect(summarize(r(1, "Tests:       1 failed, 4 passed, 5 total"), 1000)).toBe("1 failure");
    expect(summarize(r(2, "src/a.ts(1,7): error TS2322: x\nFound 2 errors in 1 file.\n"), 1000)).toBe("2 errors");
    expect(summarize(r(2, "src/a.ts(1,7): error TS2322: x\n"), 1000)).toBe("1 error");
    expect(summarize(r(7, "boom"), 1000)).toBe("exit code 7");
    expect(summarize({ code: -1, output: "", timedOut: true }, 600_000)).toBe("timed out after 600 s");
  });
});

describe("StakeRunner", () => {
  let dir: string;
  let store: GardenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-stakes-"));
    store = new GardenStore(join(dir, "data"));
    store.putBed({ id: "b1", name: "repo", path: dir, createdAt: 0 });
    store.putPlant(plant());
    store.putRing({ plantId: "p1", n: 1, prompt: "do it", startedAt: 0, checkpoint: "none" });
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("returns undefined when the bed has no stake", async () => {
    expect(await new StakeRunner({ store }).run("p1", 1)).toBeUndefined();
  });

  it("records a pass on the plant, the ring and the journal", async () => {
    store.updateBed("b1", { stakeCommand: `node -e "console.log('all good')"` });
    const res = await new StakeRunner({ store }).run("p1", 1);
    expect(res).toMatchObject({ status: "passing", summary: "passed", turn: 1 });
    expect(store.plants.get("p1")?.stake?.status).toBe("passing");
    expect(store.ring("p1", 1)?.stake?.status).toBe("passing");
    const entries = store.journalPage("p1").entries;
    expect(entries.map((e) => e.kind)).toEqual(["tool", "system"]);
    expect(entries[0].tool).toMatchObject({ name: "Stake", status: "ok" });
    expect(entries[0].tool?.output).toContain("all good");
    expect(entries[1].text).toBe(`Checked the stake: \`node -e "console.log('all good')"\` — passed`);
  });

  it("records a failure with a summary and the output tail", async () => {
    const cmd = `node -e "console.error('Tests  3 failed | 1 passed'); process.exit(1)"`;
    store.updateBed("b1", { stakeCommand: cmd });
    const res = await new StakeRunner({ store }).run("p1", 1);
    expect(res).toMatchObject({ status: "failing", summary: "3 failures" });
    const [tool, msg] = store.journalPage("p1").entries;
    expect(tool.tool).toMatchObject({ status: "error", summary: cmd });
    expect(tool.tool?.output).toContain("3 failed");
    expect(msg).toMatchObject({ kind: "error", text: `Checks failed after this turn: \`${cmd}\` (3 failures)` });
    expect(store.ring("p1", 1)?.stake?.summary).toBe("3 failures");
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(dir, "grandchild.pid");
    // The child starts a grandchild that writes its pid and then never exits.
    writeFileSync(join(dir, "grandchild.js"), `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    writeFileSync(join(dir, "child.js"), `require("child_process").spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.js"))}], { stdio: "inherit" }); setInterval(() => {}, 1000);`);
    const cmd = "node child.js";
    const started = Date.now();
    const r = await runCommand(cmd, dir, 1500);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 500));
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
