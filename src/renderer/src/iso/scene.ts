// From store state to pixels: which plants stand in which slot (PLAN D9: at most 14 per bed), the cached
// ground tiles, and one frame of the garden (or of the zoom-1 map). Cost scales with what is on screen.
import { bedMood, groundPlants, type BedMood } from "../../../shared/garden";
import type { Bed, Plant, SoilReport, Weather } from "../../../shared/types";
import { INK, MOOD_COLOR, P, TINT, type Phase } from "./palette";
import {
  animates,
  bubble,
  bubbleFor,
  compostBin,
  drawPlantCached,
  fence,
  gardener as paintGardener,
  glow,
  greenhouse,
  newGroundPlot,
  paintIsland,
  paintPlant,
  planterBlock,
  plantHeight,
  prism,
  puff,
  seedTray,
  showTally,
  signpost,
  skyCanvas,
  tally,
  tileCursor,
  tree,
  weatherFx,
} from "./paint";
import { hashString, makeCanvas, px, rect, type Ctx, type Pt } from "./raster";
import { TILE, tileKey, tileRect, tilesIn, type TileCache } from "./tiles";
import {
  BLOCK_H,
  buildWorld,
  capacity,
  CELL_D,
  CELL_W,
  cellRect,
  HEADROOM,
  intersects,
  iso,
  linesFor,
  rectOfTiles,
  slotsForBeds,
  slotTile,
  tileAt,
  type BedSpec,
  type Lot,
  type Rect,
  type World,
} from "./world";

export interface SceneInput {
  beds: Bed[];
  plants: Record<string, Plant>;
  /** Plant ids per bed in creation order (store index). Derived here when the store has none. */
  byBed?: Record<string, string[]>;
  soil: Record<string, SoilReport>;
}

export interface BedView {
  bed: Bed;
  lot: Lot;
  ground: Plant[];
  catalogue: number;
  mood: BedMood;
  staked: boolean;
  /** Everything the cached tiles show about this bed; a change repaints only its tiles. */
  sig: string;
  pips: { needs: number; failing: number; growing: number; harvest: number };
}

export interface Scene {
  world: World;
  layoutKey: string;
  views: Map<string, BedView>;
  /** Where each plant in the ground stands. */
  slotOf: Map<string, { lot: Lot; k: number }>;
  /** For the canvas aria-label. */
  summary: string;
}

let grouped: { plants: Record<string, Plant>; out: Record<string, string[]> } | null = null;
function groupByBed(plants: Record<string, Plant>) {
  if (grouped?.plants === plants) return grouped.out;
  const out: Record<string, string[]> = {};
  for (const p of Object.values(plants).sort((a, b) => a.createdAt - b.createdAt)) (out[p.bedId] ??= []).push(p.id);
  grouped = { plants, out };
  return out;
}

