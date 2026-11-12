// The Seed Catalogue (PLAN 2d): every plant in one dense, keyboard-driven list, grouped by bed.
// It is the accessible list of all plants. Rows are a fixed height so a few lines of virtualization
// keep it light at thousands of plants.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { bedMood, groundPlants, MOOD_LABEL, statusLabel, urgency, type BedMood } from "../../../shared/garden";
import type { Bed, Plant } from "../../../shared/types";
import { focus, isGrowing, isHarvest, needsYou, setState, useGarden } from "../store";

export const ROW = 30;
const OVERSCAN = 6;

export type CatalogueFilter = "all" | "needs" | "growing" | "harvest" | "potted" | "catalogue" | "volunteers";
const FILTERS: { id: CatalogueFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every plant" },
  { id: "needs", label: "Needs you", title: "Waiting on you or wilted" },
  { id: "growing", label: "Growing", title: "Working on a turn" },
  { id: "harvest", label: "Ready", title: "Ready to harvest: a finished turn you haven't read" },
  { id: "potted", label: "Potted", title: "Growing in its own worktree" },
  { id: "catalogue", label: "Catalogue only", title: "Not drawn in the ground: older plants that live only in this list" },
  { id: "volunteers", label: "Volunteers", title: "Claude Code sessions from a terminal" },
];

type Row =
  | { kind: "bed"; key: string; bed: Bed; mood: BedMood; total: number; shown: number; needs: number; growing: number; collapsed: boolean }
  | { kind: "plant"; key: string; plant: Plant };

