// Renderer-side mirror of the garden, fed by snapshot + events from the main process (or the demo).
import { useSyncExternalStore } from "react";
import type { Chore } from "../../shared/garden";
import type { Bed, Entry, GardenApi, GardenEvent, Plant, SoilReport } from "../../shared/types";

export type Selection = { kind: "plant"; id: string } | { kind: "bed"; id: string } | null;

export interface GardenState {
  ready: boolean;
  demo: boolean;
  beds: Bed[];
  plants: Record<string, Plant>;
  soil: Record<string, SoilReport>;
  entries: Record<string, Entry[]>;
  selection: Selection;
  /** Bed id the sow dialog is open for ("" = choose), or null when closed. */
  sowing: string | null;
  /** A chore to prefill the sow dialog with. */
  sowPreset: Chore | null;
  error: string | null;
}

let state: GardenState = {
  ready: false,
  demo: false,
  beds: [],
  plants: {},
  soil: {},
  entries: {},
  selection: null,
  sowing: null,
  sowPreset: null,
  error: null,
};

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

export function useGarden<T>(selector: (s: GardenState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function applyEvent(e: GardenEvent) {
  switch (e.type) {
    case "bed":
      setState((s) => ({
        beds: s.beds.some((b) => b.id === e.bed.id) ? s.beds.map((b) => (b.id === e.bed.id ? e.bed : b)) : [...s.beds, e.bed],
      }));
      return;
    case "bed:removed":
      setState((s) => ({
        beds: s.beds.filter((b) => b.id !== e.id),
        selection: s.selection?.kind === "bed" && s.selection.id === e.id ? null : s.selection,
      }));
      return;
    case "plant":
      setState((s) => ({ plants: { ...s.plants, [e.plant.id]: e.plant } }));
      return;
    case "plant:removed":
      setState((s) => {
        const plants = { ...s.plants };
        delete plants[e.id];
        const entries = { ...s.entries };
        delete entries[e.id];
        return {
          plants,
          entries,
          selection: s.selection?.kind === "plant" && s.selection.id === e.id ? null : s.selection,
        };
      });
      return;
    case "soil":
      setState((s) => ({ soil: { ...s.soil, [e.bedId]: e.report } }));
      return;
    case "entry":
      setState((s) => {
        const list = s.entries[e.entry.plantId];
        if (!list) return {}; // not loaded yet; it will come with the full journal
        const i = list.findIndex((x) => x.id === e.entry.id);
        const next = i >= 0 ? list.map((x, j) => (j === i ? e.entry : x)) : [...list, e.entry];
        return { entries: { ...s.entries, [e.entry.plantId]: next } };
      });
      return;
    case "focus":
      select({ kind: "plant", id: e.plantId });
      return;
  }
}

let api: GardenApi;

export async function connect(bridge: GardenApi, demo: boolean) {
  api = bridge;
  bridge.onEvent(applyEvent);
  const snap = await bridge.snapshot();
  setState({
    ready: true,
    demo: demo || !!snap.demo,
    beds: snap.beds,
    plants: Object.fromEntries(snap.plants.map((p) => [p.id, p])),
    soil: snap.soil,
  });
}

export function garden(): GardenApi {
  return api;
}

export function select(sel: Selection) {
  setState({ selection: sel });
  if (sel?.kind === "plant") {
    void loadEntries(sel.id);
    const p = state.plants[sel.id];
    if (p?.unread) void api.markRead(sel.id);
  }
}

async function loadEntries(plantId: string) {
  if (state.entries[plantId]) return;
  const list = await api.entries(plantId);
  setState((s) => ({ entries: { ...s.entries, [plantId]: s.entries[plantId] ?? list } }));
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

export function plantsInBed(plants: Record<string, Plant>, bedId: string): Plant[] {
  return Object.values(plants)
    .filter((p) => p.bedId === bedId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function needsYou(p: Plant) {
  return p.status === "waiting" || p.status === "error";
}

export function isGrowing(p: Plant) {
  return p.status === "thinking" || p.status === "working";
}
