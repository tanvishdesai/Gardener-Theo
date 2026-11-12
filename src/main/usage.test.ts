import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countHistory, defaultProjectsDir } from "./history";
import { GardenStore } from "./store";
import { Almanac, localDay } from "./usage";

const FIXTURE = join(__dirname, "__fixtures__", "transcripts", "session.jsonl");
const fixture = (sid: string, cwd: string) => readFileSync(FIXTURE, "utf8").replaceAll("__SID__", sid).replaceAll("__CWD__", cwd.replace(/\\/g, "\\\\")).replaceAll("__ENTRY__", "cli");
const row = (sid: string, id: string, iso: string, model: string, usage: object, cwd = "/elsewhere") =>
  `${JSON.stringify({ type: "assistant", sessionId: sid, cwd, timestamp: iso, requestId: `req-${id}`, message: { id, model, content: [], usage } })}\n`;

const A_DAY = "2026-11-10T12:00:00.000Z";
const B_DAY = "2026-11-09T12:00:00.000Z";
const NOW = Date.parse("2026-11-10T13:00:00.000Z");

describe("Almanac", () => {
  let tmp: string;
  let projects: string;
  let store: GardenStore;
  const repo = process.cwd();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "terrarium-usage-"));
    projects = join(tmp, "projects");
    store = new GardenStore(join(tmp, "data"));
    const folder = join(projects, "C--repo");
    mkdirSync(join(folder, "A", "subagents"), { recursive: true });
    // A: Claude Code's cost-state says $1.25 (opus $1.20, haiku $0.05). Its subagent's tokens are billed to it.
    writeFileSync(join(folder, "A.jsonl"), fixture("A", repo));
    writeFileSync(join(folder, "A", "subagents", "agent-1.jsonl"), row("A", "msg_sub", A_DAY, "claude-opus-5-5", { input_tokens: 100 }));
    // B: no cost-state; priced from A's opus $/unit (A's opus units: 610 + 370 + 100 = 1080, so 1080 units = $1.20).
    writeFileSync(join(folder, "B.jsonl"), row("B", "msg_b", B_DAY, "claude-opus-5-5", { input_tokens: 1080 }, repo.toUpperCase()));
    // C: a model nobody has a cost for.
    writeFileSync(join(folder, "C.jsonl"), row("C", "msg_c", A_DAY, "mystery-1", { input_tokens: 7, output_tokens: 3 }));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prices rows from Claude Code's own cost, buckets local days, and attributes beds", async () => {
    const bed = store.putBed({ id: "b1", name: "repo", path: repo, createdAt: 0 });
    store.putPlant({ id: "pa", bedId: bed.id, name: "Build fix", species: "rose", seed: "", origin: "imported", sessionId: "A", permissionMode: "default", status: "idle", live: false, turns: 1, toolCalls: 1, costUsd: 1.25, runners: 0, unread: false, plot: "bed", createdAt: 0, updatedAt: 0 });
    const al = new Almanac(store, projects);
    expect(await al.scan()).toEqual({ files: 4, rows: 6 });

    const r = al.report(7, NOW);
    expect(r.days).toHaveLength(7);
    expect(r.days.at(-1)?.day).toBe(localDay(NOW));
    const day = (iso: string) => r.days.find((d) => d.day === localDay(Date.parse(iso)))!;
    expect(day(A_DAY).costUsd).toBeCloseTo(1.25, 6); // matches cost-state exactly; C adds tokens but no cost
    expect(day(B_DAY).costUsd).toBeCloseTo(1.2, 6);
    expect(r.totalCostUsd).toBeCloseTo(2.45, 6);
    expect(r.estimated).toBe(true);
    expect(day(A_DAY)).toMatchObject({ inputTokens: 10 + 100 + 20 + 100 + 7, outputTokens: 50 + 10 + 30 + 3, cacheReadTokens: 3000, cacheWriteTokens: 200 });
    expect(r.cacheHitRatio).toBeCloseTo(3000 / (10 + 100 + 20 + 100 + 1080 + 7 + 3000 + 200), 6);

    expect(r.byModel.map((m) => [m.key, Number(m.costUsd.toFixed(4))])).toEqual([
      ["claude-opus-5-5", 2.4],
      ["claude-haiku-5-5", 0.05],
      ["mystery-1", 0],
    ]);
    // A via its plant, B via its cwd (case-insensitive on Windows), C elsewhere.
    const beds = Object.fromEntries(r.byBed.map((b) => [b.label, Number(b.costUsd.toFixed(4))]));
    expect(beds).toEqual(process.platform === "win32" ? { repo: 2.45, "Other folders": 0 } : { repo: 1.25, "Other folders": 1.2 });
    expect(r.byPlant).toEqual([{ key: "pa", label: "Build fix", costUsd: expect.closeTo(1.25, 6), tokens: expect.any(Number), turns: 1 }]);

    // One day back excludes B.
    expect(al.report(1, NOW).totalCostUsd).toBeCloseTo(1.25, 6);
  });

  it("matches cost-state totals and is exact (not estimated) when every session has one", async () => {
    rmSync(join(projects, "C--repo", "B.jsonl"));
    rmSync(join(projects, "C--repo", "C.jsonl"));
    const al = new Almanac(store, projects);
    await al.scan();
    const r = al.report(30, NOW);
    expect(Math.abs(r.totalCostUsd - 1.25) / 1.25).toBeLessThan(0.01);
    expect(r.estimated).toBe(false);
  });

  it("scans incrementally: unchanged files are skipped, appended bytes are read once", async () => {
    const al = new Almanac(store, projects);
    await al.scan();
    expect(await al.scan()).toEqual({ files: 0, rows: 0 });
    appendFileSync(join(projects, "C--repo", "C.jsonl"), row("C", "msg_c2", A_DAY, "mystery-1", { input_tokens: 1 }));
    expect(await al.scan()).toEqual({ files: 1, rows: 1 });
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n).toBe(7);
  });

  // Opt-in, read-only measurement on this machine's real history: TERRARIUM_PERF=1 npm test -- src/main/usage.test.ts
  it.skipIf(!process.env.TERRARIUM_PERF)(
    "scans the real ~/.claude/projects without blocking the event loop",
    async () => {
      const h = monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      const al = new Almanac(store, defaultProjectsDir());
      let t = performance.now();
      const res = await al.scan();
      const first = performance.now() - t;
      h.disable();
      t = performance.now();
      await al.scan();
      const second = performance.now() - t;
      t = performance.now();
      const r = al.report(3650);
      const rep = performance.now() - t;
      t = performance.now();
      const counted = await countHistory();
      const count = performance.now() - t;
      const cs = (store.db.prepare("SELECT SUM(cost_usd) AS c FROM usage_sessions").get() as { c: number }).c;
      console.log(
        JSON.stringify({ ...res, firstScanMs: Math.round(first), maxLoopDelayMs: Math.round(h.max / 1e6), p99LoopDelayMs: Math.round(h.percentile(99) / 1e6), rescanMs: Math.round(second), reportMs: Math.round(rep), countHistoryMs: Math.round(count), counted, almanacTotal: r.totalCostUsd, costStateTotal: cs, estimated: r.estimated }),
      );
    },
    600_000,
  );
});
