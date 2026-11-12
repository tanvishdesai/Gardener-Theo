import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plant, SoilReport } from "../shared/types";
import { localDay, SoilScheduler } from "./soilScheduler";
import { GardenStore } from "./store";

const settle = () => new Promise((r) => setTimeout(r, 0));

const report = (at: number, over: Partial<SoilReport> = {}): SoilReport => ({
  exists: true,
  isGitRepo: true,
  dirty: 0,
  ahead: 0,
  behind: 0,
  guidance: ["CLAUDE.md"],
  ci: [],
  tests: ["test"],
  lint: [],
  stakeCandidates: ["npm test"],
  checkedAt: at,
  ...over,
});

const plant = (id: string, bedId: string): Plant => ({
  id,
  bedId,
  name: id,
  species: "tulip",
  seed: "",
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
  createdAt: 1,
  updatedAt: 1,
});

describe("SoilScheduler", () => {
  let dir: string;
  let store: GardenStore;
  let clock: number;
  let sched: SoilScheduler | undefined;
  const now = () => clock;
  const addBeds = (n: number) => {
    for (let i = 0; i < n; i++) store.putBed({ id: `b${i}`, name: `b${i}`, path: join(dir, "missing", `b${i}`), createdAt: 0 });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-sched-"));
    store = new GardenStore(join(dir, "data"));
    clock = new Date(2026, 10, 11, 12).getTime();
  });
  afterEach(async () => {
    sched?.stop();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("runs at most `concurrency` reads, dedupes per bed and lets 'now' jump the queue", async () => {
    addBeds(5);
    const order: string[] = [];
    const waiting = new Map<string, () => void>();
    sched = new SoilScheduler({
      store,
      concurrency: 2,
      now,
      read: (root) => {
        const id = root.split(/[\\/]/).pop()!;
        order.push(id);
        return new Promise((res) => waiting.set(id, () => res(report(clock))));
      },
    });
    sched.request("b0", "idle");
    sched.request("b1", "idle");
    sched.request("b2", "idle");
    sched.request("b3", "active");
    sched.request("b2", "idle"); // duplicate
    sched.request("b4", "now");
    sched.request("b3", "idle"); // lower priority than pending: ignored
    expect(order).toEqual(["b0", "b1"]);
    waiting.get("b0")!();
    await settle();
    expect(order).toEqual(["b0", "b1", "b4"]);
    waiting.get("b1")!();
    await settle();
    waiting.get("b4")!();
    await settle();
    waiting.get("b3")!();
    await settle();
    expect(order).toEqual(["b0", "b1", "b4", "b3", "b2"]);
  });

  it("staggers 100 idle beds over the 5 minute interval", async () => {
    addBeds(100);
    const reads: number[] = [];
    sched = new SoilScheduler({ store, concurrency: 100, now, read: async () => (reads.push(clock), report(clock)) });
    const t0 = clock;
    sched.tick();
    await settle();
    expect(reads).toHaveLength(100);
    reads.length = 0;
    for (let s = 1; s <= 300; s++) {
      clock = t0 + s * 1000;
      sched.tick();
      await settle();
    }
    expect(reads).toHaveLength(100); // each bed once more
    const perSecond = new Map<number, number>();
    for (const t of reads) perSecond.set(t, (perSecond.get(t) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(5);
  });

  it("refreshes beds with recent activity every 20 s, others every 5 min", async () => {
    addBeds(2);
    const reads: string[] = [];
    sched = new SoilScheduler({ store, now, read: async (root) => (reads.push(root.split(/[\\/]/).pop()!), report(clock)) });
    sched.tick();
    await settle();
    sched.markActive("b0");
    reads.length = 0;
    const t0 = clock;
    for (let s = 1; s <= 120; s++) {
      clock = t0 + s * 1000;
      sched.tick();
      await settle();
    }
    expect(reads.filter((b) => b === "b0").length).toBeGreaterThanOrEqual(5);
    expect(reads.filter((b) => b === "b1").length).toBeLessThanOrEqual(1);
  });

  it("reuses hygiene checks until invalidated, an hour passes, or the user asks", async () => {
    addBeds(1);
    const reuses: boolean[] = [];
    sched = new SoilScheduler({ store, now, read: async (_root, reuse) => (reuses.push(!!reuse), report(clock)) });
    const read = async (p: "idle" | "now" = "idle") => {
      sched!.request("b0", p);
      await settle();
    };
    await read();
    await read();
    sched.invalidateHygiene("b0");
    await read();
    await read();
    clock += 61 * 60_000;
    await read();
    await read("now");
    expect(reuses).toEqual([false, true, false, true, false, false]);
  });

  it("scores health with the bed's stake pass rate and records it once per day", async () => {
    addBeds(1);
    store.putPlant(plant("p1", "b0"));
    const stake = (status: "passing" | "failing", at: number) => ({ status, command: "npm test", at });
    store.putRing({ plantId: "p1", n: 1, prompt: "", startedAt: 0, checkpoint: "none", stake: stake("passing", 1) });
    store.putRing({ plantId: "p1", n: 2, prompt: "", startedAt: 0, checkpoint: "none", stake: stake("failing", 2) });
    store.putRing({ plantId: "p1", n: 3, prompt: "", startedAt: 0, checkpoint: "none" });
    sched = new SoilScheduler({ store, now, read: async () => report(clock) });
    expect(sched.stakePassRate("b0")).toBe(0.5);
    sched.request("b0", "now");
    await settle();
    // guidance + tests = 40, + 20 × 0.5
    expect(store.soil.get("b0")?.health).toBe(50);
    expect(store.soilHistory("b0")).toEqual([{ day: localDay(clock), health: 50 }]);
  });
});
