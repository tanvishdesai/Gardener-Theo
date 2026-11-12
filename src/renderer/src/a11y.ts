// Accessibility: the appearance settings on <html> (theme, text size, motion) and the screen-reader
// announcements of plant transitions (needs you, wilted, ready to read). No store import: store.ts wires it.
import { activityForTool } from "../../shared/garden";
import type { Activity, Plant, Settings } from "../../shared/types";

type Appearance = Pick<Settings, "textSize" | "theme" | "motion">;
const KEY = "terrarium.appearance";

/** Put the appearance settings on <html>, and remember them so the next launch paints right before the snapshot arrives. */
export function applyAppearance(s: Partial<Appearance>) {
  const root = document.documentElement;
  if (s.theme === "light" || s.theme === "dark") root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  const size = s.textSize === 125 || s.textSize === 150 ? s.textSize : 100;
  root.classList.toggle("text-large", size > 100);
  root.style.setProperty("--text", String(size / 100));
  root.classList.toggle("motion-reduce", s.motion === "reduce");
  root.classList.toggle("motion-allow", s.motion === "allow");
  try {
    localStorage.setItem(KEY, JSON.stringify({ textSize: size, theme: s.theme, motion: s.motion }));
  } catch {
    // storage unavailable: the snapshot still applies them, a moment later
  }
}

export function cachedAppearance(): Partial<Appearance> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Appearance>;
  } catch {
    return {};
  }
}

// ---------- announcements ----------

export type Kind = "need" | "wilt" | "ready";

/** What a plant is announced as right now, if anything. */
export function plantState(p: Plant): Kind | null {
  if (p.archivedAt) return null;
  if (p.status === "waiting") return "need";
  if (p.status === "error") return "wilt";
  return p.unread && p.status === "idle" ? "ready" : null;
}

/** The announcement this patch deserves: entering a state, or a new question while already waiting. */
export function plantChange(prev: Plant | undefined, next: Plant | undefined): Kind | null {
  if (!prev || !next) return null; // sown, removed, or the first snapshot
  const k = plantState(next);
  if (!k) return null;
  if (k !== plantState(prev)) return k;
  return k === "need" && !!next.ask && prev.ask?.id !== next.ask.id ? k : null;
}

const PERMISSION_TO: Partial<Record<Activity, string>> = {
  run: "run a command",
  edit: "edit files",
  read: "read files",
  search: "search the code",
  web: "fetch from the web",
  delegate: "start a subagent",
};

function single(kind: Kind, p: Plant, bed: string): string {
  const who = `${p.name} in ${bed}`;
  if (kind === "wilt") return `${who} wilted: its turn stopped with an error`;
  if (kind === "ready") return `${who} is in bloom: its turn is done and ready to read`;
  if (p.ask?.kind === "question") return `${who} has a question for you`;
  if (p.ask?.kind === "plan") return `${who} wants you to approve a plan`;
  const tool = p.ask?.toolName ?? "";
  // MCP tools draw as "pollinating" (web) in the garden, but most aren't web fetches: say the tool's own name.
  const [, server, name] = tool.match(/^mcp__(.+?)__(.+)$/) ?? [];
  if (server) return `${who} needs your permission to use ${name} from ${server}`;
  return `${who} needs your permission to ${PERMISSION_TO[activityForTool(tool)] ?? (tool ? `use ${tool}` : "continue")}`;
}

const MANY: Record<Kind, (n: number) => string> = {
  need: (n) => `${n} plants need you`,
  wilt: (n) => `${n} plants wilted`,
  ready: (n) => `${n} plants finished a turn and are ready to read`,
};

/** One sentence per kind, most urgent first: the plant by name when it's alone, a count when there are several. */
export function sentence(items: { kind: Kind; plant: Plant; bed: string }[]): string {
  const parts: string[] = [];
  for (const kind of ["need", "wilt", "ready"] as const) {
    const of = items.filter((i) => i.kind === kind);
    if (of.length === 1) parts.push(single(kind, of[0].plant, of[0].bed));
    else if (of.length > 1) parts.push(MANY[kind](of.length));
  }
  return parts.length ? `${parts.join(". ")}.` : "";
}

/**
 * Collects plant changes and says them at most once per `gap` ms. A burst is held `settle` ms so it
 * comes out as one sentence; a plant changing twice keeps only its latest change.
 */
export class Announcer {
  private pending = new Map<string, Kind>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = -Infinity;
  constructor(
    private say: (changes: Map<string, Kind>) => void,
    private settle = 1000,
    private gap = 5000,
  ) {}

  push(id: string, kind: Kind) {
    this.pending.delete(id);
    this.pending.set(id, kind);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), Math.max(this.settle, this.last + this.gap - Date.now()));
  }

  private flush() {
    this.timer = undefined;
    const changes = this.pending;
    this.pending = new Map();
    this.last = Date.now();
    this.say(changes);
  }
}

// The live region exists from startup: some screen readers ignore a region that appears with its text.
const region = typeof document === "undefined" ? null : document.createElement("div");
if (region) {
  region.className = "sr-only";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.append(region);
}

export function speak(text: string) {
  if (!region || !text) return;
  // Cleared first so the same sentence twice in a row is read again.
  region.textContent = "";
  setTimeout(() => (region.textContent = text), 50);
}
