// Everything that gets drawn into the world, one pixel at a time.
import { maturity } from "../../../shared/garden";
import type { Plant, SoilReport } from "../../../shared/types";
import { INK, LEAF, LEAF_WILTED, P, SKY, SPECIES_STYLE, WILTED, type Phase } from "./palette";
import { blit, dither, disc, isoLine, poly, px, rect, rnd, type Ctx, type Pt } from "./raster";
import {
  BEE,
  BEE_PAL,
  BUBBLE_FILL,
  BUD,
  BUTTERFLY,
  CAN,
  CAN_PAL,
  GARDENER,
  GARDENER_PAL,
  HEADS,
  ICON_PAL,
  ICONS,
  LAVENDER_BUD,
  RAINCLOUD,
  RAINCLOUD_PAL,
  SHOVEL,
  SHOVEL_PAL,
  WEED,
  WEED_PAL,
  type BubbleKind,
} from "./sprites";
import { BLOCK_H, iso, type World } from "./world";

// ---------- shapes ----------

/** An axis-aligned iso box standing on ground point (cx, cy): hw is half the footprint width. */
export function box(c: Ctx, cx: number, cy: number, hw: number, h: number, top: string, left: string, right: string) {
  const hh = hw / 2;
  const L = { x: cx - hw, y: cy };
  const B = { x: cx, y: cy + hh };
  const R = { x: cx + hw, y: cy };
  const T = { x: cx, y: cy - hh };
  poly(c, [L, B, { x: B.x, y: B.y - h }, { x: L.x, y: L.y - h }], left);
  poly(c, [B, R, { x: R.x, y: R.y - h }, { x: B.x, y: B.y - h }], right);
  poly(c, [up(T, h), up(R, h), up(B, h), up(L, h)], top);
}

const up = (p: Pt, h: number) => ({ x: p.x, y: p.y - h });

export function diamond(c: Ctx, x: number, y: number, color: string) {
  poly(c, [{ x, y }, { x: x + 16, y: y + 8 }, { x, y: y + 16 }, { x: x - 16, y: y + 8 }], color);
}

/** Outline of a tile's top face (the Habbo-style floor cursor). */
export function tileCursor(c: Ctx, x: number, y: number, color: string, dashed = false) {
  const seg = (sx: number, sy: number, dir: 1 | -1) => {
    for (let i = 0; i < 8; i++) if (!dashed || i % 3 !== 1) rect(c, sx + dir * i * 2, sy + i, 2, 1, color);
  };
  seg(x - 2, y, -1);
  seg(x, y, 1);
  seg(x - 16, y + 8, 1);
  seg(x + 14, y + 8, -1);
}

// ---------- static ground ----------

export const CLIFF = 26;

export function worldBounds(w: World) {
  return { x: -w.rows * 16 - 24, y: -96, w: (w.cols + w.rows) * 16 + 48, h: (w.cols + w.rows) * 8 + CLIFF + 140 };
}

