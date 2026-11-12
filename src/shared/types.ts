// Types shared by the main process (which runs the agents) and the renderer (which draws the garden).
// The renderer never talks to Claude directly: it only sees these records and sends GardenApi calls.
// V2 contract: see docs/v2/PLAN.md. Keep this file free of Node and DOM APIs.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** What a plant is doing right now. */
export type PlantStatus =
  | "idle" // resting between turns (a seed if it has never grown)
  | "thinking" // model is working, no tool running
  | "working" // a tool is running
  | "waiting" // blocked on the gardener: permission, question or plan approval
  | "error"; // last turn failed: the plant has wilted

/** The kind of growth a tool call represents. Drives the plant's animation. */
export type Activity = "think" | "read" | "search" | "edit" | "run" | "web" | "delegate" | "todo" | "plan" | "other";

export const SPECIES = ["sunflower", "tulip", "daisy", "rose", "lavender", "poppy"] as const;
export type Species = (typeof SPECIES)[number];

/** A bed is one repository (any directory, really). */
export interface Bed {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Permanent slot in the garden grid. Assigned once; never changes when other beds change. */
  gridX?: number;
  gridY?: number;
  /** The fast check run after each turn that changed files ("the stake"). */
  stakeCommand?: string;
}

/**
 * Soil report: how well the bed is set up for agents to grow in it.
 * Guidance is compost, CI is the stake a plant grows against, tests are the fence,
 * lint/format is mulch that keeps weeds down.
 */
