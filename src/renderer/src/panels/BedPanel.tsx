// A bed's soil report: the platform work that decides how well every future plant grows.
import { CHORES, MOOD_LABEL, bedMood, soilChecks, statusLabel } from "../../../shared/garden";
import { useEffect, useState } from "react";
import type { Bed, Plant } from "../../../shared/types";
import { SPECIES_STYLE } from "../iso/palette";
import { attempt, focus, garden, openSow, select, useGarden } from "../store";

const NO_IDS: string[] = [];

export function BedPanel({ bed }: { bed: Bed }) {
  const soil = useGarden((s) => s.soil[bed.id]);
  const ids = useGarden((s) => s.byBed[bed.id] ?? NO_IDS);
  const allPlants = useGarden((s) => s.plants);
  const plants = ids.map((id) => allPlants[id]).filter((p): p is Plant => !!p);
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
                    <button className="btn btn--small" onClick={() => openSow(bed.id, chore)}>
                      {chore.title}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <HealthCard bedId={bed.id} health={soil?.health} />
        <StakeCard bed={bed} candidates={soil?.stakeCandidates ?? []} />

        <section className="card">
          <h3>Chores</h3>
          <p className="muted small">Tending work: sow an agent whose job is making this bed better for every agent after it.</p>
          <div className="chores">
            {CHORES.map((c) => (
              <button key={c.id} className="chore" onClick={() => openSow(bed.id, c)}>
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
                <button className="plant-row" onClick={() => focus("plant", p.id)}>
                  <span className="label__dot" style={{ background: SPECIES_STYLE[p.species].petal }} />
                  <span className="plant-row__name">{p.name}</span>
                  <span className={`plant-row__status status-text--${p.status}`}>{statusLabel(p)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn--primary" onClick={() => openSow(bed.id)}>
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

/** Soil health (0..100) and its last 30 days as hard pixel bars. */
function HealthCard({ bedId, health }: { bedId: string; health?: number }) {
  const [days, setDays] = useState<{ day: string; health: number }[] | null>(null);
  useEffect(() => {
    let live = true;
    void attempt(() => garden().soilHistory(bedId)).then((d) => live && setDays(d ?? []));
    return () => {
      live = false;
    };
  }, [bedId, health]);
  if (health === undefined && !days?.length) return null;
  return (
    <section className="card">
      <h3>
        Soil health <span className="muted">{health !== undefined ? `${health} / 100` : "not scored yet"}</span>
      </h3>
      <p className="muted small">Compost, stakes, fence and mulch, plus how often the stake has passed lately.</p>
      {days && days.length > 0 && (
        <div className="spark" role="img" aria-label={`Soil health over the last ${days.length} days, from ${days[0].health} to ${days[days.length - 1].health}`}>
          {days.map((d) => (
            <span key={d.day} className={`spark__bar ${d.health < 40 ? "is-low" : d.health < 70 ? "is-mid" : ""}`} style={{ height: `${Math.max(2, Math.round((d.health / 100) * 32))}px` }} title={`${d.day}: ${d.health}`} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The stake: one fast check command run after each turn that changed files. */
function StakeCard({ bed, candidates }: { bed: Bed; candidates: string[] }) {
  const current = bed.stakeCommand ?? "";
  const [custom, setCustom] = useState(current && !candidates.includes(current) ? current : "");
  const [choice, setChoice] = useState(current ? (candidates.includes(current) ? current : "__custom") : "");
  const command = choice === "__custom" ? custom.trim() : choice;
  const dirty = command !== current;
  return (
    <section className="card">
      <h3>
        Stake <span className="muted">{current ? "driven" : "none"}</span>
      </h3>
      <p className="muted small">A fast check run after every turn that changed files. Its result shows as a ribbon on the plant: green passing, amber running, red failing.</p>
      {current && (
        <div className="small">
          Now: <span className="mono">{current}</span>
        </div>
      )}
      <div className="stake-row">
        <select aria-label="Stake command" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">No stake</option>
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="__custom">Custom command…</option>
        </select>
        {choice === "__custom" && <input aria-label="Custom stake command" className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="npm run typecheck" />}
        <button className="btn btn--small btn--primary" disabled={!dirty || (choice === "__custom" && !command)} onClick={() => attempt(() => garden().setStake(bed.id, command || null))}>
          {command ? "Drive stake" : "Pull stake"}
        </button>
      </div>
    </section>
  );
}
