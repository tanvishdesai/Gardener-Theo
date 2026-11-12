// The Almanac (PLAN M6, D10): usage and cost from Claude Code transcripts, scanned incrementally into SQLite.
// Tokens come from assistant `message.usage`, one row per API response (deduped by messageId:requestId).
// Cost comes from Claude Code's own estimate (the last `cost-state` line of each session), spread over that
// session's rows by weighted units. Sessions without a cost-state are priced at the model's average $/unit
// from sessions that have one (the report is then marked estimated). No price table, no network.
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { UsageBucket, UsageReport, UsageRow } from "../shared/types";
import { defaultProjectsDir } from "./history";
import type { GardenStore } from "./store";
import { TranscriptTail, type ModelCost, type UsageLine } from "./transcript";

const BATCH = 500;
/** Relative price of each token kind (input = 1). Only the ratios matter; Claude Code's own cost sets the scale. */
const UNITS_SQL = "(input + 5.0 * output + 1.25 * cache_write + 0.1 * cache_read)";

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** Main session transcripts and their subagent transcripts (billed to the parent session). */
async function transcriptFiles(root: string): Promise<{ path: string; sessionId: string; main: boolean }[]> {
  const out: { path: string; sessionId: string; main: boolean }[] = [];
  let all: string[];
  try {
    all = await readdir(root, { recursive: true });
  } catch {
    return out;
  }
  for (const rel of all) {
    if (!rel.endsWith(".jsonl")) continue;
    const parts = rel.split(/[\\/]/);
    if (parts.length === 2) out.push({ path: join(root, rel), sessionId: parts[1].slice(0, -6), main: true });
    else if (parts.length === 4 && parts[2] === "subagents") out.push({ path: join(root, rel), sessionId: parts[1], main: false });
  }
  return out;
}

interface Acc {
  costUsd: number;
  tokens: number;
  turns?: number;
  label: string;
}

export class Almanac {
  private scanning: Promise<{ files: number; rows: number }> | null = null;

  constructor(
    private store: GardenStore,
    private projectsDir = defaultProjectsDir(),
  ) {}