export function deriveScene(inp: SceneInput, now: number, prev: Scene | null): Scene {
  const byBed = inp.byBed ?? groupByBed(inp.plants);
  const slots = slotsForBeds(inp.beds);
  const specs: BedSpec[] = [];
  const pending: Omit<BedView, "lot">[] = [];
  const total = { plants: 0, needs: 0, wilted: 0, growing: 0, harvest: 0 };
  for (const bed of inp.beds) {
    const all: Plant[] = [];
    for (const id of byBed[bed.id] ?? []) {
      const p = inp.plants[id];
      if (p) all.push(p);
    }
    const { ground, catalogue } = groundPlants(all, now);
    const lines = linesFor(ground.length);
    const s = slots.get(bed.id)!;
    specs.push({ bedId: bed.id, x: s.x, y: s.y, lines });
    const pips = { needs: 0, failing: 0, growing: 0, harvest: 0 };
    for (const p of all) {
      if (p.status === "waiting") pips.needs++;
      else if (p.status === "error" || p.stake?.status === "failing" || (p.pr?.state === "open" && p.pr.checks === "failing")) pips.failing++;
      else if (p.status === "thinking" || p.status === "working") pips.growing++;
      else if (p.unread) pips.harvest++;
      if (p.status === "error") total.wilted++;
    }
    total.plants += all.length;
    total.needs += pips.needs;
    total.growing += pips.growing;
    total.harvest += pips.harvest;
    const soil = inp.soil[bed.id];
    const mood = bedMood(all);
    const loose = Math.min(PLANTER_MAX, Math.ceil((soil?.dirty ?? 0) / 2));
    const sig = [lines, soil?.tests.length ? 1 : 0, soil?.guidance.length ? 1 : 0, soil?.lint.length ? 1 : 0, loose, mood, catalogue.length ? 1 : 0].join("");
    pending.push({ bed, ground, catalogue: catalogue.length, mood, staked: (soil?.ci.length ?? 0) > 0, sig, pips });
  }
  const layoutKey = specs.map((s) => `${s.bedId}:${s.x},${s.y},${s.lines}`).join("|");
  const world = prev?.layoutKey === layoutKey ? prev.world : buildWorld(specs);
  const views = new Map<string, BedView>();
  const slotOf = new Map<string, { lot: Lot; k: number }>();
  for (const v of pending) {
    const lot = world.lotByBed.get(v.bed.id)!;
    views.set(v.bed.id, { ...v, lot });
    v.ground.forEach((p, k) => slotOf.set(p.id, { lot, k }));
  }
  const summary =
    `Garden view: ${inp.beds.length} beds, ${total.plants} plants. ` +
    `${total.needs} need you, ${total.wilted} wilted, ${total.growing} growing, ${total.harvest} ready to harvest. ` +
    "Bed name tags in view are buttons; the Seed Catalogue lists every plant.";
  return { world, layoutKey, views, slotOf, summary };
}
const PLANTER_MAX = 14;

/** World rects whose cached tiles must be repainted going from `prev` to `next`, or "all". */
export function staleRects(prev: Scene | null, next: Scene): Rect[] | "all" {
  if (!prev) return "all";
  const a = prev.world;
  const b = next.world;
  if (a.x0 !== b.x0 || a.y0 !== b.y0 || a.cols !== b.cols || a.rows !== b.rows) return "all";
  const out: Rect[] = [];
  for (const [id, v] of next.views) {
    const old = prev.views.get(id);
    if (!old || old.sig !== v.sig || old.lot.sx !== v.lot.sx || old.lot.sy !== v.lot.sy) {
      out.push(v.lot.cell);
      if (old) out.push(old.lot.cell);
    }
  }
  for (const [id, old] of prev.views) if (!next.views.has(id)) out.push(old.lot.cell);
  if (a.newGround.gx !== b.newGround.gx || a.newGround.gy !== b.newGround.gy)
    for (const ng of [a.newGround, b.newGround]) out.push(cellRect(Math.floor(ng.gx / CELL_W), Math.floor(ng.gy / CELL_D)));
  return out;
}

// ---------- cached tiles ----------

type Item = { key: number; sub: number; gx: number; draw: (c: Ctx) => void };

export const lightOf = (phase: Phase) => (phase === "night" ? 2 : phase === "dusk" ? 1 : 0);

