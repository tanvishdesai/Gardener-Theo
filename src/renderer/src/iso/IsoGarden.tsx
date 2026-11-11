// The isometric garden: a small canvas drawn at true pixel resolution and scaled up
// by a whole number, so every art pixel is a crisp square. Depth-sorted like an old
// isometric sim: tiles from back to front, things on a tile after the tile itself.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bedMood, MOOD_LABEL, statusLabel } from "../../../shared/garden";
import type { Plant } from "../../../shared/types";
import { useReducedMotion } from "../motion";
import { plantsInBed, select, setState, useGarden } from "../store";
import { P, TINT, type Phase } from "./palette";
import {
  bubble,
  bubbleFor,
  compostBin,
  fence,
  gardener as paintGardener,
  glow,
  greenhouse,
  newGroundMarker,
  paintGround,
  paintPlant,
  paintSky,
  planterBlock,
  plantHeight,
  signpost,
  tileCursor,
  tree,
  worldBounds,
} from "./paint";
import { hashString, px, type Ctx } from "./raster";
import { BLOCK_H, buildWorld, findPath, focusBox, iso, tileAt, type Lot, type Tile } from "./world";

const MOOD_COLOR = { fallow: "#b8a888", sown: "#8fd06c", growing: "#5fb4ec", tending: P.amber, harvest: "#ffe27a" } as const;

type Hit =
  | { kind: "plant"; id: string }
  | { kind: "slot"; bedId: string }
  | { kind: "bed"; bedId: string }
  | { kind: "compost"; bedId: string }
  | { kind: "newground" };

interface Walker {
  x: number;
  y: number;
  path: Tile[];
  facing: "front" | "back";
  flip: boolean;
  moving: boolean;
  dist: number;
  from: Tile;
  target: string;
}

function phaseAt(d: Date): Phase {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5.5 && h < 8) return "dawn";
  if (h >= 8 && h < 17.5) return "day";
  if (h >= 17.5 && h < 20) return "dusk";
  return "night";
}

function usePhase(): Phase {
  const forced = new URLSearchParams(location.search).get("phase") as Phase | null;
  const [phase, setPhase] = useState<Phase>(() => forced ?? phaseAt(new Date()));
  useEffect(() => {
    if (forced) return;
    const t = setInterval(() => setPhase(phaseAt(new Date())), 60_000);
    return () => clearInterval(t);
  }, [forced]);
  return phase;
}

