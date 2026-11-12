// The garden as a tile map. Every bed owns a permanent cell on a slot grid (bed.gridX/gridY, assigned
// once by the main process from the shared square spiral), the greenhouse owns slot (0,0), and the
// island grows to cover every occupied cell. A bed's cell never moves when other beds change.
import { spiralSlot } from "../../../shared/garden";
import type { Bed } from "../../../shared/types";
import { rnd } from "./raster";

export { spiralSlot };

export const TW = 32;
export const TH = 16;
/** Height of a raised planter, in pixels. */
export const BLOCK_H = 8;
export const PER_LINE = 7;
/** One slot of the grid, in tiles: an M planter (2 lines of 7) with its path ring, and a strip of grass. */
export const CELL_W = 10;
export const CELL_D = 6;
/** Room above a bed's footprint for plants, bubbles and the signpost, in world pixels. */
export const HEADROOM = 80;
const MARGIN = 2;

export const GRASS = 0;
export const PATH = 1;
export const PLANTER = 2;

export type Tile = { gx: number; gy: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Screen position (world pixels) of a tile's top corner. */
export function iso(gx: number, gy: number) {
  return { x: (gx - gy) * (TW / 2), y: (gx + gy) * (TH / 2) };
}

/** Which tile a world pixel falls on. */
export function tileAt(x: number, y: number): Tile {
  const a = y / (TH / 2);
  const b = x / (TW / 2);
  return { gx: Math.floor((a + b) / 2), gy: Math.floor((a - b) / 2) };
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Bounding box (world px) of a w x d block of tiles. */
export function rectOfTiles(gx: number, gy: number, w: number, d: number): Rect {
  const left = iso(gx, gy + d).x;
  const right = iso(gx + w, gy).x;
  const top = iso(gx, gy).y;
  const bottom = iso(gx + w, gy + d).y;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const grow = (r: Rect, up: number, pad: number): Rect => ({ x: r.x - pad, y: r.y - up - pad, w: r.w + pad * 2, h: r.h + up + pad * 2 });

/** Grid buckets of rectangles: culling and hit-testing without scanning every bed. */
export class SpatialIndex<T> {
  private cells = new Map<number, { item: T; r: Rect }[]>();
  constructor(private size = 256) {}
  private key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
  insert(item: T, r: Rect) {
    const s = this.size;
    for (let cx = Math.floor(r.x / s); cx <= Math.floor((r.x + r.w) / s); cx++)
      for (let cy = Math.floor(r.y / s); cy <= Math.floor((r.y + r.h) / s); cy++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push({ item, r });
        else this.cells.set(k, [{ item, r }]);
      }
  }
  /** Items whose rectangle intersects `r`, each once. */
  query(r: Rect): T[] {
    const s = this.size;
    const out = new Set<T>();
    for (let cx = Math.floor(r.x / s); cx <= Math.floor((r.x + r.w) / s); cx++)
      for (let cy = Math.floor(r.y / s); cy <= Math.floor((r.y + r.h) / s); cy++)
        for (const e of this.cells.get(this.key(cx, cy)) ?? []) if (intersects(e.r, r)) out.add(e.item);
    return [...out];
  }
}

export interface Lot {
  bedId: string;
  /** Grid slot. */
  sx: number;
  sy: number;
  /** Outer corner of the allotment (path ring included). */
  gx: number;
  gy: number;
  w: number;
  d: number;
  planter: { gx: number; gy: number; len: number; lines: 1 | 2 };
  sign: Tile;
  compost: Tile;
  /** Seed tray ("+N in the catalogue") corner. */
  tray: Tile;
  /** Footprint plus headroom: what the bed can draw into. Used for culling and hits. */
  rect: Rect;
  /** The whole cell plus headroom: the area to repaint when the bed's static look changes. */
  cell: Rect;
}

export interface BedSpec {
  bedId: string;
  x: number;
  y: number;
  lines: 1 | 2;
}

/** S planter (1 line of 7) up to 7 plants in the ground, M (2 lines) above. */
export const linesFor = (inGround: number): 1 | 2 => (inGround <= PER_LINE ? 1 : 2);

export const cellRect = (sx: number, sy: number): Rect => grow(rectOfTiles(sx * CELL_W, sy * CELL_D, CELL_W, CELL_D), HEADROOM, 4);

export function makeLot(s: BedSpec): Lot {
  const gx = s.x * CELL_W;
  const gy = s.y * CELL_D;
  const len = PER_LINE;
  const front = gy + s.lines + 1;
  return {
    bedId: s.bedId,
    sx: s.x,
    sy: s.y,
    gx,
    gy,
    w: len + 2,
    d: s.lines + 2,
    planter: { gx: gx + 1, gy: gy + 1, len, lines: s.lines },
    sign: { gx, gy: front },
    compost: { gx: gx + len + 1, gy },
    tray: { gx: gx + len + 1, gy: front },
    rect: grow(rectOfTiles(gx, gy, len + 2, s.lines + 2), HEADROOM, 4),
    cell: cellRect(s.x, s.y),
  };
}

export const capacity = (lot: Lot) => lot.planter.len * lot.planter.lines;

/** Tile of the k-th plant in a planter, and the path tile in front where the gardener stands. */
export function slotTile(lot: Lot, k: number) {
  const gx = lot.planter.gx + (k % PER_LINE);
  const gy = lot.planter.gy + Math.floor(k / PER_LINE);
  return { gx, gy, stand: { gx, gy: lot.planter.gy + lot.planter.lines } };
}

/** Each bed's slot: its stored gridX/gridY, else (or on a clash) the first free spiral slot, in bed order. */
export function slotsForBeds(beds: Bed[]): Map<string, { x: number; y: number }> {
  const used = new Set(["0,0"]);
  const out = new Map<string, { x: number; y: number }>();
  for (const b of beds) {
    if (b.gridX === undefined || b.gridY === undefined) continue;
    const k = `${b.gridX},${b.gridY}`;
    if (used.has(k)) continue;
    used.add(k);
    out.set(b.id, { x: b.gridX, y: b.gridY });
  }
  let k = 1;
  for (const b of beds) {
    if (out.has(b.id)) continue;
    let s = spiralSlot(k++);
    while (used.has(`${s.x},${s.y}`)) s = spiralSlot(k++);
    used.add(`${s.x},${s.y}`);
    out.set(b.id, s);
  }
  return out;
}

export interface World {
  /** Tile origin of the arrays: tile (gx, gy) is at index (gy - y0) * cols + (gx - x0). */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  ground: Uint8Array;
  blocked: Uint8Array;
  lots: Lot[];
  lotByBed: Map<string, Lot>;
  index: SpatialIndex<Lot>;
  greenhouse: { gx: number; gy: number; w: number; d: number };
  home: Tile;
  newGround: { gx: number; gy: number; w: number; d: number; stand: Tile; rect: Rect };
  trees: (Tile & { size: number })[];
  flowers: (Tile & { ox: number; oy: number; color: number })[];
  /** The island in world px, cliffs included. */
  bounds: Rect;
}

export const CLIFF = 26;

export function inside(w: World, gx: number, gy: number) {
  return gx >= w.x0 && gy >= w.y0 && gx < w.x0 + w.cols && gy < w.y0 + w.rows;
}

export function groundAt(w: World, gx: number, gy: number): number {
  return inside(w, gx, gy) ? w.ground[(gy - w.y0) * w.cols + (gx - w.x0)] : -1;
}

export function buildWorld(specs: BedSpec[]): World {
  const used = new Set(specs.map((s) => `${s.x},${s.y}`));
  used.add("0,0");
  let ng = spiralSlot(1);
  for (let k = 2; used.has(`${ng.x},${ng.y}`); k++) ng = spiralSlot(k);
  const slots = [...specs.map((s) => ({ x: s.x, y: s.y })), { x: 0, y: 0 }, ng];
  const minSx = Math.min(...slots.map((s) => s.x));
  const maxSx = Math.max(...slots.map((s) => s.x));
  const minSy = Math.min(...slots.map((s) => s.y));
  const maxSy = Math.max(...slots.map((s) => s.y));
  const x0 = minSx * CELL_W - MARGIN;
  const y0 = minSy * CELL_D - MARGIN;
  const cols = (maxSx - minSx + 1) * CELL_W + MARGIN * 2;
  const rows = (maxSy - minSy + 1) * CELL_D + MARGIN * 2;
  const ground = new Uint8Array(cols * rows);
  const blocked = new Uint8Array(cols * rows);
  const at = (gx: number, gy: number) => (gy - y0) * cols + (gx - x0);

  const lots = specs.map(makeLot);
  for (const lot of lots) {
    for (let gx = lot.gx; gx < lot.gx + lot.w; gx++)
      for (let gy = lot.gy; gy < lot.gy + lot.d; gy++) {
        const p = lot.planter;
        const inPlanter = gx >= p.gx && gx < p.gx + p.len && gy >= p.gy && gy < p.gy + p.lines;
        ground[at(gx, gy)] = inPlanter ? PLANTER : PATH;
        if (inPlanter) blocked[at(gx, gy)] = 1;
      }
    for (const t of [lot.sign, lot.compost, lot.tray]) blocked[at(t.gx, t.gy)] = 1;
  }

  // The greenhouse sits in cell (0,0), its door onto a path that runs along the front of the cell.
  const greenhouse = { gx: 3, gy: 1, w: 3, d: 2 };
  for (let gx = greenhouse.gx; gx < greenhouse.gx + greenhouse.w; gx++)
    for (let gy = greenhouse.gy; gy < greenhouse.gy + greenhouse.d; gy++) blocked[at(gx, gy)] = 1;
  const home = { gx: greenhouse.gx + 1, gy: greenhouse.gy + greenhouse.d };
  for (let gy = home.gy; gy < CELL_D; gy++) ground[at(home.gx, gy)] = PATH;
  for (let gx = 0; gx < CELL_W; gx++) ground[at(gx, CELL_D - 1)] = PATH;

  const ngx = ng.x * CELL_W + 1;
  const ngy = ng.y * CELL_D + 1;
  const newGround = { gx: ngx, gy: ngy, w: 5, d: 3, stand: { gx: ngx + 2, gy: ngy + 3 }, rect: grow(rectOfTiles(ngx, ngy, 5, 3), 30, 4) };

  // Trees in the island's margin and in empty cells; flowers scattered in any grass.
  const occupied = new Set([...used, `${ng.x},${ng.y}`]);
  const trees: World["trees"] = [];
  const flowers: World["flowers"] = [];
  for (let gy = y0; gy < y0 + rows; gy++)
    for (let gx = x0; gx < x0 + cols; gx++) {
      const i = at(gx, gy);
      if (ground[i] !== GRASS || blocked[i]) continue;
      const sx = Math.floor(gx / CELL_W);
      const sy = Math.floor(gy / CELL_D);
      const margin = gx < x0 + MARGIN || gy < y0 + MARGIN || gx >= x0 + cols - MARGIN || gy >= y0 + rows - MARGIN;
      const r = rnd(gx, gy, 7);
      if ((margin && r < 0.3) || (!margin && !occupied.has(`${sx},${sy}`) && r < 0.1)) {
        trees.push({ gx, gy, size: r < 0.08 ? 2 : 1 });
        blocked[i] = 1;
      } else if (r > 0.92) {
        flowers.push({ gx, gy, ox: Math.floor(rnd(gx, gy, 3) * 12) - 6, oy: Math.floor(rnd(gx, gy, 4) * 6) - 3, color: Math.floor(rnd(gx, gy, 5) * 4) });
      }
    }

  const index = new SpatialIndex<Lot>();
  for (const lot of lots) index.insert(lot, lot.rect);
  const island = rectOfTiles(x0, y0, cols, rows);
  const bounds = grow({ ...island, h: island.h + CLIFF + 10 }, 40, 2);
  return { x0, y0, cols, rows, ground, blocked, lots, lotByBed: new Map(lots.map((l) => [l.bedId, l])), index, greenhouse, home, newGround, trees, flowers, bounds };
}

/** The part of the world worth framing: every cell that holds something. */
export function focusBox(w: World): Rect {
  const r = rectOfTiles(w.x0 + MARGIN, w.y0 + MARGIN, w.cols - MARGIN * 2, w.rows - MARGIN * 2);
  return { x: r.x, y: r.y - 40, w: r.w, h: r.h + 40 };
}

/** Cheapest walk between two tiles: paths cost 1, grass 3, so the gardener sticks to the paths. */
export function findPath(w: World, from: Tile, to: Tile): Tile[] {
  if (!inside(w, from.gx, from.gy) || !inside(w, to.gx, to.gy)) return [to];
  const n = w.cols * w.rows;
  const idx = (t: Tile) => (t.gy - w.y0) * w.cols + (t.gx - w.x0);
  const start = idx(from);
  const goal = idx(to);
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[start] = 0;
  // A tiny binary heap of [cost, index].
  const heap: [number, number][] = [[0, start]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (heap.length) {
    const [d, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goal) break;
    const lx = i % w.cols;
    const ly = (i / w.cols) | 0;
    for (const [dx, dy] of steps) {
      const nx = lx + dx;
      const ny = ly + dy;
      if (nx < 0 || ny < 0 || nx >= w.cols || ny >= w.rows) continue;
      const j = ny * w.cols + nx;
      if (w.blocked[j] && j !== goal) continue;
      const cost = d + (w.ground[j] === PATH ? 1 : 3);
      if (cost < dist[j]) {
        dist[j] = cost;
        prev[j] = i;
        push([cost, j]);
      }
    }
  }
  if (prev[goal] === -1 && goal !== start) return [to];
  const out: Tile[] = [];
  for (let i = goal; i !== start && i !== -1; i = prev[i]) out.push({ gx: (i % w.cols) + w.x0, gy: ((i / w.cols) | 0) + w.y0 });
  return out.reverse();
}
