// The isometric garden: a small canvas drawn at true pixel resolution and scaled up by a whole number,
// so every art pixel is a crisp square. The ground is cached in tiles, only beds in view are drawn,
// and frames are drawn only when something changed or moves (0 fps when the garden is still).
// React renders the chrome around it (name tags, tooltip, zoom buttons); the canvas is driven imperatively.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MOOD_LABEL } from "../../../shared/garden";
import type { Plant, Weather } from "../../../shared/types";
import { useReducedMotion } from "../motion";
import { getState, select, setState, useGarden } from "../store";
import { describePlant } from "./describe";
import "./iso.css";
import type { Phase } from "./palette";
import { perfHooks, measured } from "./perf";
import { makeCanvas } from "./raster";
import { buildTile, deriveScene, drawGarden, drawMap, MAP_DIV, pick, staleRects, type FrameResult, type Hit, type Scene, type SceneInput, type Selection } from "./scene";
import { TILE, tileKey, tileRect, tilesIn, TileCache } from "./tiles";
import { BLOCK_H, findPath, focusBox, intersects, iso, slotTile, type Lot, type Tile } from "./world";

/** Store fields this view reads (V2 store contract). Read defensively: older stores lack some. */
interface GardenSlice extends SceneInput {
  selection: Selection;
  weather?: Weather;
  tags?: Record<string, unknown[]>;
  focusRequest?: { kind: "plant" | "bed"; id: string; nonce: number } | null;
}

function phaseAt(d: Date): Phase {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5.5 && h < 8) return "dawn";
  if (h >= 8 && h < 17.5) return "day";
  if (h >= 17.5 && h < 20) return "dusk";
  return "night";
}
const forcedPhase = new URLSearchParams(location.search).get("phase") as Phase | null;

export interface TagInfo {
  bedId: string;
  name: string;
  title: string;
  meta: string[];
  active: boolean;
  /** CSS px inside the moving overlay layer. */
  x: number;
  y: number;
  tray?: { x: number; y: number; n: number };
}

interface Walker {
  x: number;
  y: number;
  path: Tile[];
  facing: "front" | "back";
  flip: boolean;
  dist: number;
  from: Tile;
  target: string;
}

const TELEPORT = 20;

/** Everything that changes per frame lives here, outside React. */
class GardenView {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  layerEl: HTMLDivElement;
  zoom = 3;
  size = { w: 800, h: 600 };
  cam = { x: 0, y: 0 };
  camGoal: { x: number; y: number } | null = null;
  reduced = false;
  phase: Phase = forcedPhase ?? phaseAt(new Date());
  state: GardenSlice | null = null;
  scene: Scene | null = null;
  stale = true;
  hover: Hit | null = null;
  tiles = new TileCache<HTMLCanvasElement>(64);
  layer = makeCanvas(1, 1);
  walker: Walker | null = null;
  puffs: { x: number; y: number; t0: number }[] = [];
  last: FrameResult | null = null;
  placed = false;
  measured = false;
  dirty = true;
  raf = 0;
  timer = 0;
  lastTick = 0;
  lastDraw = 0;
  overlayKey = "";
  onTags: (tags: TagInfo[], newGround: { x: number; y: number } | null) => void = () => {};
  onHover: (hit: Hit | null) => void = () => {};
  private minute = 0;
  private prevSel: Selection = null;
  private prevNonce: number | undefined;
  private prefetching = false;

