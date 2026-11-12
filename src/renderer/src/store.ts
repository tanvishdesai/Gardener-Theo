// Renderer-side mirror of the garden, fed by snapshot + events from the main process (or the demo).
// Events are applied incrementally (copy-on-write per batch): a "plant:patch" replaces one plant object,
// a "batch" is one state change and one notify, and the indexes (byBed, needsYouIds, counts) are kept up
// to date per plant instead of re-filtering every plant. Components select narrow slices.
import { useSyncExternalStore } from "react";
import type { Chore } from "../../shared/garden";
import { urgency } from "../../shared/garden";
import { Announcer, plantChange, plantState, sentence, speak, type Kind } from "./a11y";
import type { Bed, Entry, GardenApi, GardenEvent, Plant, PoolInfo, ReviewTag, Ring, Settings, SoilReport, Weather } from "../../shared/types";

export type Selection = { kind: "plant" | "bed"; id: string } | null;
export type PlantTab = "journal" | "rings" | "harvest";

export interface JournalState {
  /** Oldest first. */
  entries: Entry[];
  /** Older entries exist before entries[0]. */
  hasMore: boolean;
  loading: boolean;
}

export interface Counts {
  /** Waiting on you or wilted. */
  needsYou: number;
  /** Thinking or working. */
  growing: number;
  /** Unread finished turn, not needing you. */
  harvest: number;
  idle: number;
  thinking: number;
  working: number;
  waiting: number;
  error: number;
  live: number;
  queued: number;
  total: number;
}

export interface GardenState {
  ready: boolean;
  demo: boolean;
  beds: Bed[];
  plants: Record<string, Plant>;
  /** Plant ids per bed, creation order, every plant (ground and catalogue). */
  byBed: Record<string, string[]>;
  soil: Record<string, SoilReport>;
  selection: Selection;
  weather?: Weather;
  pool: PoolInfo;
  settings: Settings;
  /** Review tags waiting to be sent with the next message. */
  tags: Record<string, ReviewTag[]>;
  /** The open journal plus the last 2 viewed (LRU). */
  journals: Record<string, JournalState>;
  /** Rings, once loaded with loadRings(); kept current by "ring" events. */
  rings: Record<string, Ring[]>;
  /** Ask the canvas to move the camera. A new nonce means a new request. */
  focusRequest: { kind: "plant" | "bed"; id: string; nonce: number } | null;
  catalogueOpen: boolean;
  paletteOpen: boolean;
  view: { almanac: boolean; settings: boolean; firstRun: boolean };
  plantTab: PlantTab;
  /** Bed id the sow dialog is open for ("" = choose), or null when closed. */
  sowing: string | null;
  /** A chore to prefill the sow dialog with. */
  sowPreset: Chore | null;
  error: string | null;
  /** Plants waiting on you or wilted: most urgent first, then oldest wait first. */
  needsYouIds: string[];
  /** When each needy plant started waiting (internal, for needsYouIds order). */
  needSince: Record<string, number>;
  counts: Counts;
}

const ZERO_COUNTS: Counts = { needsYou: 0, growing: 0, harvest: 0, idle: 0, thinking: 0, working: 0, waiting: 0, error: 0, live: 0, queued: 0, total: 0 };
const DEFAULT_POOL: PoolInfo = { live: 0, canAdmit: 0, ceiling: 0, freeBytes: 0, totalBytes: 0, perProcessBytes: 0, queued: 0 };
export const DEFAULT_SETTINGS: Settings = {
  idleMinutes: 30,
  hookInstalled: false,
  hookPort: 0,
  onboarded: true,
  wakeOnRedStake: false,
  textSize: 100,
  theme: "system",
  motion: "system",
  announce: true,
};

