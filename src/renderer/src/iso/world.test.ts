import { describe, expect, it } from "vitest";
import { spiralSlot } from "../../../shared/garden";
import type { Bed, Plant, SoilReport } from "../../../shared/types";
import { syntheticGarden } from "../synthetic";
import { deriveScene, staleRects } from "./scene";
import { TileCache, tileKey, tileRect, tilesIn } from "./tiles";
import { buildWorld, capacity, findPath, groundAt, inside, intersects, PLANTER, rectOfTiles, slotsForBeds, slotTile, SpatialIndex, type BedSpec, type Rect } from "./world";

const bed = (id: string, gridX?: number, gridY?: number): Bed => ({ id, name: id, path: `/r/${id}`, createdAt: 0, gridX, gridY });
const soil = (p: Partial<SoilReport> = {}): SoilReport => ({ exists: true, isGitRepo: true, dirty: 0, ahead: 0, behind: 0, guidance: [], ci: [], tests: [], lint: [], checkedAt: 0, ...p });
const NOW = 1_000_000_000_000;
const plant = (id: string, bedId: string, p: Partial<Plant> = {}): Plant => ({
  id,
  bedId,
  name: id,
  species: "daisy",
  seed: "",
  origin: "sown",
  permissionMode: "default",
  status: "idle",
  live: false,
  turns: 1,
  toolCalls: 0,
  costUsd: 0,
  runners: 0,
  unread: false,
  plot: "bed",
  createdAt: 0,
  updatedAt: NOW,
  ...p,
});