export function paintGround(c: Ctx, w: World) {
  const L = iso(0, w.rows);
  const B = iso(w.cols, w.rows);
  const R = iso(w.cols, 0);
  // The island's cliff faces, with a ragged underside.
  poly(c, [L, B, up(B, -CLIFF), up(L, -CLIFF)], P.cliffLeft);
  poly(c, [B, R, up(R, -CLIFF), up(B, -CLIFF)], P.cliffRight);
  for (const k of [8, 17]) {
    isoLine(c, L.x, L.y + k, w.cols * 8, 1, P.cliffStrata);
    isoLine(c, B.x, B.y + k, w.rows * 8, 1, P.cliffDark, true);
  }
  for (let x = L.x; x < R.x; x += 2) {
    const onLeft = x < B.x;
    const baseY = onLeft ? L.y + (x - L.x) / 2 : B.y - (x - B.x) / 2;
    const drip = Math.floor(rnd(x, 3) * 7);
    rect(c, x, baseY + CLIFF, 2, drip, onLeft ? P.cliffLeft : P.cliffRight);
    if (drip > 3) rect(c, x, baseY + CLIFF + drip - 1, 2, 1, P.cliffDark);
  }

  for (let gy = 0; gy < w.rows; gy++)
    for (let gx = 0; gx < w.cols; gx++) {
      const g = w.ground[gy * w.cols + gx];
      const { x, y } = iso(gx, gy);
      if (g === "path") paintPath(c, x, y, gx, gy);
      else paintGrass(c, x, y, gx, gy);
    }
  // A grass lip along the island's front edges.
  isoLine(c, L.x, L.y - 1, w.cols * 8, 1, P.grassDark);
  isoLine(c, B.x - 2, B.y - 1, w.rows * 8, -1, P.grassDark, true);

  for (const f of w.flowers) {
    const { x, y } = iso(f.gx, f.gy);
    const colors = ["#ffe066", "#ff8fb1", "#ffffff", "#b79cf0"];
    const fx = x + f.ox;
    const fy = y + 8 + f.oy;
    px(c, fx, fy + 1, P.grassDark);
    px(c, fx, fy, colors[f.color]);
    px(c, fx + 3, fy + 2, P.grassDark);
    px(c, fx + 3, fy + 1, colors[(f.color + 1) % 4]);
  }

  // The empty plot waiting to become a bed.
  const ng = w.newGround;
  for (let gx = ng.gx; gx < ng.gx + ng.w; gx++)
    for (let gy = ng.gy; gy < ng.gy + ng.d; gy++) {
      const { x, y } = iso(gx, gy);
      diamond(c, x, y, P.soilLight);
      for (let i = 0; i < 4; i++) isoLine(c, x - 12 + i * 6, y + 6 + i * 3 - 4, 3, 1, P.soil);
    }
}

function paintGrass(c: Ctx, x: number, y: number, gx: number, gy: number) {
  diamond(c, x, y, (gx + gy) % 2 ? P.grassA : P.grassB);
  for (let i = 0; i < 4; i++) {
    const bx = x - 10 + Math.floor(rnd(gx, gy, i) * 20);
    const by = y + 4 + Math.floor(rnd(gx, gy, i + 9) * 8);
    px(c, bx, by, P.blade);
    px(c, bx, by + 1, P.grassDark);
  }
}

function paintPath(c: Ctx, x: number, y: number, gx: number, gy: number) {
  diamond(c, x, y, (gx + gy) % 2 ? P.pathA : P.pathB);
  for (let i = 0; i < 5; i++) {
    const bx = x - 10 + Math.floor(rnd(gx, gy, i + 20) * 20);
    const by = y + 4 + Math.floor(rnd(gx, gy, i + 30) * 8);
    rect(c, bx, by, 2, 1, P.pathLight);
    rect(c, bx, by + 1, 2, 1, P.pathDark);
  }
}

// ---------- props ----------

export function planterBlock(c: Ctx, gx: number, gy: number, edges: { nw: boolean; ne: boolean; sw: boolean; se: boolean }, soil: SoilReport | undefined, looseHere: boolean) {
  const { x, y } = iso(gx, gy);
  box(c, x, y + 8, 16, BLOCK_H, P.soil, P.woodLeft, P.woodRight);
  // plank seam
  if (edges.sw) isoLine(c, x - 16, y + 8 + BLOCK_H / 2 - 1, 8, 1, P.woodDark);
  if (edges.se) isoLine(c, x + 14, y + 8 + BLOCK_H / 2 - 1, 8, -1, P.woodDark);
  const ty = y - BLOCK_H;
  for (let i = 0; i < 7; i++) {
    const sx = x - 9 + Math.floor(rnd(gx, gy, i + 40) * 18);
    const sy = ty + 5 + Math.floor(rnd(gx, gy, i + 50) * 6);
    px(c, sx, sy, i % 2 ? P.soilDark : P.soilLight);
  }
  if (soil && soil.lint.length > 0) {
    for (let i = 0; i < 6; i++) {
      const sx = x - 10 + Math.floor(rnd(gx, gy, i + 60) * 20);
      const sy = ty + 4 + Math.floor(rnd(gx, gy, i + 70) * 8);
      rect(c, sx, sy, 2, 1, i % 2 ? P.mulch : P.mulchDark);
    }
  }
  if (looseHere) {
    const sx = x + 4;
    const sy = ty + 9;
    rect(c, sx - 2, sy, 5, 1, P.loose);
    rect(c, sx - 1, sy - 1, 3, 1, P.loose);
    px(c, sx, sy - 1, P.soilLight);
  }
  // rims along the planter's outside edges
  if (edges.nw) isoLine(c, x - 2, ty, 8, -1, P.woodTop);
  if (edges.ne) isoLine(c, x, ty, 8, 1, P.woodTop);
  if (edges.sw) {
    isoLine(c, x - 16, ty + 8, 8, 1, P.woodLight);
    isoLine(c, x - 16, ty + 7, 8, 1, P.woodTop);
  }
  if (edges.se) {
    isoLine(c, x + 14, ty + 8, 8, -1, P.woodLight);
    isoLine(c, x + 14, ty + 7, 8, -1, P.woodTop);
  }
}

