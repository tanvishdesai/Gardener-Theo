// Diff review: a wide window with the changed files on the left and one file's diff on the right.
// Select lines and "tie a tag" to leave a review note that goes out with the plant's next message.
import { useEffect, useMemo, useRef, useState } from "react";
import { parse } from "diff2html/lib-esm/diff-parser";
import type { DiffFile, DiffScope, Plant, ReviewTag } from "../../../shared/types";
import { addTag, garden, removeTag, useGarden } from "../store";
import { errorText, plural, splitRows, tagCovers, tagHunk, type Block, type Line } from "./v2/format";
import { Counts, StatusLetter, Window } from "./v2/ui";
import "./v2.css";

const NO_TAGS: ReviewTag[] = [];
const TRUNCATED = "\n[truncated]";

export function scopeTitle(scope: DiffScope): { title: string; git: string } {
  switch (scope.kind) {
    case "turn":
      return { title: `Ring ${scope.n}: what this turn changed`, git: `git diff between the checkpoints taken before and after turn ${scope.n}` };
    case "sown":
      return { title: "Since sowing: everything this plant changed", git: "git diff from the commit the plant was sown on to its files now" };
    case "uncommitted":
      return { title: "Uncommitted: not in a commit yet", git: "git diff HEAD (working tree against the last commit, untracked files included)" };
  }
}

type Loaded = { text: string; full?: boolean; loadingFull?: boolean } | { error: string };

