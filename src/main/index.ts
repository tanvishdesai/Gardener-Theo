// Electron main process: owns the garden (store), the greenhouse (Claude sessions), the window,
// and every background service (pool, soil, stakes, harvest, volunteers, almanac). PLAN section 3.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, join, resolve, sep } from "node:path";
import type { AskResponse, Bed, CommitMessage, DiffScope, FirstRunCheck, GardenApi, GardenEvent, PermissionMode, Plant, Settings, SowRequest, Weather } from "../shared/types";
import { Greenhouse } from "./agents";
import * as git from "./git";
import { Harvest } from "./harvest";
import { countHistory, importHistory, plantable } from "./history";
import { EventQueue } from "./events";
import { diagnostics, installLogger } from "./logger";
import { ProcessPool } from "./pool";
import { SoilScheduler } from "./soilScheduler";
import { StakeRunner } from "./stakes";
import { GardenStore, shell as plantShell } from "./store";
import { Almanac } from "./usage";
import { Volunteers } from "./volunteers";

app.setName("Terrarium");
// Tests and second instances can point Terrarium at their own data folder.
if (process.env.TERRARIUM_USER_DATA) app.setPath("userData", resolve(process.env.TERRARIUM_USER_DATA));
else {
  // Renamed from Gardener: keep using an existing garden in place. Moving it would break its pots
  // (git worktrees are registered by absolute path, and Claude Code finds sessions by cwd).
  const legacy = join(app.getPath("appData"), "Gardener");
  if (!existsSync(app.getPath("userData")) && existsSync(legacy)) app.setPath("userData", legacy);
}
// One Terrarium per data folder: a second copy would write the same database and run the same sessions.
// The lock is keyed on userData, so it must be taken after the path is set.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
});