export function IsoGarden({ onAddBed }: { onAddBed(): void }) {
  const beds = useGarden((s) => s.beds);
  const plants = useGarden((s) => s.plants);
  const soil = useGarden((s) => s.soil);
  const selection = useGarden((s) => s.selection);
  const reduced = useReducedMotion();
  const phase = usePhase();

  const plantsByBed = useMemo(() => Object.fromEntries(beds.map((b) => [b.id, plantsInBed(plants, b.id)])), [beds, plants]);
  // The layout only changes when beds or the set of plants change, not on every status update.
  const layoutKey = beds.map((b) => `${b.id}:${plantsByBed[b.id].map((p) => p.id).join(",")}`).join("|");
  const world = useMemo(() => buildWorld(beds, plantsByBed), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  const size = measured ?? { w: 800, h: 600 };
  const [zoom, setZoom] = useState(3);
  const [hover, setHover] = useState<{ hit: Hit | null; tile: Tile | null; sx: number; sy: number }>({ hit: null, tile: null, sx: 0, sy: 0 });
  const cam = useRef({ x: 0, y: 0 });
  const camGoal = useRef<{ x: number; y: number } | null>(null);
  const placed = useRef(false);

  // Latest state for the render loop, without re-creating it.
  const live = useRef({ world, plants, plantsByBed, soil, selection, hover, phase, reduced, zoom, size });
  live.current = { world, plants, plantsByBed, soil, selection, hover, phase, reduced, zoom, size };
  const dirty = useRef(true);
  useEffect(() => {
    dirty.current = true;
  }, [world, plants, soil, selection, hover, phase, reduced, zoom, size]);

  // ---------- sizing and camera ----------

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setMeasured({ w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = { w: Math.ceil(size.w / zoom), h: Math.ceil(size.h / zoom) };

  const centerOn = useCallback(
    (wx: number, wy: number, smooth: boolean) => {
      const goal = { x: Math.round(wx - view.w / 2), y: Math.round(wy - view.h / 2) };
      if (smooth && !reduced) camGoal.current = goal;
      else {
        cam.current = goal;
        camGoal.current = null;
      }
      dirty.current = true;
    },
    [view.w, view.h, reduced],
  );

  // First placement: frame the greenhouse and the beds, from the top if they don't all fit.
  const frameAll = useCallback(
    (z: number, smooth: boolean) => {
      const f = focusBox(world);
      const vw = size.w / z;
      const vh = size.h / z;
      const goal = { x: Math.round(f.x + f.w / 2 - vw / 2), y: Math.round(f.h > vh ? f.y - 10 : f.y + f.h / 2 - vh / 2) };
      if (smooth && !reduced) camGoal.current = goal;
      else cam.current = goal;
      dirty.current = true;
    },
    [world, size.w, size.h, reduced],
  );
  useEffect(() => {
    if (placed.current || !measured) return;
    placed.current = true;
    const z = measured.w >= 1100 ? 3 : 2;
    setZoom(z);
    frameAll(z, false);
  }, [measured, frameAll]);

  // Bring the selection into view if it is off screen.
  const targetPoint = useCallback((): { x: number; y: number } | null => {
    const sel = live.current.selection;
    if (!sel) return null;
    for (const lot of world.lots) {
      if (sel.kind === "bed" && lot.bedId === sel.id) {
        const p = iso(lot.gx + lot.w / 2, lot.gy + lot.d / 2);
        return { x: p.x, y: p.y - 10 };
      }
      const slot = lot.slots.find((s) => s.plantId === (sel.kind === "plant" ? sel.id : "~"));
      if (slot) {
        const p = iso(slot.gx, slot.gy);
        return { x: p.x, y: p.y - 10 };
      }
    }
    return null;
  }, [world]);

  useEffect(() => {
    const t = targetPoint();
    if (!t) return;
    const c = cam.current;
    const margin = 40;
    if (t.x < c.x + margin || t.x > c.x + view.w - margin || t.y < c.y + margin || t.y > c.y + view.h - margin) centerOn(t.x, t.y, true);
    // re-check after the panel opens and the view narrows
  }, [selection, targetPoint, view.w, view.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const setZoomAround = (next: number, sx?: number, sy?: number) => {
    const z = Math.max(2, Math.min(5, next));
    if (z === zoom) return;
    const ax = sx ?? size.w / 2;
    const ay = sy ?? size.h / 2;
    const wx = cam.current.x + ax / zoom;
    const wy = cam.current.y + ay / zoom;
    cam.current = { x: Math.round(wx - ax / z), y: Math.round(wy - ay / z) };
    camGoal.current = null;
    setZoom(z);
  };

  // ---------- the static ground layer ----------

  const groundLayer = useMemo(() => {
    const b = worldBounds(world);
    const cv = document.createElement("canvas");
    cv.width = b.w;
    cv.height = b.h;
    const c = cv.getContext("2d")!;
    c.translate(-b.x, -b.y);
    paintGround(c, world);
    return { cv, b };
  }, [world]);

  // ---------- walking ----------

  const walker = useRef<Walker>({ x: world.home.gx, y: world.home.gy, path: [], facing: "front", flip: false, moving: false, dist: 0, from: world.home, target: "" });

  const walkTarget = useMemo((): Tile => {
    if (selection?.kind === "plant") {
      for (const lot of world.lots) {
        const s = lot.slots.find((x) => x.plantId === selection.id);
        if (s) return s.stand;
      }
    }
    if (selection?.kind === "bed") {
      const lot = world.lots.find((l) => l.bedId === selection.id);
      if (lot) return { gx: lot.sign.gx + 1, gy: lot.sign.gy };
    }
    return world.home;
  }, [selection, world]);

  useEffect(() => {
    const w = walker.current;
    const key = `${walkTarget.gx},${walkTarget.gy}`;
    if (w.target === key) return;
    w.target = key;
    const from = { gx: Math.round(w.x), gy: Math.round(w.y) };
    if (reduced) {
      w.x = walkTarget.gx;
      w.y = walkTarget.gy;
      w.path = [];
      dirty.current = true;
      return;
    }
    w.path = findPath(world, from, walkTarget);
    w.from = from;
    w.x = from.gx;
    w.y = from.gy;
  }, [walkTarget, world, reduced]);

  // ---------- render loop ----------

  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  const hits = useRef<{ hit: Hit; x: number; y: number; w: number; h: number }[]>([]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = live.current;
      let moving = false;

      // camera easing
      const goal = camGoal.current;
      if (goal) {
        const c = cam.current;
        const nx = c.x + (goal.x - c.x) * 0.2;
        const ny = c.y + (goal.y - c.y) * 0.2;
        cam.current = { x: Math.abs(goal.x - nx) < 1 ? goal.x : nx, y: Math.abs(goal.y - ny) < 1 ? goal.y : ny };
        if (cam.current.x === goal.x && cam.current.y === goal.y) camGoal.current = null;
        moving = true;
      }

      // gardener
      const w = walker.current;
      if (w.path.length) {
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
        } else {
          w.x += (dx / d) * step;
          w.y += (dy / d) * step;
        }
        w.dist += step;
        w.moving = true;
        moving = true;
      } else if (w.moving) {
        w.moving = false;
        w.facing = "front";
        w.flip = false;
        dirty.current = true;
      }

      const animate = !L.reduced;
      const interval = moving ? 1000 / 30 : 1000 / 8;
      if (!dirty.current && !moving && (!animate || now - lastDraw < interval)) return;
      if (!moving && animate && now - lastDraw < interval && !dirty.current) return;
      lastDraw = now;
      dirty.current = false;
      draw(now);
    };

    const draw = (now: number) => {
      const L = live.current;
      const cv = canvas.current;
      if (!cv) return;
      const vw = Math.ceil(L.size.w / L.zoom);
      const vh = Math.ceil(L.size.h / L.zoom);
      if (cv.width !== vw || cv.height !== vh) {
        cv.width = vw;
        cv.height = vh;
      }
      if (!frameCanvas.current) frameCanvas.current = document.createElement("canvas");
      const fc = frameCanvas.current;
      if (fc.width !== vw || fc.height !== vh) {
        fc.width = vw;
        fc.height = vh;
      }
      const main = cv.getContext("2d")!;
      const c = fc.getContext("2d")!;
      main.imageSmoothingEnabled = false;
      c.imageSmoothingEnabled = false;
      const frame = L.reduced ? 0 : Math.floor(now / 125);
      const camX = Math.round(cam.current.x);
      const camY = Math.round(cam.current.y);
      if (overlay.current) overlay.current.style.transform = `translate(${-camX * L.zoom}px, ${-camY * L.zoom}px)`;

      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, vw, vh);
      c.translate(-camX, -camY);
      const gl = groundLayer;
      c.drawImage(gl.cv, gl.b.x, gl.b.y);

      const night = L.phase === "night";
      hits.current = [];
      const items: { key: number; sub: number; gx: number; draw: () => void }[] = [];
      const add = (gx: number, gy: number, sub: number, fn: () => void) => items.push({ key: gx + gy, sub, gx, draw: fn });
      const sel = L.selection;
      const hoverTile = L.hover.tile;
      const W = L.world;
      const bubbles: (() => void)[] = [];
      const lights: [number, number, number][] = [];

      // ground-level hover cursor goes under everything
      if (hoverTile && W.ground[hoverTile.gy * W.cols + hoverTile.gx] !== "planter") {
        const p = iso(hoverTile.gx, hoverTile.gy);
        if (hoverTile.gx >= 0 && hoverTile.gy >= 0 && hoverTile.gx < W.cols && hoverTile.gy < W.rows) tileCursor(c, p.x, p.y, "rgba(255,255,255,.75)");
      }

      newGroundMarker(c, W, frame);
      hits.current.push({ hit: { kind: "newground" }, ...rectOfTiles(W.newGround.gx, W.newGround.gy, W.newGround.w, W.newGround.d) });

      for (const t of W.trees) add(t.gx, t.gy, 1, () => tree(c, t.gx, t.gy, t.size));
      const gh = W.greenhouse;
      add(gh.gx + gh.w - 1, gh.gy + gh.d - 1, 1, () => greenhouse(c, W, night || L.phase === "dusk"));
      if (night || L.phase === "dusk") {
        const d = iso(W.home.gx, W.home.gy);
        lights.push([d.x, d.y - 6, 40]);
      }

      for (const lot of W.lots) paintLot(c, lot, add, frame, now, bubbles, lights);

      // gardener
      const w = walker.current;
      const nextT = w.path[0] ?? { gx: Math.round(w.x), gy: Math.round(w.y) };
      const gKey = Math.max(w.from.gx + w.from.gy, nextT.gx + nextT.gy);
      items.push({
        key: gKey,
        sub: 2,
        gx: w.x,
        draw: () => {
          const p = iso(w.x, w.y);
          const step = w.moving && !L.reduced ? 1 + (Math.floor(w.dist * 3.2) % 2) : 0;
          paintGardener(c, p.x, p.y + 10, w.facing, w.flip, step);
        },
      });

      items.sort((a, b) => a.key - b.key || a.sub - b.sub || a.gx - b.gx);
      for (const it of items) it.draw();

      // light and lamps
      const tint = TINT[L.phase];
      if (tint) {
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = "source-atop";
        c.fillStyle = tint;
        c.fillRect(0, 0, vw, vh);
        c.restore();
      }
      if (night || L.phase === "dusk") for (const [x, y, r] of lights) glow(c, x, y, night ? r : r * 0.6);
      // bubbles are interface, so they stay readable after dark
      for (const b of bubbles) b();

      main.setTransform(1, 0, 0, 1, 0, 0);
      paintSky(main, vw, vh, L.phase, now, camX, L.reduced);
      main.drawImage(fc, 0, 0);

      function paintLot(c: Ctx, lot: Lot, add: (gx: number, gy: number, sub: number, fn: () => void) => void, frame: number, _now: number, bubbles: (() => void)[], lights: [number, number, number][]) {
        const soil = L.soil[lot.bedId];
        const bedPlants = L.plantsByBed[lot.bedId] ?? [];
        const isPlanter = (gx: number, gy: number) => gx >= lot.planter.gx && gx < lot.planter.gx + lot.planter.len && gy >= lot.planter.gy && gy < lot.planter.gy + lot.planter.lines;
        const looseCount = Math.min(lot.planter.len * lot.planter.lines, Math.ceil((soil?.dirty ?? 0) / 2));
        const bedSelected = sel?.kind === "bed" && sel.id === lot.bedId;
        let k = 0;
        for (let gy = lot.planter.gy; gy < lot.planter.gy + lot.planter.lines; gy++)
          for (let gx = lot.planter.gx; gx < lot.planter.gx + lot.planter.len; gx++) {
            const loose = k++ < looseCount && (gx * 7 + gy * 3) % 2 === 0;
            add(gx, gy, 0, () => {
              planterBlock(c, gx, gy, { nw: !isPlanter(gx - 1, gy), ne: !isPlanter(gx, gy - 1), sw: !isPlanter(gx, gy + 1), se: !isPlanter(gx + 1, gy) }, soil, loose || (looseCount > 0 && k === 1));
              const p = iso(gx, gy);
              if (bedSelected) tileCursor(c, p.x, p.y - BLOCK_H, frame % 4 < 2 ? P.gold : "#ffffff", true);
              if (hoverTile && hoverTile.gx === gx && hoverTile.gy === gy) tileCursor(c, p.x, p.y - BLOCK_H, "rgba(255,255,255,.8)");
            });
            const r = rectOfTiles(gx, gy, 1, 1);
            hits.current.push({ hit: { kind: "bed", bedId: lot.bedId }, x: r.x, y: r.y - BLOCK_H, w: r.w, h: r.h + BLOCK_H });
          }
        if (soil && soil.tests.length > 0) {
          for (let gx = lot.gx; gx < lot.gx + lot.w; gx++) add(gx, lot.gy, -1, () => fence(c, gx, lot.gy, "ne"));
          for (let gy = lot.gy; gy < lot.gy + lot.d; gy++) add(lot.gx, gy, -1, () => fence(c, lot.gx, gy, "nw"));
        }
        const mood = bedMood(bedPlants);
        add(lot.sign.gx, lot.sign.gy, 1, () => signpost(c, lot.sign.gx, lot.sign.gy, night, MOOD_COLOR[mood]));
        {
          const p = iso(lot.sign.gx, lot.sign.gy);
          hits.current.push({ hit: { kind: "bed", bedId: lot.bedId }, x: p.x - 10, y: p.y - 24, w: 22, h: 34 });
          if (night || L.phase === "dusk") lights.push([p.x - 10, p.y - 4, 22]);
        }
        if (soil && soil.guidance.length > 0) {
          add(lot.compost.gx, lot.compost.gy, 1, () => compostBin(c, lot.compost.gx, lot.compost.gy));
          const p = iso(lot.compost.gx, lot.compost.gy);
          hits.current.push({ hit: { kind: "compost", bedId: lot.bedId }, x: p.x - 10, y: p.y - 6, w: 20, h: 18 });
        }
        const staked = (soil?.ci.length ?? 0) > 0;
        for (const slot of lot.slots) {
          const p = iso(slot.gx, slot.gy);
          const bx = p.x;
          const by = p.y + 8 - BLOCK_H;
          if (!slot.plantId) {
            add(slot.gx, slot.gy, 1, () => {
              const on = L.reduced || frame % 8 < 6;
              const col = on ? "#f6e7c4" : P.soilLight;
              px(c, bx, by - 2, col);
              px(c, bx - 1, by - 1, col);
              px(c, bx, by - 1, col);
              px(c, bx + 1, by - 1, col);
              px(c, bx, by, col);
            });
            hits.current.push({ hit: { kind: "slot", bedId: lot.bedId }, x: bx - 12, y: by - 8, w: 24, h: 14 });
            continue;
          }
          const plant = L.plants[slot.plantId];
          if (!plant) continue;
          const seed = hashString(plant.id) % 97;
          const selected = sel?.kind === "plant" && sel.id === plant.id;
          const hovered = L.hover.hit?.kind === "plant" && L.hover.hit.id === plant.id;
          add(slot.gx, slot.gy, 1, () => {
            if (selected) tileCursor(c, p.x, p.y - BLOCK_H, frame % 4 < 2 ? P.gold : "#ffffff");
            else if (hovered) tileCursor(c, p.x, p.y - BLOCK_H, "rgba(255,255,255,.85)");
            const head = paintPlant(c, { plant, bx, by, frame, staked, reduced: L.reduced, seed });
            const kind = bubbleFor(plant);
            if (kind) bubbles.push(() => bubble(c, kind, head.x, head.y - 2, frame + seed, L.reduced));
          });
          const h = plantHeight(plant);
          hits.current.push({ hit: { kind: "plant", id: plant.id }, x: bx - 12, y: by - h - 30, w: 24, h: h + 36 });
        }
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [groundLayer]);

  // ---------- input ----------

  const toWorld = (sx: number, sy: number) => ({ x: cam.current.x + sx / zoom, y: cam.current.y + sy / zoom });

  const pick = (sx: number, sy: number): { hit: Hit | null; tile: Tile | null } => {
    const p = toWorld(sx, sy);
    let hit: Hit | null = null;
    // plants first (they stand above everything), then the rest, front-most last
    for (const h of hits.current) {
      if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) {
        if (h.hit.kind === "plant") hit = h.hit;
        else if (!hit || hit.kind !== "plant") hit = hit && h.hit.kind === "bed" && hit.kind !== "bed" ? hit : h.hit;
      }
    }
    const raised = tileAt(p.x, p.y + BLOCK_H);
    const flat = tileAt(p.x, p.y);
    const inPlanter = world.ground[raised.gy * world.cols + raised.gx] === "planter";
    return { hit, tile: inPlanter ? raised : flat };
  };

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.moved || Math.abs(dx) + Math.abs(dy) > 4) {
        d.moved = true;
        camGoal.current = null;
        cam.current = { x: Math.round(d.cx - dx / zoom), y: Math.round(d.cy - dy / zoom) };
        dirty.current = true;
        return;
      }
    }
    const next = pick(sx, sy);
    const same = JSON.stringify(next.hit) === JSON.stringify(hover.hit) && next.tile?.gx === hover.tile?.gx && next.tile?.gy === hover.tile?.gy;
    if (!same) setHover({ ...next, sx, sy });
    else if (next.hit) setHover((h) => ({ ...h, sx, sy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const r = wrap.current!.getBoundingClientRect();
    const { hit } = pick(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return select(null);
    switch (hit.kind) {
      case "plant":
        return select({ kind: "plant", id: hit.id });
      case "bed":
      case "compost":
        return select({ kind: "bed", id: hit.bedId });
      case "slot":
        return setState({ sowing: hit.bedId, sowPreset: null });
      case "newground":
        return onAddBed();
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      setZoomAround(zoom + (e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    camGoal.current = null;
    cam.current = { x: cam.current.x + (e.shiftKey ? e.deltaY : e.deltaX) / zoom, y: cam.current.y + (e.shiftKey ? 0 : e.deltaY) / zoom };
    dirty.current = true;
  };

  // ---------- overlays ----------

  const hoveredPlant = hover.hit?.kind === "plant" ? plants[hover.hit.id] : undefined;
  const selectedPlantId = selection?.kind === "plant" ? selection.id : null;
  const tagPlants = new Set([hoveredPlant?.id, selectedPlantId].filter(Boolean) as string[]);
  const tooltip = tooltipFor(hover.hit, soil, beds);

  return (
    <div
      ref={wrap}
      className={`iso iso--${phase}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover({ hit: null, tile: null, sx: 0, sy: 0 })}
      onWheel={onWheel}
      style={{ cursor: hover.hit ? "pointer" : drag.current?.moved ? "grabbing" : "default" }}
    >
      <canvas ref={canvas} className="iso__canvas" style={{ width: view.w * zoom, height: view.h * zoom }} aria-label="Garden view. Use the panel and the top bar to navigate with a keyboard." />
      <div className="iso__overlay">
        <div ref={overlay} className="iso__world">
          {world.lots.map((lot) => {
            const bed = beds.find((b) => b.id === lot.bedId);
            if (!bed) return null;
            const p = iso(lot.sign.gx, lot.sign.gy);
            const s = soil[bed.id];
            const mood = bedMood(plantsByBed[bed.id] ?? []);
            const active = selection?.kind === "bed" && selection.id === bed.id;
            return (
              <button
                key={bed.id}
                className={`nametag nametag--bed ${active ? "is-active" : ""}`}
                style={{ left: p.x * zoom, top: (p.y - 26) * zoom }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={() => select({ kind: "bed", id: bed.id })}
                title={`${bed.path}\n${MOOD_LABEL[mood]}`}
              >
                <span className="nametag__name">{bed.name}</span>
                {s?.branch && <span className="nametag__meta">{s.branch}</span>}
                {s && s.dirty > 0 && <span className="nametag__meta nametag__meta--loose">{s.dirty} loose</span>}
              </button>
            );
          })}
          {world.lots.flatMap((lot) =>
            lot.slots
              .filter((s) => s.plantId && tagPlants.has(s.plantId))
              .map((s) => {
                const plant = plants[s.plantId!];
                if (!plant) return null;
                const p = iso(s.gx, s.gy);
                const top = p.y + 8 - BLOCK_H - plantHeight(plant) - (bubbleFor(plant) ? 26 : 12);
                return (
                  <div key={plant.id} className={`nametag nametag--plant nametag--${plant.status}`} style={{ left: p.x * zoom, top: top * zoom }}>
                    <span className="nametag__name">{plant.name}</span>
                    <span className="nametag__meta">{statusLabel(plant)}</span>
                  </div>
                );
              }),
          )}
          {(() => {
            const p = iso(world.newGround.gx + world.newGround.w / 2, world.newGround.gy + world.newGround.d / 2);
            return (
              <button
                className="nametag nametag--new"
                style={{ left: p.x * zoom, top: (p.y - 20) * zoom }}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={onAddBed}
              >
                <span className="nametag__name">+ Break new ground</span>
              </button>
            );
          })()}
        </div>
      </div>
      {tooltip && !hoveredPlant && (
        <div className="iso__tip" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
          {tooltip}
        </div>
      )}
      <div className="iso__zoom" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button className="pxbtn pxbtn--icon" onClick={() => setZoomAround(zoom + 1)} aria-label="Zoom in" title="Zoom in (Ctrl + scroll)">
          +
        </button>
        <button className="pxbtn pxbtn--icon" onClick={() => setZoomAround(zoom - 1)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button
          className="pxbtn pxbtn--icon"
          onClick={() => frameAll(zoom, true)}
          aria-label="Recenter"
          title="Back to the greenhouse"
        >
          ⌂
        </button>
      </div>
      <ul className="sr-only">
        {Object.values(plants).map((p: Plant) => (
          <li key={p.id}>
            <button onClick={() => select({ kind: "plant", id: p.id })}>
              {p.name}: {statusLabel(p)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function rectOfTiles(gx: number, gy: number, w: number, d: number) {
  const t = iso(gx, gy);
  const r = iso(gx + w, gy);
  const b = iso(gx + w, gy + d);
  const l = iso(gx, gy + d);
  const x = Math.min(t.x, r.x, b.x, l.x);
  const y = Math.min(t.y, r.y, b.y, l.y);
  return { x, y, w: Math.max(t.x, r.x, b.x, l.x) - x, h: Math.max(t.y, r.y, b.y, l.y) - y };
}

function tooltipFor(hit: Hit | null, soil: Record<string, import("../../../shared/types").SoilReport>, beds: { id: string; name: string }[]): string | null {
  if (!hit) return null;
  const bed = "bedId" in hit ? beds.find((b) => b.id === hit.bedId) : undefined;
  switch (hit.kind) {
    case "compost":
      return `Compost: ${soil[hit.bedId]?.guidance.join(", ")}`;
    case "slot":
      return `Sow an agent in ${bed?.name ?? "this bed"}`;
    case "bed":
      return `${bed?.name ?? "Bed"}: open the soil report`;
    case "newground":
      return "Break new ground: add a repository";
    default:
      return null;
  }
}