function staticItems(scene: Scene, soilMap: Record<string, SoilReport>, r: Rect, light: number): Item[] {
  const w = scene.world;
  const items: Item[] = [];
  const add = (gx: number, gy: number, sub: number, draw: (c: Ctx) => void) => items.push({ key: gx + gy, sub, gx, draw });
  const night = light === 2;
  for (const lot of w.index.query(r)) {
    const v = scene.views.get(lot.bedId);
    if (!v) continue;
    const soil = soilMap[lot.bedId];
    const p = lot.planter;
    const isPlanter = (gx: number, gy: number) => gx >= p.gx && gx < p.gx + p.len && gy >= p.gy && gy < p.gy + p.lines;
    const looseCount = Math.min(p.len * p.lines, Math.ceil((soil?.dirty ?? 0) / 2));
    let k = 0;
    for (let gy = p.gy; gy < p.gy + p.lines; gy++)
      for (let gx = p.gx; gx < p.gx + p.len; gx++) {
        const i = k++;
        const loose = (i < looseCount && (gx * 7 + gy * 3) % 2 === 0) || (looseCount > 0 && i === 0);
        add(gx, gy, 0, (c) => planterBlock(c, gx, gy, { nw: !isPlanter(gx - 1, gy), ne: !isPlanter(gx, gy - 1), sw: !isPlanter(gx, gy + 1), se: !isPlanter(gx + 1, gy) }, soil, loose));
      }
    if (soil && soil.tests.length > 0) {
      for (let gx = lot.gx; gx < lot.gx + lot.w; gx++) add(gx, lot.gy, -1, (c) => fence(c, gx, lot.gy, "ne"));
      for (let gy = lot.gy; gy < lot.gy + lot.d; gy++) add(lot.gx, gy, -1, (c) => fence(c, lot.gx, gy, "nw"));
    }
    add(lot.sign.gx, lot.sign.gy, 1, (c) => signpost(c, lot.sign.gx, lot.sign.gy, night, MOOD_COLOR[v.mood]));
    if (soil && soil.guidance.length > 0) add(lot.compost.gx, lot.compost.gy, 1, (c) => compostBin(c, lot.compost.gx, lot.compost.gy));
    if (v.catalogue > 0) add(lot.tray.gx, lot.tray.gy, 1, (c) => seedTray(c, lot.tray.gx, lot.tray.gy));
  }
  const gh = w.greenhouse;
  if (intersects(rectOfTiles(gh.gx, gh.gy, gh.w, gh.d + 1), { ...r, h: r.h + HEADROOM }))
    add(gh.gx + gh.w - 1, gh.gy + gh.d - 1, 1, (c) => greenhouse(c, gh, w.home, light > 0));
  if (intersects(w.newGround.rect, r)) add(w.newGround.gx, w.newGround.gy, -2, (c) => newGroundPlot(c, w.newGround));
  for (const t of w.trees) {
    const q = iso(t.gx, t.gy);
    if (q.x + 14 < r.x || q.x - 14 > r.x + r.w || q.y + 14 < r.y || q.y - 36 > r.y + r.h) continue;
    add(t.gx, t.gy, 1, (c) => tree(c, t.gx, t.gy, t.size));
  }
  items.sort((a, b) => a.key - b.key || a.sub - b.sub || a.gx - b.gx);
  return items;
}

export function buildTile(scene: Scene, soil: Record<string, SoilReport>, tx: number, ty: number, light: number): HTMLCanvasElement {
  const r = tileRect(tx, ty);
  const { cv, c } = makeCanvas(TILE, TILE);
  c.translate(-r.x, -r.y);
  paintIsland(c, scene.world, r);
  for (const it of staticItems(scene, soil, r, light)) it.draw(c);
  return cv;
}

// ---------- one frame ----------

export type Selection = { kind: "plant" | "bed"; id: string } | null;

export type Hit =
  | { kind: "plant"; id: string }
  | { kind: "slot"; bedId: string }
  | { kind: "bed"; bedId: string }
  | { kind: "compost"; bedId: string }
  | { kind: "tray"; bedId: string }
  | { kind: "newground" };

export interface Frame {
  main: Ctx;
  layer: Ctx;
  /** Canvas size in canvas pixels. */
  vw: number;
  vh: number;
  /** World px at the canvas's top-left corner. */
  cam: Pt;
  scene: Scene;
  soil: Record<string, SoilReport>;
  tags: Record<string, unknown[] | undefined>;
  selection: Selection;
  hover: Hit | null;
  phase: Phase;
  weather?: Weather;
  reduced: boolean;
  now: number;
  gardener: { x: number; y: number; facing: "front" | "back"; flip: boolean; step: number; key: number } | null;
  puffs: { x: number; y: number; k: number }[];
  tiles: TileCache<HTMLCanvasElement>;
  /** Tiles that may still be built this frame (the rest are drawn next frame). */
  buildBudget: number;
}

export interface FrameResult {
  /** Something visible moves: keep ticking at 8 fps. */
  animating: boolean;
  lots: Lot[];
  /** Visible tiles not built yet (budget ran out). */
  missing: number;
}

