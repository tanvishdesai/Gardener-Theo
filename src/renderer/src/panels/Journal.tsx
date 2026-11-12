// The growth journal: the open plant's entries, newest at the bottom, older pages loaded on scroll-up.
// Rows are memoized per entry object (a new object = a new version), Markdown is memoized per text, and
// `content-visibility: auto` lets the browser skip layout and paint for rows out of view.
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Entry } from "../../../shared/types";
import { attempt, garden, loadOlder, useGarden } from "../store";
import { Markdown } from "./Markdown";

const NEAR_TOP = 300;
const NEAR_BOTTOM = 60;

const bytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function Journal({ plantId }: { plantId: string }) {
  const j = useGarden((s) => s.journals[plantId]);
  const entries = j?.entries;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastHeight = useRef(0);
  const lastTop = useRef(0);
  const lastFirst = useRef<string | undefined>(undefined);

  // Stick to the bottom while new entries arrive; keep the view still when an older page is prepended.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !entries) return;
    const first = entries[0]?.id;
    let raf = 0;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      // Rows that scroll into view only get their real height (instead of the 44px placeholder) on the
      // next layout, which grows scrollHeight without a scroll event. Re-pin until the height settles.
      let frames = 0;
      let still = 0;
      let seen = el.scrollHeight;
      const repin = () => {
        if (!stick.current) return;
        el.scrollTop = el.scrollHeight;
        still = el.scrollHeight === seen ? still + 1 : 0;
        seen = el.scrollHeight;
        if (still < 3 && ++frames < 30) raf = requestAnimationFrame(repin);
      };
      raf = requestAnimationFrame(repin);
    } else if (lastFirst.current && first !== lastFirst.current) el.scrollTop += el.scrollHeight - lastHeight.current;
    lastFirst.current = first;
    lastHeight.current = el.scrollHeight;
    return () => cancelAnimationFrame(raf);
  }, [entries]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    // Rows are `content-visibility: auto`, so their real heights only arrive after we pin to the bottom.
    // Only a scroll *up* (the reader's doing) lets go of the bottom; growth below us re-pins.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (near) stick.current = true;
    else if (el.scrollTop < lastTop.current - 2) stick.current = false;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
    if (el.scrollTop < NEAR_TOP && j?.hasMore && !j.loading) void loadOlder(plantId);
  };

  return (
    <div className="journal" ref={box} onScroll={onScroll} role="log" aria-label="Growth journal" aria-busy={j?.loading}>
      {j?.hasMore && (
        <button className="btn btn--ghost btn--small journal__older" disabled={j.loading} onClick={() => loadOlder(plantId)}>
          {j.loading ? "Loading older entries…" : "Load older entries"}
        </button>
      )}
      {!entries?.length &&
        (j?.loading || !j ? <div className="journal__empty">Opening the journal…</div> : <div className="journal__empty">The growth journal is empty. Water this plant with a task below.</div>)}
      {entries?.map((e) => <JournalRow key={e.id} e={e} />)}
    </div>
  );
}

const JournalRow = memo(function JournalRow({ e }: { e: Entry }) {
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
    case "tool":
      return <ToolRow e={e} />;
    case "result":
      return <div className="j j--result">✿ {e.text}</div>;
    case "error":
      return <div className="j j--error">{e.text}</div>;
    default:
      return <div className="j j--system">{e.text}</div>;
  }
});

function ToolRow({ e }: { e: Entry }) {
  const t = e.tool!;
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const showFull = async () => {
    setFetching(true);
    const text = await attempt(() => garden().toolOutput(e.plantId, e.id));
    setFetching(false);
    if (text !== undefined) setFull(text);
  };
  return (
    <div className={`j j--tool j--tool-${t.status}`}>
      <button className="tool-line" onClick={() => setOpen(!open)} disabled={!t.output} aria-expanded={t.output ? open : undefined}>
        <span className={`tool-icon tool-icon--${t.activity}`} />
        <span className="tool-name">{t.name}</span>
        <span className="tool-summary">{t.summary}</span>
        {t.status === "running" && <span className="spinner" />}
      </button>
      {open && t.output && (
        <>
          <pre className="tool-output">{full ?? t.output}</pre>
          {t.outputTruncated && full === null && (
            <button className="btn btn--ghost btn--small" disabled={fetching} onClick={showFull}>
              {fetching ? "Fetching…" : `Show full output${t.outputBytes ? ` (${bytes(t.outputBytes)})` : ""}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
