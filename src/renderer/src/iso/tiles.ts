// The static ground (grass, paths, cliffs, planters, fences, signs, trees) cached in fixed-size
// world-pixel tiles, built only when in view and evicted least-recently-used. Nothing world-sized.
import { intersects, type Rect } from "./world";

/** Tile edge in world (art) pixels. Drawn at whole-number zoom, this is 1024-2560 device px. */
export const TILE = 512;

export const tileRect = (tx: number, ty: number): Rect => ({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });

/** Tile coordinates overlapping a world rect. */
export function tilesIn(r: Rect): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = [];
  for (let ty = Math.floor(r.y / TILE); ty <= Math.floor((r.y + r.h - 1) / TILE); ty++)
    for (let tx = Math.floor(r.x / TILE); tx <= Math.floor((r.x + r.w - 1) / TILE); tx++) out.push({ tx, ty });
  return out;
}

/** `lod` separates looks of the same tile (garden by day, garden after dark...). */
export const tileKey = (lod: string, tx: number, ty: number) => `${lod}|${tx}|${ty}`;

export class TileCache<V> {
  private map = new Map<string, V>();
  constructor(private cap = 64) {}
  get size() {
    return this.map.size;
  }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  has(key: string) {
    return this.map.has(key);
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value!);
  }
  /** Drops every tile (any lod) overlapping `r`. Returns the keys dropped. */
  invalidate(r: Rect): string[] {
    const gone: string[] = [];
    for (const k of this.map.keys()) {
      const [, tx, ty] = k.split("|");
      if (intersects(tileRect(+tx, +ty), r)) gone.push(k);
    }
    for (const k of gone) this.map.delete(k);
    return gone;
  }
  clear() {
    this.map.clear();
  }
}
