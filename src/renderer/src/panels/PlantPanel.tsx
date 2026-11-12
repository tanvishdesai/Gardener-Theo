// The potting bench: everything about one plant (agent), its journal, and the watering can (composer).
import { useEffect, useRef, useState } from "react";
import { ACTIVITY_HINT, MODE_LABEL, statusLabel } from "../../../shared/garden";
import type { PermissionMode, Plant, ReviewTag } from "../../../shared/types";
import { SPECIES_NAME, SPECIES_STYLE } from "../iso/palette";
import { attempt, garden, removeTag, select, setState, takeTagsForSend, useGarden, type PlantTab } from "../store";
import { AskCard } from "./AskCard";
import { HarvestFlow } from "./HarvestFlow";
import { Journal } from "./Journal";
import { RingsTab } from "./RingsTab";

const NO_TAGS: ReviewTag[] = [];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const TABS: { id: PlantTab; label: string }[] = [
  { id: "journal", label: "Journal" },
  { id: "rings", label: "Rings" },
  { id: "harvest", label: "Harvest" },
];

export function PlantPanel({ plant }: { plant: Plant }) {
  const bedName = useGarden((s) => s.beds.find((b) => b.id === plant.bedId)?.name);
  const tab = useGarden((s) => s.plantTab);
  const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
  const style = SPECIES_STYLE[plant.species];

  return (
    <aside className="panel" aria-label={`${plant.name} details`}>
      <header className="panel__head">
        <div className="panel__swatch" style={{ background: style.petal, borderColor: style.petalDark }} title={SPECIES_NAME[plant.species]} />
        <div className="panel__titles">
          <h2>{plant.name}</h2>
          <button className="panel__sub linkish" onClick={() => select({ kind: "bed", id: plant.bedId })}>
            {SPECIES_NAME[plant.species]} in {bedName ?? "?"}
          </button>
        </div>
        <button
          className={`pin-btn ${plant.pinned ? "is-on" : ""}`}
          aria-pressed={!!plant.pinned}
          onClick={() => attempt(() => garden().setPinned(plant.id, !plant.pinned))}
          title={plant.pinned ? "Pinned: stays in the ground even when old. Click to unpin." : "Pin: keep it in the ground even when old"}
        >
          {plant.pinned ? "Pinned" : "Pin"}
        </button>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </header>

      {/* Everything above the tabs shrinks and scrolls on short windows, so the tab content always keeps room. */}
      <div className="panel__top">
      <PlotLine plant={plant} />

      <div className={`status status--${plant.queued ? "queued" : plant.status}`}>
        <span className="status__dot" />
        <div>
          <div className="status__label">{plant.queued ? "Waiting for a free pot · memory is full" : statusLabel(plant)}</div>
          {plant.queued && (
            <div className="status__detail status__detail--wrap">Your message is queued. It starts by itself when another plant's Claude Code process closes and memory frees up.</div>
          )}
          {plant.activityDetail && busy && (
            <div className="status__detail" title={plant.activityDetail}>
              {plant.status === "working" && plant.activity ? `${ACTIVITY_HINT[plant.activity]}: ` : ""}
              {plant.activityDetail}
            </div>
          )}
          {plant.status === "error" && plant.error && <div className="status__detail status__detail--wrap">{plant.error}</div>}
        </div>
      </div>

      <Badges plant={plant} />

      <div className="meta">
        <span title="Completed turns">{plural(plant.turns, "turn")}</span>
        <span title="Tool calls">{plural(plant.toolCalls, "tool call")}</span>
        {plant.costUsd > 0 && <span title="Estimated API-equivalent cost">${plant.costUsd.toFixed(2)}</span>}
        {plant.runners > 0 && <span>{plural(plant.runners, "runner")}</span>}
        {plant.lastDiff && (
          <span title="Lines changed by the last turn">
            <span className="add">+{plant.lastDiff.insertions}</span> <span className="del">−{plant.lastDiff.deletions}</span>
          </span>
        )}
        {plant.model && <span className="meta__model">{plant.model}</span>}
        <ModePicker plant={plant} />
      </div>

      {plant.ask && <AskCard plant={plant} ask={plant.ask} key={plant.ask.id} />}
      </div>

      <div className="tabs" role="tablist" aria-label="Plant views">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`tabpanel-${t.id}`} className={`tab ${tab === t.id ? "is-on" : ""}`} onClick={() => setState({ plantTab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "journal" && <Journal plantId={plant.id} />}
        {tab === "rings" && (
          <div className="panel__scroll">
            <RingsTab plant={plant} />
          </div>
        )}
        {tab === "harvest" && (
          <div className="panel__scroll">
            <HarvestFlow plant={plant} />
          </div>
        )}
      </div>
      <Composer plant={plant} />
    </aside>
  );
}

function PlotLine({ plant }: { plant: Plant }) {
  if (plant.origin === "volunteer") return <div className="plot muted small">In a terminal · {plant.cwd ?? "its own folder"}</div>;
  if (plant.plot === "pot")
    return (
      <div className="plot small" title={plant.worktreePath}>
        <span className="plot__kind">Potted</span> · own worktree · <span className="mono">{plant.branch ?? "?"}</span>
        {plant.baseRef && <span className="muted"> from {plant.baseRef}</span>}
        {(plant.potDirty ?? 0) > 0 && <span className="muted"> · {plant.potDirty} uncommitted</span>}
        {(plant.unpushed ?? 0) > 0 && <span className="muted"> · {plant.unpushed} unpushed</span>}
      </div>
    );
  return (
    <div className="plot small">
      <span className="plot__kind">In the bed</span> <span className="muted">· shares the repo's working tree</span>
    </div>
  );
}

/** The message "Ask the plant to fix it" sends after a failing stake (PLAN M7): command, summary and output. */
export function stakeFixMessage(stake: NonNullable<Plant["stake"]>, output?: string): string {
  const tail = output?.trim() ? output.trim().slice(-3000) : "";
  return [
    `The bed's check \`${stake.command}\` failed after your last turn${stake.summary ? ` (${stake.summary})` : ""}. Please read the failures, fix them, and run the check again.`,
    tail ? `Output (last part):\n\`\`\`\n${tail}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function Badges({ plant }: { plant: Plant }) {
  const s = plant.stake;
  const pr = plant.pr;
  // The latest stake run's output, from the open journal.
  const stakeOutput = useGarden((st) => st.journals[plant.id]?.entries.findLast((e) => e.tool?.name === "Stake")?.tool?.output);
  const [askedFix, setAskedFix] = useState<number | null>(null);
  if (plant.origin === "sown" && !s && !pr) return null;
  return (
    <div className="badges">
      {plant.origin === "volunteer" && !plant.ended && (
        <span
          className="chip chip--volunteer"
          title={plant.watchedBy === "transcript" ? "Watched through its transcript: Gardener can't tell when it is waiting on you. Install the hook in Settings for that." : "Watched through the Claude Code hook"}
        >
          Volunteer · running in a terminal
        </span>
      )}
      {plant.origin === "volunteer" && plant.ended && (
        <>
          <span className="chip chip--volunteer">Volunteer · terminal session ended</span>
          <button className="btn btn--small" onClick={() => attempt(() => garden().adopt(plant.id))} title="Make it a plant you can message from here; it resumes the same session">
            Adopt
          </button>
        </>
      )}
      {plant.origin === "imported" && <span className="chip">Imported from Claude Code history</span>}
      {s && (
        <span className={`chip chip--stake chip--${s.status}`} title={`Stake: the bed's check command, run after turn ${s.turn ?? "?"}`}>
          Stake {s.status === "running" ? "running" : s.status} · <span className="mono">{s.command}</span>
          {s.summary ? ` · ${s.summary}` : ""}
        </span>
      )}
      {s?.status === "failing" && plant.origin !== "volunteer" && (
        <button
          className="btn btn--small"
          disabled={askedFix === s.at || plant.status === "thinking" || plant.status === "working" || plant.status === "waiting"}
          onClick={() => {
            setAskedFix(s.at);
            void attempt(() => garden().send(plant.id, stakeFixMessage(s, stakeOutput)));
          }}
          title="Sends the plant the failing check and its output, and asks it to fix them"
        >
          {askedFix === s.at ? "Sent to the plant" : "Ask the plant to fix it"}
        </button>
      )}
      {pr && (
        <a className={`chip chip--pr chip--${pr.checks === "failing" ? "failing" : pr.checks === "passing" ? "passing" : "running"}`} href={pr.url} target="_blank" rel="noreferrer">
          PR {pr.number ? `#${pr.number}` : ""} · {pr.state}
          {pr.checks !== "none" ? ` · checks ${pr.checks}` : ""}
          {pr.review ? ` · ${pr.review.replace(/_/g, " ")}` : ""}
        </a>
      )}
    </div>
  );
}