/** A white picket fence along one back edge of a tile. */
export function fence(c: Ctx, gx: number, gy: number, side: "nw" | "ne") {
  const { x, y } = iso(gx, gy);
  const dir = side === "ne" ? 1 : -1;
  const sx = side === "ne" ? x : x - 2;
  isoLine(c, sx, y - 5, 8, dir, P.fenceShade);
  isoLine(c, sx, y - 2, 8, dir, P.fenceShade);
  for (let i = 0; i < 8; i += 2) {
    const fx = sx + dir * i * 2;
    rect(c, fx, y + i - 8, 1, 8, P.fence);
    rect(c, fx + 1, y + i - 7, 1, 7, P.fenceShade);
    px(c, fx, y + i - 9, P.fenceShade);
  }
}

export function signpost(c: Ctx, gx: number, gy: number, night: boolean, mood: string) {
  const { x, y } = iso(gx, gy);
  const cx = x;
  const cy = y + 8;
  rect(c, cx - 1, cy - 18, 2, 18, P.woodLeft);
  rect(c, cx, cy - 18, 1, 18, P.woodRight);
  rect(c, cx - 9, cy - 24, 18, 9, INK);
  rect(c, cx - 8, cy - 23, 16, 7, P.woodTop);
  rect(c, cx - 8, cy - 20, 16, 1, P.woodLeft);
  rect(c, cx - 8, cy - 17, 16, 1, P.woodRight);
  // the bed's mood as a little flag
  rect(c, cx + 6, cy - 31, 1, 8, INK);
  rect(c, cx + 7, cy - 31, 5, 3, mood);
  // lantern
  rect(c, cx - 11, cy - 15, 3, 4, INK);
  rect(c, cx - 10, cy - 14, 1, 2, night ? "#ffe9a0" : "#d9c08a");
}

export function compostBin(c: Ctx, gx: number, gy: number) {
  const { x, y } = iso(gx, gy);
  box(c, x, y + 8, 10, 9, P.soilDark, P.woodLeft, P.woodRight);
  isoLine(c, x - 10, y + 8 - 4, 5, 1, P.woodDark);
  isoLine(c, x + 8, y + 8 - 4, 5, -1, P.woodDark);
  disc(c, x, y + 8 - 11, 3, "#3e2a1c");
  px(c, x - 2, y - 5, "#c9a24a");
  px(c, x + 2, y - 4, "#7aa35a");
  px(c, x, y - 6, "#e0533f");
}

export function tree(c: Ctx, gx: number, gy: number, size: number) {
  const { x, y } = iso(gx, gy);
  const cx = x;
  const cy = y + 9;
  const r = size === 2 ? 10 : 8;
  rect(c, cx - 5, cy - 1, 11, 2, "rgba(30,50,20,.35)");
  rect(c, cx - 1, cy - 10, 3, 10, P.trunk);
  px(c, cx + 1, cy - 9, "#5a341e");
  disc(c, cx, cy - 12 - r, r, P.leafB);
  disc(c, cx - 1, cy - 13 - r, r - 1, P.leafA);
  disc(c, cx - 3, cy - 15 - r, Math.max(2, r - 5), P.leafC);
  px(c, cx - 4, cy - 17 - r, P.leafD);
  px(c, cx + 3, cy - 11 - r, P.leafD);
}

