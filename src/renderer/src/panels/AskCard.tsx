// What a waiting plant needs from you: a permission, an answer, or a plan approval.
import { useState } from "react";
import type { PendingAsk, Plant } from "../../../shared/types";
import { attempt, garden } from "../store";
import { Markdown } from "./Markdown";

export function AskCard({ plant, ask }: { plant: Plant; ask: PendingAsk }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const respond = async (r: Parameters<ReturnType<typeof garden>["answer"]>[2]) => {
    setBusy(true);
    await attempt(() => garden().answer(plant.id, ask.id, r));
    setBusy(false);
  };

  if (ask.kind === "question") return <QuestionCard ask={ask} busy={busy} onSubmit={(answers) => respond({ behavior: "allow", answers })} />;

  if (ask.kind === "plan") {
    return (
      <div className="ask ask--plan">
        <div className="ask__title">
          <TrellisIcon /> {ask.title}
        </div>
        <div className="ask__plan">{ask.plan ? <Markdown text={ask.plan} /> : <em>No plan text was sent.</em>}</div>
        <div className="ask__actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => respond({ behavior: "allow", mode: "acceptEdits" })}>
            Approve, trust edits
          </button>
          <button className="btn" disabled={busy} onClick={() => respond({ behavior: "allow", mode: "default" })}>
            Approve, ask per edit
          </button>
        </div>
        <div className="ask__deny">
          <input placeholder="Or say what to change and keep planning…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && respond({ behavior: "deny", message: note })} />
          <button className="btn btn--ghost" disabled={busy} onClick={() => respond({ behavior: "deny", message: note || "Keep planning; the plan is not ready yet." })}>
            Keep planning
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ask">
      <div className="ask__title">
        <BellIcon /> {ask.title}
      </div>
      {ask.reason && <div className="ask__reason">{ask.reason}</div>}
      {ask.detail && <pre className="ask__detail">{ask.detail}</pre>}
      <div className="ask__actions">
        <button className="btn btn--primary" disabled={busy} onClick={() => respond({ behavior: "allow" })} autoFocus>
          Allow
        </button>
        {ask.canAlwaysAllow && (
          <button className="btn" disabled={busy} onClick={() => respond({ behavior: "allow", always: true })} title="Allow this kind of action for the rest of the session">
            Always allow
          </button>
        )}
        <button className="btn btn--danger" disabled={busy} onClick={() => respond({ behavior: "deny", message: note || undefined })}>
          Deny
        </button>
      </div>
      <div className="ask__deny">
        <input placeholder="Optional: tell it what to do instead" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && respond({ behavior: "deny", message: note })} />
      </div>
    </div>
  );
}

function QuestionCard({ ask, busy, onSubmit }: { ask: PendingAsk; busy: boolean; onSubmit(answers: Record<string, string>): void }) {
  const questions = ask.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[q] ?? [];
      if (multi) return { ...p, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...p, [q]: [label] };
    });
  const answers = Object.fromEntries(
    questions.map((q) => {
      const vals = [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
      return [q.question, vals.join(", ")];
    }),
  );
  const complete = questions.every((q) => answers[q.question]);
  return (
    <div className="ask ask--question">
      <div className="ask__title">
        <BellIcon /> {ask.title}
      </div>
      {questions.map((q) => (
        <div key={q.question} className="question">
          {q.header && <span className="chip">{q.header}</span>}
          <div className="question__text">{q.question}</div>
          <div className="question__options">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label);
              return (
                <button key={o.label} className={`option ${on ? "option--on" : ""}`} onClick={() => toggle(q.question, o.label, !!q.multiSelect)}>
                  <span className="option__label">{o.label}</span>
                  {o.description && <span className="option__desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            placeholder="Something else…"
            value={other[q.question] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setOther((p) => ({ ...p, [q.question]: v }));
              if (!q.multiSelect && v) setPicked((p) => ({ ...p, [q.question]: [] }));
            }}
          />
        </div>
      ))}
      <div className="ask__actions">
        <button className="btn btn--primary" disabled={busy || !complete} onClick={() => onSubmit(answers)}>
          Answer
        </button>
      </div>
    </div>
  );
}

export function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path fill="currentColor" d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.4L2 11h12l-1.5-2.6V6A4.5 4.5 0 0 0 8 1.5ZM6.2 12.5a1.8 1.8 0 0 0 3.6 0Z" />
    </svg>
  );
}

function TrellisIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path stroke="currentColor" strokeWidth="1.4" fill="none" d="M3 1v14M8 1v14M13 1v14M1 4h14M1 8h14M1 12h14" />
    </svg>
  );
}
