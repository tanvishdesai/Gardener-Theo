import { useEffect } from "react";
import { Scene } from "./garden/Scene";
import { BedPanel } from "./panels/BedPanel";
import { PlantPanel } from "./panels/PlantPanel";
import { SowDialog } from "./panels/SowDialog";
import { cycle, TopBar } from "./panels/TopBar";
import { attempt, garden, getState, needsYou, select, setState, useGarden } from "./store";

async function addBed() {
  const path = await attempt(() => garden().pickDirectory());
  if (!path) return;
  const bed = await attempt(() => garden().addBed(path));
  if (bed) select({ kind: "bed", id: bed.id });
}

export function App() {
  const ready = useGarden((s) => s.ready);
  const selection = useGarden((s) => s.selection);
  const plant = useGarden((s) => (s.selection?.kind === "plant" ? s.plants[s.selection.id] : undefined));
  const bed = useGarden((s) => (s.selection?.kind === "bed" ? s.beds.find((b) => b.id === s.selection!.id) : undefined));
  const sowing = useGarden((s) => s.sowing);
  const error = useGarden((s) => s.error);
  const empty = useGarden((s) => s.ready && s.beds.length === 0);

  // Looking at a plant when it blooms counts as harvesting it.
  useEffect(() => {
    if (plant?.unread && document.hasFocus()) void garden().markRead(plant.id);
  }, [plant?.unread, plant?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape" && !getState().sowing) {
        if (typing) (e.target as HTMLElement).blur();
        else select(null);
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") cycle(Object.values(getState().plants).filter(needsYou).sort((a, b) => a.createdAt - b.createdAt));
      if (e.key === "s" && getState().beds.length) {
        e.preventDefault();
        setState({ sowing: getState().selection?.kind === "bed" ? getState().selection!.id : "", sowPreset: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setState({ error: null }), 6000);
    return () => clearTimeout(t);
  }, [error]);

  if (!ready) return <div className="loading">Opening the garden gate…</div>;

  return (
    <div className={`app ${selection ? "app--panel" : ""}`}>
      <TopBar onAddBed={addBed} />
      <main className="main">
        <Scene onAddBed={addBed} />
        {empty && (
          <div className="welcome">
            <h1>Your garden is empty</h1>
            <p>
              Every repository is a <strong>bed</strong>. Every Claude Code agent you start in it is a <strong>plant</strong>. You are the gardener: you don't grow the code yourself, you keep the
              beds healthy so the plants grow straight, and you pull the weeds before they spread.
            </p>
            <p className="muted small">Agents run through Claude Code on this machine and use the account it is logged into.</p>
            <button className="btn btn--primary" onClick={addBed}>
              Break new ground
            </button>
          </div>
        )}
        {plant && <PlantPanel plant={plant} key={plant.id} />}
        {bed && <BedPanel bed={bed} key={bed.id} />}
      </main>
      {sowing !== null && <SowDialog key={`${sowing}-${getState().sowPreset?.id ?? ""}`} />}
      {error && (
        <div className="toast" role="alert" onClick={() => setState({ error: null })}>
          {error}
        </div>
      )}
    </div>
  );
}
