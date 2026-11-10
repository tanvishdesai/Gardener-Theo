// The garden's memory: beds, plants and each plant's journal, persisted as JSON under userData.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bed, Entry, GardenEvent, Plant, SoilReport, Snapshot } from "../shared/types";

const MAX_ENTRIES = 600;
const MAX_TOOL_OUTPUT = 4000;

interface GardenFile {
  version: 1;
  beds: Bed[];
  plants: Plant[];
}

export class GardenStore {
  readonly beds = new Map<string, Bed>();
  readonly plants = new Map<string, Plant>();
  readonly soil = new Map<string, SoilReport>();
  private journals = new Map<string, Entry[]>();
  private listeners = new Set<(e: GardenEvent) => void>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirtyJournals = new Set<string>();

  constructor(private dir: string) {
    mkdirSync(join(dir, "journals"), { recursive: true });
    this.load();
  }

  private get file() {
    return join(this.dir, "garden.json");
  }

  private journalFile(plantId: string) {
    return join(this.dir, "journals", `${plantId}.json`);
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as GardenFile;
      for (const bed of data.beds ?? []) this.beds.set(bed.id, bed);
      for (const plant of data.plants ?? []) {
        // Nothing is alive after a restart: whatever was growing is now resting.
        const wasBusy = plant.status === "thinking" || plant.status === "working" || plant.status === "waiting";
        this.plants.set(plant.id, {
          ...plant,
          live: false,
          runners: 0,
          ask: undefined,
          activity: undefined,
          activityDetail: undefined,
          status: wasBusy ? "idle" : plant.status,
        });
      }
    } catch (err) {
      console.error("[gardener] could not read garden.json, starting fresh", err);
    }
  }

  on(listener: (e: GardenEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: GardenEvent) {
    for (const l of this.listeners) l(event);
  }

  snapshot(): Snapshot {
    return {
      beds: [...this.beds.values()],
      plants: [...this.plants.values()],
      soil: Object.fromEntries(this.soil),
    };
  }

  putBed(bed: Bed) {
    this.beds.set(bed.id, bed);
    this.emit({ type: "bed", bed });
    this.scheduleSave();
  }

  deleteBed(id: string) {
    for (const p of [...this.plants.values()]) if (p.bedId === id) this.deletePlant(p.id);
    this.beds.delete(id);
    this.soil.delete(id);
    this.emit({ type: "bed:removed", id });
    this.scheduleSave();
  }

  putSoil(bedId: string, report: SoilReport) {
    const prev = this.soil.get(bedId);
    this.soil.set(bedId, report);
    if (prev && sameSoil(prev, report)) return;
    this.emit({ type: "soil", bedId, report });
  }

  putPlant(plant: Plant) {
    this.plants.set(plant.id, plant);
    this.emit({ type: "plant", plant });
    this.scheduleSave();
  }

  updatePlant(id: string, patch: Partial<Plant>): Plant | undefined {
    const prev = this.plants.get(id);
    if (!prev) return undefined;
    const next: Plant = { ...prev, ...patch, updatedAt: Date.now() };
    this.plants.set(id, next);
    this.emit({ type: "plant", plant: next });
    this.scheduleSave();
    return next;
  }

  deletePlant(id: string) {
    this.plants.delete(id);
    this.journals.delete(id);
    this.dirtyJournals.delete(id);
    rmSync(this.journalFile(id), { force: true });
    this.emit({ type: "plant:removed", id });
    this.scheduleSave();
  }

  entries(plantId: string): Entry[] {
    let list = this.journals.get(plantId);
    if (!list) {
      list = [];
      const f = this.journalFile(plantId);
      if (existsSync(f)) {
        try {
          list = JSON.parse(readFileSync(f, "utf8")) as Entry[];
        } catch {
          list = [];
        }
      }
      this.journals.set(plantId, list);
    }
    return list;
  }

  findEntry(plantId: string, id: string): Entry | undefined {
    return this.entries(plantId).find((e) => e.id === id);
  }

  upsertEntry(entry: Entry) {
    if (!this.plants.has(entry.plantId)) return;
    const clean = trimEntry(entry);
    const list = this.entries(entry.plantId);
    // Updates almost always hit one of the last few entries (a tool result for a recent call).
    let idx = -1;
    for (let i = list.length - 1; i >= Math.max(0, list.length - 200); i--) {
      if (list[i].id === clean.id) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) list[idx] = clean;
    else {
      list.push(clean);
      if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    }
    this.dirtyJournals.add(entry.plantId);
    this.emit({ type: "entry", entry: clean });
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 400);
  }

  flush() {
    const data: GardenFile = {
      version: 1,
      beds: [...this.beds.values()],
      plants: [...this.plants.values()],
    };
    atomicWrite(this.file, JSON.stringify(data, null, 2));
    for (const id of this.dirtyJournals) {
      const list = this.journals.get(id);
      if (list) atomicWrite(this.journalFile(id), JSON.stringify(list));
    }
    this.dirtyJournals.clear();
  }
}

function atomicWrite(file: string, content: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function trimEntry(e: Entry): Entry {
  if (e.tool?.output && e.tool.output.length > MAX_TOOL_OUTPUT) {
    return { ...e, tool: { ...e.tool, output: `${e.tool.output.slice(0, MAX_TOOL_OUTPUT)}\n…` } };
  }
  return e;
}

function sameSoil(a: SoilReport, b: SoilReport) {
  const { checkedAt: _a, ...ra } = a;
  const { checkedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}
