// A bed is a repository: a glass-fronted raised planter. Its props are the repo's hygiene:
// a fence for tests, stakes for CI, mulch for lint, a compost bin for agent guidance,
// and loose soil mounds for uncommitted changes.
import { memo, useMemo } from "react";
import { bedMood, MOOD_LABEL } from "../../../shared/garden";
import type { Bed as BedT, Plant, SoilReport } from "../../../shared/types";
import { PlantFigure, PlantRoots, plantReach, SLOT_W, SPECIES_STYLE } from "./Plant";

const PAD = 22;
const BELOW = 90; // soil surface to the bottom of the planter
const PER_ROW = 6;

interface BedProps {
  bed: BedT;
  plants: Plant[];
  soil?: SoilReport;
  selectedPlant: string | null;
  bedSelected: boolean;
  onSelectPlant(id: string): void;
  onSelectBed(): void;
  onSow(): void;
}

export const Bed = memo(function Bed({ bed, plants, soil, selectedPlant, bedSelected, onSelectPlant, onSelectBed, onSow }: BedProps) {
  const mood = bedMood(plants);
  const rows = useMemo(() => {
    const out: (Plant | null)[][] = [];
    const all: (Plant | null)[] = [...plants, null]; // trailing empty slot for sowing
    for (let i = 0; i < all.length; i += PER_ROW) out.push(all.slice(i, i + PER_ROW));
    return out;
  }, [plants]);

  return (
    <section className={`bed bed--${mood} ${bedSelected ? "bed--selected" : ""}`} data-bed={bed.id}>
      <header className="bed__header">
        <button className="bed__sign" onClick={onSelectBed} title={bed.path}>
          <span className="bed__name">{bed.name}</span>
        </button>
        {soil?.branch && (
          <span className="chip chip--branch" title="Branch">
            <BranchIcon /> {soil.branch}
          </span>
        )}
        {soil && soil.dirty > 0 && (
          <span className="chip chip--soil" title="Uncommitted changes: freshly turned soil">
            {soil.dirty} loose
          </span>
        )}
        {soil && !soil.exists && <span className="chip chip--warn">folder missing</span>}
        <span className={`mood mood--${mood}`}>{MOOD_LABEL[mood]}</span>
      </header>
      {rows.map((row, ri) => (
        <BedRow
          key={ri}
          row={row}
          soil={soil}
          bedId={bed.id}
          showCompost={ri === 0 && (soil?.guidance.length ?? 0) > 0}
          selectedPlant={selectedPlant}
          onSelectPlant={onSelectPlant}
          onSow={onSow}
        />
      ))}
    </section>
  );
});

