// Soil scheduler (PLAN 2f): one bounded queue for every bed's soil read, a background cadence that
// favours active beds and is staggered so a big garden never refreshes all at once, and hygiene
// file checks that only rerun when fs.watch hints at a change (or hourly).
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { SoilReport } from "../shared/types";
import { healthScore, HYGIENE_FILES, readSoil } from "./soil";
import type { GardenStore } from "./store";

export type SoilPriority = "now" | "active" | "idle";
type Hygiene = Pick<SoilReport, "guidance" | "ci" | "tests" | "lint" | "stakeCandidates">;

const RANK: Record<SoilPriority, number> = { now: 0, active: 1, idle: 2 };
export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const ACTIVE_EVERY_MS = 20_000;
export const IDLE_EVERY_MS = 5 * 60_000;
const HYGIENE_MAX_AGE_MS = 60 * 60_000;
const TICK_MS = 1000;
const MIN_GAP_MS = 5000;

/** Stable 0..1 per bed, so each bed gets its own slot within a refresh interval. */
function phase(bedId: string): number {
  let h = 2166136261;
  for (let i = 0; i < bedId.length; i++) h = Math.imul(h ^ bedId.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class SoilScheduler {
  private store: GardenStore;
  private read: (root: string, reuse?: Hygiene) => Promise<SoilReport>;
  private concurrency: number;
  private now: () => number;
  /** bedId → priority; Map order is request order within a priority. */
  private pending = new Map<string, SoilPriority>();
  private running = new Set<string>();
  private lastRead = new Map<string, number>();
  private lastActive = new Map<string, number>();
  private hygieneAt = new Map<string, number>();
  private hygieneDirty = new Set<string>();
  private healthDay = new Map<string, string>();
  private watchers = new Map<string, { path: string; ws: FSWatcher[] }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: { store: GardenStore; read?: (root: string, reuse?: Hygiene) => Promise<SoilReport>; concurrency?: number; now?: () => number }) {
    this.store = deps.store;
    this.read = deps.read ?? readSoil;
    this.concurrency = deps.concurrency ?? 4;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    this.pending.clear();
  }

  request(bedId: string, priority: SoilPriority): void {
    const prev = this.pending.get(bedId);
    if (prev && RANK[prev] <= RANK[priority]) return;
    this.pending.delete(bedId);
    this.pending.set(bedId, priority);
    this.pump();
  }

  markActive(bedId: string): void {
    this.lastActive.set(bedId, this.now());
  }

  /** Requests whatever is due. Runs every second from start(); public so tests can drive a fake clock. */
  tick(): void {
    try {
      const now = this.now();
      for (const id of this.watchers.keys()) if (!this.store.beds.has(id)) this.unwatch(id);
      for (const bed of this.store.beds.values()) {
        this.watchBed(bed.id, bed.path);
        if (this.pending.has(bed.id) || this.running.has(bed.id)) continue;
        const last = this.lastRead.get(bed.id) ?? this.store.soil.get(bed.id)?.checkedAt ?? 0;
        if (this.isDue(bed.id, last, now)) this.request(bed.id, this.isActive(bed.id, now) ? "active" : "idle");
      }
    } catch (err) {
      console.error("[soil] tick failed", err);
    }
  }

  private isActive(bedId: string, now: number) {
    const t = this.lastActive.get(bedId);
    return t !== undefined && now - t < ACTIVE_WINDOW_MS;
  }

  /**
   * A bed is due once per interval, at its own phase within it, so 100 beds read together at
   * startup spread evenly over the next 5 min instead of firing together again. A short minimum
   * gap stops a bed whose slot comes right after a read from being read twice in a row.
   */
  private isDue(bedId: string, last: number, now: number) {
    const every = this.isActive(bedId, now) ? ACTIVE_EVERY_MS : IDLE_EVERY_MS;
    if (now - last >= every) return true;
    if (now - last < Math.min(MIN_GAP_MS, every / 4)) return false;
    const off = phase(bedId) * every;
    return Math.floor((now + off) / every) > Math.floor((last + off) / every);
  }

  private pump() {
    while (!this.stopped && this.running.size < this.concurrency) {
      const next = this.pick();
      if (!next) return;
      const priority = this.pending.get(next)!;
      this.pending.delete(next);
      this.running.add(next);
      void this.refresh(next, priority).finally(() => {
        this.running.delete(next);
        this.pump();
      });
    }
  }

  private pick(): string | undefined {
    let best: string | undefined;
    for (const [id, p] of this.pending) {
      if (this.running.has(id)) continue;
      if (best === undefined || RANK[p] < RANK[this.pending.get(best)!]) best = id;
      if (p === "now") break;
    }
    return best;
  }

  /** A "now" request (the user asked) always redoes the hygiene checks. */
  private async refresh(bedId: string, priority: SoilPriority) {
    const bed = this.store.beds.get(bedId);
    if (!bed) return;
    const now = this.now();
    const prev = this.store.soil.get(bedId);
    const reuse =
      priority !== "now" &&
      prev?.exists && prev.stakeCandidates && !this.hygieneDirty.has(bedId) && now - (this.hygieneAt.get(bedId) ?? 0) < HYGIENE_MAX_AGE_MS
        ? { guidance: prev.guidance, ci: prev.ci, tests: prev.tests, lint: prev.lint, stakeCandidates: prev.stakeCandidates }
        : undefined;
    if (!reuse) this.hygieneDirty.delete(bedId);
    try {
      const report = await this.read(bed.path, reuse);
      if (this.stopped || !this.store.beds.has(bedId)) return;
      if (!reuse) this.hygieneAt.set(bedId, now);
      const health = healthScore(report, this.stakePassRate(bedId));
      this.store.putSoil(bedId, { ...report, health });
      const day = localDay(now);
      const key = `${day}:${health}`;
      if (this.healthDay.get(bedId) !== key) {
        this.store.recordHealth(bedId, day, health);
        this.healthDay.set(bedId, key);
      }
    } catch (err) {
      console.error(`[soil] reading ${bed.path} failed`, err);
    } finally {
      this.lastRead.set(bedId, this.now());
    }
  }

  /** Pass rate over the last 20 finished stake runs recorded on rings of this bed's plants; undefined if none. */
  stakePassRate(bedId: string): number | undefined {
    try {
      const rows = this.store.db
        .prepare(
          `SELECT json_extract(r.data, '$.stake.status') AS s FROM rings r JOIN plants p ON p.id = r.plant_id
           WHERE p.bed_id = ? AND json_extract(r.data, '$.stake.status') IN ('passing', 'failing')
           ORDER BY json_extract(r.data, '$.stake.at') DESC LIMIT 20`,
        )
        .all(bedId) as { s: string }[];
      if (!rows.length) return undefined;
      return rows.filter((r) => r.s === "passing").length / rows.length;
    } catch (err) {
      console.error("[soil] stake pass rate query failed", err);
      return undefined;
    }
  }

  /** Forces the next read of this bed to redo its hygiene file checks. */
  invalidateHygiene(bedId: string): void {
    this.hygieneDirty.add(bedId);
  }

  // fs.watch is only a hint (it can fail, miss events, or not support a path); the hourly re-check is the guarantee.
  private watchBed(bedId: string, path: string) {
    const cur = this.watchers.get(bedId);
    if (cur?.path === path) return;
    if (cur) this.unwatch(bedId);
    const ws: FSWatcher[] = [];
    const add = (dir: string, onChange: (file: string | null) => void) => {
      try {
        const w = watch(dir, { persistent: false }, (_e, file) => onChange(file ? String(file) : null));
        w.on("error", () => w.close());
        ws.push(w);
      } catch {
        // missing dir, permissions, or too many watchers: rely on the hourly fallback
      }
    };
    add(path, (file) => {
      if (file === null || HYGIENE_FILES.has(file.split(/[\\/]/)[0])) this.hygieneDirty.add(bedId);
    });
    add(join(path, ".github"), () => this.hygieneDirty.add(bedId));
    this.watchers.set(bedId, { path, ws });
  }

  private unwatch(bedId: string) {
    for (const w of this.watchers.get(bedId)?.ws ?? []) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers.delete(bedId);
  }
}
