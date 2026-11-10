// Exposes the garden API to the renderer. The renderer gets no Node or Electron access beyond this.
import { contextBridge, ipcRenderer } from "electron";
import type { GardenApi, GardenEvent } from "../shared/types";

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`garden:${name}`, ...args);

const api: GardenApi = {
  snapshot: call("snapshot") as GardenApi["snapshot"],
  entries: call("entries") as GardenApi["entries"],
  pickDirectory: call("pickDirectory") as GardenApi["pickDirectory"],
  addBed: call("addBed") as GardenApi["addBed"],
  removeBed: call("removeBed") as GardenApi["removeBed"],
  refreshSoil: call("refreshSoil") as GardenApi["refreshSoil"],
  sow: call("sow") as GardenApi["sow"],
  send: call("send") as GardenApi["send"],
  interrupt: call("interrupt") as GardenApi["interrupt"],
  answer: call("answer") as GardenApi["answer"],
  setMode: call("setMode") as GardenApi["setMode"],
  markRead: call("markRead") as GardenApi["markRead"],
  uproot: call("uproot") as GardenApi["uproot"],
  reveal: call("reveal") as GardenApi["reveal"],
  onEvent(listener) {
    const wrapped = (_e: unknown, event: GardenEvent) => listener(event);
    ipcRenderer.on("garden:event", wrapped);
    return () => ipcRenderer.removeListener("garden:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("gardener", api);