export function greenhouse(c: Ctx, w: World, night: boolean) {
  const g = w.greenhouse;
  const H = 22;
  const T = iso(g.gx, g.gy);
  const R = iso(g.gx + g.w, g.gy);
  const B = iso(g.gx + g.w, g.gy + g.d);
  const L = iso(g.gx, g.gy + g.d);
  const glass = night ? "#e9d48a" : P.glass;
  const glassDark = night ? "#c9ad62" : P.glassDark;
  // base course
  poly(c, [L, B, up(B, 4), up(L, 4)], "#9a8f80");
  poly(c, [B, R, up(R, 4), up(B, 4)], "#7d7366");
  poly(c, [up(L, 4), up(B, 4), up(B, H), up(L, H)], glass);
  poly(c, [up(B, 4), up(R, 4), up(R, H), up(B, H)], glassDark);
  // plants inside
  for (let i = 0; i < 9; i++) {
    const t = (i + 0.5) / 9;
    const ix = L.x + (B.x - L.x) * t;
    const iy = L.y + (B.y - L.y) * t - 6 - Math.floor(rnd(i, 4) * 4);
    disc(c, ix, iy, 2, i % 2 ? "#5aa858" : "#4a9048");
  }
  // frame
  // L→B runs along the long side (w tiles), B→R along the short side (d tiles)
  for (let i = 0; i <= g.d; i++) {
    const p = { x: B.x + ((R.x - B.x) * i) / g.d, y: B.y + ((R.y - B.y) * i) / g.d };
    rect(c, p.x, p.y - H, 1, H, P.frame);
  }
  for (let i = 0; i <= g.w; i++) {
    const p = { x: L.x + ((B.x - L.x) * i) / g.w, y: L.y + ((B.y - L.y) * i) / g.w };
    rect(c, p.x, p.y - H, 1, H, P.frame);
  }
  isoLine(c, L.x, L.y - H, g.w * 8, 1, P.frame);
  isoLine(c, B.x, B.y - H, g.d * 8, 1, P.frame, true);
  // gable roof along the long axis
  const ridge = 12;
  const M1 = { x: (T.x + L.x) / 2, y: (T.y + L.y) / 2 - H - ridge };
  const M2 = { x: (R.x + B.x) / 2, y: (R.y + B.y) / 2 - H - ridge };
  poly(c, [up(T, H), up(R, H), M2, M1], P.glassLight);
  poly(c, [M1, M2, up(B, H), up(L, H)], night ? "#f3e2a2" : "#d4f0f6");
  poly(c, [up(B, H), up(R, H), M2], glassDark);
  isoLine(c, M1.x, M1.y, g.w * 8, 1, P.frame);
  for (let i = 0; i <= g.w; i++) {
    const a = { x: L.x + ((B.x - L.x) * 0) + ((R.x - T.x) * i) / g.w, y: L.y - H + ((R.y - T.y) * i) / g.w };
    const m = { x: M1.x + ((M2.x - M1.x) * i) / g.w, y: M1.y + ((M2.y - M1.y) * i) / g.w };
    const steps = Math.max(1, Math.round(Math.abs(a.y - m.y)));
    for (let s = 0; s <= steps; s++) px(c, m.x + ((a.x - m.x) * s) / steps, m.y + ((a.y - m.y) * s) / steps, P.frame);
  }
  // door facing the path
  const door = iso(w.home.gx, w.home.gy);
  rect(c, door.x - 4, door.y - 15, 9, 15, P.frameDark);
  rect(c, door.x - 3, door.y - 14, 7, 14, night ? "#ffe9a0" : "#9fd0dc");
  rect(c, door.x, door.y - 14, 1, 14, P.frameDark);
}