export interface SoilReport {
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  /** The repo's default branch (origin/HEAD, else main/master), when known. */
  defaultBranch?: string;
  /** Files with uncommitted changes: loose, freshly turned soil. */
  dirty: number;
  ahead: number;
  behind: number;
  guidance: string[];
  ci: string[];
  tests: string[];
  lint: string[];
  /** Check commands found in the repo, offered as the bed's stake (e.g. "npm run typecheck"). */
  stakeCandidates?: string[];
  /** 0..100: compost/stakes/fence/mulch plus recent stake pass rate. */
  health?: number;
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

/** Where a plant came from. */
export type PlantOrigin =
  | "sown" // started from Terrarium
  | "imported" // a past Claude Code session pulled in from history
  | "volunteer"; // a Claude Code session running in a terminal right now (or recently)

/** "bed": shares the repo's working tree. "pot": its own git worktree on its own branch. */
export type PlotKind = "bed" | "pot";

export interface PullRequestInfo {
  number?: number;
  url: string;
  state: "open" | "merged" | "closed";
  checks: "none" | "pending" | "passing" | "failing";
  review?: "approved" | "changes_requested" | "review_required";
  checkedAt: number;
}

export interface StakeResult {
  status: "running" | "passing" | "failing";
  command: string;
  /** One line, e.g. "3 failures" or "exit code 2". */
  summary?: string;
  /** The ring (turn number) this ran after. */
  turn?: number;
  at: number;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface Plant {
  id: string;
  bedId: string;
  name: string;
  species: Species;
  /** The task it was sown with. Shells sent to the renderer carry a clipped copy. */
  seed: string;
  origin: PlantOrigin;
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: PlantStatus;
  activity?: Activity;
  activityDetail?: string;
  /** True while a Claude Code process is alive for this plant. */
  live: boolean;
  /** Waiting for the process pool to admit it ("waiting for a free pot"). */
  queued?: boolean;
  turns: number;
  toolCalls: number;
  costUsd: number;
  /** Running subagents (Task/Agent tool calls in flight). */
  runners: number;
  todos?: { done: number; total: number };
  ask?: PendingAsk;
  /** A finished turn the gardener has not looked at yet: ready to harvest. */
  unread: boolean;
  /** Clipped to a short preview in shells; the journal has the full text. */
  lastText?: string;
  error?: string;
  /** Kept in the ground even when old. */
  pinned?: boolean;
  /** Set when harvested (PR merged) or put away; the plant then lives in the Seed Catalogue. */
  archivedAt?: number;

  // Isolation (M3)
  plot: PlotKind;
  /** Absolute cwd the session runs in (worktree for pots, bed path otherwise; terminal cwd for volunteers). */
  cwd?: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
  /** Uncommitted + unpushed changes in the pot (loose soil on the rim). */
  potDirty?: number;
  /** The pot's worktree or setup has not finished yet (survives restarts so an interrupted setup is reported). */
  potPending?: boolean;

  // Rings (M4)
  /** Lines changed by the last turn (the leaf tally). */
  lastDiff?: DiffStat;
  /** Highest ring that is not pruned. */
  ring?: number;
  /** After "prune back": the assistant message uuid the next turn resumes from (internal). */
  resumeAt?: string;

  // Harvest (M5)
  pr?: PullRequestInfo;
  /** Committed changes not yet pushed. */
  unpushed?: number;

  // Stakes (M7)
  stake?: StakeResult;

  // Volunteers (M6)
  /** Volunteer whose terminal session has ended: it can be adopted. */
  ended?: boolean;
  /** How the volunteer is watched: "hook" (precise) or "transcript" (no reliable waiting state). */
  watchedBy?: "hook" | "transcript";

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
  /** Preview (first 4 KB). When `outputTruncated`, fetch the full output with `toolOutput()`. */
  output?: string;
  outputTruncated?: boolean;
  outputBytes?: number;
}

/** One line in a plant's growth journal. Entries are upserted by id. */
export interface Entry {
  id: string;
  plantId: string;
  /** Per-plant order, assigned by the store. Used for paging. */
  seq?: number;
  ts: number;
  kind: EntryKind;
  text: string;
  tool?: ToolCall;
}

export interface JournalPage {
  entries: Entry[];
  /** True when older entries exist before the first one returned. */
  hasMore: boolean;
}

/** A completed turn: a growth ring. Each has before/after checkpoints you can diff or prune back to. */
export interface Ring {
  plantId: string;
  n: number;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  costUsd?: number;
  /** Diffstat between the turn's before and after checkpoints. Undefined if checkpoints were skipped. */
  diff?: DiffStat;
  checkpoint: "ready" | "skipped" | "none";
  /** Why a checkpoint was skipped (not a git repo, repo too large, git error). */
  checkpointNote?: string;
  pruned?: boolean;
  /** Result of the bed's stake (check command) run after this ring, if any. */
  stake?: StakeResult;
}

/** A review comment tied to lines of a diff; sent as structured context with the next message. */
export interface ReviewTag {
  id: string;
  path: string;
  /** Line range in the new file (or old file for deleted lines). */
  startLine: number;
  endLine: number;
  /** The selected lines rebuilt as a small @@ hunk. */
  hunk: string;
  note: string;
}

export type DiffScope =
  | { kind: "turn"; n: number } // what one ring changed
  | { kind: "sown" } // the pot's base to now (everything this plant did)
  | { kind: "uncommitted" }; // working tree vs HEAD

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  insertions: number;
  deletions: number;
}

export interface PruneResult {
  /** Files were restored (only allowed for pots, or a bed with no other live plant). */
  filesRestored: boolean;
  conversationRewound: boolean;
  /** Plain explanation shown to the user, e.g. why files were left alone. */
  note: string;
}

export interface HarvestInfo {
  isGitRepo: boolean;
  branch?: string;
  base?: string;
  /** True when the plant would commit straight to the default branch. */
  onDefaultBranch: boolean;
  files: DiffFile[];
  /** Commits on this branch not on the remote. */
  unpushed: number;
  hasRemote: boolean;
  remoteUrl?: string;
  /** `gh` installed and logged in for this remote's host. */
  ghReady: boolean;
  pr?: PullRequestInfo;
}

export interface CommitMessage {
  subject: string;
  body: string;
}

export interface UsageBucket {
  /** Local day "YYYY-MM-DD". */
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageRow {
  key: string;
  label: string;
  costUsd: number;
  tokens: number;
  turns?: number;
}

export interface UsageReport {
  days: UsageBucket[];
  byBed: UsageRow[];
  byModel: UsageRow[];
  byPlant: UsageRow[];
  totalCostUsd: number;
  /** Cache read tokens / all input tokens. */
  cacheHitRatio: number;
  /** Costs are Claude Code's own estimates; true when some sessions had no cost data and were priced from averages. */
  estimated: boolean;
  scannedAt: number;
}

/** Usage-limit state for subscription users, drawn as weather. */
export interface Weather {
  status: "clear" | "clouds" | "rain";
  utilization?: number;
  resetsAt?: number;
  limitType?: string;
  at: number;
}

export interface PoolInfo {
  live: number;
  /** How many more processes fit right now, from free memory. */
  canAdmit: number;
  /** Sanity ceiling from total RAM. */
  ceiling: number;
  freeBytes: number;
  totalBytes: number;
  /** Moving average size of one Claude process tree. */
  perProcessBytes: number;
  queued: number;
  userMax?: number;
}

export interface Settings {
  /** Optional maximum live processes; undefined = decided by memory only. */
  maxLive?: number;
  /** Minutes before an idle plant's process is closed. */
  idleMinutes: number;
  /** Watch terminal sessions through a Claude Code hook (opt-in). */
  hookInstalled: boolean;
  hookPort: number;
  /** First-run flow finished. */
  onboarded: boolean;
  /** Offer to message the plant when its PR checks fail. */
  wakeOnRedStake: boolean;
  /** UI text size in percent. Scales the chrome's text only; the garden canvas keeps its whole-number zoom. */
  textSize: TextSize;
  /** "system" follows the OS light/dark preference. */
  theme: "system" | "light" | "dark";
  /** "system" follows the OS reduced-motion preference. */
  motion: "system" | "reduce" | "allow";
  /** Tell screen readers when a plant starts needing you, wilts, or finishes a turn. */
  announce: boolean;
}

export type TextSize = 100 | 125 | 150;

export interface HookStatus {
  installed: boolean;
  /** The exact JSON Terrarium adds to ~/.claude/settings.json. */
  preview: string;
  settingsPath: string;
  listening: boolean;
  note?: string;
}

export interface SearchHit {
  plantId: string;
  bedId: string;
  /** Present when the hit is inside a journal entry. */
  entryId?: string;
  title: string;
  snippet: string;
}

export interface Snapshot {
  beds: Bed[];
  /** Plant shells: seed and lastText clipped. */
  plants: Plant[];
  soil: Record<string, SoilReport>;
  pool: PoolInfo;
  weather?: Weather;
  settings: Settings;
  demo?: boolean;
}

export interface SowRequest {
  bedId: string;
  prompt: string;
  name?: string;
  species?: Species;
  permissionMode: PermissionMode;
  model?: string;
  /** Default "pot" for git repos. */
  plot?: PlotKind;
  /** Branch or commit to start the pot from; default: the bed's current branch. */
  baseRef?: string;
  /** Fetch the base from origin first. */
  fromOrigin?: boolean;
}

export interface FirstRunCheck {
  git: { ok: boolean; version?: string };
  claude: { ok: boolean; note?: string };
  gh: { ok: boolean; note?: string };
  historySessions: number;
  historyBeds: number;
}

export type GardenEvent =
  | { type: "bed"; bed: Bed }
  | { type: "bed:removed"; id: string }
  /** A new plant, or a full replace. */
  | { type: "plant"; plant: Plant }
  /** Changed fields only. */
  | { type: "plant:patch"; id: string; patch: Partial<Plant> }
  | { type: "plant:removed"; id: string }
  | { type: "soil"; bedId: string; report: SoilReport }
  /** Only sent for journals the renderer has open. */
  | { type: "entry"; entry: Entry }
  /** A ring was added or changed (only for open journals). */
  | { type: "ring"; ring: Ring }
  | { type: "pool"; pool: PoolInfo }
  | { type: "weather"; weather: Weather }
  | { type: "settings"; settings: Settings }
  /** Ask the UI to select a plant (e.g. the gardener clicked a notification). */
  | { type: "focus"; plantId: string }
  /** Several events coalesced into one IPC message; apply in order. */
  | { type: "batch"; events: GardenEvent[] };

/** Everything the renderer may ask of the main process. */
export interface GardenApi {
  snapshot(): Promise<Snapshot>;