/** GUI apps on macOS/Linux start with a bare PATH; borrow the login shell's so git and friends resolve. */
function adoptShellPath() {
  if (process.platform === "win32") return;
  try {
    const sh = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const out = execFileSync(sh, ["-ilc", 'printf "__TERRARIUM_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 4000 });
    const path = out.split("__TERRARIUM_PATH__")[1]?.trim();
    if (path) process.env.PATH = path;
  } catch {
    // keep what we have
  }
}

let win: BrowserWindow | null = null;
let store: GardenStore;
let greenhouse: Greenhouse;
let pool: ProcessPool;
let soil: SoilScheduler;
let stakes: StakeRunner;
let harvest: Harvest;
let volunteers: Volunteers;
let almanac: Almanac;
let logger: ReturnType<typeof installLogger>;
let weather: Weather | undefined;
let lastAlmanacScan = 0;
let hiddenSince: number | null = null;

// ── IPC v2: coalesced events, journal subscriptions ─────────────────────────

const events = new EventQueue(
  (message) => {
    if (win && !win.isDestroyed()) win.webContents.send("garden:event", message);
  },
  {
    onPlantsChanged: () => {
      let needy = 0;
      for (const p of store.plants.values()) if (p.status === "waiting" || p.status === "error") needy++;
      app.setBadgeCount(needy);
    },
  },
);
const queue = (e: GardenEvent) => events.push(e);
const openJournals = events.openJournals;
const sendNow = (e: GardenEvent) => events.sendNow(e);

function notify(plant: Plant, why: string) {
  if (win?.isFocused()) return;
  if (!Notification.isSupported()) return;
  const bed = store.beds.get(plant.bedId);
  const n = new Notification({ title: `${plant.name} needs you`, body: `${bed ? `${bed.name}: ` : ""}${why}`, silent: false });
  n.on("click", () => {
    win?.show();
    win?.focus();
    sendNow({ type: "focus", plantId: plant.id });
  });
  n.show();
}

function addBed(path: string): Bed {
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`Not a folder: ${full}`);
  const existing = [...store.beds.values()].find((b) => b.path.toLowerCase() === full.toLowerCase());
  if (existing) return existing;
  const bed = store.putBed({ id: randomUUID(), name: basename(full) || full, path: full, createdAt: Date.now() });
  soil?.request(bed.id, "now");
  return bed;
}

/** For importers and volunteers: only real project folders become beds. */
function addBedIfPlantable(path: string): Bed | null {
  try {
    return plantable(path) ? addBed(path) : null;
  } catch {
    return null;
  }
}

function hookToken(): string {
  const f = join(app.getPath("userData"), "hook.token");
  try {
    const t = readFileSync(f, "utf8").trim();
    if (t) return t;
  } catch {
    // first run
  }
  const t = randomBytes(24).toString("hex");
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

/** In the packaged app, claude.exe lives in app.asar.unpacked (executables can't run from inside the archive). */
function claudeExecutable(): string | undefined {
  if (!app.isPackaged) return undefined;
  try {
    const req = createRequire(import.meta.url);
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const exe = req.resolve(`${pkg}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
    return exe.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  } catch (err) {
    console.error("[terrarium] could not locate the Claude Code binary", err);
    return undefined;
  }
}

function which(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((r) => execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => r(err ? null : stdout.trim())));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: "Terrarium",
    backgroundColor: "#cfe8e4",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("focus", () => {
    hiddenSince = null;
    for (const p of store.plants.values()) if (p.live) soil.request(p.bedId, "active");
  });
  win.on("hide", () => (hiddenSince = Date.now()));
  win.on("minimize", () => (hiddenSince = Date.now()));
  win.on("restore", () => (hiddenSince = null));
  win.webContents.on("render-process-gone", () => openJournals.clear());
  win.webContents.on("did-start-navigation", () => openJournals.clear());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

type Handlers = { [K in Exclude<keyof GardenApi, "onEvent">]: (...args: Parameters<GardenApi[K]>) => Awaited<ReturnType<GardenApi[K]>> | ReturnType<GardenApi[K]> };

function mustPlant(id: string): Plant {
  const p = store.plants.get(id);
  if (!p) throw new Error("That plant is gone");
  return p;
}

const handlers: Handlers = {
  snapshot: () => ({
    beds: [...store.beds.values()],
    plants: [...store.plants.values()].map(plantShell),
    soil: Object.fromEntries(store.soil),
    pool: pool.info(),
    weather,
    settings: store.settings(),
  }),

  openJournal: (plantId: string, limit?: number) => {
    openJournals.add(plantId);
    return store.journalPage(plantId, Number.MAX_SAFE_INTEGER, Math.min(limit ?? 200, 1000));
  },
  journalPage: (plantId: string, beforeSeq: number, limit?: number) => store.journalPage(plantId, beforeSeq, Math.min(limit ?? 200, 1000)),
  closeJournal: (plantId: string) => {
    openJournals.delete(plantId);
  },
  toolOutput: (plantId: string, entryId: string) => store.toolOutput(plantId, entryId),
  search: (q: string) => store.search(q),

  pickDirectory: async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Choose a repository to plant a bed in", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  addBed: (path: string) => addBed(path),
  removeBed: async (id: string) => {
    // Pots live outside the repo: clean them up (branches are kept) before forgetting the bed.
    for (const p of [...store.plants.values()]) if (p.bedId === id) await greenhouse.uproot(p.id, { deleteBranch: false });
    greenhouse.closeBed(id);
    store.deleteBed(id);
  },
  refreshSoil: (bedId: string) => soil.request(bedId, "now"),
  setStake: (bedId: string, command: string | null) => {
    store.updateBed(bedId, { stakeCommand: command?.trim() || undefined });
    soil.request(bedId, "now");
  },
  soilHistory: (bedId: string) => store.soilHistory(bedId),

  sow: async (req: SowRequest) => {
    // The soil report can still be on its way for a bed added a moment ago: ask git rather than
    // falling back to "bed", which would put the plant in the user's own checkout.
    const bedPath = store.beds.get(req.bedId)?.path;
    const isGit = store.soil.get(req.bedId)?.isGitRepo ?? (bedPath ? await git.isRepo(bedPath) : false);
    const plot = isGit ? (req.plot ?? "pot") : "bed";
    const plant = greenhouse.sow({ ...req, plot });
    soil.markActive(req.bedId);
    return plantShell(plant);
  },
  send: async (plantId: string, text: string) => {
    soil.markActive(mustPlant(plantId).bedId);
    await greenhouse.send(plantId, text);
  },
  interrupt: (plantId: string) => greenhouse.interrupt(plantId),
  answer: (plantId: string, askId: string, r: AskResponse) => greenhouse.answer(plantId, askId, r),
  setMode: (plantId: string, mode: PermissionMode) => greenhouse.setMode(plantId, mode),
  markRead: (plantId: string) => {
    if (store.plants.get(plantId)?.unread) store.updatePlant(plantId, { unread: false });
  },
  setPinned: (plantId: string, pinned: boolean) => {
    store.updatePlant(plantId, { pinned: pinned || undefined });
  },
  uproot: (plantId: string, opts?: { deleteBranch?: boolean }) => greenhouse.uproot(plantId, opts ?? {}),
  adopt: (plantId: string) => {
    const p = mustPlant(plantId);
    if (p.origin !== "volunteer") return;
    if (!volunteers.adoptable(plantId)) throw new Error("That session is still running in a terminal. Adopt it once it has ended, so two processes never write the same session.");
    store.updatePlant(plantId, { origin: "sown", ended: undefined, watchedBy: undefined, status: "idle", ask: undefined });
  },
  reveal: (path: string) => {
    void shell.openPath(path);
  },

  rings: (plantId: string) => store.rings(plantId),
  diffFiles: (plantId: string, scope: DiffScope) => greenhouse.diffFiles(plantId, scope),
  diffFile: (plantId: string, scope: DiffScope, path: string, opts?: { full?: boolean }) => greenhouse.diffFile(plantId, scope, path, opts),
  pruneTo: (plantId: string, ring: number) => greenhouse.pruneTo(plantId, ring),
  forkAt: async (plantId: string, ring: number) => plantShell(await greenhouse.forkAt(plantId, ring)),

  harvestInfo: (plantId: string) => harvest.info(plantId),
  commitMessage: (plantId: string) => harvest.commitMessage(plantId),
  commit: (plantId: string, message: CommitMessage, files?: string[]) => harvest.commit(plantId, message, files),
  push: (plantId: string) => harvest.push(plantId),
  openPullRequest: (plantId: string, pr: { title: string; body: string }) => harvest.openPullRequest(plantId, pr),
  runStake: async (plantId: string) => {
    await stakes.run(plantId, mustPlant(plantId).ring);
  },

  usage: async (days: number) => {
    if (Date.now() - lastAlmanacScan > 60_000) {
      lastAlmanacScan = Date.now();
      await almanac.scan();
    }
    return almanac.report(days);
  },
  setSettings: (patch: Partial<Settings>) => {
    const { hookInstalled: _ignored, ...rest } = patch;
    const next = store.setSettings(rest);
    pool && queue({ type: "pool", pool: pool.info() });
    return next;
  },
  hookStatus: () => volunteers.status(),
  installHook: async () => {
    const port = store.settings().hookPort;
    const listening = await volunteers.listen(port, hookToken());
    const status = await volunteers.install(port, hookToken());
    store.setSettings({ hookInstalled: status.installed });
    return { ...status, listening: status.listening || listening };
  },
  uninstallHook: async () => {
    const status = await volunteers.uninstall();
    store.setSettings({ hookInstalled: status.installed });
    return status;
  },
  firstRunCheck: async (): Promise<FirstRunCheck> => {
    const [version, gh, history] = await Promise.all([git.gitVersion().catch(() => null), which("gh", ["auth", "status"]), countHistory().catch(() => ({ sessions: 0, beds: 0 }))]);
    const claudeConfig = existsSync(join(homedir(), ".claude.json")) || existsSync(join(homedir(), ".claude"));
    return {
      git: { ok: !!version, version: version ?? undefined },
      claude: claudeConfig || process.env.ANTHROPIC_API_KEY ? { ok: true } : { ok: false, note: "Run `claude` once in a terminal and log in with your Claude account." },
      gh: gh !== null ? { ok: true } : { ok: false, note: "Optional: install GitHub CLI and run `gh auth login` to open pull requests from Terrarium." },
      historySessions: history.sessions,
      historyBeds: history.beds,
    };
  },
  importHistory: () => importHistory(store, addBedIfPlantable),
  diagnostics: () =>
    diagnostics({
      appVersion: app.getVersion(),
      liveProcesses: greenhouse.liveCount(),
      beds: store.beds.size,
      plants: store.plants.size,
      queued: greenhouse.queuedCount(),
      pool: pool.info(),
      dbBytes: (() => {
        try {
          return statSync(join(app.getPath("userData"), "garden", "garden.db")).size;
        } catch {
          return undefined;
        }
      })(),
      recent: logger.recent(40),
    }),
};

function wireIpc() {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`garden:${name}`, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
  }
}

function startServices() {
  pool = new ProcessPool({
    userMax: () => store.settings().maxLive,
    liveCount: () => greenhouse.liveCount(),
    queued: () => greenhouse.queuedCount(),
    onSample: (info) => {
      queue({ type: "pool", pool: info });
      greenhouse.drain();
    },
    onPressure: () => {
      greenhouse.reapOne();
    },
  });
  greenhouse = new Greenhouse(store, {
    onTurnEnd: (plant, ring) => {
      soil.markActive(plant.bedId);
      soil.request(plant.bedId, "active");
      const bed = store.beds.get(plant.bedId);
      if (bed?.stakeCommand && ring?.diff && ring.diff.files > 0) void stakes.run(plant.id, ring.n).catch((err) => console.error("[terrarium] stake failed", err));
    },
    onNeedsYou: notify,
    onWeather: (w) => {
      weather = w;
      queue({ type: "weather", weather: w });
    },
    onPoolChange: () => queue({ type: "pool", pool: pool.info() }),
    env: () => ({ ...process.env }),
    plotsRoot: join(app.getPath("userData"), "plots"),
    pool,
    idleMinutes: () => store.settings().idleMinutes,
    claudeExecutable: claudeExecutable(),
  });
  soil = new SoilScheduler({ store });
  stakes = new StakeRunner({ store });
  harvest = new Harvest({
    store,
    uncommitted: (plantId) => greenhouse.diffFiles(plantId, { kind: "uncommitted" }),
    openExternal: (url) => void shell.openExternal(url),
    wake: (plantId, text) => void greenhouse.send(plantId, text).catch((err) => console.error("[terrarium] wake failed", err)),
    wakeOnRedStake: () => store.settings().wakeOnRedStake,
    env: () => ({ ...process.env }),
    idle: () => hiddenSince !== null && Date.now() - hiddenSince > 3600_000,
    claudeExecutable: claudeExecutable(),
  });
  volunteers = new Volunteers({ store, addBed: addBedIfPlantable, notify });
  almanac = new Almanac(store);

  pool.start();
  soil.start();
  harvest.start();
  void volunteers.start().catch((err) => console.error("[terrarium] volunteers failed to start", err));
  if (store.settings().hookInstalled) {
    void volunteers.listen(store.settings().hookPort, hookToken()).then((ok) => {
      if (!ok) console.warn(`[terrarium] could not listen on 127.0.0.1:${store.settings().hookPort}; terminal hook events will not arrive (another program may hold the port)`);
    });
  }
  const reaper = setInterval(() => greenhouse.reapIdle(), 60_000);
  reaper.unref();
  const scan = setInterval(() => {
    lastAlmanacScan = Date.now();
    void almanac.scan().catch((err) => console.error("[terrarium] almanac scan failed", err));
  }, 5 * 60_000);
  scan.unref();
  for (const id of store.beds.keys()) soil.request(id, "idle");
}

app.whenReady().then(() => {
  if (!firstInstance) return;
  logger = installLogger(join(app.getPath("userData"), "logs"));
  adoptShellPath();
  try {
    store = new GardenStore(join(app.getPath("userData"), "garden"));
  } catch (err) {
    dialog.showErrorBox("Terrarium could not open its garden", err instanceof Error ? err.message : String(err));
    app.quit();
    return;
  }
  startServices();
  store.on(queue);
  wireIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  greenhouse?.shutdown();
  pool?.stop();
  soil?.stop();
  harvest?.stop();
  volunteers?.stop();
  store?.close();
  logger?.close?.();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