export function newGroundMarker(c: Ctx, w: World, frame: number) {
  const ng = w.newGround;
  const p = iso(ng.gx + 1, ng.gy + ng.d - 1);
  blit(c, "shovel", SHOVEL, SHOVEL_PAL, p.x - 3, p.y - 2);
  const corners = [iso(ng.gx, ng.gy), iso(ng.gx + ng.w, ng.gy), iso(ng.gx + ng.w, ng.gy + ng.d), iso(ng.gx, ng.gy + ng.d)];
  const color = frame % 8 < 4 ? "#ffffff" : P.pathLight;
  isoLine(c, corners[0].x, corners[0].y, ng.w * 8, 1, color);
  isoLine(c, corners[3].x, corners[3].y, ng.w * 8, 1, color);
  isoLine(c, corners[0].x - 2, corners[0].y, ng.d * 8, -1, color);
  isoLine(c, corners[1].x - 2, corners[1].y, ng.d * 8, -1, color);
}

// ---------- plants ----------

const HEIGHTS = [0, 13, 20, 27, 34];

export function plantHeight(plant: Plant): number {
  const m = maturity(plant.turns);
  const seedOnly = m === 0 && plant.status === "idle";
  return seedOnly ? 4 : m === 0 ? 7 : HEIGHTS[m];
}

export interface PlantPaint {
  plant: Plant;
  bx: number;
  by: number;
  frame: number;
  staked: boolean;
  reduced: boolean;
  seed: number;
}

