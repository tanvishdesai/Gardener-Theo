// A plant is an agent. Everything about how it looks comes from its state:
//   height and leaves  <- completed turns (maturity)
//   bud vs bloom       <- working vs finished a turn
//   droop + sign       <- waiting on you
//   brown + weed       <- the last turn failed
//   butterfly          <- a result you have not looked at yet
//   overlays           <- the tool it is using right now (roots, watering can, bee, runners...)
import { memo } from "react";
import { maturity } from "../../../shared/garden";
import type { Plant, Species } from "../../../shared/types";
import { useReducedMotion } from "../motion";

export const SLOT_W = 124;
const HEIGHTS = [0, 58, 94, 128, 158];
const LEAVES = [0, 2, 4, 6, 8];

interface SpeciesStyle {
  petal: string;
  petalDark: string;
  center: string;
  leaf: string;
  leafDark: string;
  stem: string;
}

export const SPECIES_STYLE: Record<Species, SpeciesStyle> = {
  sunflower: { petal: "#f6c83b", petalDark: "#e09a1c", center: "#6b4423", leaf: "#5e9c3e", leafDark: "#457a2c", stem: "#4f8a35" },
  tulip: { petal: "#ee6a96", petalDark: "#c9406f", center: "#f7d14a", leaf: "#6aab52", leafDark: "#4d8a3b", stem: "#55913f" },
  daisy: { petal: "#ffffff", petalDark: "#dcdde8", center: "#f2b632", leaf: "#64a648", leafDark: "#4a8634", stem: "#4f8e37" },
  rose: { petal: "#df3f58", petalDark: "#a8243a", center: "#8f1d2e", leaf: "#4f8f45", leafDark: "#386f31", stem: "#3f7a36" },
  lavender: { petal: "#a58ad8", petalDark: "#7c62bc", center: "#a58ad8", leaf: "#7fa77a", leafDark: "#5f8a5c", stem: "#6c9a64" },
  poppy: { petal: "#f4703a", petalDark: "#d24f1b", center: "#2d2a26", leaf: "#6fae58", leafDark: "#518c3f", stem: "#5a9645" },
};

export const SPECIES_NAME: Record<Species, string> = {
  sunflower: "Sunflower",
  tulip: "Tulip",
  daisy: "Daisy",
  rose: "Rose",
  lavender: "Lavender",
  poppy: "Poppy",
};