  /** Read only what's new since the last scan. Safe to call often; concurrent calls share one scan. */
  scan(): Promise<{ files: number; rows: number }> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  private async doScan() {
    const db = this.store.db;
    const known = new Map((db.prepare("SELECT path, size, mtime, offset FROM usage_files").all() as { path: string; size: number; mtime: number; offset: number }[]).map((r) => [r.path, r]));
    const upUsage = db.prepare(
      `INSERT INTO usage(message_id, request_id, session_id, ts, model, input, output, cache_read, cache_write) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, request_id) DO UPDATE SET input = max(usage.input, excluded.input), output = max(usage.output, excluded.output),
         cache_read = max(usage.cache_read, excluded.cache_read), cache_write = max(usage.cache_write, excluded.cache_write)`,
    );
    const upSession = db.prepare(
      `INSERT INTO usage_sessions(session_id, cwd, cost_usd, model_costs, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET cwd = COALESCE(usage_sessions.cwd, excluded.cwd), cost_usd = COALESCE(excluded.cost_usd, usage_sessions.cost_usd),
         model_costs = COALESCE(excluded.model_costs, usage_sessions.model_costs), updated_at = max(usage_sessions.updated_at, excluded.updated_at)`,
    );
    const upFile = db.prepare("INSERT OR REPLACE INTO usage_files(path, size, mtime, offset, session_id) VALUES(?, ?, ?, ?, ?)");

    let files = 0;
    let rows = 0;
    for (const f of await transcriptFiles(this.projectsDir)) {
      let st;
      try {
        st = await stat(f.path);
      } catch {
        continue;
      }
      const mtime = Math.floor(st.mtimeMs);
      const k = known.get(f.path);
      if (k && k.size === st.size && k.mtime === mtime) continue;
      const tail = new TranscriptTail(f.path, f.sessionId, { mode: "usage" });
      tail.offset = k && st.size >= k.offset ? k.offset : 0;
      try {
        await tail.read();
      } catch {
        continue;
      }
      files++;
      const usage = tail.parser.takeUsage();
      const s = tail.parser.summary;
      // Short transactions; the store's own group transaction is committed first so they never nest.
      for (let i = 0; i < usage.length || i === 0; i += BATCH) {
        const batch: UsageLine[] = usage.slice(i, i + BATCH);
        const last = i + BATCH >= usage.length;
        this.store.flush();
        db.exec("BEGIN");
        try {
          for (const u of batch) upUsage.run(u.messageId, u.requestId, u.sessionId, u.ts, u.model, u.input, u.output, u.cacheRead, u.cacheWrite);
          if (last) {
            const cost = f.main && s.modelCosts ? s : undefined;
            upSession.run(f.sessionId, s.cwd ?? null, cost ? cost.costUsd : null, cost ? JSON.stringify(cost.modelCosts) : null, s.updatedAt || mtime);
            upFile.run(f.path, st.size, mtime, tail.offset, f.sessionId);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        rows += batch.length;
        await yieldNow();
      }
    }
    return { files, rows };
  }

  report(days: number, now = Date.now()): UsageReport {
    const db = this.store.db;
    const today = new Date(now);
    const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();

    // Per session+model $/unit from Claude Code's own cost (all time, so a session crossing the window is priced right).
    const units = new Map<string, Map<string, number>>();
    for (const r of db.prepare(`SELECT session_id AS s, model AS m, SUM(${UNITS_SQL}) AS u FROM usage GROUP BY session_id, model`).all() as { s: string; m: string; u: number }[]) {
      if (!units.has(r.s)) units.set(r.s, new Map());
      units.get(r.s)!.set(r.m, Number(r.u));
    }
    const sessions = db.prepare("SELECT session_id AS s, cwd, cost_usd AS cost, model_costs AS mc FROM usage_sessions").all() as { s: string; cwd: string | null; cost: number | null; mc: string | null }[];
    const rate = new Map<string, number>(); // `${session}\0${model}` → $/unit
    const extra = new Map<string, number>(); // session → $/unit for cost not tied to a model with rows (e.g. title generation)
    const avg = new Map<string, { c: number; u: number }>();
    const cwdOf = new Map<string, string>();
    for (const r of sessions) {
      if (r.cwd) cwdOf.set(r.s, r.cwd);
      if (r.cost === null) continue;
      let mc: Record<string, ModelCost> = {};
      try {
        mc = JSON.parse(r.mc ?? "{}");
      } catch {
        // treat as no per-model split
      }
      const su = units.get(r.s);
      if (!su) continue;
      let attributed = 0;
      let total = 0;
      for (const [m, u] of su) {
        total += u;
        const c = mc[m]?.costUSD;
        if (c === undefined || u <= 0) continue;
        rate.set(`${r.s}\0${m}`, c / u);
        attributed += c;
        const a = avg.get(m) ?? { c: 0, u: 0 };
        a.c += c;
        a.u += u;
        avg.set(m, a);
      }
      // Session rate is set even when zero, so these rows never fall back to the model average.
      extra.set(r.s, total > 0 && r.cost > attributed ? (r.cost - attributed) / total : 0);
    }

    // Who each session belongs to.
    const plantBySession = new Map<string, { id: string; name: string; bedId: string; turns: number }>();
    for (const p of this.store.plants.values()) if (p.sessionId) plantBySession.set(p.sessionId, p);
    const beds = [...this.store.beds.values()].map((b) => ({ b, path: norm(b.path) })).sort((x, y) => y.path.length - x.path.length);
    const bedFor = new Map<string, { key: string; label: string }>();
    const bedOf = (s: string) => {
      let hit = bedFor.get(s);
      if (hit) return hit;
      const p = plantBySession.get(s);
      const bed = p ? this.store.beds.get(p.bedId) : undefined;
      if (bed) hit = { key: bed.id, label: bed.name };
      else {
        const cwd = cwdOf.get(s);
        const n = cwd ? norm(cwd) : undefined;
        const m = n ? beds.find(({ path }) => n === path || n.startsWith(path.endsWith(sep) ? path : path + sep)) : undefined;
        hit = m ? { key: m.b.id, label: m.b.name } : { key: "other", label: "Other folders" };
      }
      bedFor.set(s, hit);
      return hit;
    };

    const dayMap = new Map<string, UsageBucket>();
    for (let i = days - 1; i >= 0; i--) {
      const day = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime());
      dayMap.set(day, { day, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
    const byBed = new Map<string, Acc>();
    const byModel = new Map<string, Acc>();
    const byPlant = new Map<string, Acc>();
    const add = (map: Map<string, Acc>, key: string, label: string, cost: number, tokens: number, turns?: number) => {
      const a = map.get(key) ?? { costUsd: 0, tokens: 0, label, turns };
      a.costUsd += cost;
      a.tokens += tokens;
      map.set(key, a);
    };

    let estimated = false;
    let total = 0;
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    const rows = db.prepare("SELECT session_id AS s, ts, model, input, output, cache_read AS cr, cache_write AS cw FROM usage WHERE ts >= ? AND ts <= ?").all(since, now) as {
      s: string;
      ts: number;
      model: string;
      input: number;
      output: number;
      cr: number;
      cw: number;
    }[];
    for (const r of rows) {
      const u = r.input + 5 * r.output + 1.25 * r.cw + 0.1 * r.cr;
      let perUnit: number;
      if (extra.has(r.s)) perUnit = (rate.get(`${r.s}\0${r.model}`) ?? 0) + extra.get(r.s)!;
      else {
        const a = avg.get(r.model);
        perUnit = a && a.u > 0 ? a.c / a.u : 0; // unknown model with no reference: tokens counted, cost 0
        if (a) estimated = true;
      }
      const cost = u * perUnit;
      const tokens = r.input + r.output + r.cr + r.cw;
      total += cost;
      input += r.input;
      cacheRead += r.cr;
      cacheWrite += r.cw;
      const day = dayMap.get(localDay(r.ts));
      if (day) {
        day.costUsd += cost;
        day.inputTokens += r.input;
        day.outputTokens += r.output;
        day.cacheReadTokens += r.cr;
        day.cacheWriteTokens += r.cw;
      }
      const bed = bedOf(r.s);
      add(byBed, bed.key, bed.label, cost, tokens);
      add(byModel, r.model, r.model, cost, tokens);
      const p = plantBySession.get(r.s);
      if (p) add(byPlant, p.id, p.name, cost, tokens, p.turns);
    }
    const list = (m: Map<string, Acc>, limit = Infinity): UsageRow[] =>
      [...m]
        .map(([key, a]) => ({ key, label: a.label, costUsd: a.costUsd, tokens: a.tokens, ...(a.turns !== undefined ? { turns: a.turns } : {}) }))
        .sort((x, y) => y.costUsd - x.costUsd || y.tokens - x.tokens)
        .slice(0, limit);
    const denom = input + cacheRead + cacheWrite;
    return {
      days: [...dayMap.values()],
      byBed: list(byBed),
      byModel: list(byModel),
      byPlant: list(byPlant, 20),
      totalCostUsd: total,
      cacheHitRatio: denom ? cacheRead / denom : 0,
      estimated,
      scannedAt: now,
    };
  }
}
