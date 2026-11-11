// A simulated garden for previewing the UI in a plain browser (`npm run demo`).
// It speaks the same GardenApi as the real main process, with scripted agents instead of Claude.
import { activityForTool, nameFromPrompt, nextSpecies, summarizeToolInput } from "../../shared/garden";
import type {
  AskResponse,
  Bed,
  Entry,
  GardenApi,
  GardenEvent,
  PendingAsk,
  PermissionMode,
  Plant,
  SoilReport,
  SowRequest,
} from "../../shared/types";

let n = 0;
const uid = (p = "id") => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const now = () => Date.now();

type Step =
  | { kind: "think"; ms: number; text?: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; ms: number; output?: string; ask?: boolean }
  | { kind: "ask-question" }
  | { kind: "plan"; plan: string }
  | { kind: "done"; text: string }
  | { kind: "fail"; text: string };

const SCRIPT: Step[] = [
  { kind: "think", ms: 1800, text: "Let me look at how the wire protocol is assembled before touching anything." },
  { kind: "tool", name: "Glob", input: { pattern: "src/**/*.ts" }, ms: 1400, output: "src/server/wire.ts\nsrc/server/thread.ts\nsrc/client/sync.ts" },
  { kind: "tool", name: "Read", input: { file_path: "src/server/wire.ts" }, ms: 2200, output: "export function encodeThread(...) {\n  …\n}" },
  { kind: "tool", name: "Grep", input: { pattern: "encodeThread", path: "src" }, ms: 1500, output: "src/server/thread.ts:41\nsrc/client/sync.ts:12" },
  { kind: "tool", name: "TodoWrite", input: { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] }, ms: 900 },
  { kind: "think", ms: 1600 },
  { kind: "tool", name: "Edit", input: { file_path: "src/server/wire.ts", old_string: "events.map(full)", new_string: "events.map(compact)" }, ms: 2400, ask: true },
  { kind: "tool", name: "Task", input: { description: "Check other callers", prompt: "Find every caller of encodeThread" }, ms: 3400, output: "Two callers, both fine." },
  { kind: "tool", name: "Bash", input: { command: "npm test -- wire", description: "Run the wire tests" }, ms: 2600, output: "✓ 14 tests passed", ask: true },
  { kind: "tool", name: "WebFetch", input: { url: "https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream" }, ms: 2000, output: "…" },
  { kind: "done", text: "Switched thread events to the compact encoding. Payload for the big fixture thread drops from 41 KB to 6 KB; wire tests pass. One thing to decide: the mobile client still asks for `full` in one place, want me to move it too?" },
];

function soil(partial: Partial<SoilReport>): SoilReport {
  return {
    exists: true,
    isGitRepo: true,
    branch: "main",
    dirty: 0,
    ahead: 0,
    behind: 0,
    guidance: [],
    ci: [],
    tests: [],
    lint: [],
    checkedAt: now(),
    ...partial,
  };
}