export function DiffView({ plant, scope, onClose }: { plant: Plant; scope: DiffScope; onClose(): void }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const tags = useGarden((s) => s.tags[plant.id] ?? NO_TAGS);
  const { title, git } = scopeTitle(scope);

  useEffect(() => {
    let live = true;
    garden()
      .diffFiles(plant.id, scope)
      .then((f) => {
        if (!live) return;
        setFiles(f);
        setActive(f[0]?.path ?? null);
      })
      .catch((e) => live && setListError(errorText(e)));
    return () => {
      live = false;
    };
  }, [plant.id, JSON.stringify(scope)]);

  /** "Show anyway": refetch one file's patch without the 1 MB cap (up to 50 MB). */
  const showAll = (path: string) => {
    setLoaded((m) => ({ ...m, [path]: { ...m[path], loadingFull: true } }));
    garden()
      .diffFile(plant.id, scope, path, { full: true })
      .then((text) => setLoaded((m) => ({ ...m, [path]: { text, full: true } })))
      .catch((e) => setLoaded((m) => ({ ...m, [path]: { error: errorText(e) } })));
  };

  // Fetch each file's patch the first time it is opened.
  useEffect(() => {
    if (!active || loaded[active]) return;
    let live = true;
    const path = active;
    garden()
      .diffFile(plant.id, scope, path)
      .then((text) => live && setLoaded((m) => ({ ...m, [path]: { text } })))
      .catch((e) => live && setLoaded((m) => ({ ...m, [path]: { error: errorText(e) } })));
    return () => {
      live = false;
    };
  }, [active]);

  // j / k: next / previous file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !files?.length || (e.key !== "j" && e.key !== "k")) return;
      e.preventDefault();
      const i = files.findIndex((f) => f.path === active);
      const next = Math.min(files.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)));
      setActive(files[next].path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, active]);

  const file = files?.find((f) => f.path === active);
  const totals = files?.reduce((t, f) => ({ ins: t.ins + f.insertions, del: t.del + f.deletions }), { ins: 0, del: 0 });

  return (
    <Window title={title} sub={<span className="mono">{git}</span>} onClose={onClose} wide className="v2-diff">
      <div className="v2-diff__body">
        <nav className="v2-diff__files" aria-label="Changed files">
          {listError && <div className="v2-err"><p>Couldn't list the changed files.</p><pre>{listError}</pre></div>}
          {!files && !listError && <div className="muted small v2-pad">Reading the changes…</div>}
          {files && files.length === 0 && <div className="muted small v2-pad">No files changed in this view.</div>}
          {files && files.length > 0 && (
            <div className="v2-diff__summary small">
              {plural(files.length, "file")} · <Counts ins={totals!.ins} del={totals!.del} />
            </div>
          )}
          <ul>
            {files?.map((f) => (
              <li key={f.path}>
                <button className={`v2-file ${f.path === active ? "is-on" : ""}`} onClick={() => setActive(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <StatusLetter status={f.status} />
                  <span className="v2-file__name">
                    <span className="v2-file__base">{f.path.split("/").pop()}</span>
                    <span className="v2-file__dir">{f.path.split("/").slice(0, -1).join("/")}</span>
                  </span>
                  {f.status !== "binary" && <Counts ins={f.insertions} del={f.deletions} />}
                  {tags.some((t) => t.path === f.path) && <span className="v2-papertag" title="Has tags" />}
                </button>
              </li>
            ))}
          </ul>
          <TagList tags={tags} plantId={plant.id} onOpen={setActive} />
          <div className="v2-diff__keys muted small">j / k next or previous file · Esc to close</div>
        </nav>

        <section className="v2-diff__main" aria-label={active ?? "Diff"}>
          <div className="v2-diff__bar">
            <span className="v2-diff__path mono" title={active ?? ""}>
              {file?.oldPath ? `${file.oldPath} → ` : ""}
              {active ?? ""}
            </span>
            <span className="small muted v2-diff__tagcount">
              {tags.length > 0 ? `${plural(tags.length, "tag")} tied · ` : "Select lines to tie a tag · "}Tags will be sent with your next message
            </span>
            <div className="v2-seg" role="group" aria-label="Layout">
              <button className={`btn btn--small ${!split ? "is-on" : ""}`} aria-pressed={!split} onClick={() => setSplit(false)}>
                Unified
              </button>
              <button className={`btn btn--small ${split ? "is-on" : ""}`} aria-pressed={split} onClick={() => setSplit(true)}>
                Split
              </button>
            </div>
          </div>
          {file?.status === "binary" ? (
            <div className="muted v2-pad">Binary file: there is no text diff to show.</div>
          ) : active && loaded[active] ? (
            "error" in loaded[active] ? (
              <div className="v2-err v2-pad">
                <p>Couldn't load this file's diff.</p>
                <pre>{(loaded[active] as { error: string }).error}</pre>
              </div>
            ) : (
              <FileDiff
                key={active}
                plantId={plant.id}
                path={active}
                text={(loaded[active] as { text: string }).text}
                full={(loaded[active] as { full?: boolean }).full}
                loadingFull={(loaded[active] as { loadingFull?: boolean }).loadingFull}
                onShowAll={() => showAll(active)}
                split={split}
                tags={tags}
              />
            )
          ) : active ? (
            <div className="muted small v2-pad">Loading the diff…</div>
          ) : null}
        </section>
      </div>
    </Window>
  );
}

function TagList({ tags, plantId, onOpen }: { tags: ReviewTag[]; plantId: string; onOpen(path: string): void }) {
  if (!tags.length) return null;
  return (
    <div className="v2-taglist">
      <h3>Tags ({tags.length})</h3>
      <p className="muted small">Paper tags are review notes. They go with your next message to this plant.</p>
      <ul>
        {tags.map((t) => (
          <li key={t.id}>
            <button className="linkish v2-taglist__where" onClick={() => onOpen(t.path)}>
              {t.path.split("/").pop()}:{t.startLine === t.endLine ? t.startLine : `${t.startLine}–${t.endLine}`}
            </button>
            <span className="v2-taglist__note">{t.note}</span>
            <button className="linkish v2-taglist__x" aria-label="Remove tag" onClick={() => removeTag(plantId, t.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Sel = { block: number; anchor: number; end: number };

function FileDiff({
  plantId,
  path,
  text,
  split,
  tags,
  full,
  loadingFull,
  onShowAll,
}: {
  plantId: string;
  path: string;
  text: string;
  split: boolean;
  tags: ReviewTag[];
  full?: boolean;
  loadingFull?: boolean;
  onShowAll(): void;
}) {
  const truncated = text.endsWith(TRUNCATED);
  // ponytail: renders every line; a 1 MB patch is ~20k rows. Virtualize if that proves slow.
  const blocks = useMemo(() => (parse(truncated ? text.slice(0, -TRUNCATED.length) : text)[0]?.blocks ?? []) as unknown as Block[], [text]);
  const [sel, setSel] = useState<Sel | null>(null);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const fileTags = tags.filter((t) => t.path === path);

  useEffect(() => {
    if (sel) input.current?.focus();
  }, [sel?.block, sel?.anchor]);

  const pick = (e: React.MouseEvent, block: number, line: number) => {
    if (e.shiftKey && sel && sel.block === block) setSel({ ...sel, end: line });
    else setSel({ block, anchor: line, end: line });
  };
  const isSel = (b: number, i: number) => !!sel && sel.block === b && i >= Math.min(sel.anchor, sel.end) && i <= Math.max(sel.anchor, sel.end);
  const tagsOn = (l: Line) => fileTags.filter((t) => tagCovers(t, l));

  const tie = () => {
    if (!sel || !note.trim()) return;
    const t = tagHunk(blocks[sel.block], sel.anchor, sel.end);
    addTag(plantId, { id: crypto.randomUUID(), path, ...t, note: note.trim() });
    setSel(null);
    setNote("");
  };

  const cells = (b: number, i: number | undefined, side?: "old" | "new") => {
    if (i == null) return [<td key="n" className="v2-ln" />, <td key="m" className="v2-mark" />, <td key="s" className="v2-src v2-src--empty" />];
    const l = blocks[b].lines[i];
    const on = tagsOn(l);
    const num = side === "old" ? l.oldNumber : side === "new" ? l.newNumber : undefined;
    return [
      ...(side ? [<td key="n" className="v2-ln">{num}</td>] : [<td key="o" className="v2-ln">{l.oldNumber}</td>, <td key="n" className="v2-ln">{l.newNumber}</td>]),
      <td key="m" className="v2-mark">{on.length > 0 && <span className="v2-papertag" title={on.map((t) => t.note).join("\n")} />}</td>,
      <td key="s" className={`v2-src v2-src--${l.type} ${isSel(b, i) ? "is-sel" : ""}`} onMouseDown={(e) => e.shiftKey && e.preventDefault()} onClick={(e) => pick(e, b, i)}>
        {l.content}
      </td>,
    ];
  };

  return (
    <div className="v2-filediff">
      {truncated && !full && (
        <div className="v2-notice small">
          [truncated] This file's diff is over 1 MB, so only the first 1 MB is shown.{" "}
          <button className="btn btn--small" onClick={onShowAll} disabled={loadingFull}>
            {loadingFull ? "Loading the whole diff…" : "Show anyway"}
          </button>{" "}
          <span className="muted">(up to 50 MB; very large diffs can make this window slow)</span>
        </div>
      )}
      {truncated && full && <div className="v2-notice small">[truncated] Even the full view stops at 50 MB. Open the file in your editor to see the rest.</div>}
      {blocks.length === 0 && <div className="muted small v2-pad">No text changes to show (an empty file, or only its mode changed).</div>}
      <div className="v2-code" role="region" aria-label={`Diff of ${path}`}>
        <table className={split ? "v2-code--split" : ""}>
          {split && (
            <colgroup>
              <col className="v2-col-ln" />
              <col className="v2-col-mark" />
              <col />
              <col className="v2-col-ln" />
              <col className="v2-col-mark" />
              <col />
            </colgroup>
          )}
          {blocks.map((block, b) => (
            <tbody key={b}>
              <tr className="v2-hunk">
                <td colSpan={split ? 6 : 4}>{block.header}</td>
              </tr>
              {split
                ? splitRows(block.lines).map((r, k) => (
                    <tr key={k}>
                      {cells(b, r.left, "old")}
                      {cells(b, r.right, "new")}
                    </tr>
                  ))
                : block.lines.map((_, i) => <tr key={i}>{cells(b, i)}</tr>)}
            </tbody>
          ))}
        </table>
      </div>
      {sel && (
        <form
          className="v2-tiebar"
          onSubmit={(e) => {
            e.preventDefault();
            tie();
          }}
        >
          <span className="v2-papertag" aria-hidden />
          <span className="small">
            Tie a tag to {Math.abs(sel.end - sel.anchor) + 1 === 1 ? "this line" : `${Math.abs(sel.end - sel.anchor) + 1} lines`}
            <span className="muted"> (shift+click to extend)</span>
          </span>
          <input
            ref={input}
            value={note}
            placeholder="Your note for the plant, e.g. “handle the empty case here”"
            onChange={(e) => setNote(e.target.value)}
            // Esc (handled by the window) blurs the field; leaving it empty drops the selection.
            onBlur={() => !note.trim() && setSel(null)}
            aria-label="Tag note"
          />
          <button className="btn btn--primary btn--small" disabled={!note.trim()}>
            Tie tag
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setSel(null)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
