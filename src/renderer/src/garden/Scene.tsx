import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { plantsInBed, select, setState, useGarden } from "../store";
import { useReducedMotion } from "../motion";
import { Bed } from "./Bed";
import { Gardener } from "./Gardener";
import { Sky, usePhase } from "./Sky";

export function Scene({ onAddBed }: { onAddBed(): void }) {
  const beds = useGarden((s) => s.beds);
  const plants = useGarden((s) => s.plants);
  const soil = useGarden((s) => s.soil);
  const selection = useGarden((s) => s.selection);
  const phase = usePhase();
  const ground = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastScrolled = useRef<string | null>(null);
  const [gardenerAt, setGardenerAt] = useState<{ x: number; y: number } | null>(null);

  const selectedPlant = selection?.kind === "plant" ? selection.id : null;
  const selectedBed = selection?.kind === "bed" ? selection.id : selectedPlant ? plants[selectedPlant]?.bedId ?? null : null;

  const place = useCallback(() => {
    const root = ground.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    let target: Element | null = null;
    if (selectedPlant) target = root.querySelector(`[data-plant-slot="${selectedPlant}"]`);
    else if (selectedBed) target = root.querySelector(`[data-bed="${selectedBed}"] .bed__sign`);
    if (!target) {
      // Nothing selected: wait at the end of the first bed, or by the gate of an empty garden.
      const first = root.querySelector(".bed .bed__row");
      const gate = root.querySelector(".new-bed");
      if (first) {
        const r = first.getBoundingClientRect();
        setGardenerAt({ x: r.right - box.left + 4, y: r.bottom - box.top - 22 });
      } else if (gate) {
        const r = gate.getBoundingClientRect();
        setGardenerAt({ x: r.left - box.left - 30, y: r.bottom - box.top });
      }
      return;
    }
    const r = target.getBoundingClientRect();
    const bedEl = target.closest(".bed");
    if (bedEl && scroller.current && lastScrolled.current !== (selectedPlant ?? selectedBed)) {
      lastScrolled.current = selectedPlant ?? selectedBed;
      bedEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
    if (selectedPlant) setGardenerAt({ x: r.left - box.left - 6, y: r.top - box.top + 4 });
    else setGardenerAt({ x: r.left - box.left - 34, y: r.bottom - box.top + 4 });
  }, [selectedPlant, selectedBed]);

  useLayoutEffect(place, [place, beds, plants]);
  useEffect(() => {
    const ro = new ResizeObserver(place);
    if (ground.current) ro.observe(ground.current);
    return () => ro.disconnect();
  }, [place]);

  return (
    <div className={`scene scene--${phase}`} ref={scroller} onClick={(e) => e.target === e.currentTarget && select(null)}>
      <SvgDefs />
      <Sky phase={phase} />
      <div className="ground" ref={ground} onClick={(e) => e.target === e.currentTarget && select(null)}>
        {beds.map((bed) => (
          <Bed
            key={bed.id}
            bed={bed}
            plants={plantsInBed(plants, bed.id)}
            soil={soil[bed.id]}
            selectedPlant={selectedPlant}
            bedSelected={selection?.kind === "bed" && selection.id === bed.id}
            onSelectPlant={(id) => select({ kind: "plant", id })}
            onSelectBed={() => select({ kind: "bed", id: bed.id })}
            onSow={() => setState({ sowing: bed.id, sowPreset: null })}
          />
        ))}
        <button className="new-bed" onClick={onAddBed}>
          <ShovelIcon />
          <span className="new-bed__title">Break new ground</span>
          <span className="new-bed__hint">Add a repository as a bed</span>
        </button>
        {gardenerAt && <Gardener x={gardenerAt.x} y={gardenerAt.y} />}
      </div>
    </div>
  );
}

function ShovelIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" aria-hidden>
      <path d="M30 6 l12 12 -4 4 -3-3 -11 11 2 2 c2 2 2 5 0 7 l-5 5 c-2 2-5 2-7 0 l-6-6 c-2-2-2-5 0-7 l5-5 c2-2 5-2 7 0 l2 2 11-11 -3-3z" fill="currentColor" opacity={0.85} />
    </svg>
  );
}

/** Gradients shared by every bed (referenced by id). */
function SvgDefs() {
  const reduced = useReducedMotion();
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden data-reduced={reduced}>
      <defs>
        <radialGradient id="sunGlow">
          <stop offset="0%" stopColor="#fff6c8" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fff6c8" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="amberGlow">
          <stop offset="0%" stopColor="#ffbf47" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ffbf47" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="goldGlow">
          <stop offset="0%" stopColor="#ffe28a" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#ffe28a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="soilSection" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--soil-a)" />
          <stop offset="100%" stopColor="var(--soil-b)" />
        </linearGradient>
        <pattern id="seedDots" width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.7" fill="#2b1a0c" />
        </pattern>
      </defs>
    </svg>
  );
}