  constructor(wrap: HTMLDivElement, canvas: HTMLCanvasElement, layerEl: HTMLDivElement) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.layerEl = layerEl;
    this.minute = window.setInterval(() => {
      // plants age out of the ground, tallies fade, the sky moves on: at most once a minute
      this.stale = true;
      if (!forcedPhase) this.phase = phaseAt(new Date());
      this.invalidate();
    }, 60_000);
    document.addEventListener("visibilitychange", this.onVisible);
    const perf = perfHooks();
    if (perf) perf.visiblePlant = () => this.visiblePlant();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    clearInterval(this.minute);
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (!document.hidden) this.invalidate();
  };

  get scale() {
    return this.zoom === 1 ? 1 / MAP_DIV : this.zoom;
  }

  invalidate() {
    this.dirty = true;
    this.wake();
  }

  wake() {
    if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this.tick);
  }

  setStore(s: GardenSlice) {
    this.state = s;
    this.stale = true;
    if (s.selection !== this.prevSel) {
      const changed = s.selection?.kind !== this.prevSel?.kind || s.selection?.id !== this.prevSel?.id;
      this.prevSel = s.selection;
      if (changed) {
        this.ensureScene();
        this.walkTo();
        this.revealSelection();
      }
    }
    const fr = s.focusRequest;
    if (fr && fr.nonce !== this.prevNonce) {
      this.prevNonce = fr.nonce;
      this.ensureScene();
      this.focus(fr.kind, fr.id);
    }
    this.place();
    this.invalidate();
  }

  setReduced(r: boolean) {
    this.reduced = r;
    if (r && this.walker) {
      this.walker.path = [];
      this.puffs = [];
    }
    this.invalidate();
  }

  setSize(w: number, h: number) {
    this.size = { w, h };
    this.measured = true;
    this.place();
    this.invalidate();
  }

  /** First placement, once both the size and the garden are known. */
  private place() {
    if (this.placed || !this.measured || !this.ensureScene()) return;
    this.placed = true;
    this.zoom = this.size.w >= 1100 ? 3 : 2;
    this.frameAll(false);
  }

  /** Re-derives the scene from the latest store state when it changed; repaints only the tiles it touches. */
  ensureScene(): Scene | null {
    if (!this.state) return null;
    if (!this.stale && this.scene) return this.scene;
    const next = deriveScene(this.state, Date.now(), this.scene);
    const stale = staleRects(this.scene, next);
    if (stale === "all") this.tiles.clear();
    else for (const r of stale) this.tiles.invalidate(r);
    if (!this.scene || next.world !== this.scene.world) {
      if (!this.walker) {
        const h = next.world.home;
        this.walker = { x: h.gx, y: h.gy, path: [], facing: "front", flip: false, dist: 0, from: h, target: "" };
      }
    }
    if (this.canvas.getAttribute("aria-label") !== next.summary) this.canvas.setAttribute("aria-label", next.summary);
    this.scene = next;
    this.stale = false;
    return next;
  }

  // ---------- camera ----------

  viewWorld() {
    return { w: this.size.w / this.scale, h: this.size.h / this.scale };
  }

  centerOn(wx: number, wy: number, smooth: boolean) {
    const v = this.viewWorld();
    const goal = { x: Math.round(wx - v.w / 2), y: Math.round(wy - v.h / 2) };
    if (smooth && !this.reduced) this.camGoal = goal;
    else {
      this.cam = goal;
      this.camGoal = null;
    }
    this.invalidate();
  }

  frameAll(smooth: boolean) {
    const s = this.ensureScene();
    if (!s) return;
    const f = focusBox(s.world);
    const v = this.viewWorld();
    if (f.w <= v.w && f.h <= v.h) this.centerOn(f.x + f.w / 2, f.y + f.h / 2, smooth);
    else {
      const gh = s.world.greenhouse;
      const p = iso(gh.gx + gh.w / 2, gh.gy + gh.d / 2 + 2);
      this.centerOn(p.x, p.y, smooth);
    }
  }

  zoomAround(next: number, sx = this.size.w / 2, sy = this.size.h / 2) {
    const z = Math.max(1, Math.min(5, next));
    if (z === this.zoom) return;
    const wx = this.cam.x + sx / this.scale;
    const wy = this.cam.y + sy / this.scale;
    this.zoom = z;
    this.camGoal = null;
    // The map (zoom 1) shows every bed: frame the whole garden instead of keeping the pointer's spot.
    if (z === 1) {
      this.frameAll(false);
      return;
    }
    this.cam = { x: Math.round(wx - sx / this.scale), y: Math.round(wy - sy / this.scale) };
    this.invalidate();
  }

  /** World point of a plant (in the ground) or a bed. */
  pointOf(kind: "plant" | "bed", id: string): { x: number; y: number } | null {
    const s = this.scene;
    if (!s) return null;
    if (kind === "plant") {
      const at = s.slotOf.get(id);
      if (at) {
        const t = slotTile(at.lot, at.k);
        const p = iso(t.gx, t.gy);
        return { x: p.x, y: p.y - 10 };
      }
      const plant = this.state?.plants[id];
      if (!plant) return null;
      return this.pointOf("bed", plant.bedId);
    }
    const lot = s.world.lotByBed.get(id);
    if (!lot) return null;
    const p = iso(lot.gx + lot.w / 2, lot.gy + lot.d / 2);
    return { x: p.x, y: p.y - 10 };
  }

  focus(kind: "plant" | "bed", id: string) {
    if (kind === "plant" && this.zoom === 1) this.zoomAround(3);
    const p = this.pointOf(kind, id);
    if (p) this.centerOn(p.x, p.y, true);
  }

  revealSelection() {
    const sel = this.state?.selection;
    if (!sel) return;
    const p = this.pointOf(sel.kind, sel.id);
    if (!p) return;
    const v = this.viewWorld();
    const m = 40 / this.scale;
    const c = this.cam;
    if (p.x < c.x + m || p.x > c.x + v.w - m || p.y < c.y + m || p.y > c.y + v.h - m) this.centerOn(p.x, p.y, true);
  }

  // ---------- the gardener ----------

  walkTarget(): Tile | null {
    const s = this.scene;
    const sel = this.state?.selection;
    if (!s) return null;
    if (sel?.kind === "plant") {
      const at = s.slotOf.get(sel.id);
      if (at) return slotTile(at.lot, at.k).stand;
      const plant = this.state?.plants[sel.id];
      const lot = plant && s.world.lotByBed.get(plant.bedId);
      if (lot) return { gx: lot.sign.gx + 1, gy: lot.sign.gy };
    }
    if (sel?.kind === "bed") {
      const lot = s.world.lotByBed.get(sel.id);
      if (lot) return { gx: lot.sign.gx + 1, gy: lot.sign.gy };
    }
    return s.world.home;
  }

  walkTo() {
    const w = this.walker;
    const to = this.walkTarget();
    if (!w || !to || !this.scene) return;
    const key = `${to.gx},${to.gy}`;
    if (w.target === key) return;
    w.target = key;
    const from = { gx: Math.round(w.x), gy: Math.round(w.y) };
    const far = Math.abs(to.gx - from.gx) + Math.abs(to.gy - from.gy) > TELEPORT;
    if (this.reduced || far) {
      // far away (or holding still): step through the garden in a puff instead of a minutes-long walk
      if (far && !this.reduced) {
        const t0 = performance.now();
        this.puffs.push({ x: w.x, y: w.y, t0 }, { x: to.gx, y: to.gy, t0 });
      }
      Object.assign(w, { x: to.gx, y: to.gy, from: to, path: [], facing: "front", flip: false });
      return;
    }
    w.path = findPath(this.scene.world, from, to);
    w.from = from;
    w.x = from.gx;
    w.y = from.gy;
  }

  private stepWalker(dt: number): boolean {
    const w = this.walker;
    if (!w || !w.path.length) return false;
    const next = w.path[0];
    const dx = next.gx - w.x;
    const dy = next.gy - w.y;
    const d = Math.hypot(dx, dy);
    const step = dt * 3.4;
    if (Math.abs(dx) > 0.01) {
      w.facing = dx > 0 ? "front" : "back";
      w.flip = dx < 0;
    } else if (Math.abs(dy) > 0.01) {
      w.facing = dy > 0 ? "front" : "back";
      w.flip = dy > 0;
    }
    if (d <= step) {
      w.x = next.gx;
      w.y = next.gy;
      w.from = next;
      w.path.shift();
      if (!w.path.length) {
        w.facing = "front";
        w.flip = false;
      }
    } else {
      w.x += (dx / d) * step;
      w.y += (dy / d) * step;
    }
    w.dist += step;
    return true;
  }

  private stepCamera(): boolean {
    const goal = this.camGoal;
    if (!goal) return false;
    const c = this.cam;
    const nx = c.x + (goal.x - c.x) * 0.25;
    const ny = c.y + (goal.y - c.y) * 0.25;
    this.cam = { x: Math.abs(goal.x - nx) < 1 ? goal.x : nx, y: Math.abs(goal.y - ny) < 1 ? goal.y : ny };
    if (this.cam.x === goal.x && this.cam.y === goal.y) this.camGoal = null;
    return true;
  }

  // ---------- frame scheduler ----------

  tick = (now: number) => {
    this.raf = 0;
    if (document.hidden) return;
    const dt = Math.min(0.1, (now - (this.lastTick || now)) / 1000);
    this.lastTick = now;
    this.puffs = this.puffs.filter((p) => now - p.t0 < 390);
    const camMoved = this.stepCamera();
    const walked = this.stepWalker(dt);
    const moving = camMoved || walked || this.puffs.length > 0;
    const animDue = !!this.last?.animating && !this.reduced && now - this.lastDraw >= 120;
    // camera and gardener motion draw at 30 fps; input (drag, wheel, hover) draws right away
    if (this.dirty || animDue || (moving && now - this.lastDraw >= 30)) this.draw(now);
    if (moving || (this.last?.missing ?? 0) > 0) {
      this.wake();
      return;
    }
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.last?.animating && !this.reduced) {
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        this.wake();
      }, Math.max(0, 125 - (performance.now() - this.lastDraw)));
    } else this.lastTick = 0;
    this.prefetch();
  };

  private draw(now: number) {
    measured(() => {
      // deriving the scene (which plants stand where) counts toward the frame
      const scene = this.ensureScene();
      if (!scene || !this.state) return;
      this.dirty = false;
      this.lastDraw = now;
      const map = this.zoom === 1;
      const cssScale = map ? 1 : this.zoom;
      const vw = map ? this.size.w : Math.ceil(this.size.w / this.zoom);
      const vh = map ? this.size.h : Math.ceil(this.size.h / this.zoom);
      const cv = this.canvas;
      if (cv.width !== vw || cv.height !== vh) {
        cv.width = vw;
        cv.height = vh;
        cv.style.width = `${vw * cssScale}px`;
        cv.style.height = `${vh * cssScale}px`;
      }
      const L = this.layer;
      if (L.cv.width !== vw || L.cv.height !== vh) {
        L.cv.width = vw;
        L.cv.height = vh;
      }
      const main = cv.getContext("2d")!;
      main.imageSmoothingEnabled = false;
      L.c.imageSmoothingEnabled = false;
      const cam = { x: Math.round(this.cam.x), y: Math.round(this.cam.y) };
      const w = this.walker;
      const next = w?.path[0] ?? (w ? { gx: Math.round(w.x), gy: Math.round(w.y) } : null);
      const s = this.state!;
      const frame = {
        main,
        layer: L.c,
        vw,
        vh,
        cam,
        scene,
        soil: s.soil,
        tags: s.tags ?? {},
        selection: s.selection,
        hover: this.hover,
        phase: this.phase,
        weather: s.weather,
        reduced: this.reduced,
        now: Date.now(),
        gardener:
          w && next
            ? { x: w.x, y: w.y, facing: w.facing, flip: w.flip, step: w.path.length && !this.reduced ? 1 + (Math.floor(w.dist * 3.2) % 2) : 0, key: Math.max(w.from.gx + w.from.gy, next.gx + next.gy) }
            : null,
        puffs: this.puffs.map((p) => ({ x: p.x, y: p.y, k: Math.floor((now - p.t0) / 130) })),
        tiles: this.tiles,
        buildBudget: this.last ? 3 : 64,
      };
      this.last = map ? drawMap(frame) : drawGarden(frame);
      const sc = this.scale;
      this.layerEl.style.transform = `translate(${-cam.x * sc}px, ${-cam.y * sc}px)`;
      this.wrap.className = `iso iso--${this.phase}`;
      this.updateTags(this.last.lots);
    });
  }

  /** Builds tiles just outside the view while nothing else is happening, one per idle slice. */
  private prefetch() {
    if (this.prefetching || this.zoom === 1 || !this.scene) return;
    const scene = this.scene;
    const v = this.viewWorld();
    const r = { x: this.cam.x - TILE, y: this.cam.y - TILE, w: v.w + TILE * 2, h: v.h + TILE * 2 };
    const lod = `g${this.phase === "night" ? 2 : this.phase === "dusk" ? 1 : 0}`;
    const todo = tilesIn(r).find((t) => intersects(tileRect(t.tx, t.ty), scene.world.bounds) && !this.tiles.has(tileKey(lod, t.tx, t.ty)));
    if (!todo) return;
    this.prefetching = true;
    const idle = (window as Window & { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 30));
    idle(() => {
      this.prefetching = false;
      if (this.scene !== scene || this.state === null) return;
      const light = lod === "g2" ? 2 : lod === "g1" ? 1 : 0;
      if (!this.tiles.has(tileKey(lod, todo.tx, todo.ty))) this.tiles.set(tileKey(lod, todo.tx, todo.ty), buildTile(scene, this.state.soil, todo.tx, todo.ty, light));
      this.prefetch();
    });
  }

  // ---------- name tags (only beds in view, never overlapping) ----------

  private updateTags(lots: Lot[]) {
    const s = this.state!;
    const scene = this.scene!;
    const map = this.zoom === 1;
    const sel = s.selection;
    const ordered = [...lots].sort((a, b) => (sel?.kind === "bed" && sel.id === b.bedId ? 1 : 0) - (sel?.kind === "bed" && sel.id === a.bedId ? 1 : 0));
    const key = `${this.zoom}|${sel?.kind === "bed" ? sel.id : ""}|${ordered.map((l) => `${l.bedId}:${scene.views.get(l.bedId)?.catalogue}:${s.soil[l.bedId]?.dirty}:${s.soil[l.bedId]?.branch}`).join(",")}`;
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const sc = this.scale;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const free = (r: { x: number; y: number; w: number; h: number }) => !placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
    const out: TagInfo[] = [];
    for (const lot of ordered) {
      const v = scene.views.get(lot.bedId);
      if (!v) continue;
      const soil = s.soil[lot.bedId];
      const meta = map ? [] : [soil?.branch, soil && soil.dirty > 0 ? `${soil.dirty} loose` : undefined].filter((x): x is string => !!x);
      const anchor = map ? iso(lot.gx + lot.w / 2, lot.gy + lot.d / 2) : iso(lot.sign.gx, lot.sign.gy);
      const x = anchor.x * sc;
      const y = (anchor.y - (map ? 6 : 26)) * sc;
      const tw = Math.max(v.bed.name.length * 8, ...meta.map((m) => m.length * 7)) + 18;
      const th = meta.length ? 34 : 20;
      const r = { x: x - tw / 2, y: y - th, w: tw, h: th };
      if (!free(r)) continue;
      placed.push(r);
      const tag: TagInfo = { bedId: lot.bedId, name: v.bed.name, title: `${v.bed.path}\n${MOOD_LABEL[v.mood]}`, meta, active: sel?.kind === "bed" && sel.id === lot.bedId, x, y };
      if (!map && v.catalogue > 0) {
        const t = iso(lot.tray.gx, lot.tray.gy);
        const tr = { x: t.x * sc, y: (t.y + 14) * sc, n: v.catalogue };
        const rr = { x: tr.x - 70, y: tr.y, w: 140, h: 18 };
        if (free(rr)) {
          placed.push(rr);
          tag.tray = tr;
        }
      }
      out.push(tag);
    }
    const ng = scene.world.newGround;
    const v = this.viewWorld();
    const np = iso(ng.gx + ng.w / 2, ng.gy + ng.d / 2);
    const inView = intersects(ng.rect, { x: this.cam.x, y: this.cam.y, w: v.w, h: v.h });
    this.onTags(out, inView ? { x: np.x * sc, y: (np.y - (this.zoom === 1 ? 4 : 20)) * sc } : null);
  }

  // ---------- input ----------

  pickAt(sx: number, sy: number): Hit | null {
    const s = this.ensureScene();
    if (!s || !this.state) return null;
    return pick(s, this.state.soil, { x: this.cam.x + sx / this.scale, y: this.cam.y + sy / this.scale }, this.zoom === 1);
  }

  setHover(hit: Hit | null) {
    const same = JSON.stringify(hit) === JSON.stringify(this.hover);
    if (same) return;
    this.hover = hit;
    this.onHover(hit);
    this.invalidate();
  }

  visiblePlant() {
    const s = this.scene;
    if (!s || !this.last || this.zoom === 1) return null;
    for (const lot of this.last.lots) {
      const v = s.views.get(lot.bedId);
      const plant = v?.ground[0];
      if (!plant) continue;
      const t = slotTile(lot, 0);
      const p = iso(t.gx, t.gy);
      const x = (p.x - this.cam.x) * this.scale;
      const y = (p.y + 8 - BLOCK_H - 6 - this.cam.y) * this.scale;
      if (x > 20 && y > 20 && x < this.size.w - 20 && y < this.size.h - 20) return { x, y, id: plant.id };
    }
    return null;
  }
}

