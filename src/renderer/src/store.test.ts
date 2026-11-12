import { describe, expect, it } from "vitest";
import { urgency } from "../../shared/garden";
import type { GardenEvent, Plant, PlantStatus } from "../../shared/types";
import { formatTags, initialState, isGrowing, isHarvest, mergeFresh, needsYou, reduce, type GardenState } from "./store";

const plant = (id: string, bedId: string, at: number, p: Partial<Plant> = {}): Plant => ({
  id,
  bedId,
  name: id,
  species: "tulip",
  seed: "",
  origin: "sown",
  permissionMode: "default",
  status: "idle",
  live: false,
  turns: 0,
  toolCalls: 0,
  costUsd: 0,
  runners: 0,
  unread: false,
  plot: "bed",
  createdAt: at,
  updatedAt: at,
  ...p,
});

/** What the incremental indexes must equal: a full recompute from s.plants. */
function recompute(s: GardenState) {
  const all = Object.values(s.plants);
  const byBed: Record<string, string[]> = {};
  for (const p of [...all].sort((a, b) => a.createdAt - b.createdAt)) (byBed[p.bedId] ??= []).push(p.id);
  const needy = all.filter(needsYou).sort((a, b) => urgency(a) - urgency(b) || s.needSince[a.id] - s.needSince[b.id] || (a.id < b.id ? -1 : 1));
  return {
    byBed,
    needs: needy.map((p) => p.id),
    counts: {
      needsYou: needy.length,
      growing: all.filter(isGrowing).length,
      harvest: all.filter(isHarvest).length,
      waiting: all.filter((p) => p.status === "waiting").length,
      live: all.filter((p) => p.live).length,
      total: all.length,
    },
  };
}

describe("renderer store reducer", () => {
  it("keeps byBed, needsYouIds and counts equal to a full recompute under random events", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const statuses: PlantStatus[] = ["idle", "thinking", "working", "waiting", "error"];
    let s = initialState();
    let t = 1;
    for (let round = 0; round < 300; round++) {
      const events: GardenEvent[] = [];
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) {
        const id = `p${Math.floor(rnd() * 40)}`;
        const r = rnd();
        if (!s.plants[id] && !events.some((e) => e.type === "plant" && e.plant.id === id)) events.push({ type: "plant", plant: plant(id, `b${Math.floor(rnd() * 4)}`, t++) });
        else if (r < 0.08) events.push({ type: "plant:removed", id });
        else {
          const status = statuses[Math.floor(rnd() * statuses.length)];
          const kind = (["permission", "question", "plan"] as const)[Math.floor(rnd() * 3)];
          events.push({
            type: "plant:patch",
            id,
            patch: { status, live: rnd() < 0.5, unread: rnd() < 0.3, updatedAt: t++, ask: status === "waiting" ? { id: "a", kind, toolName: "Bash", title: "", detail: "", canAlwaysAllow: false, createdAt: t++ } : undefined },
          });
        }
      }
      const before = s;
      s = reduce(s, [{ type: "batch", events }]);
      const want = recompute(s);
      const got = Object.fromEntries(Object.entries(s.byBed).filter(([, ids]) => ids.length));
      expect(got).toEqual(want.byBed);
      expect(s.needsYouIds).toEqual(want.needs);
      expect(s.counts).toMatchObject(want.counts);
      expect(before).not.toBe(s);
    }
  });

  it("a patch replaces only that plant object", () => {
    let s = reduce(initialState(), [
      { type: "plant", plant: plant("a", "b", 1) },
      { type: "plant", plant: plant("b", "b", 2) },
    ]);
    const a = s.plants.a;
    const byBed = s.byBed;
    s = reduce(s, [{ type: "plant:patch", id: "b", patch: { toolCalls: 3 } }]);
    expect(s.plants.a).toBe(a);
    expect(s.plants.b.toolCalls).toBe(3);
    expect(s.byBed).toBe(byBed);
  });
});

describe("journal paging", () => {
  const e = (seq: number) => ({ id: `e${seq}`, plantId: "p", seq, ts: seq, kind: "text" as const, text: "" });
  it("keeps older cached pages only when they join the fresh page", () => {
    const cached = { entries: [1, 2, 3, 4, 5].map(e), hasMore: true, loading: false };
    expect(mergeFresh(cached, { entries: [5, 6, 7].map(e), hasMore: true }).entries.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const gap = mergeFresh(cached, { entries: [9, 10].map(e), hasMore: true });
    expect(gap.entries.map((x) => x.seq)).toEqual([9, 10]);
  });
});

describe("review tags", () => {
  it("serializes tags as structured context", () => {
    expect(
      formatTags([{ id: "t", path: "src/a.ts", startLine: 12, endLine: 18, hunk: "@@ -12,2 +12,3 @@\n-a\n+b\n", note: "Use the helper" }]),
    ).toBe("Review tags:\n- file: src/a.ts\n  range: L12-L18\n  note: Use the helper\n  diff:\n    @@ -12,2 +12,3 @@\n    -a\n    +b");
  });
});
