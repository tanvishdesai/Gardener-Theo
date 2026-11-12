import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GardenEvent, Plant } from "../shared/types";
import { GardenStore, INTERRUPTED_POT } from "./store";

const plant = (over: Partial<Plant> = {}): Plant => ({
  id: "p1",
  bedId: "b1",
  name: "Fix login",
  species: "tulip",
  seed: "fix the login redirect",
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
  ...over,
});

describe("GardenStore (SQLite)", () => {
  let dir: string;
  let store: GardenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-store-"));
    store = new GardenStore(dir);
    store.putBed({ id: "b1", name: "repo", path: "/work/repo", createdAt: 0 });
    store.putPlant(plant());
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns permanent spiral grid slots and persists across reopen", () => {
    store.putBed({ id: "b2", name: "two", path: "/work/two", createdAt: 0 });
    store.updatePlant("p1", { turns: 3, status: "error", error: "boom" });
    store.close();
    store = new GardenStore(dir);
    expect(store.beds.get("b1")).toMatchObject({ gridX: 1, gridY: 0 });
    expect(store.beds.get("b2")).toMatchObject({ gridX: 1, gridY: 1 });
    expect(store.plants.get("p1")).toMatchObject({ turns: 3, status: "error", error: "boom" });
  });

  it("loses only uncommitted writes when the process dies", () => {
    store.flush();
    store.updatePlant("p1", { turns: 9 });
    // Simulate a crash: a second connection sees only committed data.
    const other = new GardenStore(dir);
    expect(other.plants.get("p1")!.turns).toBe(0);
    other.close();
  });

  it("restores busy plants to idle after a restart", () => {
    store.updatePlant("p1", { status: "working", live: true, activity: "run" });
    store.close();
    store = new GardenStore(dir);
    expect(store.plants.get("p1")).toMatchObject({ status: "idle", live: false, activity: undefined });
  });

  it("keeps entry order stable across upserts and pages from the newest", () => {
    for (let i = 0; i < 250; i++) store.upsertEntry({ id: `e${i}`, plantId: "p1", ts: i, kind: "text", text: `line ${i}` });
    store.upsertEntry({ id: "e5", plantId: "p1", ts: 5, kind: "text", text: "edited" });
    const first = store.journalPage("p1");
    expect(first.entries).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    expect(first.entries.at(-1)!.id).toBe("e249");
    const older = store.journalPage("p1", first.entries[0].seq!, 200);
    expect(older.hasMore).toBe(false);
    expect(older.entries.find((e) => e.id === "e5")!.text).toBe("edited");
    expect(store.entryCount("p1")).toBe(250);
  });

  it("moves big tool output to a blob and keeps a preview", () => {
    const big = "x".repeat(50_000) + "END";
    const stored = store.upsertEntry({ id: "tool:t1", plantId: "p1", ts: 1, kind: "tool", text: "Bash", tool: { id: "t1", name: "Bash", summary: "ls", activity: "run", status: "ok", output: big } })!;
    expect(stored.tool!.output!.length).toBe(4096);
    expect(stored.tool!.outputTruncated).toBe(true);
    expect(store.toolOutput("p1", "tool:t1")).toBe(big);
  });

  it("searches plant names and journal text (FTS5 trigram)", () => {
    store.upsertEntry({ id: "u1", plantId: "p1", ts: 1, kind: "user", text: "please refactor the websocket reconnect loop" });
    store.upsertEntry({ id: "u1", plantId: "p1", ts: 1, kind: "user", text: "please refactor the websocket reconnect loop now" });
    expect(store.search("login")[0]).toMatchObject({ plantId: "p1" });
    expect(store.search("login")[0].entryId).toBeUndefined();
    const hits = store.search("reconnect").filter((h) => h.entryId === "u1");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("reconnect");
    expect(store.search("zzzz-not-there")).toHaveLength(0);
  });

  it("stores rings with checkpoint metadata and prunes later rings", () => {
    store.putRing({ plantId: "p1", n: 1, prompt: "a", startedAt: 1, checkpoint: "ready" }, { ckptBefore: "aaa" });
    store.updateRing("p1", 1, { endedAt: 2, ok: true }, { ckptAfter: "bbb", assistantUuid: "u-1" });
    store.putRing({ plantId: "p1", n: 2, prompt: "b", startedAt: 3, checkpoint: "ready" });
    store.pruneRingsAfter("p1", 1);
    expect(store.ringMeta("p1", 1)).toEqual({ ckptBefore: "aaa", ckptAfter: "bbb", assistantUuid: "u-1" });
    expect(store.rings("p1").map((r) => [r.n, !!r.pruned])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("deletes a bed's plants and journal by cascade", () => {
    store.upsertEntry({ id: "e1", plantId: "p1", ts: 1, kind: "text", text: "hi" });
    const events: GardenEvent["type"][] = [];
    store.on((e) => events.push(e.type));
    store.deleteBed("b1");
    store.flush();
    expect(store.plants.size).toBe(0);
    expect(events).toEqual(["plant:removed", "bed:removed"]);
    expect(store.entryCount("p1")).toBe(0);
  });

  it("emits field patches with long text clipped", () => {
    const events: GardenEvent[] = [];
    store.on((e) => events.push(e));
    store.updatePlant("p1", { lastText: "y".repeat(5000) });
    const e = events[0] as Extract<GardenEvent, { type: "plant:patch" }>;
    expect(e.type).toBe("plant:patch");
    expect(e.patch.lastText!.length).toBeLessThan(700);
    expect(store.plants.get("p1")!.lastText!.length).toBe(5000);
  });

  it("reports a pot whose setup was interrupted, once, and keeps it wilted until fixed", () => {
    store.putPlant(plant({ id: "pot1", plot: "pot", potPending: true, status: "thinking", activityDetail: "Preparing the pot · setup" }));
    store.close();
    store = new GardenStore(dir);
    expect(store.plants.get("pot1")).toMatchObject({ status: "error", error: INTERRUPTED_POT, potPending: true });
    const warnings = () => store.journalPage("pot1").entries.filter((e) => e.text === INTERRUPTED_POT).length;
    expect(warnings()).toBe(1);
    store.close();
    store = new GardenStore(dir);
    expect(warnings()).toBe(1);
  });

  it("persists settings over defaults", () => {
    expect(store.settings().idleMinutes).toBe(30);
    store.setSettings({ maxLive: 6, onboarded: true });
    store.close();
    store = new GardenStore(dir);
    expect(store.settings()).toMatchObject({ maxLive: 6, onboarded: true, idleMinutes: 30 });
  });
});

describe("V1 import", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-v1-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves garden.json and journals into SQLite, then renames them", () => {
    const v1Plant = plant({ id: "sess-1", sessionId: "sess-1" }) as Partial<Plant>;
    delete v1Plant.origin;
    delete v1Plant.plot;
    writeFileSync(join(dir, "garden.json"), JSON.stringify({ version: 1, beds: [{ id: "b1", name: "repo", path: "/work/repo", createdAt: 0 }], plants: [v1Plant] }));
    mkdirSync(join(dir, "journals"));
    writeFileSync(join(dir, "journals", "sess-1.json"), JSON.stringify([{ id: "e1", plantId: "sess-1", ts: 1, kind: "user", text: "hello" }]));
    const store = new GardenStore(dir);
    expect(store.plants.get("sess-1")).toMatchObject({ origin: "imported", plot: "bed", cwd: "/work/repo" });
    expect(store.journalPage("sess-1").entries.map((e) => e.text)).toEqual(["hello"]);
    store.close();
    expect(existsSync(join(dir, "garden.json"))).toBe(false);
    expect(existsSync(join(dir, "garden.json.v1.bak"))).toBe(true);
    expect(existsSync(join(dir, "journals.v1.bak"))).toBe(true);
  });

  it("refuses to start over an unreadable V1 garden and leaves it untouched", () => {
    writeFileSync(join(dir, "garden.json"), "{ not json");
    expect(() => new GardenStore(dir)).toThrow(/Could not read the V1 garden/);
    expect(existsSync(join(dir, "garden.json"))).toBe(true);
  });
});