describe("spiralSlot", () => {
  it("walks the documented square spiral", () => {
    const want = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
      [2, -1],
      [2, 0],
      [2, 1],
      [2, 2],
      [1, 2],
    ];
    expect(want.map((_, k) => [spiralSlot(k).x, spiralSlot(k).y])).toEqual(want);
  });

  it("never repeats a slot and fills each square ring before the next", () => {
    const seen = new Set<string>();
    for (let k = 0; k < 25; k++) {
      const s = spiralSlot(k);
      const key = `${s.x},${s.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // the first 25 slots are exactly the 5x5 square around the greenhouse
    for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) expect(seen.has(`${x},${y}`)).toBe(true);
    const many = new Set(Array.from({ length: 2000 }, (_, k) => `${spiralSlot(k).x},${spiralSlot(k).y}`));
    expect(many.size).toBe(2000);
  });
});

describe("layout", () => {
  it("keeps stored slots and gives beds without one the first free spiral slots", () => {
    const slots = slotsForBeds([bed("a", 1, 0), bed("b"), bed("c", 1, 0), bed("d", 0, 0)]);
    expect(slots.get("a")).toEqual({ x: 1, y: 0 });
    // b, c (clash) and d (the greenhouse's slot) fall back to the spiral, skipping taken slots
    expect([slots.get("b"), slots.get("c"), slots.get("d")]).toEqual([
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: -1, y: 1 },
    ]);
  });

  it("never moves a bed when other beds are added, removed or resized", () => {
    const spec = (id: string, k: number, lines: 1 | 2 = 1): BedSpec => ({ bedId: id, ...spiralSlot(k), lines });
    const before = buildWorld([spec("a", 1), spec("b", 2), spec("c", 3)]);
    const after = buildWorld([spec("a", 1), spec("c", 3, 2), spec("d", 4), spec("e", 9, 2)]);
    for (const id of ["a", "c"]) {
      const x = before.lotByBed.get(id)!;
      const y = after.lotByBed.get(id)!;
      expect([y.gx, y.gy, y.cell]).toEqual([x.gx, x.gy, x.cell]);
    }
    expect(after.lotByBed.get("a")!.rect).toEqual(before.lotByBed.get("a")!.rect);
    // resizing only grows the planter inside the bed's own cell
    const c = after.lotByBed.get("c")!;
    expect(c.planter.lines).toBe(2);
    expect(capacity(c)).toBe(14);
  });

  it("covers every occupied slot with island, each plant slot on a planter tile", () => {
    const specs: BedSpec[] = Array.from({ length: 30 }, (_, i) => ({ bedId: `b${i}`, ...spiralSlot(i + 1), lines: (i % 2 ? 2 : 1) as 1 | 2 }));
    const w = buildWorld(specs);
    for (const lot of w.lots) {
      for (const t of [lot.sign, lot.compost, lot.tray]) expect(inside(w, t.gx, t.gy)).toBe(true);
      for (let k = 0; k < capacity(lot); k++) {
        const s = slotTile(lot, k);
        expect(groundAt(w, s.gx, s.gy)).toBe(PLANTER);
        expect(w.blocked[(s.stand.gy - w.y0) * w.cols + (s.stand.gx - w.x0)]).toBe(0);
      }
      const f = rectOfTiles(lot.gx, lot.gy, lot.w, lot.d);
      expect(f.x >= w.bounds.x && f.y >= w.bounds.y && f.x + f.w <= w.bounds.x + w.bounds.w && f.y + f.h <= w.bounds.y + w.bounds.h).toBe(true);
    }
    expect(inside(w, w.home.gx, w.home.gy)).toBe(true);
    expect(inside(w, w.newGround.gx + w.newGround.w - 1, w.newGround.gy + w.newGround.d - 1)).toBe(true);
    // the empty plot is on the next free slot
    expect(Math.floor(w.newGround.gx / 10)).toBe(spiralSlot(31).x);
  });

  it("walks the gardener around planters, never through them", () => {
    const w = buildWorld([1, 2, 3, 5, 8].map((k, i) => ({ bedId: `b${i}`, ...spiralSlot(k), lines: 2 as const })));
    const target = slotTile(w.lotByBed.get("b4")!, 3).stand;
    const path = findPath(w, w.home, target);
    expect(path.at(-1)).toEqual(target);
    let prev = w.home;
    for (const step of path) {
      expect(w.blocked[(step.gy - w.y0) * w.cols + (step.gx - w.x0)]).toBe(0);
      expect(Math.abs(step.gx - prev.gx) + Math.abs(step.gy - prev.gy)).toBe(1);
      prev = step;
    }
  });
});

describe("SpatialIndex", () => {
  it("returns exactly the rectangles that intersect the query", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 4000 - 2000;
    const rects: Rect[] = Array.from({ length: 300 }, () => ({ x: r(), y: r(), w: Math.abs(r()) / 8 + 1, h: Math.abs(r()) / 8 + 1 }));
    const index = new SpatialIndex<number>(256);
    rects.forEach((rc, i) => index.insert(i, rc));
    for (let q = 0; q < 50; q++) {
      const view = { x: r(), y: r(), w: 700, h: 450 };
      const want = rects.flatMap((rc, i) => (intersects(rc, view) ? [i] : [])).sort((a, b) => a - b);
      expect(index.query(view).sort((a, b) => a - b)).toEqual(want);
    }
  });
});

describe("tile cache", () => {
  const beds = [bed("a", 1, 0), bed("b", 1, 1), bed("c", -1, 0), bed("d", 2, 2)];
  const soils = Object.fromEntries(beds.map((b) => [b.id, soil()]));
  const input = (s: Record<string, SoilReport>, plants: Record<string, Plant> = {}) => ({ beds, plants, soil: s });

  it("repaints only the tiles a changed bed overlaps", () => {
    const one = deriveScene(input(soils), NOW, null);
    const cache = new TileCache<number>(1000);
    const all = tilesIn(one.world.bounds).map((t) => tileKey("g0", t.tx, t.ty));
    for (const k of all) cache.set(k, 1);
    // bed b gets tests (a fence): its look changed, nobody else's did
    const two = deriveScene(input({ ...soils, b: soil({ tests: ["vitest"] }) }), NOW, one);
    const stale = staleRects(one, two);
    expect(stale).not.toBe("all");
    const dropped = (stale as Rect[]).flatMap((r) => cache.invalidate(r));
    const cell = two.views.get("b")!.lot.cell;
    expect(dropped.length).toBeGreaterThan(0);
    for (const k of all) {
      const [, tx, ty] = k.split("|").map(Number);
      expect(cache.has(k)).toBe(!intersects(tileRect(tx, ty), cell));
    }
  });

  it("keeps every tile when only a plant's state changes", () => {
    const p = { p1: plant("p1", "a") };
    const one = deriveScene(input(soils, p), NOW, null);
    const two = deriveScene(input(soils, { p1: { ...p.p1, toolCalls: 5 } }), NOW, one);
    expect(two.world).toBe(one.world);
    expect(staleRects(one, two)).toEqual([]);
  });

  it("evicts least recently used tiles", () => {
    const cache = new TileCache<number>(2);
    cache.set("a|0|0", 1);
    cache.set("a|1|0", 2);
    cache.get("a|0|0");
    cache.set("a|2|0", 3);
    expect([cache.has("a|0|0"), cache.has("a|1|0"), cache.has("a|2|0")]).toEqual([true, false, true]);
  });
});

describe("plants in the ground", () => {
  it("draws at most 14 plants of a 200-plant bed, live ones first, the rest in the catalogue", () => {
    const g = syntheticGarden({ beds: 10, plants: 1000, live: 30, seed: 3, now: NOW });
    const plants = Object.fromEntries(g.plants.map((p) => [p.id, p]));
    const scene = deriveScene({ beds: g.beds, plants, soil: g.soil }, NOW, null);
    const big = scene.views.get("bed-0")!;
    expect(g.plants.filter((p) => p.bedId === "bed-0")).toHaveLength(200);
    expect(big.ground.length).toBeLessThanOrEqual(14);
    expect(big.ground.length + big.catalogue).toBe(200);
    expect(big.ground.length).toBeLessThanOrEqual(capacity(big.lot));
    for (const p of g.plants.filter((p) => p.bedId === "bed-0" && p.status === "waiting")) expect(big.ground).toContain(p);
    let drawn = 0;
    for (const v of scene.views.values()) drawn += v.ground.length;
    expect(drawn).toBeLessThanOrEqual(14 * 10);
  });

  it("uses an S planter up to 7 plants in the ground and an M planter above", () => {
    const mk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, plant(`p${i}`, "a", { createdAt: i })]));
    const s7 = deriveScene({ beds: [bed("a", 1, 0)], plants: mk(7), soil: {} }, NOW, null);
    const s8 = deriveScene({ beds: [bed("a", 1, 0)], plants: mk(8), soil: {} }, NOW, null);
    expect(s7.views.get("a")!.lot.planter.lines).toBe(1);
    expect(s8.views.get("a")!.lot.planter.lines).toBe(2);
    expect(s8.views.get("a")!.lot.cell).toEqual(s7.views.get("a")!.lot.cell);
  });
});