function ModePicker({ plant }: { plant: Plant }) {
  return (
    <select
      className="mode-select"
      value={plant.permissionMode}
      title={MODE_LABEL[plant.permissionMode].hint}
      aria-label="Permission mode"
      onChange={(e) => attempt(() => garden().setMode(plant.id, e.target.value as PermissionMode))}
    >
      {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
        <option key={m} value={m}>
          {MODE_LABEL[m].name}
        </option>
      ))}
    </select>
  );
}

let lastInputWasPointer = false;
if (typeof window !== "undefined") {
  // A click in the Seed Catalogue keeps focus on the list, so j / k carry on from the clicked row.
  window.addEventListener("pointerdown", (e) => (lastInputWasPointer = !(e.target instanceof Element && e.target.closest(".catalogue"))), true);
  window.addEventListener("keydown", () => (lastInputWasPointer = false), true);
}

function Composer({ plant }: { plant: Plant }) {
  const [text, setText] = useState("");
  const [uprooting, setUprooting] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const tags = useGarden((s) => s.tags[plant.id] ?? NO_TAGS);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
  useEffect(() => {
    // Only take the keyboard when the plant was opened with the pointer. Opened by n/N, [/], the catalogue
    // or the palette, focus stays put so the next key keeps navigating instead of typing into the box.
    if (lastInputWasPointer) ref.current?.focus();
  }, [plant.id]);
  const canSend = !!text.trim() || tags.length > 0;
  const send = async () => {
    if (!canSend) return;
    const body = [text.trim(), takeTagsForSend(plant.id)].filter(Boolean).join("\n\n");
    setText("");
    await attempt(() => garden().send(plant.id, body));
  };
  return (
    <div className="composer">
      {tags.length > 0 && (
        <div className="tagchips" aria-label="Review tags to send">
          <span className="muted small">Sent with your message:</span>
          {tags.map((t) => (
            <span key={t.id} className="chip chip--tag" title={t.note || t.hunk}>
              {t.path.split("/").pop()}:{t.startLine === t.endLine ? t.startLine : `${t.startLine}-${t.endLine}`}
              <button className="linkish" aria-label={`Remove tag on ${t.path}`} onClick={() => removeTag(plant.id, t.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={3}
        value={text}
        aria-label="Message to this plant"
        placeholder={
          plant.status === "waiting"
            ? "Reply instead of answering (counts as a no)…"
            : busy
              ? "Queue a follow-up…"
              : plant.turns === 0
                ? "Give this seed its first task…"
                : "Water it with a follow-up…"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {uprooting ? (
        <div className="composer__row uproot">
          <span className="small">Uproot "{plant.name}"? Its session stays in Claude Code's history.</span>
          {plant.plot === "pot" && plant.branch && (
            <label className="small check-inline">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Also delete branch <span className="mono">{plant.branch}</span>
            </label>
          )}
          <button className="btn btn--ghost btn--small" onClick={() => setUprooting(false)}>
            Keep it
          </button>
          <button className="btn btn--danger btn--small" onClick={() => attempt(() => garden().uproot(plant.id, { deleteBranch }))}>
            Uproot
          </button>
        </div>
      ) : (
        <div className="composer__row">
          <button className="btn btn--ghost btn--small" onClick={() => setUprooting(true)}>
            Uproot
          </button>
          <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
          {busy && (
            <button className="btn btn--small" onClick={() => attempt(() => garden().interrupt(plant.id))}>
              Pause
            </button>
          )}
          <button className="btn btn--primary btn--small" onClick={send} disabled={!canSend}>
            Water
          </button>
        </div>
      )}
    </div>
  );
}
