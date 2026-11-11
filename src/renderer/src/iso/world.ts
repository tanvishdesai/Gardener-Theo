// The garden as a tile map: every bed gets a fenced allotment with a raised planter,
// paths run between allotments, and a greenhouse sits at the top of the island.
import type { Bed, Plant } from "../../../shared/types";
import { rnd } from "./raster";

export const TW = 32;
export const TH = 16;
/** Height of a raised planter, in pixels. */
export const BLOCK_H = 8;
export const PER_LINE = 7;

export type Tile = { gx: number; gy: number };

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

export interface Slot {
  plantId: string | null;
  gx: number;
  gy: number;
  /** Path tile in front of it, where the gardener stands. */
  stand: Tile;
}

export interface Lot {
  bedId: string;
  /** Outer corner of the allotment (path ring included). */
  gx: number;
  gy: number;
  w: number;
  d: number;
  planter: { gx: number; gy: number; len: number; lines: number };
  slots: Slot[];
  sign: Tile;
  compost: Tile;
}

export type Ground = "grass" | "path" | "planter" | "void";

export interface World {
  cols: number;
  rows: number;
  ground: Ground[];
  blocked: Uint8Array;
  lots: Lot[];
  greenhouse: { gx: number; gy: number; w: number; d: number };
  home: Tile;
  newGround: { gx: number; gy: number; w: number; d: number; stand: Tile };
  trees: (Tile & { size: number })[];
  flowers: (Tile & { ox: number; oy: number; color: number })[];
}

const MARGIN = 1;
const TOP = 5;
const CELL_W = 11;
const COLS = 2;

export function buildWorld(beds: Bed[], plantsByBed: Record<string, Plant[]>): World {
  const lines = beds.map((b) => Math.max(1, Math.ceil(((plantsByBed[b.id]?.length ?? 0) + 1) / PER_LINE)));
  const maxLines = Math.max(1, ...lines);
  const cellH = maxLines + 5;
  const cells = beds.length + 1; // +1 for the "break new ground" plot
  const gridRows = Math.ceil(cells / COLS);
  const cols = MARGIN * 2 + COLS * CELL_W + 1;
  const rows = TOP + gridRows * cellH + MARGIN;
  const ground: Ground[] = new Array(cols * rows).fill("grass");
  const blocked = new Uint8Array(cols * rows);
  const at = (gx: number, gy: number) => gy * cols + gx;
  const setPath = (gx: number, gy: number) => {
    if (ground[at(gx, gy)] === "grass") ground[at(gx, gy)] = "path";
  };

  // Main road along the top, and a lane down the left of each column of allotments.
  for (let gx = MARGIN; gx < cols - MARGIN; gx++) setPath(gx, TOP - 1);
  for (let c = 0; c < COLS; c++) for (let gy = TOP - 1; gy < rows - MARGIN; gy++) setPath(MARGIN + c * CELL_W, gy);
  for (let r = 0; r < gridRows; r++) for (let gx = MARGIN; gx < cols - MARGIN; gx++) setPath(gx, TOP + r * cellH + cellH - 1);

  const lots: Lot[] = beds.map((bed, i) => {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const ox = MARGIN + c * CELL_W + 1;
    const oy = TOP + r * cellH;
    const n = plantsByBed[bed.id]?.length ?? 0;
    const ln = lines[i];
    const len = Math.max(4, Math.min(PER_LINE, n + 1));
    const planter = { gx: ox + 1, gy: oy + 1, len, lines: ln };
    for (let gx = ox; gx <= ox + len + 1; gx++)
      for (let gy = oy; gy <= oy + ln + 1; gy++) {
        const inPlanter = gx > ox && gx <= ox + len && gy > oy && gy <= oy + ln;
        ground[at(gx, gy)] = inPlanter ? "planter" : "path";
        if (inPlanter) blocked[at(gx, gy)] = 1;
      }
    const plants = plantsByBed[bed.id] ?? [];
    const slots: Slot[] = [];
    for (let k = 0; k <= plants.length; k++) {
      const line = Math.floor(k / PER_LINE);
      const gx = planter.gx + (k % PER_LINE);
      const gy = planter.gy + line;
      slots.push({ plantId: plants[k]?.id ?? null, gx, gy, stand: { gx, gy: oy + ln + 1 } });
    }
    const sign = { gx: ox, gy: oy + ln + 1 };
    const compost = { gx: ox + len + 1, gy: oy };
    blocked[at(sign.gx, sign.gy)] = 1;
    blocked[at(compost.gx, compost.gy)] = 1;
    return { bedId: bed.id, gx: ox, gy: oy, w: len + 2, d: ln + 2, planter, slots, sign, compost };
  });

  const ni = beds.length;
  const nx = MARGIN + (ni % COLS) * CELL_W + 2;
  const ny = TOP + Math.floor(ni / COLS) * cellH + 1;
  const newGround = { gx: nx, gy: ny, w: 5, d: 3, stand: { gx: nx + 2, gy: ny + 3 } };

  const greenhouse = { gx: MARGIN + 2, gy: 1, w: 3, d: 2 };
  for (let gx = greenhouse.gx; gx < greenhouse.gx + greenhouse.w; gx++)
    for (let gy = greenhouse.gy; gy < greenhouse.gy + greenhouse.d; gy++) blocked[at(gx, gy)] = 1;
  const home = { gx: greenhouse.gx + 1, gy: greenhouse.gy + greenhouse.d };
  for (let gy = home.gy; gy < TOP; gy++) setPath(home.gx, gy);

  // Trees along the back edges and the far right; flowers scattered in the grass.
  const trees: World["trees"] = [];
  const flowers: World["flowers"] = [];
  const free = (gx: number, gy: number) => ground[at(gx, gy)] === "grass" && !blocked[at(gx, gy)];
  for (let gx = 0; gx < cols; gx++)
    for (let gy = 0; gy < rows; gy++) {
      if (!free(gx, gy)) continue;
      const edge = gy === 0 || gx === 0 || gx === cols - 1 || (gy < TOP - 1 && gx > greenhouse.gx + greenhouse.w + 2);
      const r = rnd(gx, gy, 7);
      if (edge && r < (gy === 0 || gx === 0 ? 0.5 : 0.22)) {
        trees.push({ gx, gy, size: r < 0.2 ? 2 : 1 });
        blocked[at(gx, gy)] = 1;
      } else if (r > 0.9) {
        flowers.push({ gx, gy, ox: Math.floor(rnd(gx, gy, 3) * 12) - 6, oy: Math.floor(rnd(gx, gy, 4) * 6) - 3, color: Math.floor(rnd(gx, gy, 5) * 4) });
      }
    }

  return { cols, rows, ground, blocked, lots, greenhouse, home, newGround, trees, flowers };
}

