// Electron main process: owns the garden (store), the greenhouse (Claude sessions) and the window.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AskResponse, Bed, GardenEvent, PermissionMode, Plant, SowRequest } from "../shared/types";
import { Greenhouse } from "./agents";
import { readSoil } from "./soil";
import { GardenStore } from "./store";

app.setName("Gardener");

/** GUI apps on macOS/Linux start with a bare PATH; borrow the login shell's so git and friends resolve. */
function adoptShellPath() {
  if (process.platform === "win32") return;
  try {
    const sh = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const out = execFileSync(sh, ["-ilc", 'printf "__GARDENER_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 4000 });
    const path = out.split("__GARDENER_PATH__")[1]?.trim();
    if (path) process.env.PATH = path;
  } catch {
    // keep what we have
  }
}

let win: BrowserWindow | null = null;
let store: GardenStore;
let greenhouse: Greenhouse;
const soilTimers = new Map<string, NodeJS.Timeout>();

function send(event: GardenEvent) {
  if (win && !win.isDestroyed()) win.webContents.send("garden:event", event);
}

function refreshSoil(bedId: string) {
  // Coalesce bursts (several plants finishing at once) into one git call.
  if (soilTimers.has(bedId)) return;
  soilTimers.set(
    bedId,
    setTimeout(async () => {
      soilTimers.delete(bedId);
      const bed = store.beds.get(bedId);
      if (!bed) return;
      store.putSoil(bedId, await readSoil(bed.path));
    }, 250),
  );
}

function updateBadge() {
  const needy = [...store.plants.values()].filter((p) => p.status === "waiting" || p.status === "error").length;
  app.setBadgeCount(needy);
}

function notify(plant: Plant, why: string) {
  if (win?.isFocused()) return;
  if (!Notification.isSupported()) return;
  const bed = store.beds.get(plant.bedId);
  const n = new Notification({ title: `${plant.name} needs you`, body: `${bed ? `${bed.name}: ` : ""}${why}`, silent: false });
  n.on("click", () => {
    win?.show();
    win?.focus();
    send({ type: "focus", plantId: plant.id });
  });
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: "Gardener",
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
    for (const id of store.beds.keys()) refreshSoil(id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function handle<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(`garden:${name}`, (_e, ...args) => fn(...(args as A)));
}

function wireIpc() {
  handle("snapshot", () => store.snapshot());
  handle("entries", (plantId: string) => store.entries(plantId));
  handle("pickDirectory", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "Choose a repository to plant a bed in",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle("addBed", (path: string) => {
    const full = resolve(path);
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`Not a folder: ${full}`);
    const existing = [...store.beds.values()].find((b) => b.path === full);
    if (existing) return existing;
    const bed: Bed = { id: randomUUID(), name: basename(full) || full, path: full, createdAt: Date.now() };
    store.putBed(bed);
    refreshSoil(bed.id);
    return bed;
  });
  handle("removeBed", (id: string) => {
    greenhouse.closeBed(id);
    store.deleteBed(id);
  });
  handle("refreshSoil", (bedId: string) => refreshSoil(bedId));
  handle("sow", (req: SowRequest) => greenhouse.sow(req));
  handle("send", (plantId: string, text: string) => greenhouse.send(plantId, text));
  handle("interrupt", (plantId: string) => greenhouse.interrupt(plantId));
  handle("answer", (plantId: string, askId: string, r: AskResponse) => greenhouse.answer(plantId, askId, r));
  handle("setMode", (plantId: string, mode: PermissionMode) => greenhouse.setMode(plantId, mode));
  handle("markRead", (plantId: string) => {
    if (store.plants.get(plantId)?.unread) store.updatePlant(plantId, { unread: false });
  });
  handle("uproot", (plantId: string) => greenhouse.uproot(plantId));
  handle("reveal", (path: string) => {
    void shell.openPath(path);
  });
}

app.whenReady().then(() => {
  adoptShellPath();
  store = new GardenStore(join(app.getPath("userData"), "garden"));
  greenhouse = new Greenhouse(store, {
    onTurnEnd: (plant) => refreshSoil(plant.bedId),
    onNeedsYou: notify,
    env: () => ({ ...process.env }),
  });
  store.on((e) => {
    send(e);
    if (e.type === "plant" || e.type === "plant:removed") updateBadge();
  });
  wireIpc();
  createWindow();
  for (const id of store.beds.keys()) refreshSoil(id);
  setInterval(() => {
    for (const id of store.beds.keys()) refreshSoil(id);
  }, 20_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  greenhouse?.shutdown();
  store?.flush();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
