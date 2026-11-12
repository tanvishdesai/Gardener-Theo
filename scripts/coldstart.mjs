// Cold-start budget (PLAN 1.1: ≤ 1.5 s to an interactive garden) measured on the real built app,
// with a seeded garden of 100 beds / 1,000 plants / 20,000 journal entries in a temp data folder.
// No migration, no Claude turns, no network. Usage: npm run build && node scripts/coldstart.mjs [--runs 5]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const electron = require("electron");
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;
const userData = mkdtempSync(join(tmpdir(), "terrarium-coldstart-"));

async function launch() {
  const t0 = performance.now();
  const app = await _electron.launch({ executablePath: electron, args: ["."], env: { ...process.env, TERRARIUM_USER_DATA: userData } });
  const win = await app.firstWindow();
  // Interactive: the snapshot is loaded (no "Opening the garden gate" screen) and the garden canvas exists.
  await win.waitForFunction(() => !document.querySelector(".loading") && !!document.querySelector(".topbar") && !!document.querySelector("canvas"), null, { timeout: 30_000 });
  const ms = performance.now() - t0;
  const plants = await win.evaluate(async () => (await window.terrarium.snapshot()).plants.length);
  await app.close();
  return { ms, plants };
}

/** Seed straight into SQLite (schema comes from the app's own migrations on the first launch). */
function seed(dbFile) {
  const script = join(userData, "seed.cjs");
  writeFileSync(
    script,
    `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(dbFile)});
const now = Date.now();
db.exec("BEGIN");
const bed = db.prepare("INSERT INTO beds(id, path, created_at, data) VALUES(?, ?, ?, ?)");
const plant = db.prepare("INSERT INTO plants(id, bed_id, session_id, origin, updated_at, data) VALUES(?, ?, ?, ?, ?, ?)");
const entry = db.prepare("INSERT INTO entries(plant_id, seq, id, ts, kind, text) VALUES(?, ?, ?, ?, ?, ?)");
let k = 0;
const spiral = []; { let x = 0, y = 0, i = 0; const d = [[1,0],[0,1],[-1,0],[0,-1]]; for (let run = 1, di = 0; i < 100; run++) for (let r = 0; r < 2 && i < 100; r++, di = (di + 1) % 4) for (let s = 0; s < run && i < 100; s++, i++) { x += d[di][0]; y += d[di][1]; spiral.push([x, y]); } }
for (let b = 0; b < 100; b++) {
  const id = "bed-" + b, path = "C:/seed/repo-" + b;
  bed.run(id, path, now, JSON.stringify({ id, name: "repo-" + b, path, createdAt: now, gridX: spiral[b][0], gridY: spiral[b][1] }));
  for (let p = 0; p < 10; p++, k++) {
    const pid = "plant-" + k, updated = now - (p < 2 ? 3600e3 : 30 * 86400e3);
    plant.run(pid, id, "sess-" + k, "sown", updated, JSON.stringify({ id: pid, bedId: id, name: "Task " + k, species: ["sunflower","tulip","daisy","rose","lavender","poppy"][k % 6], seed: "Do task " + k, origin: "sown", plot: p % 2 ? "pot" : "bed", sessionId: "sess-" + k, permissionMode: "default", status: "idle", live: false, turns: 1 + (k % 9), toolCalls: k % 40, costUsd: (k % 50) / 10, runners: 0, unread: p === 0, createdAt: updated - 3600e3, updatedAt: updated }));
    for (let e = 0; e < 20; e++) entry.run(pid, e + 1, "e" + e, updated, e % 2 ? "text" : "user", "Journal line " + e + " for plant " + k + " about refactoring the websocket reconnect loop");
  }
}
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('onboarded', 'true')").run();
db.exec("COMMIT");
db.close();`,
  );
  execFileSync(electron, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
}

try {
  const first = await launch(); // creates garden.db through the real migrations
  seed(join(userData, "garden", "garden.db"));
  const times = [];
  let plants = 0;
  for (let i = 0; i < runs; i++) {
    const r = await launch();
    times.push(r.ms);
    plants = r.plants;
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(JSON.stringify({ emptyFirstLaunchMs: Math.round(first.ms), plants, runsMs: times.map(Math.round), medianMs: Math.round(median), budgetMs: 1500 }, null, 2));
  process.exitCode = median <= 1500 ? 0 : 1;
} finally {
  rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
