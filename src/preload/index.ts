// Exposes the garden API to the renderer. The renderer gets no Node or Electron access beyond this.
import { contextBridge, ipcRenderer } from "electron";
import type { GardenApi, GardenEvent } from "../shared/types";

type Method = Exclude<keyof GardenApi, "onEvent">;

/** Every GardenApi method is a plain invoke on `garden:<name>`; the list is checked against the type. */
const METHODS = [
  "snapshot",
  "openJournal",
  "journalPage",
  "closeJournal",
  "toolOutput",
  "search",
  "pickDirectory",
  "addBed",
  "removeBed",
  "refreshSoil",
  "setStake",
  "soilHistory",
  "sow",
  "send",
  "interrupt",
  "answer",
  "setMode",
  "markRead",
  "setPinned",
  "uproot",
  "adopt",
  "reveal",
  "rings",
  "diffFiles",
  "diffFile",
  "pruneTo",
  "forkAt",
  "harvestInfo",
  "commitMessage",
  "commit",
  "push",
  "openPullRequest",
  "runStake",
  "usage",
  "setSettings",
  "hookStatus",
  "installHook",
  "uninstallHook",
  "firstRunCheck",
  "importHistory",
  "diagnostics",
] as const satisfies readonly Method[];

// Compile-time check that no GardenApi method is missing from METHODS.
type Missing = Exclude<Method, (typeof METHODS)[number]>;
const complete: [Missing] extends [never] ? true : Missing = true;
void complete;

const api = Object.fromEntries(METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`garden:${name}`, ...args)])) as unknown as GardenApi;

api.onEvent = (listener) => {
  const wrapped = (_e: unknown, event: GardenEvent) => listener(event);
  ipcRenderer.on("garden:event", wrapped);
  return () => ipcRenderer.removeListener("garden:event", wrapped);
};

contextBridge.exposeInMainWorld("terrarium", api);