function BedRow({
  row,
  soil,
  bedId,
  showCompost,
  selectedPlant,
  onSelectPlant,
  onSow,
}: {
  row: (Plant | null)[];
  soil?: SoilReport;
  bedId: string;
  showCompost: boolean;
  selectedPlant: string | null;
  onSelectPlant(id: string): void;
  onSow(): void;
}) {
  // The row is as tall as its tallest plant, so a young bed sits close to its sign.
  const SOIL_Y = Math.max(96, ...row.map((p) => (p ? plantReach(p) : 0))) + 8;
  const H = SOIL_Y + BELOW;
  const FRONT_TOP = SOIL_Y + 6;
  const FRONT_BOTTOM = H - 18;
  const slots = Math.max(3, row.length);
  const compostW = showCompost ? 70 : 0;
  const W = PAD * 2 + slots * SLOT_W + compostW;
  const innerL = PAD;
  const innerR = PAD + slots * SLOT_W;
  const xAt = (i: number) => PAD + SLOT_W / 2 + i * SLOT_W;
  const tests = (soil?.tests.length ?? 0) > 0;
  const ci = (soil?.ci.length ?? 0) > 0;
  const lint = (soil?.lint.length ?? 0) > 0;
  const loose = Math.min(8, Math.ceil((soil?.dirty ?? 0) / 2));
  const clipId = `front-${bedId}-${row[0]?.id ?? "empty"}`;

  return (
    <div className="bed__row">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="bed__svg" role="group">
        <defs>
          <clipPath id={clipId}>
            <rect x={innerL} y={FRONT_TOP} width={innerR - innerL} height={FRONT_BOTTOM - FRONT_TOP} />
          </clipPath>
        </defs>
        <ellipse cx={(innerL + innerR) / 2} cy={H - 10} rx={(innerR - innerL) / 2 + 26} ry={10} fill="var(--shadow)" />

        {tests && <Fence x1={innerL - 4} x2={innerR + 4} y={SOIL_Y - 4} />}

        {/* back rim and soil surface */}
        <rect x={innerL - 8} y={SOIL_Y - 12} width={innerR - innerL + 16} height={8} rx={2} fill="var(--wood-light)" />
        <rect x={innerL - 4} y={SOIL_Y - 6} width={innerR - innerL + 8} height={12} fill="var(--soil-top)" />
        {lint && <Mulch x1={innerL} x2={innerR} y={SOIL_Y - 3} seed={bedId} />}
        {Array.from({ length: loose }, (_, i) => {
          const x = innerL + 18 + ((i * 97 + 31) % Math.max(40, innerR - innerL - 36));
          return <path key={i} d={`M${x - 9},${SOIL_Y + 1} C${x - 5},${SOIL_Y - 7} ${x + 5},${SOIL_Y - 7} ${x + 9},${SOIL_Y + 1}Z`} fill="var(--soil-loose)" />;
        })}

        {row.map((p, i) =>
          p ? (
            <g key={p.id} transform={`translate(${xAt(i)} ${SOIL_Y})`}>
              <PlantFigure plant={p} staked={ci} selected={p.id === selectedPlant} />
            </g>
          ) : (
            <g key="sow" transform={`translate(${xAt(i)} ${SOIL_Y})`} className="sow-slot" onClick={onSow}>
              <rect x={-SLOT_W / 2 + 10} y={-80} width={SLOT_W - 20} height={84} fill="transparent" />
              <path d="M-16,2 C-10,-6 10,-6 16,2Z" fill="var(--soil-loose)" opacity={0.6} />
              <circle cx={0} cy={-30} r={13} className="sow-slot__ring" />
              <path d="M0,-36 v12 M-6,-30 h12" className="sow-slot__plus" />
            </g>
          ),
        )}

        {/* front rim over the stem bases */}
        <rect x={innerL - 8} y={SOIL_Y + 2} width={innerR - innerL + 16} height={8} rx={2} fill="var(--wood)" />

        {/* glass front: a cross-section of the soil, where the roots live */}
        <g clipPath={`url(#${clipId})`}>
          <rect x={innerL} y={FRONT_TOP} width={innerR - innerL} height={FRONT_BOTTOM - FRONT_TOP} fill="url(#soilSection)" />
          <path d={strata(innerL, innerR, FRONT_TOP + 26, bedId)} stroke="var(--soil-line)" strokeWidth={1.2} fill="none" />
          <path d={strata(innerL, innerR, FRONT_TOP + 52, bedId + "b")} stroke="var(--soil-line)" strokeWidth={1.2} fill="none" />
          {pebbles(innerL, innerR, FRONT_TOP, FRONT_BOTTOM, bedId).map(([x, y, r], i) => (
            <ellipse key={i} cx={x} cy={y} rx={r} ry={r * 0.7} fill="var(--pebble)" />
          ))}
          {row.map((p, i) =>
            p ? (
              <g key={p.id} transform={`translate(${xAt(i)} ${FRONT_TOP + 2})`}>
                <PlantRoots plant={p} />
              </g>
            ) : null,
          )}
          <path d={`M${innerL + 30},${FRONT_TOP} l40,${FRONT_BOTTOM - FRONT_TOP} h14 l-40,${-(FRONT_BOTTOM - FRONT_TOP)}Z`} fill="#fff" opacity={0.06} />
        </g>
        <rect x={innerL - 8} y={FRONT_BOTTOM} width={innerR - innerL + 16} height={10} rx={2} fill="var(--wood-dark)" />
        <rect x={innerL - 10} y={SOIL_Y - 14} width={10} height={FRONT_BOTTOM - SOIL_Y + 24} rx={2} fill="var(--wood-dark)" />
        <rect x={innerR} y={SOIL_Y - 14} width={10} height={FRONT_BOTTOM - SOIL_Y + 24} rx={2} fill="var(--wood-dark)" />
        {row.slice(1).map((_, i) => (
          <rect key={i} x={PAD + (i + 1) * SLOT_W - 1.5} y={FRONT_TOP + 6} width={3} height={FRONT_BOTTOM - FRONT_TOP - 6} fill="var(--wood)" opacity={0.35} />
        ))}

        {showCompost && <CompostBin x={innerR + 18} y={FRONT_BOTTOM + 8} files={soil?.guidance ?? []} />}

        {/* click targets */}
        {row.map((p, i) =>
          p ? (
            <rect
              key={p.id}
              x={xAt(i) - SLOT_W / 2}
              y={4}
              width={SLOT_W}
              height={FRONT_BOTTOM - 4}
              fill="transparent"
              className="slot-hit"
              onClick={() => onSelectPlant(p.id)}
            >
              <title>{p.name}</title>
            </rect>
          ) : null,
        )}
      </svg>
      <div className="bed__labels" style={{ paddingLeft: PAD, width: W }}>
        {row.map((p) =>
          p ? (
            <button
              key={p.id}
              className={`label label--${p.status} ${p.unread ? "label--unread" : ""} ${p.id === selectedPlant ? "label--selected" : ""}`}
              style={{ width: SLOT_W }}
              data-plant-slot={p.id}
              onClick={() => onSelectPlant(p.id)}
            >
              <span className="label__dot" style={{ background: SPECIES_STYLE[p.species].petal }} />
              <span className="label__name">{p.name}</span>
            </button>
          ) : (
            <button key="sow" className="label label--sow" style={{ width: SLOT_W }} onClick={onSow}>
              Sow an agent
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function rand(seed: string, i: number) {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function strata(x1: number, x2: number, y: number, seed: string) {
  let d = `M${x1},${y}`;
  for (let x = x1; x < x2; x += 40) d += ` q20,${(rand(seed, x) - 0.5) * 8} 40,0`;
  return d;
}

function pebbles(x1: number, x2: number, FRONT_TOP: number, FRONT_BOTTOM: number, seed: string): [number, number, number][] {
  const n = Math.floor((x2 - x1) / 34);
  return Array.from({ length: n }, (_, i) => [x1 + 10 + rand(seed, i) * (x2 - x1 - 20), FRONT_TOP + 14 + rand(seed, i + 99) * (FRONT_BOTTOM - FRONT_TOP - 22), 1.6 + rand(seed, i + 7) * 2.4]);
}

function Fence({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  const pickets = [];
  for (let x = x1; x <= x2; x += 15) {
    pickets.push(<path key={x} d={`M${x - 4},${y} v-30 l4,-6 l4,6 v30Z`} fill="var(--fence)" stroke="var(--fence-line)" strokeWidth={0.8} />);
  }
  return (
    <g className="fence">
      <rect x={x1 - 6} y={y - 26} width={x2 - x1 + 12} height={4} fill="var(--fence)" stroke="var(--fence-line)" strokeWidth={0.6} />
      <rect x={x1 - 6} y={y - 12} width={x2 - x1 + 12} height={4} fill="var(--fence)" stroke="var(--fence-line)" strokeWidth={0.6} />
      {pickets}
    </g>
  );
}

function Mulch({ x1, x2, y, seed }: { x1: number; x2: number; y: number; seed: string }) {
  const bits = [];
  for (let i = 0, x = x1 + 4; x < x2 - 4; i++, x += 7) {
    bits.push(<line key={i} x1={x} y1={y + rand(seed, i) * 6} x2={x + 5} y2={y + rand(seed, i + 50) * 6} stroke="var(--mulch)" strokeWidth={1.6} strokeLinecap="round" />);
  }
  return <g opacity={0.9}>{bits}</g>;
}

function CompostBin({ x, y, files }: { x: number; y: number; files: string[] }) {
  return (
    <g transform={`translate(${x} ${y})`} className="compost">
      <title>{`Compost: ${files.join(", ")}`}</title>
      <path d="M-4,-44 C4,-60 34,-60 42,-44Z" fill="var(--compost)" />
      <circle cx={10} cy={-50} r={2.4} fill="#c9a24a" />
      <circle cx={26} cy={-49} r={2} fill="#7aa35a" />
      <rect x={-6} y={-46} width={50} height={46} rx={3} fill="var(--wood)" />
      {[-36, -24, -12].map((yy) => (
        <rect key={yy} x={-6} y={yy} width={50} height={2.4} fill="var(--wood-dark)" opacity={0.6} />
      ))}
      <rect x={2} y={-34} width={34} height={14} rx={2} fill="#fbf4e3" />
      <text x={19} y={-24} textAnchor="middle" className="compost__label">
        {files[0]?.split("/").pop()?.replace(".md", "") ?? "guide"}
      </text>
    </g>
  );
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V9.25c.574.36 1.248.57 1.97.57H9.5a2.25 2.25 0 0 1 2.25 2.25v.378a2.25 2.25 0 1 0 1.5 0v-.378A3.75 3.75 0 0 0 9.5 8.32H6.97a2.22 2.22 0 0 1-1.97-1.2ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
      />
    </svg>
  );
}
