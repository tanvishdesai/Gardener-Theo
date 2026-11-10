// Garden vocabulary shared by both processes: how tools map to growth, and the chores a gardener can sow.
import type { Activity, Plant, PermissionMode, SoilReport, Species } from "./types";
import { SPECIES } from "./types";

const ACTIVITY_BY_TOOL: Record<string, Activity> = {
  Read: "read",
  NotebookRead: "read",
  LSP: "read",
  ReadMcpResourceTool: "read",
  Glob: "search",
  Grep: "search",
  LS: "search",
  ToolSearch: "search",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  BashOutput: "run",
  KillShell: "run",
  PowerShell: "run",
  Monitor: "run",
  WebFetch: "web",
  WebSearch: "web",
  Task: "delegate",
  Agent: "delegate",
  SendMessage: "delegate",
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
  TaskList: "todo",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan",
};

export function activityForTool(name: string): Activity {
  if (ACTIVITY_BY_TOOL[name]) return ACTIVITY_BY_TOOL[name];
  if (name.startsWith("mcp__")) return "web";
  return "other";
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  think: "Photosynthesizing",
  read: "Spreading roots",
  search: "Feeling through the soil",
  edit: "Growing new leaves",
  run: "Being watered",
  web: "Out pollinating",
  delegate: "Sending out runners",
  todo: "Laying out rows",
  plan: "Building a trellis",
  other: "Growing",
};

export const ACTIVITY_HINT: Record<Activity, string> = {
  think: "thinking",
  read: "reading files",
  search: "searching the code",
  edit: "editing files",
  run: "running commands",
  web: "fetching from the web",
  delegate: "running subagents",
  todo: "updating its todo list",
  plan: "planning",
  other: "using a tool",
};

export function statusLabel(plant: Plant): string {
  switch (plant.status) {
    case "waiting":
      if (plant.ask?.kind === "plan") return "Wants you to approve a plan";
      if (plant.ask?.kind === "question") return "Has a question for you";
      return "Needs your permission";
    case "error":
      return "Wilted";
    case "thinking":
      return ACTIVITY_LABEL.think;
    case "working":
      return ACTIVITY_LABEL[plant.activity ?? "other"];
    case "idle":
      if (plant.turns === 0) return "A seed, waiting to be watered";
      return plant.unread ? "In bloom: ready to harvest" : "In bloom, resting";
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** One line describing what a tool call is doing, for logs and permission cards. */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.skill);
  if (name === "Grep" && str(i.pattern)) return `/${i.pattern}/${str(i.path) ? ` in ${i.path}` : ""}`;
  if (name === "TodoWrite" && Array.isArray(i.todos)) return `${i.todos.length} todos`;
  if (pick) return oneLine(pick, 240);
  try {
    return oneLine(JSON.stringify(i), 240);
  } catch {
    return "";
  }
}

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short name for a plant, from the task it was sown with. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words.join(" ");
  if (!name) return "Seedling";
  return name.length > 28 ? `${name.slice(0, 27)}…` : name[0].toUpperCase() + name.slice(1);
}

export function nextSpecies(existing: Species[]): Species {
  const counts = new Map<Species, number>(SPECIES.map((s) => [s, 0]));
  for (const s of existing) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: Species = SPECIES[0];
  for (const s of SPECIES) if ((counts.get(s) ?? 0) < (counts.get(best) ?? 0)) best = s;
  return best;
}

export const MODE_LABEL: Record<PermissionMode, { name: string; hint: string }> = {
  default: { name: "Ask me", hint: "Asks before edits and commands" },
  acceptEdits: { name: "Trust edits", hint: "Edits freely, asks before commands" },
  plan: { name: "Plan first", hint: "Read-only until you approve a plan" },
  bypassPermissions: { name: "Wild growth", hint: "Never asks. Only for sandboxes you trust" },
};

