// Garden renderer benchmark (PLAN M0/M2). Starts the browser demo, drives a scripted 10 s session
// (pan, zoom, select, idle) and records frame times from `window.__terrariumPerf` (?perf=1).
//
//   node scripts/bench.mjs                      run, write bench/results.json, compare to bench/baseline.json
//   node scripts/bench.mjs --baseline           run and write bench/baseline.json
//   node scripts/bench.mjs --plants 1000 --beds 100 --live 30 [--journal 2000] [--page /] [--out file] [--headed]
//                          [--query "weather=clear"] (extra URL params) [--reduced] (emulate prefers-reduced-motion)
//
// Exits 1 when p95 frame time regresses by more than 15% (and more than 1 ms) against the baseline.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const cfg = {
  beds: Number(opt("beds", 100)),
  plants: Number(opt("plants", 1000)),
  live: Number(opt("live", 30)),
  journal: Number(opt("journal", 2000)),
  query: opt("query", ""),
  reduced: flag("reduced"),
  page: "/" + opt("page", "/").replace(/^\/+/, ""), // no leading slash needed (Git Bash rewrites "/x" into a Windows path)
};
const out = flag("baseline") ? "bench/baseline.json" : opt("out", "bench/results.json");

const freePort = () =>
  new Promise((resolve) => {
    const s = netServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const server = await createServer({ configFile: "vite.web.config.ts", logLevel: "error", server: { port, strictPort: true } });
await server.listen();

let browser;
for (const channel of ["msedge", "chrome"]) {
  try {
    browser = await chromium.launch({ channel, headless: !flag("headed") });
    break;
  } catch (e) {
    if (channel === "chrome") throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (x) => Math.round(x * 100) / 100;

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: cfg.reduced ? "reduce" : "no-preference" });
  await page.addInitScript(() => {
    window.__longtasks = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__longtasks.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  const q = `beds=${cfg.beds}&plants=${cfg.plants}&live=${cfg.live}&journal=${cfg.journal}&perf=1${cfg.query ? `&${cfg.query}` : ""}`;
  const url = `http://localhost:${port}${cfg.page}${cfg.page.includes("?") ? "&" : "?"}${q}`;
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.waitForFunction(() => (window.__terrariumPerf?.draws ?? 0) > 0, null, { timeout: 60_000 });
  const firstFrameMs = Date.now() - t0;
  await sleep(1500);
  const box = await page.locator("canvas").first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.evaluate(() => {
    window.__terrariumPerf.reset();
    window.__longtasks = [];
  });

  // 1. select a plant
  const target = await page.evaluate(() => window.__terrariumPerf.visiblePlant?.() ?? null);
  await page.mouse.click(target ? box.x + target.x : cx, target ? box.y + target.y : cy);
  await sleep(800);
  // 2. drag-pan in several directions
  for (const [dx, dy] of [[360, 0], [0, 260], [-360, 0], [0, -260], [300, 200], [-300, -200]]) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(cx + (dx * i) / 20, cy + (dy * i) / 20);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(60);
  }
  // 3. wheel zoom out (to the map) and back in
  await page.mouse.move(cx, cy);
  await page.keyboard.down("Control");
  for (const d of [100, 100, 100, 100, -100, -100, -100, -100, 100, -100]) {
    await page.mouse.wheel(0, d);
    await sleep(220);
  }
  await page.keyboard.up("Control");
  await sleep(500);
  const interact = await page.evaluate(() => ({ frames: [...window.__terrariumPerf.frames], fills: window.__terrariumPerf.fills }));
  // 4. idle
  await page.mouse.move(box.x + 5, box.y + box.height - 5);
  await sleep(300);
  const d0 = await page.evaluate(() => {
    const p = window.__terrariumPerf;
    return { draws: p.draws, n: p.frames.length };
  });
  await sleep(3000);
  const end = await page.evaluate(() => {
    const p = window.__terrariumPerf;
    return { draws: p.draws, frames: p.frames, fills: p.fills, longtasks: window.__longtasks, heap: performance.memory?.usedJSHeapSize ?? null };
  });
  const idleFrames = end.frames.slice(d0.n);
  const all = end.frames;

  const result = {
    at: new Date().toISOString(),
    config: cfg,
    firstFrameMs,
    frames: all.length,
    p50: round(pct(all, 50)),
    p95: round(pct(all, 95)),
    max: round(Math.max(0, ...all)),
    interactP95: round(pct(interact.frames, 95)),
    fillsLastFrame: interact.fills,
    idleFps: round((end.draws - d0.draws) / 3),
    idleDrawCpuPct: round((idleFrames.reduce((a, b) => a + b, 0) / 3000) * 100),
    longTasks: end.longtasks.length,
    longTaskMs: round(end.longtasks.reduce((a, b) => a + b, 0)),
    heapMB: end.heap ? round(end.heap / 1048576) : null,
  };
  mkdirSync("bench", { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));

  let code = 0;
  if (result.p95 > 16) {
    console.error(`p95 ${result.p95} ms is over the 16 ms budget`);
    code = 1;
  }
  if (!flag("baseline") && existsSync("bench/baseline.json")) {
    const base = JSON.parse(readFileSync("bench/baseline.json", "utf8"));
    console.log(`\np95 ${result.p95} ms vs baseline ${base.p95} ms; p50 ${result.p50} vs ${base.p50}; idle ${result.idleFps} fps vs ${base.idleFps}`);
    if (result.p95 > base.p95 * 1.15 && result.p95 - base.p95 > 1) {
      console.error(`p95 regressed more than 15% (${base.p95} -> ${result.p95} ms)`);
      // The baseline is recorded on a dev machine; CI runners differ, so there it's a warning, not a gate.
      if (!process.env.CI) code = 1;
    }
  }
  process.exitCode = code;
} finally {
  await browser.close();
  await server.close();
}