/** Feeds store changes to the view without re-rendering the garden component. */
function StoreFeed({ view }: { view: GardenView }) {
  const s = useGarden((s) => s);
  useEffect(() => view.setStore(s as unknown as GardenSlice), [s, view]);
  return null;
}

function Tags({ view, onAddBed }: { view: GardenView; onAddBed(): void }) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [ng, setNg] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    view.onTags = (t, n) => {
      setTags(t);
      setNg(n);
    };
    view.overlayKey = "";
    view.invalidate();
  }, [view]);
  const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onPointerUp: (e: React.PointerEvent) => e.stopPropagation() };
  return (
    <>
      {tags.map((t) => (
        <div key={t.bedId}>
          <button className={`nametag nametag--bed ${t.active ? "is-active" : ""}`} style={{ left: t.x, top: t.y }} {...stop} onClick={() => select({ kind: "bed", id: t.bedId })} title={t.title}>
            <span className="nametag__name">{t.name}</span>
            {t.meta.map((m) => (
              <span key={m} className={`nametag__meta ${m.endsWith("loose") ? "nametag__meta--loose" : ""}`}>
                {m}
              </span>
            ))}
          </button>
          {t.tray && (
            <button
              className="nametag nametag--tray"
              style={{ left: t.tray.x, top: t.tray.y }}
              {...stop}
              onClick={() => {
                select({ kind: "bed", id: t.bedId });
                setState({ catalogueOpen: true } as never);
              }}
              title="Older plants in this bed live in the Seed Catalogue"
            >
              +{t.tray.n} in the catalogue
            </button>
          )}
        </div>
      ))}
      {ng && (
        <button className="nametag nametag--new" style={{ left: ng.x, top: ng.y }} {...stop} onClick={onAddBed}>
          <span className="nametag__name">+ Break new ground</span>
        </button>
      )}
    </>
  );
}