/** How far above the soil a plant (with its overlays) reaches, so beds can size themselves. */
export function plantReach(plant: Plant): number {
  const m = maturity(plant.turns);
  const busy = plant.status === "thinking" || plant.status === "working";
  const seedOnly = m === 0 && !busy && plant.status !== "waiting" && plant.status !== "error";
  const h = m === 0 ? (seedOnly ? 40 : 34) : HEIGHTS[m];
  return h + (plant.permissionMode === "plan" ? 34 : 0) + 48;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

type Pt = { x: number; y: number };
function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const LEAF = "M0,0 C6,-9 18,-11 27,-3 C18,3 8,5 0,0Z";

function Leaf({ at, angle, size, s, flip, className }: { at: Pt; angle: number; size: number; s: SpeciesStyle; flip: boolean; className?: string }) {
  return (
    <g transform={`translate(${at.x} ${at.y}) rotate(${angle}) scale(${flip ? -size : size} ${size})`} className={className}>
      <path d={LEAF} fill={s.leaf} />
      <path d="M1,0 C9,-4 17,-5 25,-3" stroke={s.leafDark} strokeWidth={0.9} fill="none" opacity={0.7} />
    </g>
  );
}

function Bloom({ species, s, scale }: { species: Species; s: SpeciesStyle; scale: number }) {
  const g = (children: React.ReactNode) => <g transform={`scale(${scale})`}>{children}</g>;
  switch (species) {
    case "sunflower":
      return g(
        <>
          {Array.from({ length: 14 }, (_, i) => (
            <ellipse key={i} cx={0} cy={-13} rx={4.4} ry={9} fill={i % 2 ? s.petal : s.petalDark} transform={`rotate(${(360 / 14) * i})`} />
          ))}
          <circle r={9.5} fill={s.center} />
          <circle r={9.5} fill="url(#seedDots)" opacity={0.5} />
        </>,
      );
    case "daisy":
      return g(
        <>
          {Array.from({ length: 16 }, (_, i) => (
            <ellipse key={i} cx={0} cy={-11} rx={2.8} ry={8} fill={s.petal} stroke={s.petalDark} strokeWidth={0.6} transform={`rotate(${(360 / 16) * i})`} />
          ))}
          <circle r={5.6} fill={s.center} />
        </>,
      );
    case "poppy":
      return g(
        <>
          {[0, 72, 144, 216, 288].map((r) => (
            <circle key={r} cx={0} cy={-8} r={9} fill={r % 144 ? s.petal : s.petalDark} transform={`rotate(${r})`} opacity={0.96} />
          ))}
          <circle r={4.6} fill={s.center} />
          {[0, 60, 120, 180, 240, 300].map((r) => (
            <circle key={r} cx={0} cy={-6} r={0.9} fill={s.center} transform={`rotate(${r})`} />
          ))}
        </>,
      );
    case "rose":
      return g(
        <>
          {[0, 120, 240].map((r) => (
            <ellipse key={r} cx={0} cy={-6} rx={9} ry={7} fill={s.petalDark} transform={`rotate(${r})`} />
          ))}
          <circle r={9} fill={s.petal} />
          <path d="M-5,1 C-5,-6 5,-6 5,0 C5,4 -1,5 -2,1 C-2,-2 2,-2 2,0" stroke={s.center} strokeWidth={1.4} fill="none" strokeLinecap="round" />
        </>,
      );
    case "tulip":
      return g(
        <>
          <path d="M-10,-2 C-12,-14 -6,-20 -3,-22 C-1,-16 -1,-8 0,-4 Z" fill={s.petalDark} />
          <path d="M10,-2 C12,-14 6,-20 3,-22 C1,-16 1,-8 0,-4 Z" fill={s.petalDark} />
          <path d="M-9,0 C-11,-12 -4,-24 0,-24 C4,-24 11,-12 9,0 C6,5 -6,5 -9,0Z" fill={s.petal} />
          <path d="M0,-22 C-2,-14 -2,-6 0,2" stroke={s.petalDark} strokeWidth={0.8} fill="none" opacity={0.6} />
        </>,
      );
    case "lavender":
      return g(
        <>
          {Array.from({ length: 9 }, (_, i) => (
            <g key={i} transform={`translate(0 ${-i * 4.2 + 8})`}>
              <ellipse cx={-2.6} cy={0} rx={2.6} ry={3.4} fill={i % 2 ? s.petal : s.petalDark} />
              <ellipse cx={2.6} cy={-1.6} rx={2.6} ry={3.4} fill={i % 2 ? s.petalDark : s.petal} />
            </g>
          ))}
        </>,
      );
  }
}

function Bud({ s, scale, species }: { s: SpeciesStyle; scale: number; species: Species }) {
  if (species === "lavender") {
    return (
      <g transform={`scale(${scale})`}>
        {Array.from({ length: 7 }, (_, i) => (
          <ellipse key={i} cx={0} cy={-i * 4 + 6} rx={2.4} ry={3} fill={i > 3 ? s.leafDark : s.petalDark} opacity={0.9} />
        ))}
      </g>
    );
  }
  return (
    <g transform={`scale(${scale})`}>
      <path d="M0,4 C-8,0 -8,-10 0,-18 C8,-10 8,0 0,4Z" fill={s.leaf} />
      <path d="M0,-18 C-3,-13 -3,-9 0,-6 C3,-9 3,-13 0,-18Z" fill={s.petal} opacity={0.9} />
      <path d="M-6,0 C-3,-4 3,-4 6,0" stroke={s.leafDark} strokeWidth={1} fill="none" />
    </g>
  );
}

function Sway({ busy, phase, still, children }: { busy: boolean; phase: number; still: boolean; children: React.ReactNode }) {
  return (
    <g>
      {!still && (
        <animateTransform
          attributeName="transform"
          type="rotate"
          values={busy ? "-3;3;-3" : "-1.2;1.2;-1.2"}
          dur={busy ? "2.6s" : "6s"}
          begin={`-${(phase * 6).toFixed(2)}s`}
          repeatCount="indefinite"
          calcMode="spline"
          keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
        />
      )}
      {children}
    </g>
  );
}

export interface PlantProps {
  plant: Plant;
  staked: boolean;
  selected: boolean;
}

/** Above-ground part of a plant, drawn with its base at (0,0). */
export const PlantFigure = memo(function PlantFigure({ plant, staked, selected }: PlantProps) {
  const reduced = useReducedMotion();
  const s = SPECIES_STYLE[plant.species];
  const m = maturity(plant.turns);
  const busy = plant.status === "thinking" || plant.status === "working";
  const waiting = plant.status === "waiting";
  const wilted = plant.status === "error";
  const seedOnly = m === 0 && !busy && !waiting && !wilted;
  const h = m === 0 ? (seedOnly ? 0 : 34) : HEIGHTS[m];
  const r = hash(plant.id);
  const lean = (r - 0.5) * 14;
  const p0 = { x: 0, y: 0 };
  const p1 = { x: -5 + lean * 0.2, y: -h * 0.42 };
  const p2 = { x: lean * 0.8 + 4, y: -h * 0.76 };
  const p3 = { x: lean, y: -h };
  const head = p3;
  const scale = 0.8 + m * 0.09;
  const leaves = m === 0 ? 0 : LEAVES[m];
  const open = !busy && !waiting && m > 0;
  const activity = busy ? (plant.status === "thinking" ? "think" : plant.activity ?? "other") : undefined;
  const plan = plant.permissionMode === "plan" && !seedOnly;

  return (
    <g className={`plant ${wilted ? "plant--wilted" : ""} ${selected ? "plant--selected" : ""}`} data-activity={activity}>
      {selected && <ellipse className="plant__halo" cx={0} cy={2} rx={46} ry={9} />}

      {plan && <Trellis h={Math.max(h, 60)} />}
      {staked && !seedOnly && h > 40 && <Stake h={h} lean={lean} />}

      {seedOnly ? (
        <SeedMound s={s} />
      ) : (
        <g transform={waiting ? "rotate(9)" : wilted ? "rotate(-14)" : undefined}>
          <Sway busy={busy} phase={r} still={reduced || waiting || wilted}>
            <path
              d={`M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}
              stroke={s.stem}
              strokeWidth={m >= 3 ? 5 : 4}
              strokeLinecap="round"
              fill="none"
            />
            {m === 0 ? (
              <>
                <Leaf at={{ x: lean * 0.9, y: -h + 6 }} angle={-28} size={0.6} s={s} flip={false} />
                <Leaf at={{ x: lean * 0.9, y: -h + 6 }} angle={28} size={0.6} s={s} flip />
              </>
            ) : (
              Array.from({ length: leaves }, (_, k) => {
                const t = 0.16 + 0.66 * (k / Math.max(1, leaves - 1));
                const at = bezier(p0, p1, p2, p3, Math.min(t, 0.86));
                const left = k % 2 === 0;
                const size = 1.05 - t * 0.4 + m * 0.05;
                return <Leaf key={k} at={at} angle={left ? 24 - t * 20 : -24 + t * 20} size={size} s={s} flip={left} />;
              })
            )}
            {activity === "edit" && !reduced && (
              <g className="new-leaf">
                <Leaf at={bezier(p0, p1, p2, p3, 0.9)} angle={-30} size={0.9} s={s} flip={false} />
              </g>
            )}
            {m > 0 && (
              <g transform={`translate(${head.x} ${head.y}) rotate(${waiting ? 24 : wilted ? 40 : 0})`}>
                {open ? <Bloom species={plant.species} s={s} scale={scale} /> : <Bud s={s} scale={scale} species={plant.species} />}
              </g>
            )}
          </Sway>
        </g>
      )}

      {!reduced && activity && <ActivityOverlay activity={activity} head={head} h={h} s={s} runners={plant.runners} />}
      {reduced && activity && <circle cx={head.x + 18} cy={head.y - 18} r={4} className="still-marker" />}
      {waiting && <NeedsYouSign x={30} h={Math.max(h, 40)} reduced={reduced} />}
      {wilted && <Weed x={-32} />}
      {plant.unread && open && <Butterfly at={head} scale={scale} reduced={reduced} hue={r} />}
      {busy && plant.todos && plant.todos.total > 0 && <RowTag x={-40} todos={plant.todos} />}
    </g>
  );
});

function SeedMound({ s }: { s: SpeciesStyle }) {
  return (
    <g>
      <path d="M-22,1 C-14,-9 14,-9 22,1Z" fill="var(--soil-loose)" />
      <ellipse cx={0} cy={-5} rx={3.2} ry={2.2} fill="#d8b98a" transform="rotate(-20)" />
      <g transform="translate(16 -2)">
        <rect x={-0.8} y={-26} width={1.6} height={26} fill="#b98a5a" />
        <rect x={-9} y={-38} width={18} height={14} rx={1.5} fill="#fbf4e3" stroke="#c9b48c" strokeWidth={0.8} />
        <circle cx={0} cy={-31} r={3.6} fill={s.petal} stroke={s.petalDark} strokeWidth={0.8} />
      </g>
    </g>
  );
}

function Stake({ h, lean }: { h: number; lean: number }) {
  const top = -h * 0.82;
  return (
    <g className="stake">
      <line x1={-9} y1={6} x2={-9 + lean * 0.4} y2={top} stroke="#c9a76b" strokeWidth={3} strokeLinecap="round" />
      <line x1={-9} y1={6} x2={-9 + lean * 0.4} y2={top} stroke="#e3c78f" strokeWidth={1} strokeLinecap="round" />
      {[0.35, 0.65].map((t) => (
        <path key={t} d={`M${-11 + lean * 0.4 * t},${top * t} q5,3 10,-1`} stroke="#8a6b44" strokeWidth={1} fill="none" />
      ))}
    </g>
  );
}

function Trellis({ h }: { h: number }) {
  const top = -h - 26;
  const xs = [-26, -9, 9, 26];
  const ys = Array.from({ length: Math.floor(-top / 18) }, (_, i) => -12 - i * 18);
  return (
    <g className="trellis" opacity={0.85}>
      {xs.map((x) => (
        <line key={x} x1={x} y1={2} x2={x} y2={top} stroke="#b88f5c" strokeWidth={1.8} />
      ))}
      {ys.map((y) => (
        <line key={y} x1={-28} y1={y} x2={28} y2={y} stroke="#b88f5c" strokeWidth={1.4} />
      ))}
      <line x1={-28} y1={top} x2={28} y2={top} stroke="#9c7445" strokeWidth={2.4} />
    </g>
  );
}

function ActivityOverlay({ activity, head, h, s, runners }: { activity: string; head: Pt; h: number; s: SpeciesStyle; runners: number }) {
  switch (activity) {
    case "think":
      return (
        <g className="fx-think">
          <circle cx={head.x} cy={head.y} r={30} fill="url(#sunGlow)" className="fx-think__glow" />
          {[-14, -4, 8, 16].map((dx, i) => (
            <circle key={i} cx={head.x + dx} cy={head.y + 8} r={1.8} className="mote" style={{ animationDelay: `${i * 0.55}s` }} />
          ))}
        </g>
      );
    case "edit":
      return (
        <g>
          {[
            [head.x + 18, head.y + 10],
            [head.x - 16, head.y + 22],
            [head.x + 8, head.y - 22],
          ].map(([x, y], i) => (
            <path key={i} d={`M${x},${y - 5} L${x + 1.4},${y - 1.4} L${x + 5},${y} L${x + 1.4},${y + 1.4} L${x},${y + 5} L${x - 1.4},${y + 1.4} L${x - 5},${y} L${x - 1.4},${y - 1.4}Z`} className="sparkle" style={{ animationDelay: `${i * 0.4}s` }} />
          ))}
        </g>
      );
    case "run":
      return <WateringCan x={-36} y={-h - 30} />;
    case "web":
      return <Bee center={head} />;
    case "delegate":
      return (
        <g>
          {Array.from({ length: Math.max(1, Math.min(3, runners)) }, (_, i) => {
            const x = [34, -36, 48][i];
            return (
              <g key={i} transform={`translate(${x} 0)`} className="runner" style={{ animationDelay: `${i * 0.3}s` }}>
                <path d="M0,0 C1,-8 0,-14 0,-18" stroke={s.stem} strokeWidth={2.4} fill="none" strokeLinecap="round" />
                <Leaf at={{ x: 0, y: -15 }} angle={-30} size={0.42} s={s} flip={false} />
                <Leaf at={{ x: 0, y: -15 }} angle={30} size={0.42} s={s} flip />
              </g>
            );
          })}
          <path d={`M4,1 Q19,6 34,1`} stroke={s.stem} strokeWidth={1.6} fill="none" strokeDasharray="3 3" className="runner-line" />
        </g>
      );
    case "todo":
    case "plan":
      return (
        <g transform={`translate(${head.x + 22} ${head.y - 6})`} className="bob">
          <rect x={-8} y={-10} width={16} height={20} rx={2} fill="#fffaf0" stroke="#b9a37b" />
          {[-5, 0, 5].map((y) => (
            <line key={y} x1={-5} y1={y} x2={5} y2={y} stroke="#8f9c86" strokeWidth={1.2} />
          ))}
        </g>
      );
    default:
      return null;
  }
}

function WateringCan({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="can" transform="rotate(28)">
        <path d="M-12,-8 h20 v16 a3,3 0 0 1 -3,3 h-14 a3,3 0 0 1 -3,-3Z" fill="#6aa3b8" />
        <path d="M8,-4 L22,-12 L23,-9 L10,1Z" fill="#5a92a6" />
        <ellipse cx={23} cy={-11} rx={2.6} ry={3.4} fill="#4d8195" transform="rotate(-30 23 -11)" />
        <path d="M-12,-6 C-20,-6 -20,6 -12,6" stroke="#5a92a6" strokeWidth={2.4} fill="none" />
      </g>
      {[0, 1, 2, 3, 4].map((i) => (
        <ellipse key={i} cx={28 + (i % 3) * 4} cy={6} rx={1.2} ry={2.4} className="drop" style={{ animationDelay: `${i * 0.22}s` }} />
      ))}
    </g>
  );
}

function Bee({ center }: { center: Pt }) {
  return (
    <g>
      <circle cx={center.x} cy={center.y} r={26} fill="none" stroke="#c9b47a" strokeWidth={0.8} strokeDasharray="2 4" opacity={0.6} />
      <g>
        <animateTransform attributeName="transform" type="rotate" from={`0 ${center.x} ${center.y}`} to={`360 ${center.x} ${center.y}`} dur="3.2s" repeatCount="indefinite" />
        <g transform={`translate(${center.x + 26} ${center.y})`}>
          <ellipse cx={-1} cy={-5} rx={3.4} ry={2.2} fill="#ffffff" opacity={0.85} className="wing" />
          <ellipse cx={0} cy={0} rx={5} ry={3.6} fill="#f2c230" />
          <path d="M-1.5,-3.4 v6.8 M1.5,-3.2 v6.4" stroke="#2f2a22" strokeWidth={1.3} />
          <circle cx={4.6} cy={-0.4} r={1.8} fill="#2f2a22" />
        </g>
      </g>
    </g>
  );
}

function NeedsYouSign({ x, h, reduced }: { x: number; h: number; reduced: boolean }) {
  const y = -Math.min(h, 70) - 6;
  return (
    <g transform={`translate(${x} 0)`}>
      <circle cx={0} cy={y} r={20} fill="url(#amberGlow)" className={reduced ? "" : "pulse"} />
      <rect x={-1.3} y={y + 8} width={2.6} height={-y - 8} fill="#a77a4a" />
      <g className={reduced ? "" : "bob"}>
        <rect x={-10} y={y - 10} width={20} height={20} rx={4} fill="#f2b33d" stroke="#b97d14" strokeWidth={1.4} />
        <rect x={-1.6} y={y - 6} width={3.2} height={8} rx={1.2} fill="#5a3a0b" />
        <circle cx={0} cy={y + 5.2} r={1.8} fill="#5a3a0b" />
      </g>
    </g>
  );
}

function Weed({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`} className="weed">
      <path d="M0,0 L-8,-10 L-3,-9 L-9,-20 L-2,-15 L0,-26 L2,-15 L9,-20 L3,-9 L8,-10Z" fill="#7d8f3a" />
      <path d="M0,0 L0,-24" stroke="#5f6e2a" strokeWidth={1} />
      <circle cx={0} cy={-28} r={3} fill="#e8d36b" />
    </g>
  );
}

function Butterfly({ at, scale, reduced, hue }: { at: Pt; scale: number; reduced: boolean; hue: number }) {
  const colors = ["#5aa6e8", "#f08c5a", "#b07ce0", "#e86fa0"];
  const c = colors[Math.floor(hue * colors.length) % colors.length];
  return (
    <g transform={`translate(${at.x + 4} ${at.y - 18 * scale})`}>
      <circle r={26} fill="url(#goldGlow)" className={reduced ? "" : "pulse"} />
      <g className={reduced ? "" : "flutter"}>
        <path d="M0,0 C-10,-12 -16,-2 -12,4 C-8,8 -2,4 0,0Z" fill={c} />
        <path d="M0,0 C10,-12 16,-2 12,4 C8,8 2,4 0,0Z" fill={c} />
        <path d="M0,0 C-6,4 -9,10 -4,10 C-1,10 0,4 0,0Z" fill={c} opacity={0.8} />
        <path d="M0,0 C6,4 9,10 4,10 C1,10 0,4 0,0Z" fill={c} opacity={0.8} />
      </g>
      <rect x={-0.8} y={-5} width={1.6} height={13} rx={0.8} fill="#2f2a22" />
    </g>
  );
}

function RowTag({ x, todos }: { x: number; todos: { done: number; total: number } }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect x={-0.8} y={-22} width={1.6} height={22} fill="#a77a4a" />
      <rect x={-13} y={-36} width={26} height={15} rx={2} fill="#fbf4e3" stroke="#c9b48c" strokeWidth={0.8} />
      <text x={0} y={-25.5} textAnchor="middle" className="tag-text">
        {todos.done}/{todos.total}
      </text>
    </g>
  );
}

/** Below-ground part, drawn inside the bed's glass-fronted soil. Roots grow with maturity and glow while reading. */
export const PlantRoots = memo(function PlantRoots({ plant }: { plant: Plant }) {
  const m = maturity(plant.turns);
  const busy = plant.status === "thinking" || plant.status === "working";
  const reading = busy && (plant.activity === "read" || plant.activity === "search");
  const depth = 10 + m * 8 + (reading ? 8 : 0);
  const spread = 8 + m * 6 + (reading ? 10 : 0);
  if (m === 0 && !busy) return null;
  const r = hash(plant.id);
  const roots = [
    `M0,0 C${-spread * 0.3},${depth * 0.4} ${-spread * 0.8},${depth * 0.6} ${-spread},${depth}`,
    `M0,0 C${spread * 0.2},${depth * 0.5} ${spread * 0.6},${depth * 0.7} ${spread * (0.8 + r * 0.3)},${depth * 0.95}`,
    `M0,0 C1,${depth * 0.5} -2,${depth * 0.8} 0,${depth * 1.15}`,
    `M${-spread * 0.4},${depth * 0.5} c-6,3 -8,6 -12,7`,
    `M${spread * 0.4},${depth * 0.55} c6,2 8,6 11,9`,
  ];
  return (
    <g className={`roots ${reading ? "roots--reading" : ""} ${plant.activity === "search" && reading ? "roots--search" : ""}`}>
      {roots.slice(0, 3 + Math.min(2, m)).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  );
});
