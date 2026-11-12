// SQLite for Terrarium (PLAN D1/M1): node:sqlite (built into Electron's Node), WAL, forward-only migrations.
// One connection, owned by the main process. Everything that writes goes through GardenStore.
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

export type Db = DatabaseSync;

/** Each migration runs once, in order, inside a transaction. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: string[] = [
  // 1: V2 initial schema
  `
  CREATE TABLE beds(
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE plants(
    id TEXT PRIMARY KEY,
    bed_id TEXT NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
    session_id TEXT,
    origin TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX plants_bed ON plants(bed_id);
  CREATE INDEX plants_session ON plants(session_id);

  CREATE TABLE entries(
    rowid INTEGER PRIMARY KEY,
    plant_id TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    tool TEXT,
    output_blob TEXT,
    UNIQUE(plant_id, seq),
    UNIQUE(plant_id, id)
  );
  CREATE TABLE blobs(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL);

  CREATE TABLE rings(
    plant_id TEXT NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    ckpt_before TEXT,
    ckpt_after TEXT,
    assistant_uuid TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY(plant_id, n)
  );

  CREATE TABLE soil(bed_id TEXT PRIMARY KEY REFERENCES beds(id) ON DELETE CASCADE, report TEXT NOT NULL);
  CREATE TABLE soil_history(
    bed_id TEXT NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    health INTEGER NOT NULL,
    PRIMARY KEY(bed_id, day)
  );

  -- Usage (Almanac): one row per API response, deduped by (message_id, request_id).
  CREATE TABLE usage(
    message_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(message_id, request_id)
  );
  CREATE INDEX usage_ts ON usage(ts);
  CREATE INDEX usage_session ON usage(session_id);
  -- Claude Code's own cost estimate per session and model (from transcript cost-state lines).
  CREATE TABLE usage_sessions(
    session_id TEXT PRIMARY KEY,
    cwd TEXT,
    cost_usd REAL,
    model_costs TEXT,
    updated_at INTEGER NOT NULL
  );
  -- Incremental transcript scanning: how far each file has been read.
  CREATE TABLE usage_files(
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    session_id TEXT
  );

  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE VIRTUAL TABLE entries_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram');
  CREATE TRIGGER entries_fts_ai AFTER INSERT ON entries WHEN new.kind IN ('user', 'text') BEGIN
    INSERT INTO entries_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER entries_fts_ad AFTER DELETE ON entries WHEN old.kind IN ('user', 'text') BEGIN
    DELETE FROM entries_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER entries_fts_au AFTER UPDATE OF text ON entries WHEN new.kind IN ('user', 'text') BEGIN
    DELETE FROM entries_fts WHERE rowid = old.rowid;
    INSERT INTO entries_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA journal_size_limit = 67108864;
    PRAGMA wal_autocheckpoint = 0;
  `);
  migrate(db);
  return db;
}

// The checkpointer runs in a worker with its own connection: copying the WAL into the database
// file (and its fsync) never blocks the main thread. PASSIVE checkpoints don't block the writer.
const CHECKPOINT_WORKER = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA busy_timeout = 5000");
const done = new Int32Array(workerData.done);
const tick = () => { try { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch {} };
const timer = setInterval(tick, workerData.everyMs);
parentPort.on("message", (m) => {
  if (m !== "stop") return;
  clearInterval(timer);
  tick();
  db.close();
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
  parentPort.close();
});
`;

export interface Checkpointer {
  /** Final checkpoint, then close the worker's connection (waits up to 3 s so the file is free afterwards). */
  stop(): void;
}

export function startCheckpointer(file: string, everyMs = 1000): Checkpointer {
  const done = new SharedArrayBuffer(4);
  const worker = new Worker(CHECKPOINT_WORKER, { eval: true, workerData: { file, everyMs, done } });
  worker.unref();
  worker.on("error", (err) => console.error("[terrarium] checkpoint worker failed", err));
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      worker.postMessage("stop");
      Atomics.wait(new Int32Array(done), 0, 0, 3000);
    },
  };
}

export function schemaVersion(db: Db): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

export function migrate(db: Db) {
  const from = schemaVersion(db);
  if (from === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${v + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