export function drawGarden(f: Frame): FrameResult {
  const { layer: c, scene, cam } = f;
  const w = scene.world;
  const view: Rect = { x: cam.x, y: cam.y, w: f.vw, h: f.vh };
  const light = lightOf(f.phase);
  const night = f.phase === "night";
  const frame = f.reduced ? 0 : Math.floor(f.now / 125);
  let missing = 0;

  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, f.vw, f.vh);
  c.translate(-cam.x, -cam.y);
  for (const { tx, ty } of tilesIn(view)) {
    if (!intersects(tileRect(tx, ty), w.bounds)) continue;
    const key = tileKey(`g${light}`, tx, ty);
    let cv = f.tiles.get(key);
    if (!cv) {
      if (f.buildBudget <= 0) {
        missing++;
        continue;
      }
      f.buildBudget--;
      cv = buildTile(scene, f.soil, tx, ty, light);
      f.tiles.set(key, cv);
    }
    c.drawImage(cv, tx * TILE, ty * TILE);
  }

  const lots = w.index.query(view);
  const items: Item[] = [];
  const labels: (() => void)[] = [];
  const lights: [number, number, number][] = [];
  let animating = false;
  const sel = f.selection;
  for (const lot of lots) {
    const v = scene.views.get(lot.bedId);
    if (!v) continue;
    if (sel?.kind === "bed" && sel.id === lot.bedId) {
      const p = lot.planter;
      for (let gy = p.gy; gy < p.gy + p.lines; gy++)
        for (let gx = p.gx; gx < p.gx + p.len; gx++) {
          const q = iso(gx, gy);
          tileCursor(c, q.x, q.y - BLOCK_H, P.gold, true);
        }
    }
    if (light > 0) {
      const q = iso(lot.sign.gx, lot.sign.gy);
      lights.push([q.x - 10, q.y - 4, 22]);
    }
    v.ground.forEach((plant, k) => {
      const t = slotTile(lot, k);
      const q = iso(t.gx, t.gy);
      const bx = q.x;
      const by = q.y + 8 - BLOCK_H;
      const moving = !f.reduced && animates(plant);
      if (moving) animating = true;
      const selected = sel?.kind === "plant" && sel.id === plant.id;
      const hovered = f.hover?.kind === "plant" && f.hover.id === plant.id;
      const seed = hashString(plant.id) % 97;
      const tags = f.tags[plant.id]?.length ?? 0;
      items.push({
        key: t.gx + t.gy,
        sub: 1,
        gx: t.gx,
        draw: () => {
          if (selected) tileCursor(c, q.x, q.y - BLOCK_H, P.gold);
          else if (hovered) tileCursor(c, q.x, q.y - BLOCK_H, "rgba(255,255,255,.85)");
          const o = { plant, bx, by, frame, staked: v.staked, reduced: f.reduced, seed, tags };
          const head = moving ? paintPlant(c, o) : drawPlantCached(c, o);
          const kind = bubbleFor(plant);
          if (kind) labels.push(() => bubble(c, kind, head.x, head.y - 2, frame + seed, f.reduced));
          if (showTally(plant, f.now)) labels.push(() => tally(c, bx + 6, by - Math.min(plantHeight(plant), 24) - 4, plant.lastDiff!.insertions, plant.lastDiff!.deletions));
        },
      });
    });
    if (v.ground.length < capacity(lot)) {
      const t = slotTile(lot, v.ground.length);
      const q = iso(t.gx, t.gy);
      const bx = q.x;
      const by = q.y + 8 - BLOCK_H;
      items.push({
        key: t.gx + t.gy,
        sub: 1,
        gx: t.gx,
        draw: () => {
          const col = f.hover?.kind === "slot" && f.hover.bedId === lot.bedId ? "#ffffff" : "#f6e7c4";
          px(c, bx, by - 2, col);
          rect(c, bx - 1, by - 1, 3, 1, col);
          px(c, bx, by, col);
        },
      });
    }
  }
  const g = f.gardener;
  if (g) {
    const q = iso(g.x, g.y);
    if (intersects({ x: q.x - 8, y: q.y - 14, w: 16, h: 26 }, view))
      items.push({ key: g.key, sub: 2, gx: g.x, draw: () => paintGardener(c, q.x, q.y + 10, g.facing, g.flip, g.step) });
  }
  items.sort((a, b) => a.key - b.key || a.sub - b.sub || a.gx - b.gx);
  for (const it of items) it.draw(c);

  const tint = TINT[f.phase];
  if (tint) {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-atop";
    c.fillStyle = tint;
    c.fillRect(0, 0, f.vw, f.vh);
    c.restore();
  }
  if (light > 0) {
    const d = iso(w.home.gx, w.home.gy);
    lights.push([d.x, d.y - 6, 40]);
    for (const [x, y, r] of lights) glow(c, x, y, night ? r : r * 0.6);
  }
  // bubbles and tallies are interface, so they stay readable after dark
  for (const l of labels) l();
  for (const p of f.puffs) {
    const q = iso(p.x, p.y);
    puff(c, q.x, q.y + 10, p.k);
  }

  f.main.setTransform(1, 0, 0, 1, 0, 0);
  f.main.drawImage(skyCanvas(f.vw, f.vh, f.phase), 0, 0);
  weatherFx(f.main, f.vw, f.vh, f.weather, f.now, f.reduced, f.phase);
  f.main.drawImage(c.canvas, 0, 0);
  return { animating: animating || (!f.reduced && !!f.weather && f.weather.status !== "clear"), lots, missing };
}

