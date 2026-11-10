// The potting bench: everything about one plant (agent), its journal, and the watering can (composer).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ACTIVITY_HINT, MODE_LABEL, statusLabel } from "../../../shared/garden";
import type { Entry, PermissionMode, Plant } from "../../../shared/types";
import { SPECIES_NAME, SPECIES_STYLE } from "../iso/palette";
import { attempt, garden, select, useGarden } from "../store";
import { AskCard } from "./AskCard";
import { Markdown } from "./Markdown";

const EMPTY: Entry[] = [];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function PlantPanel({ plant }: { plant: Plant }) {
  const bed = useGarden((s) => s.beds.find((b) => b.id === plant.bedId));
  const entries = useGarden((s) => s.entries[plant.id] ?? EMPTY);
  const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
  const style = SPECIES_STYLE[plant.species];

  return (
    <aside className="panel" aria-label={`${plant.name} details`}>
      <header className="panel__head">
        <div className="panel__swatch" style={{ background: style.petal, borderColor: style.petalDark }} title={SPECIES_NAME[plant.species]} />
        <div className="panel__titles">
          <h2>{plant.name}</h2>
          <button className="panel__sub linkish" onClick={() => select({ kind: "bed", id: plant.bedId })}>
            {SPECIES_NAME[plant.species]} in {bed?.name ?? "?"}
          </button>
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          ×
        </button>
      </header>

      <div className={`status status--${plant.status}`}>
        <span className="status__dot" />
        <div>
          <div className="status__label">{statusLabel(plant)}</div>
          {plant.activityDetail && busy && (
            <div className="status__detail" title={plant.activityDetail}>
              {plant.status === "working" && plant.activity ? `${ACTIVITY_HINT[plant.activity]}: ` : ""}
              {plant.activityDetail}
            </div>
          )}
          {plant.status === "error" && plant.error && <div className="status__detail status__detail--wrap">{plant.error}</div>}
        </div>
      </div>

      <div className="meta">
        <span title="Completed turns">{plural(plant.turns, "turn")}</span>
        <span title="Tool calls">{plural(plant.toolCalls, "tool call")}</span>
        {plant.costUsd > 0 && <span title="Estimated API-equivalent cost">${plant.costUsd.toFixed(2)}</span>}
        {plant.runners > 0 && <span>{plural(plant.runners, "runner")}</span>}
        {plant.model && <span className="meta__model">{plant.model}</span>}
        <ModePicker plant={plant} />
      </div>

      {plant.ask && <AskCard plant={plant} ask={plant.ask} key={plant.ask.id} />}

      <Journal entries={entries} />
      <Composer plant={plant} />
    </aside>
  );
}

function ModePicker({ plant }: { plant: Plant }) {
  return (
    <select
      className="mode-select"
      value={plant.permissionMode}
      title={MODE_LABEL[plant.permissionMode].hint}
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

function Journal({ entries }: { entries: Entry[] }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div
      className="journal"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {entries.length === 0 && <div className="journal__empty">The growth journal is empty. Water this plant with a task below.</div>}
      {entries.map((e) => (
        <JournalEntry key={e.id} e={e} />
      ))}
    </div>
  );
}

function JournalEntry({ e }: { e: Entry }) {
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case "user":
      return (
        <div className="j j--user">
          <div className="bubble">{e.text}</div>
        </div>
      );
    case "text":
      return (
        <div className="j j--text">
          <Markdown text={e.text} />
        </div>
      );
    case "thinking":
      return (
        <details className="j j--thinking">
          <summary>Thought for a moment</summary>
          <div className="j__thought">{e.text}</div>
        </details>
      );
    case "tool": {
      const t = e.tool!;
      return (
        <div className={`j j--tool j--tool-${t.status}`}>
          <button className="tool-line" onClick={() => setOpen(!open)} disabled={!t.output}>
            <span className={`tool-icon tool-icon--${t.activity}`} />
            <span className="tool-name">{t.name}</span>
            <span className="tool-summary">{t.summary}</span>
            {t.status === "running" && <span className="spinner" />}
          </button>
          {open && t.output && <pre className="tool-output">{t.output}</pre>}
        </div>
      );
    }
    case "result":
      return <div className="j j--result">✿ {e.text}</div>;
    case "error":
      return <div className="j j--error">{e.text}</div>;
    default:
      return <div className="j j--system">{e.text}</div>;
  }
}

function Composer({ plant }: { plant: Plant }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
  useEffect(() => {
    ref.current?.focus();
  }, [plant.id]);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    await attempt(() => garden().send(plant.id, body));
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={3}
        value={text}
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
      <div className="composer__row">
        <button className="btn btn--ghost btn--small" onClick={() => confirm(`Uproot "${plant.name}"? Its session stays in Claude Code's history, but it leaves the garden.`) && attempt(() => garden().uproot(plant.id))}>
          Uproot
        </button>
        <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
        {busy && (
          <button className="btn btn--small" onClick={() => attempt(() => garden().interrupt(plant.id))}>
            Pause
          </button>
        )}
        <button className="btn btn--primary btn--small" onClick={send} disabled={!text.trim()}>
          Water
        </button>
      </div>
    </div>
  );
}