/** Draws the plant and its in-world effects; returns where its head is (for the bubble). */
export function paintPlant(c: Ctx, o: PlantPaint): Pt {
  const { plant, bx, by, frame, reduced } = o;
  const m = maturity(plant.turns);
  const busy = plant.status === "thinking" || plant.status === "working";
  const waiting = plant.status === "waiting";
  const wilted = plant.status === "error";
  const seedOnly = m === 0 && !busy && !waiting && !wilted;
  const s = wilted ? WILTED : SPECIES_STYLE[plant.species];
  const lf = wilted ? LEAF_WILTED : LEAF;
  const f = reduced ? 0 : frame;
  const activity = busy ? (plant.status === "thinking" ? "think" : plant.activity ?? "other") : undefined;

  if (plant.permissionMode === "plan" && !seedOnly) trellis(c, bx, by, HEIGHTS[Math.max(1, m)] + 6);

  if (seedOnly) {
    rect(c, bx - 3, by - 1, 7, 1, P.loose);
    rect(c, bx - 2, by - 2, 5, 1, P.loose);
    rect(c, bx + 4, by - 9, 1, 8, P.woodLeft);
    rect(c, bx + 2, by - 14, 6, 6, INK);
    rect(c, bx + 3, by - 13, 4, 4, "#fbf4e3");
    rect(c, bx + 4, by - 12, 2, 2, s.petal);
    return { x: bx, y: by - 14 };
  }

  rect(c, bx - 3, by, 8, 1, P.soilDark);
  rect(c, bx - 2, by + 1, 6, 1, P.soilDark);
  if ((activity === "read" || activity === "search") && !reduced) roots(c, bx, by, f, activity === "search");

  const h = m === 0 ? 7 : HEIGHTS[m];
  if (o.staked && h > 12) {
    const sh = Math.round(h * 0.75);
    rect(c, bx - 4, by - sh, 1, sh, P.bamboo);
    px(c, bx - 4, by - sh, P.bambooDark);
    px(c, bx - 4, by - Math.round(sh * 0.4), P.bambooDark);
    rect(c, bx - 3, by - Math.round(sh * 0.6), 2, 1, P.twine);
  }

  // sway: the top of the stem drifts, more when busy
  const swayCycle = busy ? [0, 1, 1, 0, 0, -1, -1, 0] : [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, -1, -1, -1, 0, 0, 0];
  const sway = reduced ? 0 : swayCycle[(f + o.seed) % swayCycle.length];
  const lean = waiting ? 3 : wilted ? -4 : 0;
  const xAt = (i: number) => bx + Math.round((sway + lean) * (i / Math.max(1, h)) ** 2);
  const thick = m >= 1;

  for (let i = 0; i < h; i++) {
    const x = xAt(i);
    px(c, x, by - 1 - i, lf.stem);
    if (thick) px(c, x + 1, by - 1 - i, lf.stemDark);
  }
  const leaves = m === 0 ? 2 : [0, 2, 4, 5, 6][m];
  for (let k = 0; k < leaves; k++) {
    const t = m === 0 ? 1 : 0.14 + (0.6 * k) / Math.max(1, leaves - 1);
    const i = Math.round(h * t) - 1;
    const x = xAt(i);
    const y = by - 1 - i;
    const side = m === 0 ? (k ? 1 : -1) : k % 2 ? 1 : -1;
    const x0 = side > 0 ? x + (thick ? 2 : 1) : x - 1;
    const at = (dx: number, dy: number, col: string) => px(c, x0 + side * dx, y + dy, col);
    if (wilted) {
      at(0, 0, lf.leaf);
      at(1, 1, lf.leaf);
      at(2, 2, lf.leafDark);
      at(1, 2, lf.leafDark);
    } else if (m <= 1) {
      at(0, 0, lf.leaf);
      at(1, 0, lf.leaf);
      at(1, -1, lf.leafLight);
      at(2, -1, lf.leaf);
      at(2, 0, lf.leafDark);
    } else {
      at(1, -1, lf.leafLight);
      at(2, -1, lf.leafLight);
      at(0, 0, lf.leaf);
      at(1, 0, lf.leaf);
      at(2, 0, lf.leaf);
      at(3, 0, lf.leafLight);
      at(1, 1, lf.leafDark);
      at(2, 1, lf.leafDark);
      if (m >= 3) {
        at(3, -1, lf.leaf);
        at(4, -1, lf.leafLight);
      }
    }
  }
  const head = { x: xAt(h), y: by - h };
  const pal = { p: s.petal, d: s.petalDark, L: s.petalLight, c: s.center, C: "#3d2412", g: lf.leaf };
  const open = !busy && !waiting && m > 0;
  if (m > 0) {
    const map = open ? HEADS[plant.species] : plant.species === "lavender" ? LAVENDER_BUD : BUD;
    const key = `head-${open ? plant.species : plant.species === "lavender" ? "lbud" : "bud"}-${wilted ? "w" : plant.species}`;
    const hw = map[0].length;
    const hh = map.length;
    const hx = head.x - Math.floor(hw / 2) + (thick ? 1 : 0) + (wilted ? -1 : 0);
    const hy = head.y - hh + (plant.species === "lavender" ? 1 : 3) + (wilted || waiting ? 2 : 0);
    blit(c, key, map, pal, hx, hy);
    head.x += thick ? 1 : 0;
    head.y = hy;
  }

  if (!reduced && activity) activityFx(c, activity, head, bx, by, f, plant.runners);
  if (wilted) {
    blit(c, "weed", WEED, WEED_PAL, bx - 12, by - 6);
    blit(c, "raincloud", RAINCLOUD, RAINCLOUD_PAL, head.x - 5, head.y - 20);
    if (!reduced) for (let k = 0; k < 3; k++) rect(c, head.x - 3 + k * 3, head.y - 14 + ((f * 2 + k * 3) % 8), 1, 2, P.rain);
  }
  if (plant.unread && open) {
    const flap = reduced ? 0 : f % 2;
    const bob = reduced ? 0 : [0, -1, -2, -1][f % 4];
    const pal2 = { p: ["#5aa6e8", "#f08c5a", "#b07ce0", "#e86fa0"][o.seed % 4], k: INK };
    blit(c, `butterfly-${flap}-${o.seed % 4}`, BUTTERFLY[flap], pal2, head.x + 3, head.y - 7 + bob);
    if (!reduced && f % 3 === 0) px(c, head.x - 4, head.y - 3, P.sparkle);
  }
  return head;
}

function trellis(c: Ctx, bx: number, by: number, h: number) {
  for (const dx of [-5, 0, 5]) rect(c, bx + dx, by - h, 1, h, P.woodTop);
  for (let y = by - 3; y > by - h; y -= 4) rect(c, bx - 5, y, 11, 1, P.woodLeft);
}