function seedGarden() {
  const beds: Bed[] = [
    { id: "bed-t3", name: "t3code", path: "~/code/t3code", createdAt: now() - 9e6 },
    { id: "bed-garden", name: "gardener", path: "~/code/gardener", createdAt: now() - 8e6 },
    { id: "bed-site", name: "marketing-site", path: "~/code/marketing-site", createdAt: now() - 7e6 },
  ];
  const soilMap: Record<string, SoilReport> = {
    "bed-t3": soil({ branch: "theo/wire-v2", dirty: 7, ahead: 2, guidance: ["AGENTS.md", "CLAUDE.md"], ci: [".github/workflows"], tests: ["npm test"], lint: ["oxlint", ".prettierrc"] }),
    "bed-garden": soil({ branch: "main", dirty: 2, guidance: ["CLAUDE.md"], tests: ["vitest.config.ts"], lint: [] }),
    "bed-site": soil({ branch: "redesign", dirty: 0, guidance: [], ci: [], tests: [], lint: [".prettierrc"] }),
  };
  const base = (p: Partial<Plant> & Pick<Plant, "bedId" | "name" | "species" | "seed">): Plant => ({
    id: uid("plant"),
    permissionMode: "default",
    status: "idle",
    live: false,
    turns: 0,
    toolCalls: 0,
    costUsd: 0,
    runners: 0,
    unread: false,
    model: "claude-opus-5-5",
    createdAt: now() - 5e6 + n * 1000,
    updatedAt: now(),
    ...p,
  });
  const plants: Plant[] = [
    base({ bedId: "bed-t3", name: "Compact wire protocol", species: "sunflower", seed: "Shrink the thread payload", status: "working", activity: "edit", activityDetail: "src/server/wire.ts", live: true, turns: 5, toolCalls: 61, costUsd: 1.92, todos: { done: 2, total: 5 } }),
    base({ bedId: "bed-t3", name: "Delete useless tests", species: "tulip", seed: "Find and remove tests that never catch anything", status: "waiting", live: true, turns: 3, toolCalls: 22, costUsd: 0.71, permissionMode: "default" }),
    base({ bedId: "bed-t3", name: "Thread transfer check", species: "lavender", seed: "Add a CI check for thread payload size", status: "idle", turns: 9, toolCalls: 140, costUsd: 4.1, unread: true, lastText: "Added the thread transfer impact action. It posts the payload diff on every PR and fails on >10% regressions." }),
    base({ bedId: "bed-t3", name: "Investigate flaky reconnect", species: "rose", seed: "Why does reconnect flake on mobile", status: "working", activity: "delegate", activityDetail: "runner: Grep reconnect", runners: 2, live: true, turns: 2, toolCalls: 17, costUsd: 0.5 }),
    base({ bedId: "bed-garden", name: "Plan sync engine port", species: "daisy", seed: "Plan moving the custom sync engine to Convex", status: "waiting", permissionMode: "plan", live: true, turns: 1, toolCalls: 30, costUsd: 0.9 }),
    base({ bedId: "bed-garden", name: "Rewrite bed layout", species: "poppy", seed: "Make beds wrap nicely on small windows", status: "thinking", activity: "think", live: true, turns: 4, toolCalls: 33, costUsd: 0.88 }),
    base({ bedId: "bed-garden", name: "Fix soil polling", species: "sunflower", seed: "Soil polling runs git too often", status: "error", error: "Hit a usage limit. The plant will need to wait for the next window.", turns: 2, toolCalls: 12, costUsd: 0.3 }),
    base({ bedId: "bed-site", name: "Hero section copy", species: "tulip", seed: "Draft new hero copy", status: "idle", turns: 0 }),
    base({ bedId: "bed-site", name: "Survey the bed", species: "daisy", seed: "Give me a tour", status: "working", activity: "read", activityDetail: "src/pages/index.astro", live: true, turns: 0, toolCalls: 4, costUsd: 0.04, permissionMode: "plan" }),
  ];
  return { beds, soil: soilMap, plants };
}

