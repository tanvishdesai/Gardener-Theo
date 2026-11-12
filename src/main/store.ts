// The garden's memory (PLAN M1): beds, plants, journals, rings, soil and settings in SQLite.
// Beds and plants are mirrored in memory (small); journals live only in the database and are paged.
// Writes are grouped into one transaction committed every ~100 ms ("group commit"), or at once via flush().
// Every change emits an event; the IPC layer decides what reaches the renderer.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nextGridSlot, oneLine } from "../shared/garden";
import type { Bed, Entry, GardenEvent, JournalPage, Plant, Ring, SearchHit, Settings, SoilReport } from "../shared/types";
import { openDb, startCheckpointer, type Checkpointer, type Db } from "./db";

const PREVIEW_BYTES = 4096;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const SHELL_TEXT = 600;
const COMMIT_MS = 100;

export const INTERRUPTED_POT = "Gardener closed before this pot was ready: its git worktree or setup didn't finish. Send a message to finish preparing it, or uproot it.";

export const DEFAULT_SETTINGS: Settings = {
  idleMinutes: 30,
  hookInstalled: false,
  hookPort: 47823,
  onboarded: false,
  wakeOnRedStake: false,
};

export interface RingMeta {
  ckptBefore?: string;
  ckptAfter?: string;
  assistantUuid?: string;
}

interface EntryRow {
  seq: number;
  id: string;
  plant_id: string;
  ts: number;
  kind: Entry["kind"];
  text: string;
  tool: string | null;
}

/** The renderer's copy of a plant: long free text clipped (the journal has the full text). */
export function shell(p: Plant): Plant {
  const clip = (s?: string) => (s && s.length > SHELL_TEXT ? `${s.slice(0, SHELL_TEXT)}…` : s);
  return { ...p, seed: clip(p.seed) ?? "", lastText: clip(p.lastText) };
}

export class GardenStore {
  readonly beds = new Map<string, Bed>();
  readonly plants = new Map<string, Plant>();
  readonly soil = new Map<string, SoilReport>();
  readonly db: Db;
  private listeners = new Set<(e: GardenEvent) => void>();
  private inTx = false;
  private commitTimer: NodeJS.Timeout | null = null;
  private dirtyPlants = new Set<string>();
  private seqs = new Map<string, number>();
  private settingsCache: Settings;
  private interruptedPots: string[] = [];
  private checkpointer: Checkpointer;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = openDb(join(dir, "garden.db"));
    this.checkpointer = startCheckpointer(join(dir, "garden.db"));
    try {
      this.load();
      this.settingsCache = this.readSettings();
      this.importV1();
      for (const id of this.interruptedPots) {
        this.upsertEntry({ id: `interrupted-pot-${Date.now()}`, plantId: id, ts: Date.now(), kind: "error", text: INTERRUPTED_POT });
        this.dirtyPlants.add(id);
      }
      this.interruptedPots = [];
      this.flush();
    } catch (err) {
      this.checkpointer.stop();
      this.db.close();
      throw err;
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private load() {
    for (const r of this.db.prepare("SELECT data FROM beds").all() as { data: string }[]) {
      const bed = JSON.parse(r.data) as Bed;
      this.beds.set(bed.id, bed);
    }
    for (const r of this.db.prepare("SELECT data FROM plants").all() as { data: string }[]) {
      const p = JSON.parse(r.data) as Plant;
      // Nothing is alive after a restart: whatever was growing is now resting.
      const wasBusy = p.status === "thinking" || p.status === "working" || p.status === "waiting";
      // A pot whose worktree/setup never finished must not look healthy: say so plainly.
      const interrupted = p.plot === "pot" && !!p.potPending;
      this.plants.set(p.id, {
        ...p,
        live: false,
        queued: false,
        runners: 0,
        ask: undefined,
        activity: undefined,
        activityDetail: undefined,
        status: interrupted ? "error" : wasBusy ? "idle" : p.status,
        ...(interrupted ? { error: INTERRUPTED_POT } : {}),
      });
      if (interrupted && p.error !== INTERRUPTED_POT) this.interruptedPots.push(p.id);
    }
    for (const r of this.db.prepare("SELECT bed_id, report FROM soil").all() as { bed_id: string; report: string }[]) {
      this.soil.set(r.bed_id, JSON.parse(r.report));
    }
  }

  /** Commit pending writes now (turn end, an ask, quit). */
  flush() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    if (!this.inTx) return;
    try {
      const up = this.db.prepare("UPDATE plants SET data = ?, session_id = ?, updated_at = ? WHERE id = ?");
      for (const id of this.dirtyPlants) {
        const p = this.plants.get(id);
        if (p) up.run(JSON.stringify(p), p.sessionId ?? null, p.updatedAt, id);
      }
      this.dirtyPlants.clear();
      this.db.exec("COMMIT");
    } catch (err) {
      console.error("[gardener] commit failed; will retry", err);
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      // Everything in memory is still right: rewrite all plants on the next commit.
      for (const id of this.plants.keys()) this.dirtyPlants.add(id);
      this.seqs.clear();
    }
    this.inTx = false;
  }