export function initialState(): GardenState {
  return {
    ready: false,
    demo: false,
    beds: [],
    plants: {},
    byBed: {},
    soil: {},
    selection: null,
    pool: DEFAULT_POOL,
    settings: DEFAULT_SETTINGS,
    tags: {},
    journals: {},
    rings: {},
    focusRequest: null,
    catalogueOpen: false,
    paletteOpen: false,
    view: { almanac: false, settings: false, firstRun: false },
    plantTab: "journal",
    sowing: null,
    sowPreset: null,
    error: null,
    needsYouIds: [],
    needSince: {},
    counts: ZERO_COUNTS,
  };
}

let state: GardenState = initialState();
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<GardenState> | ((s: GardenState) => Partial<GardenState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Subscribe to a slice. The selector must return a stable value (a field, a primitive), never a new object. */
export function useGarden<T>(selector: (s: GardenState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---------- plant predicates ----------

export function needsYou(p: Plant) {
  return p.status === "waiting" || p.status === "error";
}

export function isGrowing(p: Plant) {
  return p.status === "thinking" || p.status === "working";
}

export function isHarvest(p: Plant) {
  return p.unread && !needsYou(p);
}

/** A bed's plants in creation order (uses the byBed index). */
export function plantsInBed(plants: Record<string, Plant>, bedId: string): Plant[] {
  const ids = state.byBed[bedId] ?? [];
  const out: Plant[] = [];
  for (const id of ids) if (plants[id]) out.push(plants[id]);
  return out;
}

// ---------- the reducer (pure; copy-on-write within one batch) ----------

type RecKey = "plants" | "byBed" | "soil" | "journals" | "needSince" | "counts" | "tags" | "rings";

class Tx {
  s: GardenState;
  private own = new Set<string>();
  constructor(s: GardenState) {
    this.s = { ...s };
  }
  rec<K extends RecKey>(k: K): GardenState[K] {
    if (!this.own.has(k)) {
      this.s[k] = { ...this.s[k] };
      this.own.add(k);
    }
    return this.s[k];
  }
  needs(): string[] {
    if (!this.own.has("needsYouIds")) {
      this.s.needsYouIds = [...this.s.needsYouIds];
      this.own.add("needsYouIds");
    }
    return this.s.needsYouIds;
  }
  beds(): Bed[] {
    if (!this.own.has("beds")) {
      this.s.beds = [...this.s.beds];
      this.own.add("beds");
    }
    return this.s.beds;
  }
  bedList(bedId: string): string[] {
    const byBed = this.rec("byBed");
    const k = `bed:${bedId}`;
    if (!this.own.has(k)) {
      byBed[bedId] = [...(byBed[bedId] ?? [])];
      this.own.add(k);
    }
    return byBed[bedId];
  }
  /** An owned copy of one journal's state and entries array. */
  journal(plantId: string): JournalState {
    const journals = this.rec("journals");
    const k = `j:${plantId}`;
    if (!this.own.has(k)) {
      const cur = journals[plantId];
      journals[plantId] = { ...cur, entries: [...cur.entries] };
      this.own.add(k);
    }
    return journals[plantId];
  }
}

function countKeys(p: Plant): (keyof Counts)[] {
  const keys: (keyof Counts)[] = ["total", p.status];
  if (needsYou(p)) keys.push("needsYou");
  if (isGrowing(p)) keys.push("growing");
  if (isHarvest(p)) keys.push("harvest");
  if (p.live) keys.push("live");
  if (p.queued) keys.push("queued");
  return keys;
}

function needCmp(s: GardenState, a: string, b: string): number {
  return urgency(s.plants[a]) - urgency(s.plants[b]) || (s.needSince[a] ?? 0) - (s.needSince[b] ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Replace (or remove, with undefined) one plant and update every index for it. */
function setPlant(tx: Tx, id: string, next: Plant | undefined) {
  const prev = tx.s.plants[id];
  if (prev === next) return;
  const plants = tx.rec("plants");
  if (next) plants[id] = next;
  else delete plants[id];

  if (!prev && next) tx.bedList(next.bedId).push(id);
  else if (prev && !next) removeFrom(tx.bedList(prev.bedId), id);
  else if (prev && next && prev.bedId !== next.bedId) {
    removeFrom(tx.bedList(prev.bedId), id);
    tx.bedList(next.bedId).push(id);
  }

  const before = prev ? countKeys(prev) : [];
  const after = next ? countKeys(next) : [];
  if (before.length !== after.length || before.some((k, i) => k !== after[i])) {
    const c = tx.rec("counts");
    for (const k of before) c[k]--;
    for (const k of after) c[k]++;
  }

  const wasNeed = !!prev && needsYou(prev);
  const isNeed = !!next && needsYou(next);
  if (!wasNeed && !isNeed) return;
  if (wasNeed && isNeed && urgency(prev!) === urgency(next!)) return;
  const ids = tx.needs();
  const since = tx.rec("needSince");
  if (wasNeed) removeFrom(ids, id);
  if (!isNeed) {
    delete since[id];
    return;
  }
  if (!wasNeed) since[id] = next!.ask?.createdAt ?? next!.updatedAt;
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (needCmp(tx.s, ids[mid], id) < 0) lo = mid + 1;
    else hi = mid;
  }
  ids.splice(lo, 0, id);
}

function removeFrom(list: string[], id: string) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

function mergePatch(p: Plant, patch: Partial<Plant>): Plant {
  const next = { ...p } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) next[k] = v === null ? undefined : v;
  return next as unknown as Plant;
}

function step(tx: Tx, e: GardenEvent) {
  const s = tx.s;
  switch (e.type) {
    case "batch":
      for (const inner of e.events) step(tx, inner);
      return;
    case "bed": {
      const beds = tx.beds();
      const i = beds.findIndex((b) => b.id === e.bed.id);
      if (i >= 0) beds[i] = e.bed;
      else beds.push(e.bed);
      if (!s.byBed[e.bed.id]) tx.rec("byBed")[e.bed.id] = [];
      return;
    }
    case "bed:removed": {
      const beds = tx.beds();
      const i = beds.findIndex((b) => b.id === e.id);
      if (i >= 0) beds.splice(i, 1);
      for (const id of [...(s.byBed[e.id] ?? [])]) setPlant(tx, id, undefined);
      delete tx.rec("byBed")[e.id];
      delete tx.rec("soil")[e.id];
      if (s.selection?.kind === "bed" && s.selection.id === e.id) s.selection = null;
      return;
    }
    case "plant":
      setPlant(tx, e.plant.id, e.plant);
      return;
    case "plant:patch": {
      const prev = s.plants[e.id];
      if (prev) setPlant(tx, e.id, mergePatch(prev, e.patch));
      return;
    }
    case "plant:removed":
      setPlant(tx, e.id, undefined);
      if (s.tags[e.id]) delete tx.rec("tags")[e.id];
      if (s.journals[e.id]) delete tx.rec("journals")[e.id];
      if (s.rings[e.id]) delete tx.rec("rings")[e.id];
      if (s.selection?.kind === "plant" && s.selection.id === e.id) s.selection = null;
      return;
    case "soil":
      tx.rec("soil")[e.bedId] = e.report;
      return;
    case "entry": {
      const pid = e.entry.plantId;
      // Only the open journal streams; others are stale caches until reopened.
      if (!s.journals[pid] || s.selection?.kind !== "plant" || s.selection.id !== pid) return;
      const j = tx.journal(pid);
      let i = j.entries.length - 1;
      while (i >= 0 && j.entries[i].id !== e.entry.id) i--;
      if (i >= 0) j.entries[i] = e.entry.seq === undefined ? { ...e.entry, seq: j.entries[i].seq } : e.entry;
      else j.entries.push(e.entry);
      return;
    }
    case "ring": {
      const list = s.rings[e.ring.plantId];
      if (!list) return;
      const next = list.filter((r) => r.n !== e.ring.n);
      next.push(e.ring);
      next.sort((a, b) => a.n - b.n);
      tx.rec("rings")[e.ring.plantId] = next;
      return;
    }
    case "pool":
      s.pool = e.pool;
      return;
    case "weather":
      s.weather = e.weather;
      return;
    case "settings":
      s.settings = e.settings;
      return;
    case "focus":
      return; // a side effect, handled in dispatch()
  }
}

/** Apply events in order and return the next state. Pure: `s` is never mutated. */
export function reduce(s: GardenState, events: GardenEvent[]): GardenState {
  const tx = new Tx(s);
  for (const e of events) step(tx, e);
  return tx.s;
}

function focusIds(e: GardenEvent, out: string[]) {
  if (e.type === "focus") out.push(e.plantId);
  else if (e.type === "batch") for (const inner of e.events) focusIds(inner, out);
}

function plantIds(e: GardenEvent, out: Set<string>) {
  if (e.type === "plant") out.add(e.plant.id);
  else if (e.type === "plant:patch") out.add(e.id);
  else if (e.type === "batch") for (const inner of e.events) plantIds(inner, out);
}

const bedName = (s: GardenState, bedId: string) => s.beds.find((b) => b.id === bedId)?.name ?? "the garden";

// Screen-reader announcements: only for plants this event touched, never a scan of the whole garden.
const announcer = new Announcer((changes) => {
  if (!state.settings.announce) return;
  const items: { kind: Kind; plant: Plant; bed: string }[] = [];
  for (const [id, kind] of changes) {
    const plant = state.plants[id];
    // Already handled (answered, read) before we got to say it: stay quiet.
    if (plant && plantState(plant) === kind) items.push({ kind, plant, bed: bedName(state, plant.bedId) });
  }
  speak(sentence(items));
});

function dispatch(e: GardenEvent) {
  const prevSel = state.selection;
  const prev = state;
  setState(reduce(state, [e]));
  if (prev.ready && state.settings.announce) {
    const ids = new Set<string>();
    plantIds(e, ids);
    for (const id of ids) {
      const kind = plantChange(prev.plants[id], state.plants[id]);
      if (kind) announcer.push(id, kind);
    }
  }
  // A removed plant or bed may have dropped the selection: stop its journal stream.
  if (prevSel?.kind === "plant" && state.selection === null) void api.closeJournal(prevSel.id).catch(() => {});
  const focuses: string[] = [];
  focusIds(e, focuses);
  if (focuses.length) focus("plant", focuses[focuses.length - 1]);
}

// ---------- connection ----------

let api: GardenApi;

export async function connect(bridge: GardenApi, demo: boolean) {
  api = bridge;
  bridge.onEvent(dispatch);
  const snap = await bridge.snapshot();
  const settings = { ...DEFAULT_SETTINGS, ...snap.settings };
  const base: GardenState = {
    ...state,
    ready: true,
    demo: demo || !!snap.demo,
    beds: snap.beds,
    byBed: Object.fromEntries(snap.beds.map((b) => [b.id, []])),
    soil: snap.soil,
    pool: snap.pool ?? DEFAULT_POOL,
    weather: snap.weather,
    settings,
    plants: {},
    needsYouIds: [],
    needSince: {},
    counts: ZERO_COUNTS,
    view: { ...state.view, firstRun: !settings.onboarded },
  };
  const plants = [...snap.plants].sort((a, b) => a.createdAt - b.createdAt);
  setState(reduce(base, plants.map((plant) => ({ type: "plant", plant }) as GardenEvent)));
}

export function garden(): GardenApi {
  return api;
}

/** Run an api call and surface failures in the UI instead of swallowing them. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
    setState({ error: msg });
    return undefined;
  }
}

// ---------- selection, focus, navigation ----------

export function select(sel: Selection) {
  const prevId = state.selection?.kind === "plant" ? state.selection.id : null;
  const nextId = sel?.kind === "plant" ? sel.id : null;
  setState({ selection: sel });
  if (prevId && prevId !== nextId) void api.closeJournal(prevId).catch(() => {});
  if (nextId && nextId !== prevId) {
    void openJournal(nextId);
    if (state.plants[nextId]?.unread) void api.markRead(nextId);
  }
}

/** Select and ask the canvas to bring it into view. */
export function focus(kind: "plant" | "bed", id: string) {
  select({ kind, id });
  setState((s) => ({ focusRequest: { kind, id, nonce: (s.focusRequest?.nonce ?? 0) + 1 } }));
}

/** n / N: the next (or previous) plant needing you, most urgent and oldest wait first. */
export function nextNeedingYou(dir: 1 | -1 = 1) {
  const ids = state.needsYouIds;
  if (!ids.length) return;
  const cur = state.selection?.kind === "plant" ? ids.indexOf(state.selection.id) : -1;
  const i = cur < 0 ? (dir > 0 ? 0 : ids.length - 1) : (cur + dir + ids.length) % ids.length;
  focus("plant", ids[i]);
}

/** [ / ]: the previous or next bed. */
export function nextBed(dir: 1 | -1) {
  const beds = state.beds;
  if (!beds.length) return;
  const sel = state.selection;
  const curBed = sel?.kind === "bed" ? sel.id : sel?.kind === "plant" ? state.plants[sel.id]?.bedId : undefined;
  const cur = beds.findIndex((b) => b.id === curBed);
  const i = cur < 0 ? (dir > 0 ? 0 : beds.length - 1) : (cur + dir + beds.length) % beds.length;
  focus("bed", beds[i].id);
}

export function openSow(bedId = "", preset: Chore | null = null) {
  if (state.beds.length) setState({ sowing: bedId, sowPreset: preset, paletteOpen: false });
}

export function setView(patch: Partial<GardenState["view"]>) {
  setState((s) => ({ view: { ...s.view, ...patch } }));
}

// ---------- journals ----------

const JOURNALS_KEPT = 3; // the open one + last 2
let lru: string[] = [];

function touchJournal(id: string): Record<string, JournalState> | undefined {
  lru = [...lru.filter((x) => x !== id), id];
  if (lru.length <= JOURNALS_KEPT) return undefined;
  const evict = lru.slice(0, lru.length - JOURNALS_KEPT);
  lru = lru.slice(-JOURNALS_KEPT);
  const journals = { ...state.journals };
  for (const x of evict) delete journals[x];
  return journals;
}

/** Fold a fresh newest page into what we had cached. Older cached pages stay if they still join up. */
export function mergeFresh(cached: JournalState | undefined, page: { entries: Entry[]; hasMore: boolean }): JournalState {
  const fresh = page.entries;
  if (!cached || !cached.entries.length) return { entries: fresh, hasMore: page.hasMore, loading: false };
  if (!fresh.length) return { ...cached, loading: false };
  const first = fresh[0].seq;
  const last = fresh[fresh.length - 1].seq;
  const ids = new Set(fresh.map((e) => e.id));
  const older = first === undefined ? [] : cached.entries.filter((e) => e.seq !== undefined && e.seq < first);
  const joins = older.length > 0 && older[older.length - 1].seq! >= first! - 1;
  // Live entries that arrived while the page was in flight.
  const newer = cached.entries.filter((e) => !ids.has(e.id) && (e.seq === undefined || last === undefined || e.seq > last));
  return { entries: [...(joins ? older : []), ...fresh, ...newer], hasMore: joins ? cached.hasMore : page.hasMore, loading: false };
}

async function openJournal(id: string) {
  const journals = touchJournal(id) ?? state.journals;
  const cur = journals[id];
  setState({ journals: { ...journals, [id]: { entries: cur?.entries ?? [], hasMore: cur?.hasMore ?? false, loading: true } } });
  const page = await attempt(() => api.openJournal(id, 200));
  setState((s) => {
    const now = s.journals[id];
    if (!now && !lru.includes(id)) return {};
    return { journals: { ...s.journals, [id]: page ? mergeFresh(now, page) : { ...(now ?? { entries: [], hasMore: false }), loading: false } } };
  });
}

/** Load the page before the oldest loaded entry. */
export async function loadOlder(plantId: string) {
  const j = state.journals[plantId];
  const first = j?.entries[0]?.seq;
  if (!j || j.loading || !j.hasMore || first === undefined) return;
  setState((s) => ({ journals: { ...s.journals, [plantId]: { ...j, loading: true } } }));
  const page = await attempt(() => api.journalPage(plantId, first, 200));
  setState((s) => {
    const cur = s.journals[plantId];
    if (!cur) return {};
    if (!page) return { journals: { ...s.journals, [plantId]: { ...cur, loading: false } } };
    const ids = new Set(cur.entries.map((e) => e.id));
    return { journals: { ...s.journals, [plantId]: { entries: [...page.entries.filter((e) => !ids.has(e.id)), ...cur.entries], hasMore: page.hasMore, loading: false } } };
  });
}

/** Fetch a plant's rings once; "ring" events keep them current afterwards. */
export async function loadRings(plantId: string) {
  const rings = await attempt(() => api.rings(plantId));
  if (rings) setState((s) => ({ rings: { ...s.rings, [plantId]: [...rings].sort((a, b) => a.n - b.n) } }));
}

// ---------- review tags ----------

const sameLines = (a: Pick<ReviewTag, "path" | "startLine" | "endLine">, b: Pick<ReviewTag, "path" | "startLine" | "endLine">) =>
  a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;

let tagN = 0;

export function addTag(plantId: string, tag: Omit<ReviewTag, "id"> & { id?: string }) {
  const full: ReviewTag = { ...tag, id: tag.id ?? `tag-${Date.now().toString(36)}-${(tagN++).toString(36)}` };
  setState((s) => ({ tags: { ...s.tags, [plantId]: [...(s.tags[plantId] ?? []), full] } }));
  return full;
}

export function removeTag(plantId: string, tagId: string) {
  setState((s) => ({ tags: { ...s.tags, [plantId]: (s.tags[plantId] ?? []).filter((t) => t.id !== tagId) } }));
}

/** Tag these lines, or untag them if a tag on exactly these lines exists. */
export function toggleTag(plantId: string, tag: Omit<ReviewTag, "id"> & { id?: string }) {
  const existing = (state.tags[plantId] ?? []).find((t) => sameLines(t, tag));
  if (existing) removeTag(plantId, existing.id);
  else addTag(plantId, tag);
}

export function clearTags(plantId: string) {
  setState((s) => {
    const tags = { ...s.tags };
    delete tags[plantId];
    return { tags };
  });
}

const indent = (text: string, pad: string) =>
  text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

/** Review tags as structured context for the agent's next message. */
export function formatTags(tags: ReviewTag[]): string {
  if (!tags.length) return "";
  const items = tags.map((t) => {
    const range = t.startLine === t.endLine ? `L${t.startLine}` : `L${t.startLine}-L${t.endLine}`;
    const lines = [`- file: ${t.path}`, `  range: ${range}`];
    if (t.note.trim()) lines.push(t.note.includes("\n") ? `  note: |\n${indent(t.note.trim(), "    ")}` : `  note: ${t.note.trim()}`);
    if (t.hunk.trim()) lines.push(`  diff:\n${indent(t.hunk, "    ")}`);
    return lines.join("\n");
  });
  return `Review tags:\n${items.join("\n")}`;
}

/** Serialize this plant's tags for sending and clear them. "" when there are none. */
export function takeTagsForSend(plantId: string): string {
  const text = formatTags(state.tags[plantId] ?? []);
  if (text) clearTags(plantId);
  return text;
}

// ---------- for tests ----------

export function __resetForTests() {
  state = initialState();
  lru = [];
}
