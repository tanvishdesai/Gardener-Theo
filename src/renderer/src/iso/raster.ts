// Pixel-exact drawing. Canvas paths always anti-alias, so every shape here is filled
// with whole-pixel rectangles: no blurry edges, no in-between colors.

export type Ctx = CanvasRenderingContext2D;
export type Pt = { x: number; y: number };

export function px(c: Ctx, x: number, y: number, color: string) {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), 1, 1);
}

export function rect(c: Ctx, x: number, y: number, w: number, h: number, color: string) {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Scanline fill of a convex polygon, sampling each row at its pixel centre. */
export function poly(c: Ctx, pts: Pt[], color: string) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  c.fillStyle = color;
  for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
    const sy = y + 0.5;
    let xl = Infinity;
    let xr = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
        const x = a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    if (xr > xl) {
      const l = Math.round(xl);
      c.fillRect(l, y, Math.round(xr) - l, 1);
    }
  }
}

/** A 2:1 isometric line, the stair-step every iso game is built from. dir: 1 = down-right, -1 = down-left. */
export function isoLine(c: Ctx, x: number, y: number, len: number, dir: 1 | -1, color: string, rise = false) {
  c.fillStyle = color;
  const dy = rise ? -1 : 1;
  for (let i = 0; i < len; i++) c.fillRect(Math.round(x + dir * i * 2), Math.round(y + dy * i), 2, 1);
}

/** Filled pixel disc. */
export function disc(c: Ctx, cx: number, cy: number, r: number, color: string) {
  c.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.round(Math.sqrt(r * r - y * y + r * 0.6));
    c.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}

/** Ordered 2x2 dither: true for roughly `amount` (0..1) of pixels. */
export function dither(x: number, y: number, amount: number) {
  const m = [0, 2, 3, 1][((y & 1) << 1) | (x & 1)] / 4 + 0.125;
  return m < amount;
}

/** Stable pseudo-random number in [0,1) for a tile/seed. */
export function rnd(a: number, b = 0, c = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Sprites are written as strings of palette keys; '.' is transparent. Pre-rendered once, then blitted. */
export type PixelMap = readonly string[];
export type Palette = Record<string, string>;

const cache = new Map<string, HTMLCanvasElement>();

export function spriteCanvas(key: string, map: PixelMap, pal: Palette, flip = false): HTMLCanvasElement {
  const k = `${key}|${flip ? 1 : 0}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const w = Math.max(...map.map((r) => r.length));
  const h = map.length;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d")!;
  for (let y = 0; y < h; y++) {
    const row = map[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "." || ch === " ") continue;
      const color = pal[ch];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(flip ? w - 1 - x : x, y, 1, 1);
    }
  }
  cache.set(k, cv);
  return cv;
}

export function blit(c: Ctx, key: string, map: PixelMap, pal: Palette, x: number, y: number, flip = false) {
  c.drawImage(spriteCanvas(key, map, pal, flip), Math.round(x), Math.round(y));
}