/** The part of the world worth looking at: the greenhouse and every allotment. */
export function focusBox(w: World) {
  const pts = [iso(w.greenhouse.gx, w.greenhouse.gy), iso(w.newGround.gx + w.newGround.w, w.newGround.gy + w.newGround.d)];
  for (const l of w.lots) pts.push(iso(l.gx, l.gy), iso(l.gx + l.w, l.gy), iso(l.gx, l.gy + l.d), iso(l.gx + l.w, l.gy + l.d));
  pts.push(iso(w.newGround.gx, w.newGround.gy + w.newGround.d), iso(w.newGround.gx + w.newGround.w, w.newGround.gy));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys) - 50, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) + 50 };
}

/** Cheapest walk between two tiles: paths cost 1, grass 3, so the gardener sticks to the paths. */
export function findPath(w: World, from: Tile, to: Tile): Tile[] {
  const n = w.cols * w.rows;
  const inside = (t: Tile) => t.gx >= 0 && t.gy >= 0 && t.gx < w.cols && t.gy < w.rows;
  if (!inside(from) || !inside(to)) return [to];
  const start = from.gy * w.cols + from.gx;
  const goal = to.gy * w.cols + to.gx;
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
  while (heap.length) {
    const [d, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goal) break;
    const gx = i % w.cols;
    const gy = (i / w.cols) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= w.cols || ny >= w.rows) continue;
      const j = ny * w.cols + nx;
      if (w.blocked[j] && j !== goal) continue;
      const cost = d + (w.ground[j] === "path" ? 1 : 3);
      if (cost < dist[j]) {
        dist[j] = cost;
        prev[j] = i;
        push([cost, j]);
      }
    }
  }
  if (prev[goal] === -1 && goal !== start) return [to];
  const out: Tile[] = [];
  for (let i = goal; i !== start && i !== -1; i = prev[i]) out.push({ gx: i % w.cols, gy: (i / w.cols) | 0 });
  return out.reverse();
}