// ---------- the map (zoom 1) ----------

/** World px per screen px in the map view. */
export const MAP_DIV = 3;

const PIP = { needs: P.amber, failing: P.red, growing: "#5cbf4a", harvest: P.gold } as const;

/** Beds as solid blocks coloured by mood, with status pips. Drawn at screen resolution. */
export function drawMap(f: Frame): FrameResult {
  const { layer: c, scene, cam } = f;
  const w = scene.world;
  const m = (x: number, y: number): Pt => ({ x: Math.round((x - cam.x) / MAP_DIV), y: Math.round((y - cam.y) / MAP_DIV) });
  const corners = (gx: number, gy: number, cw: number, cd: number) => {
    const T = iso(gx, gy);
    const R = iso(gx + cw, gy);
    const B = iso(gx + cw, gy + cd);
    const L = iso(gx, gy + cd);
    return [m(T.x, T.y), m(R.x, R.y), m(B.x, B.y), m(L.x, L.y)] as const;
  };
  const down = (p: Pt, h: number) => ({ x: p.x, y: p.y + h });
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, f.vw, f.vh);
  const [T, R, B, L] = corners(w.x0, w.y0, w.cols, w.rows);
  prism(c, down(T, 9), down(R, 9), down(B, 9), down(L, 9), 9, P.grassA, P.cliffLeft, P.cliffRight);
  const gh = w.greenhouse;
  const g = corners(gh.gx, gh.gy, gh.w, gh.d);
  prism(c, g[0], g[1], g[2], g[3], 6, P.glassLight, P.glass, P.glassDark);
  const ng = w.newGround;
  const n = corners(ng.gx, ng.gy, ng.w, ng.d);
  prism(c, n[0], n[1], n[2], n[3], 0, P.soilLight, P.soil, P.soil);
  const view: Rect = { x: cam.x, y: cam.y, w: f.vw * MAP_DIV, h: f.vh * MAP_DIV };
  const lots = w.index.query(view);
  for (const lot of lots) {
    const v = scene.views.get(lot.bedId);
    if (!v) continue;
    const q = corners(lot.gx, lot.gy, lot.w, lot.d);
    const selected = f.selection?.kind === "bed" && f.selection.id === lot.bedId;
    const hovered = f.hover?.kind === "bed" && f.hover.bedId === lot.bedId;
    if (selected || hovered) {
      const o = corners(lot.gx - 0.5, lot.gy - 0.5, lot.w + 1, lot.d + 1);
      prism(c, o[0], o[1], o[2], o[3], 4, selected ? P.gold : P.white, selected ? P.gold : P.white, selected ? P.gold : P.white);
    }
    prism(c, q[0], q[1], q[2], q[3], 4, MOOD_COLOR[v.mood], P.woodLeft, P.woodRight);
    const pips: string[] = [];
    for (const k of ["needs", "failing", "growing", "harvest"] as const) for (let i = 0; i < Math.min(3, v.pips[k]); i++) pips.push(PIP[k]);
    const cx = Math.round((q[0].x + q[2].x) / 2);
    const cy = Math.round((q[0].y + q[2].y) / 2) - 6;
    pips.forEach((col, i) => {
      const x = cx - pips.length * 3 + i * 6;
      rect(c, x, cy, 5, 5, INK);
      rect(c, x + 1, cy + 1, 3, 3, col);
    });
  }
  const tint = TINT[f.phase];
  if (tint) {
    c.save();
    c.globalCompositeOperation = "source-atop";
    c.fillStyle = tint;
    c.fillRect(0, 0, f.vw, f.vh);
    c.restore();
  }
  f.main.setTransform(1, 0, 0, 1, 0, 0);
  f.main.drawImage(skyCanvas(f.vw, f.vh, f.phase), 0, 0);
  weatherFx(f.main, f.vw, f.vh, f.weather, f.now, f.reduced, f.phase);
  f.main.drawImage(c.canvas, 0, 0);
  return { animating: !f.reduced && !!f.weather && f.weather.status !== "clear", lots, missing: 0 };
}

