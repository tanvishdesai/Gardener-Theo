import type { Plant } from "../../../shared/types";
import { isGrowing, needsYou, select, setState, useGarden } from "../store";

let lastCycled: string | undefined;

/** Visit the next plant in a list, so repeated clicks walk the gardener down the row. */
export function cycle(list: Plant[]) {
  if (!list.length) return;
  const i = list.findIndex((p) => p.id === lastCycled);
  const next = list[(i + 1) % list.length];
  lastCycled = next.id;
  select({ kind: "plant", id: next.id });
}

export function TopBar({ onAddBed }: { onAddBed(): void }) {
  const plants = useGarden((s) => s.plants);
  const demo = useGarden((s) => s.demo);
  const hasBeds = useGarden((s) => s.beds.length > 0);
  const all = Object.values(plants).sort((a, b) => a.createdAt - b.createdAt);
  const needy = all.filter(needsYou);
  const harvest = all.filter((p) => p.unread && !needsYou(p));
  const growing = all.filter(isGrowing);

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="24" height="24" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden>
          <path fill="#2b2233" d="M5 4h2v8H5zM1 2h3v1H1zM0 3h1v2H0zM1 5h3v1H1zM4 3h1v2H4zM8 1h3v1H8zM11 2h1v2h-1zM8 4h3v1H8zM7 2h1v2H7z" />
          <path fill="#6cc45a" d="M1 3h3v2H1zM8 2h3v2H8z" />
          <path fill="#3f8f4f" d="M6 4h1v8H6z" />
          <path fill="#5aa848" d="M5 4h1v8H5z" />
        </svg>
        <span>Gardener</span>
        {demo && <span className="chip chip--demo" title="Simulated agents. Run the desktop app to grow real ones.">demo garden</span>}
      </div>

      <nav className="tally" aria-label="Garden status">
        <button className={`tally__item tally__item--need ${needy.length ? "is-on" : ""}`} onClick={() => cycle(needy)} disabled={!needy.length} title="Waiting on you or wilted. Click to visit each.">
          <span className="tally__n">{needy.length}</span> need tending
        </button>
        <button className={`tally__item tally__item--harvest ${harvest.length ? "is-on" : ""}`} onClick={() => cycle(harvest)} disabled={!harvest.length} title="Finished turns you have not read yet">
          <span className="tally__n">{harvest.length}</span> ready to harvest
        </button>
        <button className={`tally__item tally__item--grow ${growing.length ? "is-on" : ""}`} onClick={() => cycle(growing)} disabled={!growing.length}>
          <span className="tally__n">{growing.length}</span> growing
        </button>
      </nav>

      <div className="topbar__actions">
        <button className="btn btn--ghost" onClick={onAddBed}>
          Add bed
        </button>
        <button className="btn btn--primary" onClick={() => setState({ sowing: "", sowPreset: null })} disabled={!hasBeds}>
          Sow an agent
        </button>
      </div>
    </header>
  );
}