export interface Chore {
  id: string;
  title: string;
  /** What it is in the garden. */
  metaphor: string;
  prompt: string;
  mode: PermissionMode;
}

/** Tending work: the platform-side work that makes every later plant grow better. */
export const CHORES: Chore[] = [
  {
    id: "survey",
    title: "Survey the bed",
    metaphor: "Walk the rows before planting",
    mode: "plan",
    prompt:
      "Give me a short tour of this repository: what it does, how it is laid out, how to run it, how to test it, and the three places an agent is most likely to trip. Do not change any files.",
  },
  {
    id: "compost",
    title: "Add compost",
    metaphor: "Write the guidance agents grow toward",
    mode: "acceptEdits",
    prompt:
      "Read this repository and write (or tighten) a CLAUDE.md at the root: the commands to build, test and lint, the conventions that are not obvious from the code, and the mistakes an agent should avoid. Keep it short and concrete; delete anything stale or generic.",
  },
  {
    id: "weeds",
    title: "Pull weeds",
    metaphor: "Find the slop before it spreads",
    mode: "plan",
    prompt:
      "Look for weeds in this repository: dead code, unused exports and dependencies, redundant or useless tests, lint suppressions, duplicated helpers, misleading docs or examples an agent would copy. Rank them by how much they would mislead the next contributor and propose a plan to remove the worst ones. Do not change anything until I approve the plan.",
  },
  {
    id: "stake",
    title: "Drive a stake",
    metaphor: "A fast check that guides growth",
    mode: "plan",
    prompt:
      "Find one thing that keeps regressing (or would be easy to regress) in this repository, and propose a fast, automated check for it that runs in CI and reports clearly on every pull request, so agents and reviewers notice. Plan it first; implement once I approve.",
  },
];

export interface SoilCheck {
  id: "compost" | "stakes" | "fence" | "mulch";
  name: string;
  what: string;
  found: string[];
  missingHint: string;
  chore?: string;
}

export function soilChecks(report: SoilReport | undefined): SoilCheck[] {
  const r = report;
  return [
    {
      id: "compost",
      name: "Compost",
      what: "Agent guidance (CLAUDE.md / AGENTS.md)",
      found: r?.guidance ?? [],
      missingHint: "No guidance file. Agents will guess at your conventions.",
      chore: "compost",
    },
    {
      id: "stakes",
      name: "Stakes",
      what: "CI checks agents can grow against",
      found: r?.ci ?? [],
      missingHint: "No CI found. Nothing tells a plant it is growing crooked.",
      chore: "stake",
    },
    {
      id: "fence",
      name: "Fence",
      what: "Tests that keep regressions out",
      found: r?.tests ?? [],
      missingHint: "No tests found.",
    },
    {
      id: "mulch",
      name: "Mulch",
      what: "Lint and format config that smothers weeds",
      found: r?.lint ?? [],
      missingHint: "No lint or format config found.",
      chore: "weeds",
    },
  ];
}

export type BedMood = "fallow" | "sown" | "growing" | "tending" | "harvest";

export function bedMood(plants: Plant[]): BedMood {
  if (plants.length === 0) return "fallow";
  if (plants.some((p) => p.status === "waiting" || p.status === "error")) return "tending";
  if (plants.some((p) => p.status === "thinking" || p.status === "working")) return "growing";
  if (plants.some((p) => p.unread)) return "harvest";
  return "sown";
}

export const MOOD_LABEL: Record<BedMood, string> = {
  fallow: "Fallow",
  sown: "Sown",
  growing: "Growing",
  tending: "Needs tending",
  harvest: "Ready to harvest",
};

/** Maturity grows with completed turns: seed, sprout, young, mature, flourishing. */
export function maturity(turns: number): 0 | 1 | 2 | 3 | 4 {
  if (turns <= 0) return 0;
  if (turns === 1) return 1;
  if (turns <= 3) return 2;
  if (turns <= 7) return 3;
  return 4;
}