function roots(c: Ctx, bx: number, by: number, f: number, search: boolean) {
  const reach = 2 + (f % 5);
  const dirs: [number, number][] = [
    [-2, 1],
    [2, 1],
    [-2, -1],
    [2, -1],
  ];
  for (const [dx, dy] of dirs)
    for (let i = 1; i <= reach; i++) {
      if (search && (i + f) % 2) continue;
      px(c, bx + dx * i, by + dy * i * 0.5 + 1, i === reach ? P.sparkle : P.root);
    }
}

function activityFx(c: Ctx, activity: string, head: Pt, bx: number, by: number, f: number, runners: number) {
  switch (activity) {
    case "think": {
      const spots = [
        [-6, -3],
        [6, -6],
        [-3, -9],
        [7, 0],
      ];
      spots.forEach(([dx, dy], i) => {
        if ((f + i) % 4 < 2) px(c, head.x + dx, head.y + dy, P.sparkle);
      });
      return;
    }
    case "edit": {
      const spots = [
        [-5, 6],
        [5, 3],
        [0, -5],
      ];
      spots.forEach(([dx, dy], i) => {
        if ((f + i * 2) % 6 < 3) {
          const x = head.x + dx;
          const y = head.y + dy;
          px(c, x, y, P.white);
          px(c, x - 1, y, P.sparkle);
          px(c, x + 1, y, P.sparkle);
          px(c, x, y - 1, P.sparkle);
          px(c, x, y + 1, P.sparkle);
        }
      });
      return;
    }
    case "run": {
      const cx = head.x - 15;
      const cy = head.y - 12;
      blit(c, "can", CAN, CAN_PAL, cx, cy);
      for (let k = 0; k < 3; k++) {
        const dy = (f * 2 + k * 4) % 12;
        rect(c, cx + 8 + (k % 2), cy + 3 + dy, 1, 2, P.water);
      }
      return;
    }
    case "web": {
      const a = (f / 8) * Math.PI * 2;
      blit(c, "bee", BEE, BEE_PAL, head.x + Math.round(Math.cos(a) * 10) - 2, head.y + Math.round(Math.sin(a) * 4) - 3, Math.sin(a) < 0);
      return;
    }
    case "delegate": {
      const n = Math.max(1, Math.min(3, runners));
      const spots = [8, -8, 12];
      for (let i = 0; i < n; i++) {
        const x = bx + spots[i];
        const y = by + (i === 2 ? 2 : i ? 1 : -1);
        const tall = (f + i) % 4 < 2 ? 3 : 2;
        rect(c, x, y - tall, 1, tall, LEAF.stem);
        px(c, x - 1, y - tall, LEAF.leafLight);
        px(c, x + 1, y - tall, LEAF.leaf);
      }
      return;
    }
  }
}

// ---------- thought bubbles ----------

export function bubbleFor(plant: Plant): BubbleKind | null {
  if (plant.status === "waiting") return plant.ask?.kind === "question" ? "question" : plant.ask?.kind === "plan" ? "plan_ask" : "waiting";
  if (plant.status === "error") return "error";
  if (plant.status === "thinking") return "think";
  if (plant.status === "working") return plant.activity ?? "other";
  if (plant.unread) return "harvest";
  return null;
}

export function bubble(c: Ctx, kind: BubbleKind, x: number, y: number, frame: number, reduced: boolean) {
  const bob = reduced ? 0 : (frame >> 1) % 2;
  const bx = Math.round(x - 6);
  const by = Math.round(y - 15 - bob);
  const fill = BUBBLE_FILL[kind] ?? P.white;
  rect(c, bx + 1, by, 11, 11, INK);
  rect(c, bx, by + 1, 13, 9, INK);
  rect(c, bx + 1, by + 1, 11, 9, fill);
  rect(c, bx + 5, by + 11, 3, 1, INK);
  px(c, bx + 6, by + 12, INK);
  px(c, bx + 6, by + 10, fill);
  px(c, bx + 2, by + 2, P.white);
  const icon = ICONS[kind] ?? ICONS.other;
  blit(c, `icon-${kind}`, icon, ICON_PAL, bx + 3, by + 2);
}

// ---------- the gardener ----------