  close() {
    this.flush();
    this.checkpointer.stop();
    // Last connection out: fold the WAL into the database file.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // busy or already closed; the WAL is replayed on the next open
    }
    this.db.close();
  }

  /** Every write goes through here: opens the group transaction and schedules its commit. */
  private write<T>(fn: () => T): T {
    if (!this.inTx) {
      this.db.exec("BEGIN");
      this.inTx = true;
    }
    if (!this.commitTimer) this.commitTimer = setTimeout(() => this.flush(), COMMIT_MS);
    return fn();
  }

  on(listener: (e: GardenEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: GardenEvent) {
    for (const l of this.listeners) l(event);
  }

  // ── beds and soil ─────────────────────────────────────────────────────────

  putBed(input: Bed): Bed {
    const bed = input.gridX === undefined || input.gridY === undefined ? { ...input, ...nextGridSlot([...this.beds.values()]) } : input;
    this.write(() =>
      this.db.prepare("INSERT INTO beds(id, path, created_at, data) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, data = excluded.data").run(bed.id, bed.path, bed.createdAt, JSON.stringify(bed)),
    );
    this.beds.set(bed.id, bed);
    this.emit({ type: "bed", bed });
    return bed;
  }

  updateBed(id: string, patch: Partial<Bed>): Bed | undefined {
    const prev = this.beds.get(id);
    if (!prev) return undefined;
    return this.putBed({ ...prev, ...patch, id });
  }

  deleteBed(id: string) {
    this.write(() => this.db.prepare("DELETE FROM beds WHERE id = ?").run(id));
    for (const p of [...this.plants.values()]) {
      if (p.bedId !== id) continue;
      this.plants.delete(p.id);
      this.dirtyPlants.delete(p.id);
      this.emit({ type: "plant:removed", id: p.id });
    }
    this.beds.delete(id);
    this.soil.delete(id);
    this.emit({ type: "bed:removed", id });
  }

  putSoil(bedId: string, report: SoilReport) {
    const prev = this.soil.get(bedId);
    this.soil.set(bedId, report);
    if (prev && sameSoil(prev, report)) return;
    if (this.beds.has(bedId)) this.write(() => this.db.prepare("INSERT OR REPLACE INTO soil(bed_id, report) VALUES(?, ?)").run(bedId, JSON.stringify(report)));
    this.emit({ type: "soil", bedId, report });
  }

  recordHealth(bedId: string, day: string, health: number) {
    if (!this.beds.has(bedId)) return;
    this.write(() => this.db.prepare("INSERT OR REPLACE INTO soil_history(bed_id, day, health) VALUES(?, ?, ?)").run(bedId, day, Math.round(health)));
  }

  soilHistory(bedId: string, days = 90): { day: string; health: number }[] {
    return (this.db.prepare("SELECT day, health FROM soil_history WHERE bed_id = ? ORDER BY day DESC LIMIT ?").all(bedId, days) as { day: string; health: number }[]).reverse();
  }

  // ── plants ────────────────────────────────────────────────────────────────

  putPlant(plant: Plant) {
    this.write(() =>
      this.db
        .prepare("INSERT OR REPLACE INTO plants(id, bed_id, session_id, origin, updated_at, data) VALUES(?, ?, ?, ?, ?, ?)")
        .run(plant.id, plant.bedId, plant.sessionId ?? null, plant.origin, plant.updatedAt, JSON.stringify(plant)),
    );
    this.dirtyPlants.delete(plant.id);
    this.plants.set(plant.id, plant);
    this.emit({ type: "plant", plant: shell(plant) });
  }

  updatePlant(id: string, patch: Partial<Plant>): Plant | undefined {
    const prev = this.plants.get(id);
    if (!prev) return undefined;
    const next: Plant = { ...prev, ...patch, updatedAt: Date.now() };
    this.plants.set(id, next);
    this.write(() => this.dirtyPlants.add(id));
    const sent: Partial<Plant> = { ...patch, updatedAt: next.updatedAt };
    if (typeof sent.lastText === "string" && sent.lastText.length > SHELL_TEXT) sent.lastText = `${sent.lastText.slice(0, SHELL_TEXT)}…`;
    if (typeof sent.seed === "string" && sent.seed.length > SHELL_TEXT) sent.seed = `${sent.seed.slice(0, SHELL_TEXT)}…`;
    this.emit({ type: "plant:patch", id, patch: sent });
    return next;
  }

  deletePlant(id: string) {
    this.write(() => this.db.prepare("DELETE FROM plants WHERE id = ?").run(id));
    this.plants.delete(id);
    this.dirtyPlants.delete(id);
    this.seqs.delete(id);
    this.emit({ type: "plant:removed", id });
  }

  plantBySession(sessionId: string): Plant | undefined {
    for (const p of this.plants.values()) if (p.sessionId === sessionId) return p;
    return undefined;
  }

  // ── journal ───────────────────────────────────────────────────────────────

  private nextSeq(plantId: string): number {
    let s = this.seqs.get(plantId);
    if (s === undefined) s = Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM entries WHERE plant_id = ?").get(plantId) as { m: number }).m);
    s += 1;
    this.seqs.set(plantId, s);
    return s;
  }

  /** Insert or update an entry by (plantId, id). Large tool outputs move to a blob; the entry keeps a 4 KB preview. */
  upsertEntry(entry: Entry): Entry | undefined {
    if (!this.plants.has(entry.plantId)) return undefined;
    return this.write(() => {
      let blob: string | null = null;
      let tool = entry.tool;
      if (tool?.output && tool.output.length > PREVIEW_BYTES) {
        const full = Buffer.from(tool.output, "utf8");
        const kept = full.length > MAX_BLOB_BYTES ? full.subarray(0, MAX_BLOB_BYTES) : full;
        blob = createHash("sha256").update(kept).digest("hex");
        this.db.prepare("INSERT OR IGNORE INTO blobs(hash, size, bytes) VALUES(?, ?, ?)").run(blob, kept.length, deflateSync(kept));
        tool = { ...tool, output: tool.output.slice(0, PREVIEW_BYTES), outputTruncated: true, outputBytes: full.length };
      }
      const existing = this.db.prepare("SELECT seq FROM entries WHERE plant_id = ? AND id = ?").get(entry.plantId, entry.id) as { seq: number } | undefined;
      const seq = existing?.seq ?? this.nextSeq(entry.plantId);
      this.db
        .prepare(
          `INSERT INTO entries(plant_id, seq, id, ts, kind, text, tool, output_blob) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(plant_id, id) DO UPDATE SET kind = excluded.kind, text = excluded.text, tool = excluded.tool,
             output_blob = COALESCE(excluded.output_blob, entries.output_blob)`,
        )
        .run(entry.plantId, seq, entry.id, existing ? entry.ts : entry.ts, entry.kind, entry.text, tool ? JSON.stringify(tool) : null, blob);
      const stored: Entry = { ...entry, seq, tool };
      this.emit({ type: "entry", entry: stored });
      return stored;
    });
  }

  /** Bulk insert for imports: one transaction, no per-entry events. */
  importEntries(plantId: string, entries: Omit<Entry, "plantId">[]) {
    if (!this.plants.has(plantId)) return;
    const quiet = this.listeners;
    this.listeners = new Set();
    try {
      for (const e of entries) this.upsertEntry({ ...e, plantId });
    } finally {
      this.listeners = quiet;
    }
  }

  findEntry(plantId: string, id: string): Entry | undefined {
    const r = this.db.prepare("SELECT seq, id, plant_id, ts, kind, text, tool FROM entries WHERE plant_id = ? AND id = ?").get(plantId, id) as EntryRow | undefined;
    return r ? toEntry(r) : undefined;
  }

  /** Newest `limit` entries before `beforeSeq` (exclusive), oldest first. */
  journalPage(plantId: string, beforeSeq = Number.MAX_SAFE_INTEGER, limit = 200): JournalPage {
    const rows = this.db
      .prepare("SELECT seq, id, plant_id, ts, kind, text, tool FROM entries WHERE plant_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(plantId, beforeSeq, limit + 1) as unknown as EntryRow[];
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).reverse().map(toEntry), hasMore };
  }

  entryCount(plantId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE plant_id = ?").get(plantId) as { n: number }).n);
  }

  /** Full tool output (inflated from its blob when it was truncated). */
  toolOutput(plantId: string, entryId: string): string {
    const r = this.db.prepare("SELECT tool, output_blob FROM entries WHERE plant_id = ? AND id = ?").get(plantId, entryId) as { tool: string | null; output_blob: string | null } | undefined;
    if (!r) return "";
    if (r.output_blob) {
      const b = this.db.prepare("SELECT bytes FROM blobs WHERE hash = ?").get(r.output_blob) as { bytes: Uint8Array } | undefined;
      if (b) return inflateSync(b.bytes).toString("utf8");
    }
    return r.tool ? ((JSON.parse(r.tool) as Entry["tool"])?.output ?? "") : "";
  }

  /** Plant names/seeds/branches by substring, then journal text through FTS5 (trigram, ≥ 3 chars). */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    const hits: SearchHit[] = [];
    for (const p of this.plants.values()) {
      const hay = `${p.name}\n${p.branch ?? ""}\n${p.seed}`.toLowerCase();
      if (hay.includes(lower)) hits.push({ plantId: p.id, bedId: p.bedId, title: p.name, snippet: snippet(p.seed || p.name, lower) });
      if (hits.length >= limit) return hits;
    }
    if (q.length < 3) return hits;
    const rows = this.db
      .prepare(
        `SELECT e.plant_id AS plant_id, e.id AS id, e.text AS text FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
         WHERE entries_fts MATCH ? ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(`"${q.replace(/"/g, '""')}"`, limit) as { plant_id: string; id: string; text: string }[];
    for (const r of rows) {
      const p = this.plants.get(r.plant_id);
      if (!p) continue;
      hits.push({ plantId: p.id, bedId: p.bedId, entryId: r.id, title: p.name, snippet: snippet(r.text, lower) });
    }
    return hits.slice(0, limit);
  }

  // ── rings ─────────────────────────────────────────────────────────────────

  putRing(ring: Ring, meta: RingMeta = {}) {
    this.write(() =>
      this.db
        .prepare(
          `INSERT INTO rings(plant_id, n, ckpt_before, ckpt_after, assistant_uuid, data) VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(plant_id, n) DO UPDATE SET ckpt_before = COALESCE(excluded.ckpt_before, rings.ckpt_before),
             ckpt_after = COALESCE(excluded.ckpt_after, rings.ckpt_after),
             assistant_uuid = COALESCE(excluded.assistant_uuid, rings.assistant_uuid), data = excluded.data`,
        )
        .run(ring.plantId, ring.n, meta.ckptBefore ?? null, meta.ckptAfter ?? null, meta.assistantUuid ?? null, JSON.stringify(ring)),
    );
    this.emit({ type: "ring", ring });
  }

  updateRing(plantId: string, n: number, patch: Partial<Ring>, meta: RingMeta = {}): Ring | undefined {
    const prev = this.ring(plantId, n);
    if (!prev) return undefined;
    const next = { ...prev, ...patch, plantId, n };
    this.putRing(next, meta);
    return next;
  }

  ring(plantId: string, n: number): Ring | undefined {
    const r = this.db.prepare("SELECT data FROM rings WHERE plant_id = ? AND n = ?").get(plantId, n) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Ring) : undefined;
  }

  rings(plantId: string): Ring[] {
    return (this.db.prepare("SELECT data FROM rings WHERE plant_id = ? ORDER BY n").all(plantId) as { data: string }[]).map((r) => JSON.parse(r.data) as Ring);
  }

  ringMeta(plantId: string, n: number): RingMeta {
    const r = this.db.prepare("SELECT ckpt_before, ckpt_after, assistant_uuid FROM rings WHERE plant_id = ? AND n = ?").get(plantId, n) as
      | { ckpt_before: string | null; ckpt_after: string | null; assistant_uuid: string | null }
      | undefined;
    return { ckptBefore: r?.ckpt_before ?? undefined, ckptAfter: r?.ckpt_after ?? undefined, assistantUuid: r?.assistant_uuid ?? undefined };
  }

  /** Mark rings after `n` as pruned. */
  pruneRingsAfter(plantId: string, n: number) {
    for (const r of this.rings(plantId)) if (r.n > n && !r.pruned) this.putRing({ ...r, pruned: true });
  }

  // ── settings ──────────────────────────────────────────────────────────────

  private readSettings(): Settings {
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
      try {
        s[r.key] = JSON.parse(r.value);
      } catch {
        // ignore a corrupt value; the default stands
      }
    }
    return s as unknown as Settings;
  }

  settings(): Settings {
    return this.settingsCache;
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.write(() => {
      const st = this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)");
      const del = this.db.prepare("DELETE FROM settings WHERE key = ?");
      for (const [k, v] of Object.entries(patch)) v === undefined ? del.run(k) : st.run(k, JSON.stringify(v));
    });
    this.settingsCache = { ...this.settingsCache, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (this.settingsCache as unknown as Record<string, unknown>)[k];
    this.emit({ type: "settings", settings: this.settingsCache });
    return this.settingsCache;
  }

  // ── V1 import ─────────────────────────────────────────────────────────────

  /**
   * One-time move of V1's garden.json + journals/*.json into SQLite. A V1 file that cannot be read is a
   * hard error (never silently start an empty garden over it). After success the V1 files are renamed *.v1.bak.
   */
  private importV1() {
    const file = join(this.dir, "garden.json");
    if (!existsSync(file)) return;
    let data: { beds?: Bed[]; plants?: Plant[] };
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Could not read the V1 garden at ${file} (${err instanceof Error ? err.message : String(err)}). It was left untouched; fix or move it and start Gardener again.`);
    }
    const journals = join(this.dir, "journals");
    const quiet = this.listeners;
    this.listeners = new Set();
    try {
      this.write(() => {
        for (const bed of data.beds ?? []) if (!this.beds.has(bed.id)) this.putBed(bed);
        for (const v1 of data.plants ?? []) {
          if (this.plants.has(v1.id) || !this.beds.has(v1.bedId)) continue;
          const bed = this.beds.get(v1.bedId)!;
          const plant: Plant = {
            ...v1,
            origin: v1.origin ?? (v1.sessionId && v1.id === v1.sessionId ? "imported" : "sown"),
            plot: v1.plot ?? "bed",
            cwd: v1.cwd ?? bed.path,
            live: false,
            queued: false,
            runners: 0,
            ask: undefined,
            status: v1.status === "error" ? "error" : "idle",
          };
          this.putPlant(plant);
          const jf = join(journals, `${v1.id}.json`);
          if (existsSync(jf)) {
            let list: Entry[] = [];
            try {
              list = JSON.parse(readFileSync(jf, "utf8")) as Entry[];
            } catch {
              console.error(`[gardener] V1 journal ${jf} unreadable; skipped`);
            }
            for (const e of list) this.upsertEntry({ ...e, plantId: plant.id });
          }
        }
      });
      this.flush();
    } finally {
      this.listeners = quiet;
    }
    renameSync(file, `${file}.v1.bak`);
    if (existsSync(journals)) {
      try {
        renameSync(journals, `${journals}.v1.bak`);
      } catch (err) {
        console.error("[gardener] could not rename V1 journals folder", err);
      }
    }
  }
}

function toEntry(r: EntryRow): Entry {
  return { id: r.id, plantId: r.plant_id, seq: r.seq, ts: r.ts, kind: r.kind, text: r.text, ...(r.tool ? { tool: JSON.parse(r.tool) } : {}) };
}

function snippet(text: string, lowerQuery: string): string {
  const i = text.toLowerCase().indexOf(lowerQuery);
  if (i < 0) return oneLine(text, 140);
  const start = Math.max(0, i - 50);
  return `${start > 0 ? "…" : ""}${oneLine(text.slice(start, i + lowerQuery.length + 80), 160)}`;
}

function sameSoil(a: SoilReport, b: SoilReport) {
  const { checkedAt: _a, ...ra } = a;
  const { checkedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}