export function createDemo(): GardenApi {
  const seeded = seedGarden();
  const beds = new Map(seeded.beds.map((b) => [b.id, b]));
  const plants = new Map(seeded.plants.map((p) => [p.id, p]));
  const soilMap = seeded.soil;
  const journals = new Map<string, Entry[]>();
  const listeners = new Set<(e: GardenEvent) => void>();
  const runs = new Map<string, { step: number; timer?: ReturnType<typeof setTimeout>; resume?: (r: AskResponse) => void }>();

  const emit = (e: GardenEvent) => listeners.forEach((l) => l(e));
  const update = (id: string, patch: Partial<Plant>) => {
    const p = plants.get(id);
    if (!p) return;
    const next = { ...p, ...patch, updatedAt: now() };
    plants.set(id, next);
    emit({ type: "plant", plant: next });
    return next;
  };
  const journal = (id: string) => {
    let j = journals.get(id);
    if (!j) {
      j = [];
      journals.set(id, j);
    }
    return j;
  };
  const entry = (plantId: string, e: Omit<Entry, "plantId" | "ts" | "id"> & { id?: string }) => {
    const j = journal(plantId);
    const full: Entry = { id: e.id ?? uid("e"), plantId, ts: now(), ...e };
    const i = j.findIndex((x) => x.id === full.id);
    if (i >= 0) j[i] = { ...full, ts: j[i].ts };
    else j.push(full);
    emit({ type: "entry", entry: i >= 0 ? j[i] : full });
  };

  // Give the pre-seeded plants a little history.
  for (const p of plants.values()) {
    entry(p.id, { kind: "system", text: `Rooted in ${beds.get(p.bedId)?.path} · ${p.model} · Claude Code (demo)` });
    entry(p.id, { kind: "user", text: p.seed });
    if (p.turns > 0) entry(p.id, { kind: "text", text: p.lastText ?? "Looked around the bed and made a first pass." });
    if (p.unread) entry(p.id, { kind: "result", text: `Bloomed after 12 steps · 94s · $${p.costUsd.toFixed(2)} so far` });
    if (p.status === "error") entry(p.id, { kind: "error", text: p.error ?? "Wilted" });
  }

  const askFor = (p: Plant, ask: PendingAsk) => update(p.id, { status: "waiting", ask });

  // Pre-seeded waiting plants get real asks.
  for (const p of plants.values()) {
    if (p.status !== "waiting") continue;
    if (p.permissionMode === "plan") {
      askFor(p, {
        id: uid("ask"),
        kind: "plan",
        toolName: "ExitPlanMode",
        title: "A plan, waiting for your approval",
        detail: "",
        canAlwaysAllow: false,
        createdAt: now(),
        plan: "## Port the sync engine to Convex\n\n1. Model threads, messages and attachments as Convex tables.\n2. Replace the hand-rolled websocket diffing with `useQuery` subscriptions.\n3. Keep the old engine behind a flag for one release; dual-write during the window.\n4. Delete `src/sync/*` once the flag has been on for a week with no regressions.\n\nRisk: attachment uploads, which currently stream through the sync socket.",
      });
    } else {
      askFor(p, {
        id: uid("ask"),
        kind: "permission",
        toolName: "Bash",
        title: "Claude wants to run a command",
        detail: "Delete 212 test files that only assert mocks were called\n\n$ git rm $(cat /tmp/useless-tests.txt)",
        reason: "Bash commands that delete files need approval",
        canAlwaysAllow: true,
        createdAt: now(),
      });
    }
  }

  function runStep(plantId: string) {
    const run = runs.get(plantId);
    const p = plants.get(plantId);
    if (!run || !p) return;
    const step = SCRIPT[run.step % SCRIPT.length];
    run.step++;
    const next = (ms: number) => (run.timer = setTimeout(() => runStep(plantId), ms));
    switch (step.kind) {
      case "think":
        update(plantId, { status: "thinking", activity: "think", activityDetail: undefined });
        if (step.text) entry(plantId, { kind: "text", text: step.text });
        next(step.ms);
        return;
      case "tool": {
        const needsAsk = step.ask && p.permissionMode === "default";
        const toolId = uid("tool");
        const activity = activityForTool(step.name);
        const summary = summarizeToolInput(step.name, step.input);
        const go = () => {
          const cur = plants.get(plantId)!;
          entry(plantId, { id: `tool:${toolId}`, kind: "tool", text: step.name, tool: { id: toolId, name: step.name, summary, activity, status: "running" } });
          update(plantId, {
            status: "working",
            activity,
            activityDetail: summary,
            toolCalls: cur.toolCalls + 1,
            ask: undefined,
            runners: activity === "delegate" ? 1 : cur.runners,
            todos: step.name === "TodoWrite" ? { done: 1, total: 3 } : cur.todos,
          });
          run.timer = setTimeout(() => {
            entry(plantId, { id: `tool:${toolId}`, kind: "tool", text: step.name, tool: { id: toolId, name: step.name, summary, activity, status: "ok", output: step.output } });
            update(plantId, { runners: 0 });
            runStep(plantId);
          }, step.ms);
        };
        if (needsAsk) {
          const ask: PendingAsk = {
            id: uid("ask"),
            kind: "permission",
            toolName: step.name,
            title: step.name === "Bash" ? "Claude wants to run a command" : `Claude wants to edit ${String(step.input.file_path)}`,
            detail: step.name === "Bash" ? `${step.input.description}\n\n$ ${step.input.command}` : `${step.input.file_path}\n\n- ${step.input.old_string}\n+ ${step.input.new_string}`,
            canAlwaysAllow: true,
            createdAt: now(),
          };
          askFor(p, ask);
          run.resume = (r) => {
            run.resume = undefined;
            if (r.behavior === "allow") go();
            else {
              entry(plantId, { kind: "text", text: "Understood, I'll leave that alone." });
              update(plantId, { ask: undefined });
              runStep(plantId);
            }
          };
        } else go();
        return;
      }
      case "done": {
        const cur = plants.get(plantId)!;
        entry(plantId, { kind: "text", text: step.text });
        entry(plantId, { kind: "result", text: `Bloomed after ${SCRIPT.length} steps · 26s · $${(cur.costUsd + 0.42).toFixed(2)} so far` });
        update(plantId, {
          status: "idle",
          activity: undefined,
          activityDetail: undefined,
          turns: cur.turns + 1,
          costUsd: cur.costUsd + 0.42,
          unread: true,
          lastText: step.text,
          todos: { done: 3, total: 3 },
        });
        runs.delete(plantId);
        return;
      }
      default:
        next(500);
    }
  }

  function start(plantId: string) {
    const existing = runs.get(plantId);
    if (existing?.timer) clearTimeout(existing.timer);
    runs.set(plantId, { step: 0 });
    update(plantId, { status: "thinking", activity: "think", live: true, unread: false, error: undefined });
    setTimeout(() => runStep(plantId), 900);
  }

  // Keep the pre-seeded busy plants looking alive.
  const ambient = ["read", "search", "edit", "run", "web", "think"] as const;
  setInterval(() => {
    for (const p of plants.values()) {
      if (runs.has(p.id) || (p.status !== "working" && p.status !== "thinking")) continue;
      if (Math.random() < 0.5) continue;
      const a = ambient[Math.floor(Math.random() * ambient.length)];
      update(p.id, { status: a === "think" ? "thinking" : "working", activity: a, toolCalls: p.toolCalls + 1 });
    }
  }, 4200);

  const api: GardenApi = {
    async snapshot() {
      return { beds: [...beds.values()], plants: [...plants.values()], soil: soilMap, demo: true };
    },
    async entries(plantId) {
      return [...journal(plantId)];
    },
    async pickDirectory() {
      const name = prompt("Demo: name a folder to plant a bed in", "~/code/new-project");
      return name || null;
    },
    async addBed(path) {
      const bed: Bed = { id: uid("bed"), name: path.split("/").filter(Boolean).pop() ?? path, path, createdAt: now() };
      beds.set(bed.id, bed);
      soilMap[bed.id] = soil({ branch: "main" });
      emit({ type: "bed", bed });
      emit({ type: "soil", bedId: bed.id, report: soilMap[bed.id] });
      return bed;
    },
    async removeBed(id) {
      for (const p of [...plants.values()]) if (p.bedId === id) await api.uproot(p.id);
      beds.delete(id);
      emit({ type: "bed:removed", id });
    },
    async refreshSoil() {},
    async sow(req: SowRequest) {
      const siblings = [...plants.values()].filter((p) => p.bedId === req.bedId);
      const plant: Plant = {
        id: uid("plant"),
        bedId: req.bedId,
        name: req.name?.trim() || nameFromPrompt(req.prompt),
        species: req.species ?? nextSpecies(siblings.map((p) => p.species)),
        seed: req.prompt,
        model: req.model || "claude-opus-5-5",
        permissionMode: req.permissionMode,
        status: "idle",
        live: false,
        turns: 0,
        toolCalls: 0,
        costUsd: 0,
        runners: 0,
        unread: false,
        createdAt: now(),
        updatedAt: now(),
      };
      plants.set(plant.id, plant);
      emit({ type: "plant", plant });
      if (req.prompt.trim()) await api.send(plant.id, req.prompt);
      return plant;
    },
    async send(plantId, text) {
      entry(plantId, { kind: "user", text });
      const run = runs.get(plantId);
      if (run?.resume) {
        run.resume({ behavior: "deny", message: text });
        return;
      }
      start(plantId);
    },
    async interrupt(plantId) {
      const run = runs.get(plantId);
      if (run?.timer) clearTimeout(run.timer);
      runs.delete(plantId);
      entry(plantId, { kind: "system", text: "Paused by you." });
      update(plantId, { status: "idle", activity: undefined, ask: undefined, runners: 0 });
    },
    async answer(plantId, askId, response) {
      const p = plants.get(plantId);
      if (!p?.ask || p.ask.id !== askId) return;
      const ask = p.ask;
      entry(plantId, { kind: "system", text: response.behavior === "allow" ? `Allowed ${ask.toolName}` : `Declined ${ask.toolName}` });
      if (response.behavior === "allow" && response.mode) update(plantId, { permissionMode: response.mode });
      const run = runs.get(plantId);
      if (run?.resume) {
        run.resume(response);
        return;
      }
      // Pre-seeded asks: approving starts the scripted run, declining rests the plant.
      if (response.behavior === "allow") {
        update(plantId, { ask: undefined });
        runs.set(plantId, { step: 5 });
        runStep(plantId);
      } else {
        update(plantId, { ask: undefined, status: "idle" });
      }
    },
    async setMode(plantId, mode: PermissionMode) {
      update(plantId, { permissionMode: mode });
    },
    async markRead(plantId) {
      if (plants.get(plantId)?.unread) update(plantId, { unread: false });
    },
    async uproot(plantId) {
      const run = runs.get(plantId);
      if (run?.timer) clearTimeout(run.timer);
      runs.delete(plantId);
      plants.delete(plantId);
      emit({ type: "plant:removed", id: plantId });
    },
    async reveal() {},
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}