export function shortStatus(p: Plant): { label: string; cls: string } {
  if (p.status === "waiting") return { label: p.ask?.kind === "plan" ? "Plan" : p.ask?.kind === "question" ? "Question" : "Permission", cls: "waiting" };
  if (p.status === "error") return { label: "Wilted", cls: "error" };
  if (p.queued) return { label: "Queued", cls: "queued" };
  if (isGrowing(p)) return { label: "Growing", cls: "growing" };
  if (p.unread) return { label: "Ready", cls: "harvest" };
  if (p.archivedAt) return { label: p.pr?.state === "merged" ? "Harvested" : "Stored", cls: "stored" };
  if (p.turns === 0) return { label: "Seed", cls: "seed" };
  return { label: "Resting", cls: "idle" };
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 7)}w`;
}

/** Most urgent first, then most recently active. */
export const byUrgency = (a: Plant, b: Plant) => urgency(a) - urgency(b) || b.updatedAt - a.updatedAt;

function matches(p: Plant, f: CatalogueFilter, catalogueOnly: Set<string> | null): boolean {
  switch (f) {
    case "all":
      return true;
    case "needs":
      return needsYou(p);
    case "growing":
      return isGrowing(p) || !!p.queued;
    case "harvest":
      return isHarvest(p);
    case "potted":
      return p.plot === "pot";
    case "catalogue":
      return !!catalogueOnly?.has(p.id);
    case "volunteers":
      return p.origin === "volunteer";
  }
}

export function Catalogue() {
  const beds = useGarden((s) => s.beds);
  const plants = useGarden((s) => s.plants);
  const byBed = useGarden((s) => s.byBed);
  const selected = useGarden((s) => (s.selection?.kind === "plant" ? s.selection.id : null));
  const [filter, setFilter] = useState<CatalogueFilter>("all");
  const [text, setText] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    const out: Row[] = [];
    const groups: { bed: Bed; all: Plant[]; shown: Plant[] }[] = [];
    for (const bed of beds) {
      const all: Plant[] = [];
      for (const id of byBed[bed.id] ?? []) if (plants[id]) all.push(plants[id]);
      const cat = filter === "catalogue" ? new Set(groundPlants(all, now).catalogue.map((p) => p.id)) : null;
      const bedHit = q && bed.name.toLowerCase().includes(q);
      const shown = all.filter((p) => matches(p, filter, cat) && (!q || bedHit || p.name.toLowerCase().includes(q) || !!p.branch?.toLowerCase().includes(q)));
      if (!shown.length && (filter !== "all" || q)) continue;
      shown.sort(byUrgency);
      groups.push({ bed, all, shown });
    }
    groups.sort((a, b) => {
      const ua = a.shown.length ? urgency(a.shown[0]) : 9;
      const ub = b.shown.length ? urgency(b.shown[0]) : 9;
      return ua - ub || (b.shown[0]?.updatedAt ?? 0) - (a.shown[0]?.updatedAt ?? 0);
    });
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.bed.id);
      out.push({
        kind: "bed",
        key: `bed:${g.bed.id}`,
        bed: g.bed,
        mood: bedMood(g.all),
        total: g.all.length,
        shown: g.shown.length,
        needs: g.all.filter(needsYou).length,
        growing: g.all.filter(isGrowing).length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) for (const p of g.shown) out.push({ kind: "plant", key: p.id, plant: p });
    }
    return out;
  }, [beds, plants, byBed, filter, text, collapsed, now]);

  const active = Math.max(
    0,
    rows.findIndex((r) => r.key === (activeKey ?? selected)),
  );

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the active row in view.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !activeKey) return;
    const top = active * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [active, activeKey]);

  const toggle = (bedId: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(bedId)) next.delete(bedId);
      else next.add(bedId);
      return next;
    });

  const open = (r: Row | undefined) => {
    if (!r) return;
    setActiveKey(r.key);
    if (r.kind === "bed") toggle(r.bed.id);
    else focus("plant", r.plant.id);
  };

  const move = (d: number) => {
    if (!rows.length) return;
    const i = Math.min(rows.length - 1, Math.max(0, active + d));
    setActiveKey(rows[i].key);
  };

  // j / k work anywhere in the app while the catalogue is open (not while typing).
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        list.current?.focus();
        moveRef.current(e.key === "j" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onListKey = (e: ReactKeyboardEvent) => {
    const r = rows[active];
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(Math.floor(view.height / ROW));
    else if (e.key === "PageUp") move(-Math.floor(view.height / ROW));
    else if (e.key === "Home") move(-rows.length);
    else if (e.key === "End") move(rows.length);
    else if (e.key === "Enter" || e.key === " ") open(r);
    else if (e.key === "ArrowLeft" && r?.kind === "bed" && !r.collapsed) toggle(r.bed.id);
    else if (e.key === "ArrowRight" && r?.kind === "bed" && r.collapsed) toggle(r.bed.id);
    else return;
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const optId = (r: Row) => `cat-${r.key.replace(/[^\w-]/g, "_")}`;
  const plantCount = rows.reduce((n, r) => n + (r.kind === "bed" ? r.shown : 0), 0);

  return (
    <aside className="catalogue" aria-label="Seed Catalogue">
      <header className="catalogue__head">
        <h2>Seed Catalogue</h2>
        <span className="muted small">{plantCount} plants</span>
        <button className="icon-btn" aria-label="Close the Seed Catalogue" onClick={() => setState({ catalogueOpen: false })}>
          ×
        </button>
      </header>
      <div className="catalogue__tools">
        <input className="catalogue__search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name, branch or bed" aria-label="Filter plants" />
        <div className="catalogue__filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip chip--filter ${filter === f.id ? "is-on" : ""}`} aria-pressed={filter === f.id} title={f.title} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="catalogue__cols" aria-hidden>
        <span>Status</span>
        <span>Name</span>
        <span>Plot</span>
        <span className="num">Turns</span>
        <span className="num">Cost</span>
        <span className="num">Last</span>
      </div>
      <div
        ref={list}
        className="catalogue__list"
        role="listbox"
        tabIndex={0}
        aria-label="Plants, grouped by bed. j and k move, Enter opens."
        aria-activedescendant={rows[active] ? optId(rows[active]) : undefined}
        onKeyDown={onListKey}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        {rows.length === 0 && <div className="catalogue__empty muted small">No plants match.</div>}
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const style = { top: i * ROW, height: ROW };
            const on = i === active;
            if (r.kind === "bed")
              return (
                <div
                  key={r.key}
                  id={optId(r)}
                  role="option"
                  aria-selected={on}
                  aria-setsize={rows.length}
                  aria-posinset={i + 1}
                  aria-label={`${r.bed.name} bed, ${MOOD_LABEL[r.mood]}, ${r.total} plants${r.collapsed ? ", collapsed" : ""}`}
                  className={`crow crow--bed ${on ? "is-active" : ""}`}
                  style={style}
                  onClick={() => open(r)}
                >
                  <span className="crow__caret" aria-hidden>
                    {r.collapsed ? "▸" : "▾"}
                  </span>
                  <span className="crow__bed">{r.bed.name}</span>
                  <span className={`mood mood--${r.mood}`}>{MOOD_LABEL[r.mood]}</span>
                  <span className="crow__counts muted">
                    {r.shown !== r.total ? `${r.shown} of ${r.total}` : r.total}
                    {r.needs ? ` · ${r.needs} need you` : ""}
                    {r.growing ? ` · ${r.growing} growing` : ""}
                  </span>
                </div>
              );
            const p = r.plant;
            const st = shortStatus(p);
            const plot = p.origin === "volunteer" ? "Terminal" : p.plot === "pot" ? `Potted · ${p.branch ?? "?"}` : "In the bed";
            return (
              <div
                key={r.key}
                id={optId(r)}
                role="option"
                aria-selected={on}
                aria-setsize={rows.length}
                aria-posinset={i + 1}
                aria-label={`${p.name}: ${statusLabel(p)}. ${plot}. ${p.turns} turns, $${p.costUsd.toFixed(2)}, active ${ago(p.updatedAt, now)} ago`}
                className={`crow ${on ? "is-active" : ""} ${p.id === selected ? "is-selected" : ""}`}
                style={style}
                onClick={() => open(r)}
                title={statusLabel(p)}
              >
                <span className={`crow__status st--${st.cls}`}>
                  <span className="crow__dot" />
                  {st.label}
                </span>
                <span className="crow__name">{p.name}</span>
                <span className="crow__plot" title={p.worktreePath ?? plot}>
                  {plot}
                </span>
                <span className="num">{p.turns}</span>
                <span className="num">{p.costUsd ? `$${p.costUsd.toFixed(2)}` : "–"}</span>
                <span className="num muted">{ago(p.updatedAt, now)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
