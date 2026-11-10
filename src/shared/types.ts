// Types shared by the main process (which runs the agents) and the renderer (which draws the garden).
// The renderer never talks to Claude directly: it only sees these records and sends GardenApi calls.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** What a plant is doing right now. */
export type PlantStatus =
  | "idle" // resting between turns (a seed if it has never grown)
  | "thinking" // model is working, no tool running
  | "working" // a tool is running
  | "waiting" // blocked on the gardener: permission, question or plan approval
  | "error"; // last turn failed: the plant has wilted

/** The kind of growth a tool call represents. Drives the plant's animation. */
export type Activity =
  | "think"
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "delegate"
  | "todo"
  | "plan"
  | "other";

export const SPECIES = ["sunflower", "tulip", "daisy", "rose", "lavender", "poppy"] as const;
export type Species = (typeof SPECIES)[number];

/** A bed is one repository (any directory, really). */
export interface Bed {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/**
 * Soil report: how well the bed is set up for agents to grow in it.
 * The metaphor comes straight from "engineers are gardeners":
 * guidance is compost, CI is the stake a plant grows against, tests are the fence,
 * lint/format is mulch that keeps weeds down.
 */
export interface SoilReport {
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  /** Files with uncommitted changes: loose, freshly turned soil. */
  dirty: number;
  ahead: number;
  behind: number;
  guidance: string[];
  ci: string[];
  tests: string[];
  lint: string[];
  checkedAt: number;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** Something a plant needs from the gardener before it can keep growing. */
export interface PendingAsk {
  id: string;
  kind: "permission" | "question" | "plan";
  toolName: string;
  title: string;
  /** Human readable summary of the tool input (command, file path, url...). */
  detail: string;
  reason?: string;
  canAlwaysAllow: boolean;
  questions?: AskQuestion[];
  plan?: string;
  createdAt: number;
}

export interface Plant {
  id: string;
  bedId: string;
  name: string;
  species: Species;
  /** The task it was sown with. */
  seed: string;
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: PlantStatus;
  activity?: Activity;
  activityDetail?: string;
  /** True while a Claude Code process is alive for this plant. */
  live: boolean;
  turns: number;
  toolCalls: number;
  costUsd: number;
  /** Running subagents (Task/Agent tool calls in flight). */
  runners: number;
  todos?: { done: number; total: number };
  ask?: PendingAsk;
  /** A finished turn the gardener has not looked at yet: ready to harvest. */
  unread: boolean;
  lastText?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type EntryKind = "user" | "text" | "thinking" | "tool" | "result" | "system" | "error";

export interface ToolCall {
  id: string;
  name: string;
  summary: string;
  activity: Activity;
  status: "running" | "ok" | "error";
  output?: string;
}

/** One line in a plant's growth journal. Entries are upserted by id. */
export interface Entry {
  id: string;
  plantId: string;
  ts: number;
  kind: EntryKind;
  text: string;
  tool?: ToolCall;
}

export interface Snapshot {
  beds: Bed[];
  plants: Plant[];
  soil: Record<string, SoilReport>;
  demo?: boolean;
}

export interface SowRequest {
  bedId: string;
  prompt: string;
  name?: string;
  species?: Species;
  permissionMode: PermissionMode;
  model?: string;
}

export type AskResponse =
  | {
      behavior: "allow";
      always?: boolean;
      /** question text -> answer (multi-select answers comma separated) */
      answers?: Record<string, string>;
      /** For plan approval: the mode to continue in. */
      mode?: PermissionMode;
    }
  | { behavior: "deny"; message?: string };

export type GardenEvent =
  | { type: "bed"; bed: Bed }
  | { type: "bed:removed"; id: string }
  | { type: "plant"; plant: Plant }
  | { type: "plant:removed"; id: string }
  | { type: "soil"; bedId: string; report: SoilReport }
  | { type: "entry"; entry: Entry }
  /** Ask the UI to select a plant (e.g. the gardener clicked a notification). */
  | { type: "focus"; plantId: string };

/** Everything the renderer may ask of the main process. */
export interface GardenApi {
  snapshot(): Promise<Snapshot>;
  entries(plantId: string): Promise<Entry[]>;
  pickDirectory(): Promise<string | null>;
  addBed(path: string): Promise<Bed>;
  removeBed(id: string): Promise<void>;
  refreshSoil(bedId: string): Promise<void>;
  sow(req: SowRequest): Promise<Plant>;
  send(plantId: string, text: string): Promise<void>;
  interrupt(plantId: string): Promise<void>;
  answer(plantId: string, askId: string, response: AskResponse): Promise<void>;
  setMode(plantId: string, mode: PermissionMode): Promise<void>;
  markRead(plantId: string): Promise<void>;
  uproot(plantId: string): Promise<void>;
  reveal(path: string): Promise<void>;
  onEvent(listener: (event: GardenEvent) => void): () => void;
}