// ---------- hit testing (spatial index, visible beds only) ----------

const inR = (p: Pt, x: number, y: number, w: number, h: number) => p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;

export function pick(scene: Scene, soil: Record<string, SoilReport>, p: Pt, map: boolean): Hit | null {
  const w = scene.world;
  const near = w.index.query({ x: p.x - 1, y: p.y - 1, w: 2, h: 2 });
  if (map) {
    for (const lot of near) {
      const r = rectOfTiles(lot.gx, lot.gy, lot.w, lot.d);
      if (inR(p, r.x, r.y - 12, r.w, r.h + 12)) return { kind: "bed", bedId: lot.bedId };
    }
    const r = w.newGround.rect;
    return inR(p, r.x, r.y, r.w, r.h) ? { kind: "newground" } : null;
  }
  let best: { id: string; depth: number } | null = null;
  for (const lot of near) {
    const v = scene.views.get(lot.bedId);
    v?.ground.forEach((plant, k) => {
      const t = slotTile(lot, k);
      const q = iso(t.gx, t.gy);
      const by = q.y + 8 - BLOCK_H;
      const h = plantHeight(plant);
      if (inR(p, q.x - 9, by - h - 14, 18, h + 17) && (!best || t.gx + t.gy > best.depth)) best = { id: plant.id, depth: t.gx + t.gy };
    });
  }
  if (best) return { kind: "plant", id: (best as { id: string }).id };
  for (const lot of near) {
    const v = scene.views.get(lot.bedId);
    if (!v) continue;
    if (v.ground.length < capacity(lot)) {
      const t = slotTile(lot, v.ground.length);
      const q = iso(t.gx, t.gy);
      if (inR(p, q.x - 9, q.y - 8, 18, 14)) return { kind: "slot", bedId: lot.bedId };
    }
    const s = iso(lot.sign.gx, lot.sign.gy);
    if (inR(p, s.x - 10, s.y - 24, 22, 34)) return { kind: "bed", bedId: lot.bedId };
    if (soil[lot.bedId]?.guidance.length) {
      const q = iso(lot.compost.gx, lot.compost.gy);
      if (inR(p, q.x - 10, q.y - 6, 20, 18)) return { kind: "compost", bedId: lot.bedId };
    }
    if (v.catalogue > 0) {
      const q = iso(lot.tray.gx, lot.tray.gy);
      if (inR(p, q.x - 8, q.y + 2, 16, 12)) return { kind: "tray", bedId: lot.bedId };
    }
    const t = tileAt(p.x, p.y + BLOCK_H);
    const pl = lot.planter;
    if (t.gx >= pl.gx && t.gx < pl.gx + pl.len && t.gy >= pl.gy && t.gy < pl.gy + pl.lines) return { kind: "bed", bedId: lot.bedId };
  }
  const r = w.newGround.rect;
  return inR(p, r.x, r.y, r.w, r.h) ? { kind: "newground" } : null;
}
