// A bed's soil report: the platform work that decides how well every future plant grows.
import { CHORES, MOOD_LABEL, bedMood, soilChecks, statusLabel } from "../../../shared/garden";
import type { Bed } from "../../../shared/types";
import { SPECIES_STYLE } from "../iso/palette";
import { attempt, garden, plantsInBed, select, setState, useGarden } from "../store";

export function BedPanel({ bed }: { bed: Bed }) {
  const soil = useGarden((s) => s.soil[bed.id]);
  const allPlants = useGarden((s) => s.plants);
  const plants = plantsInBed(allPlants, bed.id);
  const checks = soilChecks(soil);
  const healthy = checks.filter((c) => c.found.length > 0).length;
  const mood = bedMood(plants);

  return (
    <aside className="panel" aria-label={`${bed.name} bed`}>
      <header className="panel__head">
        <div className="panel__swatch panel__swatch--bed" />
        <div className="panel__titles">
          <h2>{bed.name}</h2>
          <button className="panel__sub linkish mono" onClick={() => garden().reveal(bed.path)} title="Open folder">
            {bed.path}
          </button>
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </header>

      <div className="panel__scroll">
        <div className="meta">
          <span className={`mood mood--${mood}`}>{MOOD_LABEL[mood]}</span>
          {soil?.branch && <span>on {soil.branch}</span>}
          {soil && soil.dirty > 0 && <span>{soil.dirty} uncommitted</span>}
          {soil && soil.ahead > 0 && <span>{soil.ahead} ahead</span>}
          {soil && soil.behind > 0 && <span>{soil.behind} behind</span>}
          {soil && !soil.isGitRepo && soil.exists && <span>not a git repo</span>}
          <button className="btn btn--ghost btn--small" onClick={() => garden().refreshSoil(bed.id)}>
            Re-test soil
          </button>
        </div>

        <section className="card">
          <h3>
            Soil report <span className="muted">{healthy}/4 healthy</span>
          </h3>
          <p className="muted small">
            Agents grow toward whatever the bed gives them. Guidance, checks and tests are the compost, stakes and fence that keep the slop from spreading.
          </p>
          <ul className="checks">
            {checks.map((c) => {
              const ok = c.found.length > 0;
              const chore = CHORES.find((x) => x.id === c.chore);
              return (
                <li key={c.id} className={`check check--${ok ? "ok" : "missing"}`}>
                  <span className={`check__icon check__icon--${c.id}`} />
                  <div className="check__body">
                    <div className="check__name">
                      {c.name} <span className="muted">· {c.what}</span>
                    </div>
                    <div className="check__found">{ok ? c.found.join(", ") : c.missingHint}</div>
                  </div>
                  {!ok && chore && (
                    <button className="btn btn--small" onClick={() => setState({ sowing: bed.id, sowPreset: chore })}>
                      {chore.title}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <h3>Chores</h3>
          <p className="muted small">Tending work: sow an agent whose job is making this bed better for every agent after it.</p>
          <div className="chores">
            {CHORES.map((c) => (
              <button key={c.id} className="chore" onClick={() => setState({ sowing: bed.id, sowPreset: c })}>
                <span className="chore__title">{c.title}</span>
                <span className="chore__meta">{c.metaphor}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h3>
            Plants <span className="muted">{plants.length}</span>
          </h3>
          {plants.length === 0 && <p className="muted small">Fallow. Sow the first agent.</p>}
          <ul className="plant-list">
            {plants.map((p) => (
              <li key={p.id}>
                <button className="plant-row" onClick={() => select({ kind: "plant", id: p.id })}>
                  <span className="label__dot" style={{ background: SPECIES_STYLE[p.species].petal }} />
                  <span className="plant-row__name">{p.name}</span>
                  <span className={`plant-row__status status-text--${p.status}`}>{statusLabel(p)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn--primary" onClick={() => setState({ sowing: bed.id, sowPreset: null })}>
            Sow an agent
          </button>
        </section>

        <button
          className="btn btn--ghost btn--danger-text"
          onClick={() => confirm(`Remove the "${bed.name}" bed from the garden? This stops its agents. Your files are not touched.`) && attempt(() => garden().removeBed(bed.id))}
        >
          Remove bed from garden
        </button>
      </div>
    </aside>
  );
}
