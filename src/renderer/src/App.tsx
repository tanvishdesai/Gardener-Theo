import { useEffect } from "react";
import { IsoGarden } from "./iso/IsoGarden";
import { Almanac } from "./panels/Almanac";
import { BedPanel } from "./panels/BedPanel";
import { FirstRun } from "./panels/FirstRun";
import { SettingsPanel } from "./panels/SettingsPanel";
import { Catalogue } from "./panels/Catalogue";
import { Palette } from "./panels/Palette";
import { PlantPanel } from "./panels/PlantPanel";
import { SowDialog } from "./panels/SowDialog";
import { TopBar } from "./panels/TopBar";
import { attempt, garden, getState, nextBed, nextNeedingYou, openSow, select, setState, setView, useGarden } from "./store";

async function addBed() {
  const path = await attempt(() => garden().pickDirectory());
  if (!path) return;
  const bed = await attempt(() => garden().addBed(path));
  if (bed) select({ kind: "bed", id: bed.id });
}

/** Esc closes the top-most thing. Returns false when there was nothing to close. */
function closeTopmost(): boolean {
  const s = getState();
  if (s.paletteOpen) setState({ paletteOpen: false });
  else if (s.sowing !== null) setState({ sowing: null, sowPreset: null });
  else if (s.view.settings) setView({ settings: false });
  else if (s.view.almanac) setView({ almanac: false });
  else if (s.view.firstRun) setView({ firstRun: false });
  else if (s.selection) select(null);
  else if (s.catalogueOpen) setState({ catalogueOpen: false });
  else return false;
  return true;
}

function onKey(e: KeyboardEvent) {
  const t = e.target;
  const typing = t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  const s = getState();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setState({ paletteOpen: !s.paletteOpen });
    return;
  }
  if (e.key === "Escape") {
    // In the composer, the first Esc just leaves the text box; in the palette or a dialog it closes them.
    if (typing && !s.paletteOpen && s.sowing === null) (t as HTMLElement).blur();
    else if (closeTopmost()) e.preventDefault();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || s.paletteOpen || s.sowing !== null) return;
  switch (e.key) {
    case "n":
      nextNeedingYou(1);
      break;
    case "N":
      nextNeedingYou(-1);
      break;
    case "]":
      nextBed(1);
      break;
    case "[":
      nextBed(-1);
      break;
    case "\\":
      setState({ catalogueOpen: !s.catalogueOpen });
      break;
    case "s":
      openSow(s.selection?.kind === "bed" ? s.selection.id : s.selection?.kind === "plant" ? (s.plants[s.selection.id]?.bedId ?? "") : "");
      break;
    default:
      return;
  }
  e.preventDefault();
}

export function App() {
  const ready = useGarden((s) => s.ready);
  const selection = useGarden((s) => s.selection);
  const plant = useGarden((s) => (s.selection?.kind === "plant" ? s.plants[s.selection.id] : undefined));
  const bed = useGarden((s) => (s.selection?.kind === "bed" ? s.beds.find((b) => b.id === s.selection!.id) : undefined));
  const sowing = useGarden((s) => s.sowing);
  const sowKey = useGarden((s) => s.sowPreset?.id ?? "");
  const error = useGarden((s) => s.error);
  const empty = useGarden((s) => s.ready && s.beds.length === 0);
  const catalogueOpen = useGarden((s) => s.catalogueOpen);
  const paletteOpen = useGarden((s) => s.paletteOpen);
  const view = useGarden((s) => s.view);

  // Looking at a plant when it blooms counts as harvesting it.
  useEffect(() => {
    if (plant?.unread && document.hasFocus()) void garden().markRead(plant.id);
  }, [plant?.unread, plant?.id]);

  useEffect(() => {
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
    <div className={`app ${selection ? "app--panel" : ""} ${catalogueOpen ? "app--catalogue" : ""}`}>
      <TopBar onAddBed={addBed} />
      <main className="main">
        <IsoGarden onAddBed={addBed} />
        {catalogueOpen && <Catalogue />}
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
      {view.almanac && <Almanac onClose={() => setView({ almanac: false })} />}
      {view.settings && <SettingsPanel onClose={() => setView({ settings: false })} />}
      {view.firstRun && <FirstRun onDone={() => setView({ firstRun: false })} />}
      {sowing !== null && <SowDialog key={`${sowing}-${sowKey}`} />}
      {paletteOpen && <Palette />}
      {error && (
        <div className="toast" role="alert" onClick={() => setState({ error: null })}>
          {error}
        </div>
      )}
    </div>
  );
}