export function gardener(c: Ctx, x: number, y: number, facing: "front" | "back", flip: boolean, step: number) {
  rect(c, x - 4, y, 9, 2, "rgba(20,30,10,.35)");
  const frames = GARDENER[facing];
  blit(c, `gardener-${facing}-${step}`, frames[step], GARDENER_PAL, x - 5, y - 20, flip);
}

// ---------- sky ----------

export function paintSky(c: Ctx, w: number, h: number, phase: Phase, t: number, camX: number, reduced: boolean) {
  const bands = SKY[phase];
  const bandH = Math.ceil(h / bands.length);
  for (let i = 0; i < bands.length; i++) rect(c, 0, i * bandH, w, bandH + 1, bands[i]);
  // dithered seams between bands
  for (let i = 1; i < bands.length; i++) {
    const y0 = i * bandH;
    for (let y = y0 - 3; y < y0 + 3; y++) {
      const amt = (y0 + 3 - y) / 6;
      c.fillStyle = bands[i - 1];
      for (let x = (y & 1) * 0; x < w; x++) if (dither(x, y, amt)) c.fillRect(x, y, 1, 1);
    }
  }
  if (phase === "night") {
    for (let i = 0; i < 70; i++) {
      const sx = Math.floor(rnd(i, 1) * w);
      const sy = Math.floor(rnd(i, 2) * h * 0.7);
      const tw = reduced || (Math.floor(t / 600) + i) % 9 !== 0;
      if (tw) px(c, sx, sy, i % 5 ? "#c8d0ff" : "#ffffff");
    }
    disc(c, w - 60, 40, 9, "#f4f1de");
    disc(c, w - 56, 37, 8, bands[0]);
  } else {
    const sx = phase === "dawn" ? 50 : phase === "dusk" ? w - 70 : w - 80;
    const sy = phase === "day" ? 36 : h * 0.45;
    disc(c, sx, sy, 13, phase === "day" ? "#fff3b0" : "#ffd29a");
    disc(c, sx, sy, 10, phase === "day" ? "#ffe066" : "#ffa95e");
  }
  const drift = reduced ? 0 : t / 400;
  for (let i = 0; i < 6; i++) {
    const span = w + 120;
    const cx = (((rnd(i, 9) * span + drift * (0.5 + rnd(i, 8)) - camX * 0.08) % span) + span) % span - 60;
    const cy = 20 + rnd(i, 7) * h * 0.4;
    cloud(c, cx, cy, 0.7 + rnd(i, 6) * 0.6, phase);
  }
}

function cloud(c: Ctx, x: number, y: number, s: number, phase: Phase) {
  const base = phase === "night" ? "#3a4680" : phase === "dusk" ? "#f2b8c0" : phase === "dawn" ? "#ffe2d6" : P.cloud;
  const shade = phase === "night" ? "#2c3666" : phase === "dusk" ? "#c98aa6" : phase === "dawn" ? "#e8bfc0" : P.cloudShade;
  const r = Math.round(6 * s);
  disc(c, x, y + 2, r, shade);
  disc(c, x + r * 1.4, y + 3, r - 1, shade);
  disc(c, x - r * 1.3, y + 4, r - 2, shade);
  disc(c, x, y, r, base);
  disc(c, x + r * 1.4, y + 1, r - 1, base);
  disc(c, x - r * 1.3, y + 2, r - 2, base);
  rect(c, x - r * 2.2, y + r - 1, r * 4.6, 2, shade);
}

/** Warm light pools at night (lanterns, greenhouse), drawn in banded steps. */
export function glow(c: Ctx, x: number, y: number, r: number) {
  c.save();
  c.globalCompositeOperation = "lighter";
  for (const [k, a] of [
    [1, 0.08],
    [0.7, 0.08],
    [0.4, 0.1],
  ] as const) {
    c.fillStyle = `rgba(255, 200, 110, ${a})`;
    const rr = Math.round(r * k);
    for (let yy = -rr; yy <= rr; yy++) {
      const ww = Math.round(Math.sqrt(rr * rr - yy * yy) * 2);
      c.fillRect(Math.round(x - ww), Math.round(y + yy / 2), ww * 2, 1);
    }
  }
  c.restore();
}
