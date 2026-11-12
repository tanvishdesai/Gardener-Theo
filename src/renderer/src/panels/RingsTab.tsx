// Growth rings: one row per finished turn, each a checkpoint you can open, prune back to, or branch from.
import { useEffect, useState } from "react";
import type { DiffScope, Plant, PruneResult, Ring } from "../../../shared/types";
import { attempt, focus, garden, useGarden } from "../store";
import { DiffView } from "./DiffView";
import { diffBar, duration, errorText, money, plural } from "./v2/format";
import { useEscape } from "./v2/ui";
import "./v2.css";

const busy = (p: Plant) => p.status === "thinking" || p.status === "working" || p.status === "waiting";

export function RingsTab({ plant }: { plant: Plant }) {
  const [rings, setRings] = useState<Ring[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<DiffScope | null>(null);
  const [pruning, setPruning] = useState<Ring | null>(null);
  const [result, setResult] = useState<PruneResult | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    garden()
      .rings(plant.id)
      .then((r) => live && (setRings(r), setError(null)))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [plant.id, plant.turns, plant.ring, reload]);

  const sorted = rings ? [...rings].sort((a, b) => b.n - a.n) : [];
  const latest = sorted.find((r) => !r.pruned);
  const max = Math.max(1, ...sorted.map((r) => (r.diff ? r.diff.insertions + r.diff.deletions : 0)));
  const noCheckpoints = sorted.length > 0 && sorted.every((r) => r.checkpoint !== "ready");

  const fork = async (r: Ring) => {
    const p = await attempt(() => garden().forkAt(plant.id, r.n));
    if (p) focus("plant", p.id);
  };

  return (
    <div className="v2-rings">
      <div className="v2-scopes" role="group" aria-label="Review changes">
        <span className="v2-scopes__label">Review changes</span>
        <button className="btn btn--small" disabled={!latest || latest.checkpoint !== "ready"} onClick={() => latest && setScope({ kind: "turn", n: latest.n })} title="What the latest ring (turn) changed">
          This turn
        </button>
        <button className="btn btn--small" onClick={() => setScope({ kind: "sown" })} title="Everything this plant changed since it was sown">
          Since sowing
        </button>
        <button className="btn btn--small" onClick={() => setScope({ kind: "uncommitted" })} title="Changes not in a commit yet (git diff HEAD)">
          Uncommitted
        </button>
      </div>

      {result && (
        <div className="v2-notice small" role="status">
          <strong>Pruned.</strong> {result.note}
          <button className="linkish v2-notice__x" aria-label="Dismiss" onClick={() => setResult(null)}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div className="v2-err">
          <p>Couldn't read this plant's rings.</p>
          <pre>{error}</pre>
        </div>
      )}
      {!rings && !error && <div className="muted small">Counting rings…</div>}
      {rings && sorted.length === 0 && (
        <div className="v2-empty small">
          <strong>No growth rings yet.</strong> Each finished turn adds a ring: a checkpoint of the plant's files that you can open as a diff, prune back to, or branch from.
        </div>
      )}
      {noCheckpoints && (
        <div className="v2-notice small">
          No file checkpoints for these rings{sorted[0].checkpointNote ? `: ${sorted[0].checkpointNote}` : "."} You can still read what each turn cost, but not open or restore its files.
        </div>
      )}
      {sorted.length > 0 && <p className="muted small v2-rings__hint">Checkpoints include new untracked files, but not ignored ones (node_modules, .env).</p>}

      <ol className="v2-timeline">
        {sorted.map((r) => {
          const bar = r.diff ? diffBar(r.diff.insertions, r.diff.deletions, max) : null;
          const ready = r.checkpoint === "ready" && !r.pruned;
          return (
            <li key={r.n} className={`v2-ring ${r.pruned ? "is-pruned" : ""}`}>
              <div className="v2-ring__notch" title={`Ring ${r.n}: turn ${r.n}`}>
                <span>{r.n}</span>
              </div>
              <div className="v2-ring__body">
                <div className="v2-ring__prompt" title={r.prompt}>
                  {r.prompt || <span className="muted">(no prompt)</span>}
                </div>
                <div className="v2-ring__meta small">
                  {r.pruned && <span className="chip">pruned</span>}
                  {r.ok === false ? <span className="chip chip--warn">failed</span> : r.endedAt ? <span className="chip v2-chip--ok">ok</span> : <span className="chip">growing</span>}
                  {r.stake && <StakeBadge stake={r.stake} />}
                  {r.diff && bar && (
                    <span className="v2-bar" title={`${plural(r.diff.files, "file")} changed: ${r.diff.insertions} lines added, ${r.diff.deletions} removed`}>
                      <span className="v2-bar__cells" aria-hidden>
                        <span className="v2-bar__plus" style={{ width: bar.plus * 4 }} />
                        <span className="v2-bar__minus" style={{ width: bar.minus * 4 }} />
                      </span>
                      <span className="v2-plus">+{r.diff.insertions}</span> <span className="v2-minus">−{r.diff.deletions}</span>
                      <span className="muted"> · {plural(r.diff.files, "file")}</span>
                    </span>
                  )}
                  {r.diff && r.diff.files === 0 && <span className="muted">no file changes</span>}
                  {r.costUsd != null && <span title="Estimated cost (Claude Code's own estimate)">{money(r.costUsd)}</span>}
                  {r.endedAt && <span title="How long the turn took">{duration(r.endedAt - r.startedAt)}</span>}
                </div>
                {r.checkpoint !== "ready" && !noCheckpoints && <div className="muted small">No checkpoint for this ring{r.checkpointNote ? `: ${r.checkpointNote}` : "."}</div>}
                {!r.pruned && (
                  <div className="v2-ring__actions">
                    <button className="btn btn--small" disabled={!ready} onClick={() => setScope({ kind: "turn", n: r.n })}>
                      Open diff
                    </button>
                    {r !== latest && (
                      <button
                        className="btn btn--small"
                        disabled={!ready || busy(plant)}
                        title={busy(plant) ? "Pause the plant first" : `Restore files and conversation to the end of ring ${r.n}`}
                        onClick={() => setPruning(r)}
                      >
                        <span className="v2-shears" aria-hidden /> Prune back to here
                      </button>
                    )}
                    <button className="btn btn--small" disabled={!ready} title={`Start a new potted plant from the end of ring ${r.n}: its own worktree and a copy of the conversation`} onClick={() => fork(r)}>
                      Grow a new branch from here
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {scope && <DiffView plant={plant} scope={scope} onClose={() => setScope(null)} />}
      {pruning && (
        <PruneConfirm
          plant={plant}
          ring={pruning}
          last={latest?.n ?? pruning.n}
          onCancel={() => setPruning(null)}
          onDone={(res) => {
            setPruning(null);
            setResult(res);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function StakeBadge({ stake }: { stake: NonNullable<Ring["stake"]> }) {
  const label = stake.status === "passing" ? "checks passed" : stake.status === "failing" ? "checks failed" : "checks running";
  return (
    <span className={`chip v2-stake v2-stake--${stake.status}`} title={`${stake.command}${stake.summary ? `: ${stake.summary}` : ""}`}>
      <span className="v2-ribbon" aria-hidden /> {label}
      {stake.summary ? ` · ${stake.summary}` : ""}
    </span>
  );
}

function PruneConfirm({ plant, ring, last, onCancel, onDone }: { plant: Plant; ring: Ring; last: number; onCancel(): void; onDone(r: PruneResult): void }) {
  const plants = useGarden((s) => s.plants);
  const others = Object.values(plants).filter((p) => p.bedId === plant.bedId && p.id !== plant.id && p.live);
  const filesToo = plant.plot === "pot" || others.length === 0;
  const [working, setWorking] = useState(false);
  useEscape(onCancel);
  const later = last > ring.n ? (last === ring.n + 1 ? `ring ${last}` : `rings ${ring.n + 1}–${last}`) : null;

  const go = async () => {
    setWorking(true);
    const res = await attempt(() => garden().pruneTo(plant.id, ring.n));
    setWorking(false);
    if (res) onDone(res);
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="v2-prune-title">
        <h2 id="v2-prune-title">Prune back to ring {ring.n}?</h2>
        <ul className="v2-list">
          {filesToo ? (
            <li>
              <strong>Files:</strong> {plant.plot === "pot" ? "the pot's files" : "the bed's files"} go back to exactly how they were at the end of ring {ring.n}{" "}
              <span className="muted">(git restore + git clean in {plant.cwd ?? plant.worktreePath ?? "its folder"}; ignored files like node_modules and .env are left alone)</span>.
            </li>
          ) : (
            <li>
              <strong>Files stay as they are.</strong> This plant shares the bed's working tree with {others.map((p) => p.name).join(", ")}, which {others.length === 1 ? "is" : "are"} still running, so
              restoring files could undo their work. Only the conversation is pruned.
            </li>
          )}
          <li>
            <strong>Conversation:</strong> the plant continues from the end of ring {ring.n}
            {later ? ` and forgets ${later}` : ""}.
          </li>
          {later && (
            <li>
              <strong>{later[0].toUpperCase() + later.slice(1)}</strong> turn grey. They stay listed for the record, but can't be restored once the plant takes a new turn.
            </li>
          )}
        </ul>
        <div className="dialog__actions">
          <button className="btn btn--ghost" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={go} disabled={working}>
            <span className="v2-shears" aria-hidden /> {working ? "Pruning…" : `Prune back to ring ${ring.n}`}
          </button>
        </div>
      </div>
    </div>
  );
}
