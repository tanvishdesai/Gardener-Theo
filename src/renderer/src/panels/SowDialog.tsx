import { useEffect, useRef, useState } from "react";
import { MODE_LABEL } from "../../../shared/garden";
import { SPECIES, type PermissionMode, type PlotKind, type Species } from "../../../shared/types";
import { SPECIES_NAME, SPECIES_STYLE } from "../iso/palette";
import { attempt, garden, getState, select, setState, useGarden } from "../store";

const MODELS = [
  { id: "", name: "Claude Code default" },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

export function SowDialog() {
  const sowing = useGarden((s) => s.sowing);
  const preset = useGarden((s) => s.sowPreset);
  const beds = useGarden((s) => s.beds);
  const [bedId, setBedId] = useState(sowing || beds[0]?.id || "");
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [name, setName] = useState(preset?.title ?? "");
  const [species, setSpecies] = useState<Species | undefined>();
  const [mode, setMode] = useState<PermissionMode>(preset?.mode ?? "default");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const soil = useGarden((s) => s.soil[bedId]);
  const git = !!soil?.isGitRepo;
  // Unset until the user picks: the soil report may still be loading, and a git repo defaults to a pot.
  const [picked, setPlot] = useState<PlotKind | undefined>();
  const plot: PlotKind = picked ?? (git ? "pot" : "bed");
  const [baseRef, setBaseRef] = useState(soil?.branch ?? "");
  const [fromOrigin, setFromOrigin] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // Escape is handled by App (it closes the top-most thing).
  useEffect(() => {
    area.current?.focus();
  }, []);

  const pickBed = (id: string) => {
    setBedId(id);
    const next = getState().soil[id];
    setPlot(undefined);
    setBaseRef(next?.branch ?? "");
  };

  const close = () => setState({ sowing: null, sowPreset: null });
  const submit = async () => {
    if (!bedId || !prompt.trim()) return;
    setBusy(true);
    const plant = await attempt(() => garden().sow({
        bedId,
        prompt,
        name: name || undefined,
        species,
        permissionMode: mode,
        model: model || undefined,
        // Soil not read yet: let the main process decide (it asks git).
        plot: !soil ? picked : git ? plot : "bed",
        ...(git && plot === "pot" ? { baseRef: baseRef.trim() || undefined, fromOrigin } : {}),
      }),
    );
    setBusy(false);
    if (plant) {
      close();
      select({ kind: "plant", id: plant.id });
    }
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{preset ? preset.title : "Sow an agent"}</h2>
        <p className="muted small">{preset ? preset.metaphor : "Each plant is one Claude Code session, rooted in the bed's folder."}</p>

        <label className="field">
          <span>Bed</span>
          <select value={bedId} onChange={(e) => pickBed(e.target.value)}>
            {beds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Task</span>
          <textarea
            ref={area}
            rows={5}
            value={prompt}
            placeholder="What should this agent grow? e.g. Find why reconnect flakes on mobile and fix it."
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
        </label>

        <div className="field">
          <span>Where it grows</span>
          <div className="modes modes--plot" role="radiogroup" aria-label="Where it grows">
            {git && (
              <button type="button" role="radio" aria-checked={plot === "pot"} className={`mode ${plot === "pot" ? "mode--on" : ""}`} onClick={() => setPlot("pot")}>
                <span className="mode__name">Potted (own worktree, recommended)</span>
                <span className="mode__hint">A git worktree on its own branch. Its edits can't collide with yours or other plants'.</span>
              </button>
            )}
            <button type="button" role="radio" aria-checked={!git || plot === "bed"} className={`mode ${!git || plot === "bed" ? "mode--on" : ""}`} onClick={() => setPlot("bed")}>
              <span className="mode__name">In the bed (share the working tree)</span>
              <span className="mode__hint">Edits the repo folder directly, like a terminal in it. Plants in the same bed can step on each other.</span>
            </button>
          </div>
          {!git && <span className="muted small">This folder is not a git repo, so plants share its files. Pots need git.</span>}
        </div>

        {git && plot === "pot" && (
          <div className="field-row field-row--base">
            <label className="field">
              <span>Start from branch</span>
              <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder={soil?.branch ?? "main"} />
            </label>
            <label className="check-inline small" title="git fetch origin first, then branch from origin/<branch>">
              <input type="checkbox" checked={fromOrigin} onChange={(e) => setFromOrigin(e.target.checked)} /> Start from origin (fetch first)
            </label>
          </div>
        )}

        <div className="field-row">
          <label className="field">
            <span>Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="From the task" />
          </label>
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field">
          <span>How much to trust it</span>
          <div className="modes">
            {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
              <button type="button" key={m} className={`mode ${mode === m ? "mode--on" : ""} ${m === "bypassPermissions" ? "mode--wild" : ""}`} onClick={() => setMode(m)}>
                <span className="mode__name">{MODE_LABEL[m].name}</span>
                <span className="mode__hint">{MODE_LABEL[m].hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Species</span>
          <div className="species">
            <button type="button" className={`species__opt ${!species ? "species__opt--on" : ""}`} onClick={() => setSpecies(undefined)}>
              Any
            </button>
            {SPECIES.map((sp) => (
              <button type="button" key={sp} className={`species__opt ${species === sp ? "species__opt--on" : ""}`} onClick={() => setSpecies(sp)} title={SPECIES_NAME[sp]}>
                <span className="label__dot" style={{ background: SPECIES_STYLE[sp].petal, borderColor: SPECIES_STYLE[sp].petalDark }} />
                {SPECIES_NAME[sp]}
              </button>
            ))}
          </div>
        </div>

        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !prompt.trim() || !bedId}>
            Sow and water
          </button>
        </div>
      </form>
    </div>
  );
}
