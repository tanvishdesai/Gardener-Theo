// IPC v2 event queue (PLAN M1): everything the store emits is coalesced into at most one
// renderer message per frame (17 ms). Bursts of patches for the same plant merge into one,
// only the latest pool/weather/settings survives, and journal/ring events are dropped unless
// the renderer has that plant's journal open.
import type { GardenEvent } from "../shared/types";

/** 17 ms keeps the renderer at ≤ 60 messages a second by construction (PLAN 1.1). */
export const FLUSH_MS = 17;

export class EventQueue {
  /** Journals the renderer has open: only their entry/ring events cross IPC. */
  readonly openJournals = new Set<string>();
  private pending: GardenEvent[] = [];
  /** Index in `pending` of the latest patch per plant, so bursts of patches merge into one. */
  private patchAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private plantsChanged = false;

  constructor(
    private send: (message: GardenEvent) => void,
    private opts: { intervalMs?: number; onPlantsChanged?: () => void } = {},
  ) {}

  push(e: GardenEvent) {
    switch (e.type) {
      case "entry":
        if (!this.openJournals.has(e.entry.plantId)) return;
        break;
      case "ring":
        if (!this.openJournals.has(e.ring.plantId)) return;
        break;
      case "plant:patch": {
        this.plantsChanged = true;
        const at = this.patchAt.get(e.id);
        if (at !== undefined) {
          const prev = this.pending[at] as Extract<GardenEvent, { type: "plant:patch" }>;
          this.pending[at] = { type: "plant:patch", id: e.id, patch: { ...prev.patch, ...e.patch } };
          return;
        }
        this.patchAt.set(e.id, this.pending.length);
        break;
      }
      case "plant":
      case "plant:removed":
        this.plantsChanged = true;
        this.patchAt.delete(e.type === "plant" ? e.plant.id : e.id);
        break;
      case "pool":
      case "weather":
      case "settings": {
        // Only the latest of these matters.
        const i = this.pending.findIndex((x) => x.type === e.type);
        if (i >= 0) {
          this.pending[i] = e;
          return;
        }
        break;
      }
    }
    this.pending.push(e);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.intervalMs ?? FLUSH_MS);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const events = this.pending;
    this.pending = [];
    this.patchAt = new Map();
    if (events.length) this.send(events.length === 1 ? events[0] : { type: "batch", events });
    if (this.plantsChanged) {
      this.plantsChanged = false;
      this.opts.onPlantsChanged?.();
    }
  }

  /** Send now (after anything already queued), e.g. "focus" from a notification click. */
  sendNow(e: GardenEvent) {
    this.flush();
    this.send(e);
  }
}
