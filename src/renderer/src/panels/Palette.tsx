// Ctrl+K: jump to any plant or bed, search every journal, or run an action, from the keyboard.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { statusLabel } from "../../../shared/garden";
import type { SearchHit } from "../../../shared/types";
import { focus, garden, getState, nextNeedingYou, openSow, setState, setView, useGarden } from "../store";
import { byUrgency } from "./Catalogue";

/** Subsequence match: null if `q` is not a subsequence of `text`, else higher is better. */
export function fuzzy(q: string, text: string): number | null {
  const query = q.toLowerCase().replace(/\s+/g, "");
  if (!query) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of query) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 3;
    if (i === 0 || /[\s/_.\-:]/.test(t[i - 1])) score += 2;
    prev = i;
    from = i + 1;
  }
  if (t.startsWith(q.toLowerCase())) score += 6;
  else if (t.includes(q.toLowerCase())) score += 3;
  return score - t.length * 0.02;
}

interface Item {
  key: string;
  group: "Actions" | "Plants" | "Beds" | "In journals";
  title: string;
  sub?: string;
  score: number;
  run(): void;
}

const MAX = 40;

export function Palette() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const plants = useGarden((s) => s.plants);
  const beds = useGarden((s) => s.beds);
  const needsYouIds = useGarden((s) => s.needsYouIds);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  // Full-text search over journals, debounced; stale answers are dropped.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      garden()
        .search(query)
        .then((h) => live && setHits(h))
        .catch(() => live && setHits([]))
        .finally(() => live && setSearching(false));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const close = () => setState({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const items = useMemo(() => {
    const query = q.trim();
    const sel = getState().selection;
    const selBed = sel?.kind === "bed" ? sel.id : sel?.kind === "plant" ? plants[sel.id]?.bedId : undefined;
    const bedName = (id: string) => beds.find((b) => b.id === id)?.name ?? "?";
    const actions: Omit<Item, "score">[] = [
      { key: "a:next", group: "Actions", title: "Next plant needing me", sub: needsYouIds.length ? `${needsYouIds.length} waiting · n` : "none right now · n", run: run(() => nextNeedingYou(1)) },
      { key: "a:cat", group: "Actions", title: "Toggle Seed Catalogue", sub: "\\", run: run(() => setState((s) => ({ catalogueOpen: !s.catalogueOpen }))) },
      { key: "a:almanac", group: "Actions", title: "Open Almanac", sub: "usage and cost", run: run(() => setView({ almanac: true, settings: false })) },
      { key: "a:settings", group: "Actions", title: "Open Settings", run: run(() => setView({ settings: true, almanac: false })) },
    ];
    const sowFor = (id: string): Omit<Item, "score"> => ({ key: `a:sow:${id}`, group: "Actions", title: `Sow in ${bedName(id)}…`, sub: "s", run: run(() => openSow(id)) });

    if (!query) {
      const out: Item[] = [];
      if (selBed) out.push({ ...sowFor(selBed), score: 0 });
      else if (beds.length) out.push({ key: "a:sow", group: "Actions", title: "Sow an agent…", sub: "s", score: 0, run: run(() => openSow("")) });
      for (const a of actions) out.push({ ...a, score: 0 });
      const needy = needsYouIds.slice(0, 8).map((id) => plants[id]);
      const recent = Object.values(plants)
        .filter((p) => !needsYouIds.includes(p.id))
        .sort(byUrgency)
        .slice(0, 8 - Math.min(8, needy.length) + 4);
      for (const p of [...needy, ...recent]) out.push({ key: `p:${p.id}`, group: "Plants", title: p.name, sub: `${bedName(p.bedId)} · ${statusLabel(p)}`, score: 0, run: run(() => focus("plant", p.id)) });
      return out;
    }

    const scored: Item[] = [];
    for (const a of actions) {
      const s = fuzzy(query, a.title);
      if (s !== null) scored.push({ ...a, score: s + 1 });
    }
    for (const b of beds) {
      const s = fuzzy(query, b.name);
      if (s !== null) scored.push({ key: `b:${b.id}`, group: "Beds", title: b.name, sub: b.path, score: s + 0.5, run: run(() => focus("bed", b.id)) });
      const sow = fuzzy(query, `sow in ${b.name}`);
      if (sow !== null && /^s/i.test(query)) scored.push({ ...sowFor(b.id), score: sow });
    }
    for (const p of Object.values(plants)) {
      const byName = fuzzy(query, p.name);
      const byBranch = p.branch ? fuzzy(query, p.branch) : null;
      const s = Math.max(byName ?? -Infinity, byBranch === null ? -Infinity : byBranch - 1);
      if (s === -Infinity) continue;
      scored.push({ key: `p:${p.id}`, group: "Plants", title: p.name, sub: `${bedName(p.bedId)}${p.branch ? ` · ${p.branch}` : ""} · ${statusLabel(p)}`, score: s, run: run(() => focus("plant", p.id)) });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = scored.slice(0, MAX);
    for (const [i, h] of hits.entries())
      out.push({ key: `h:${h.plantId}:${h.entryId ?? i}`, group: "In journals", title: h.title, sub: h.snippet, score: 0, run: run(() => focus("plant", h.plantId)) });
    return out;
    // `run` and `close` only call setState; they don't need to be deps.
  }, [q, hits, plants, beds, needsYouIds]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) setActive((a) => Math.min(items.length - 1, a + 1));
    else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") items[active]?.run();
    else return;
    e.preventDefault();
  };

  let lastGroup = "";
  return (
    <div className="modal modal--top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          className="palette__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Jump to a plant or bed, search journals, or run an action…"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `pal-${active}` : undefined}
        />
        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key} role="presentation">
                {head && (
                  <div className="palette__group" role="presentation">
                    {head}
                  </div>
                )}
                <div
                  id={`pal-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`palette__item ${i === active ? "is-active" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={it.run}
                >
                  <span className="palette__title">{it.title}</span>
                  {it.sub && <span className="palette__sub">{it.sub}</span>}
                </div>
              </div>
            );
          })}
          {!items.length && <div className="palette__empty muted small">{searching ? "Searching journals…" : "Nothing matches."}</div>}
          {items.length > 0 && searching && <div className="palette__empty muted small">Searching journals…</div>}
        </div>
        <div className="palette__foot muted small">↑↓ move · Enter jump · Esc close</div>
      </div>
    </div>
  );
}