function tipLines(hit: Hit): { title?: string; lines: string[]; status?: string } | null {
  const s = getState() as unknown as GardenSlice;
  const bed = "bedId" in hit ? s.beds.find((b) => b.id === hit.bedId) : undefined;
  switch (hit.kind) {
    case "plant": {
      const p: Plant | undefined = s.plants[hit.id];
      if (!p) return null;
      return { title: p.name, lines: describePlant(p, s.tags?.[p.id]?.length ?? 0), status: p.status };
    }
    case "compost":
      return { lines: [`Compost: agent guidance (${s.soil[hit.bedId]?.guidance.join(", ")})`] };
    case "slot":
      return { lines: [`Sow an agent in ${bed?.name ?? "this bed"}`] };
    case "bed":
      return { lines: [`${bed?.name ?? "Bed"}: open the soil report`] };
    case "tray":
      return { lines: ["Seed tray: older plants in this bed live in the Seed Catalogue. Click to open it."] };
    case "newground":
      return { lines: ["Break new ground: add a repository"] };
  }
}

function Tip({ view, tipRef }: { view: GardenView; tipRef: React.RefObject<HTMLDivElement | null> }) {
  const [hit, setHit] = useState<Hit | null>(null);
  useEffect(() => {
    view.onHover = setHit;
  }, [view]);
  const t = hit ? tipLines(hit) : null;
  return (
    <div ref={tipRef} className={`iso__tip ${t?.title ? "iso__tip--plant" : ""} ${t?.status ? `iso__tip--${t.status}` : ""}`} style={{ display: t ? "block" : "none" }}>
      {t?.title && <div className="iso__tip-title">{t.title}</div>}
      {t?.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

export function IsoGarden({ onAddBed }: { onAddBed(): void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GardenView | null>(null);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const v = new GardenView(wrap.current!, canvas.current!, layer.current!);
    v.reduced = reduced;
    setView(v);
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      v.setSize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      v.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => view?.setReduced(reduced), [view, reduced]);

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !view) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: view.cam.x, cy: view.cam.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!view) return;
    const { sx, sy } = local(e);
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.moved || Math.abs(dx) + Math.abs(dy) > 4) {
        d.moved = true;
        view.camGoal = null;
        view.cam = { x: Math.round(d.cx - dx / view.scale), y: Math.round(d.cy - dy / view.scale) };
        wrap.current!.style.cursor = "grabbing";
        view.invalidate();
        return;
      }
    }
    const hit = view.pickAt(sx, sy);
    view.setHover(hit);
    wrap.current!.style.cursor = hit ? "pointer" : "default";
    if (tip.current) {
      tip.current.style.left = `${sx + 14}px`;
      tip.current.style.top = `${sy + 14}px`;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!view || !d || d.moved) return;
    const { sx, sy } = local(e);
    const hit = view.pickAt(sx, sy);
    if (!hit) return select(null);
    switch (hit.kind) {
      case "plant":
        return select({ kind: "plant", id: hit.id });
      case "bed":
      case "compost":
        if (view.zoom === 1) view.focus("bed", hit.bedId);
        return select({ kind: "bed", id: hit.bedId });
      case "tray":
        select({ kind: "bed", id: hit.bedId });
        return setState({ catalogueOpen: true } as never);
      case "slot":
        return setState({ sowing: hit.bedId, sowPreset: null } as never);
      case "newground":
        return onAddBed();
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!view) return;
    const { sx, sy } = local(e);
    if (e.ctrlKey || e.metaKey) {
      view.zoomAround(view.zoom + (e.deltaY < 0 ? 1 : -1), sx, sy);
      return;
    }
    view.camGoal = null;
    view.cam = { x: view.cam.x + (e.shiftKey ? e.deltaY : e.deltaX) / view.scale, y: view.cam.y + (e.shiftKey ? 0 : e.deltaY) / view.scale };
    view.invalidate();
  };

  return (
    <div
      ref={wrap}
      className="iso"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => view?.setHover(null)}
      onWheel={onWheel}
    >
      <canvas ref={canvas} className="iso__canvas" role="img" aria-label="Garden view" />
      <div className="iso__overlay">
        <div ref={layer} className="iso__world">
          {view && <Tags view={view} onAddBed={onAddBed} />}
        </div>
      </div>
      {view && <StoreFeed view={view} />}
      {view && <Tip view={view} tipRef={tip} />}
      <div className="iso__zoom" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button className="pxbtn pxbtn--icon" onClick={() => view?.zoomAround(view.zoom + 1)} aria-label="Zoom in" title="Zoom in (Ctrl + scroll)">
          +
        </button>
        <button className="pxbtn pxbtn--icon" onClick={() => view?.zoomAround(view.zoom - 1)} aria-label="Zoom out" title="Zoom out (zoom 1 is the map of every bed)">
          −
        </button>
        <button className="pxbtn pxbtn--icon" onClick={() => view?.frameAll(true)} aria-label="Recenter" title="Back to the greenhouse">
          ⌂
        </button>
      </div>
    </div>
  );
}
