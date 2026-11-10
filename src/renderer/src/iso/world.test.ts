import { describe, expect, it } from "vitest";
import type { Bed, Plant } from "../../../shared/types";
import { buildWorld, findPath, PER_LINE } from "./world";

const bed = (id: string): Bed => ({ id, name: id, path: `/r/${id}`, createdAt: 0 });
const plant = (id: string, bedId: string): Plant =>
  ({ id, bedId, name: id, species: "daisy", seed: "", permissionMode: "default", status: "idle", live: false, turns: 0, toolCalls: 0, costUsd: 0, runners: 0, unread: false, createdAt: 0, updatedAt: 0 }) as Plant;

describe("buildWorld", () => {
  const beds = [bed("a"), bed("b"), bed("c")];
  const many = Array.from({ length: PER_LINE + 3 }, (_, i) => plant(`p${i}`, "a"));
  const world = buildWorld(beds, { a: many, b: [plant("q", "b")], c: [] });
  const at = (gx: number, gy: number) => gy * world.cols + gx;

  it("puts every plant on its own planter tile, with a walkable spot in front", () => {
    const seen = new Set<string>();
    for (const lot of world.lots)
      for (const s of lot.slots) {
        expect(world.ground[at(s.gx, s.gy)]).toBe("planter");
        expect(world.blocked[at(s.stand.gx, s.stand.gy)]).toBe(0);
        const key = `${s.gx},${s.gy}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    // a bed with more plants than one line holds grows a second line
    expect(world.lots[0].planter.lines).toBe(2);
    expect(world.lots[0].slots).toHaveLength(many.length + 1);
  });

  it("walks the gardener around planters, never through them", () => {
    const target = world.lots[2].slots[0].stand;
    const path = findPath(world, world.home, target);
    expect(path.at(-1)).toEqual(target);
    let prev = world.home;
    for (const step of path) {
      expect(world.blocked[at(step.gx, step.gy)]).toBe(0);
      expect(Math.abs(step.gx - prev.gx) + Math.abs(step.gy - prev.gy)).toBe(1);
      prev = step;
    }
  });
});
