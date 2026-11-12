import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAsk, Plant } from "../../shared/types";
import { Announcer, plantChange, sentence, type Kind } from "./a11y";

const plant = (p: Partial<Plant> = {}): Plant => ({
  id: "p1",
  bedId: "b1",
  name: "Tulip",
  species: "tulip",
  seed: "",
  origin: "sown",
  permissionMode: "default",
  status: "working",
  live: true,
  turns: 1,
  toolCalls: 0,
  costUsd: 0,
  runners: 0,
  unread: false,
  plot: "bed",
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

const ask = (p: Partial<PendingAsk> = {}): PendingAsk => ({ id: "a1", kind: "permission", toolName: "Bash", title: "", detail: "", canAlwaysAllow: true, createdAt: 0, ...p });

describe("plantChange", () => {
  it("announces entering a state, not staying in it", () => {
    const working = plant();
    const waiting = plant({ status: "waiting", ask: ask() });
    expect(plantChange(working, waiting)).toBe("need");
    expect(plantChange(waiting, { ...waiting, updatedAt: 5 })).toBeNull();
    expect(plantChange(working, plant({ status: "error" }))).toBe("wilt");
    expect(plantChange(working, plant({ status: "idle", unread: true }))).toBe("ready");
  });

  it("announces a new ask while still waiting", () => {
    const waiting = plant({ status: "waiting", ask: ask() });
    expect(plantChange(waiting, { ...waiting, ask: ask({ id: "a2" }) })).toBe("need");
  });

  it("ignores the snapshot, new plants, archived plants and unread plants that start growing again", () => {
    expect(plantChange(undefined, plant({ status: "waiting", ask: ask() }))).toBeNull();
    expect(plantChange(plant(), plant({ status: "error", archivedAt: 1 }))).toBeNull();
    // A volunteer can start its next turn before you read the last one: still unread, but not "ready".
    expect(plantChange(plant({ status: "waiting", unread: true }), plant({ status: "working", unread: true }))).toBeNull();
    expect(plantChange(plant({ status: "idle", unread: true }), plant({ status: "idle", unread: true, turns: 2 }))).toBeNull();
  });
});

describe("sentence", () => {
  const item = (kind: Kind, p: Partial<Plant> = {}) => ({ kind, plant: plant(p), bed: "t3code" });

  it("names a single plant and what it needs", () => {
    expect(sentence([item("need", { status: "waiting", ask: ask() })])).toBe("Tulip in t3code needs your permission to run a command.");
    expect(sentence([item("need", { status: "waiting", ask: ask({ kind: "question", toolName: "AskUserQuestion" }) })])).toBe("Tulip in t3code has a question for you.");
    expect(sentence([item("need", { status: "waiting", ask: ask({ toolName: "mcp__postgres__run_query" }) })])).toBe("Tulip in t3code needs your permission to use run_query from postgres.");
    expect(sentence([item("need", { status: "waiting", ask: ask({ toolName: "WebFetch" }) })])).toBe("Tulip in t3code needs your permission to fetch from the web.");
    expect(sentence([item("wilt")])).toBe("Tulip in t3code wilted: its turn stopped with an error.");
  });

  it("counts several of a kind, most urgent first", () => {
    const s = sentence([item("ready"), item("ready", { name: "Rose" }), item("need", { name: "Fern", status: "waiting", ask: ask({ kind: "plan" }) }), item("ready", { name: "Iris" })]);
    expect(s).toBe("Fern in t3code wants you to approve a plan. 3 plants finished a turn and are ready to read.");
    expect(sentence([])).toBe("");
  });
});

describe("Announcer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst, keeps each plant's latest change, and spaces announcements out", () => {
    const said: [string, Kind][][] = [];
    const a = new Announcer((c) => said.push([...c]), 1000, 5000);
    a.push("p1", "need");
    a.push("p2", "need");
    vi.advanceTimersByTime(500);
    a.push("p1", "wilt");
    vi.advanceTimersByTime(499);
    expect(said).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(said).toEqual([
      [
        ["p2", "need"],
        ["p1", "wilt"],
      ],
    ]);

    // The next change comes soon after: held until 5 s after the last announcement.
    vi.advanceTimersByTime(1000);
    a.push("p3", "ready");
    vi.advanceTimersByTime(3999);
    expect(said).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(said[1]).toEqual([["p3", "ready"]]);
  });
});
