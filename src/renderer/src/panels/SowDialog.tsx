import { useEffect, useRef, useState } from "react";
import { MODE_LABEL } from "../../../shared/garden";
import { SPECIES, type PermissionMode, type Species } from "../../../shared/types";
import { SPECIES_NAME, SPECIES_STYLE } from "../garden/Plant";
import { attempt, garden, select, setState, useGarden } from "../store";

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
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => setState({ sowing: null, sowPreset: null });
  const submit = async () => {
    if (!bedId || !prompt.trim()) return;
    setBusy(true);
    const plant = await attempt(() => garden().sow({ bedId, prompt, name: name || undefined, species, permissionMode: mode, model: model || undefined }));
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
          <select value={bedId} onChange={(e) => setBedId(e.target.value)}>
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