  // Journal (paged, subscription-based)
  openJournal(plantId: string, limit?: number): Promise<JournalPage>;
  journalPage(plantId: string, beforeSeq: number, limit?: number): Promise<JournalPage>;
  closeJournal(plantId: string): Promise<void>;
  toolOutput(plantId: string, entryId: string): Promise<string>;
  search(query: string): Promise<SearchHit[]>;

  // Beds
  pickDirectory(): Promise<string | null>;
  addBed(path: string): Promise<Bed>;
  removeBed(id: string): Promise<void>;
  refreshSoil(bedId: string): Promise<void>;
  setStake(bedId: string, command: string | null): Promise<void>;
  soilHistory(bedId: string): Promise<{ day: string; health: number }[]>;

  // Plants
  sow(req: SowRequest): Promise<Plant>;
  send(plantId: string, text: string): Promise<void>;
  interrupt(plantId: string): Promise<void>;
  answer(plantId: string, askId: string, response: AskResponse): Promise<void>;
  setMode(plantId: string, mode: PermissionMode): Promise<void>;
  markRead(plantId: string): Promise<void>;
  setPinned(plantId: string, pinned: boolean): Promise<void>;
  uproot(plantId: string, opts?: { deleteBranch?: boolean }): Promise<void>;
  /** Volunteer whose terminal session ended → a sown plant you can message. */
  adopt(plantId: string): Promise<void>;
  reveal(path: string): Promise<void>;

  // Rings, diffs, pruning (M4)
  rings(plantId: string): Promise<Ring[]>;
  diffFiles(plantId: string, scope: DiffScope): Promise<DiffFile[]>;
  /** One file's patch, capped at 1 MB; `full` raises the cap to 50 MB ("show anyway"). */
  diffFile(plantId: string, scope: DiffScope, path: string, opts?: { full?: boolean }): Promise<string>;
  pruneTo(plantId: string, ring: number): Promise<PruneResult>;
  /** New potted plant grown from a ring (conversation fork + pot from that checkpoint). */
  forkAt(plantId: string, ring: number): Promise<Plant>;

  // Harvest (M5)
  harvestInfo(plantId: string): Promise<HarvestInfo>;
  commitMessage(plantId: string): Promise<CommitMessage>;
  commit(plantId: string, message: CommitMessage, files?: string[]): Promise<{ sha: string }>;
  push(plantId: string): Promise<void>;
  openPullRequest(plantId: string, pr: { title: string; body: string }): Promise<{ url: string; viaBrowser: boolean }>;
  runStake(plantId: string): Promise<void>;

  // Almanac, settings, volunteers (M6, M8)
  usage(days: number): Promise<UsageReport>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  hookStatus(): Promise<HookStatus>;
  installHook(): Promise<HookStatus>;
  uninstallHook(): Promise<HookStatus>;
  firstRunCheck(): Promise<FirstRunCheck>;
  importHistory(): Promise<{ added: number }>;
  diagnostics(): Promise<string>;

  onEvent(listener: (event: GardenEvent) => void): () => void;
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
