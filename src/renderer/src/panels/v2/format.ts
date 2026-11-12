// Pure helpers for the V2 panels: number formatting, diffstat bars, chart scaling, diff rows and tag hunks.
// No DOM, no React: tested in format.test.ts.

export function money(usd: number | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function tokens(n: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) if (Math.abs(n) >= size) return (n / size).toFixed(1).replace(/\.0$/, "") + suffix;
  return String(Math.round(n));
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace(/\.0$/, "") + " GB";
  return Math.round(n / 1024 ** 2) + " MB";
}

export function duration(ms: number | undefined): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Message of a thrown api error, without Electron's "Error invoking remote method" wrapper. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** One plain sentence about a git/gh failure. The verbatim output is shown next to it. */
export function explainGitError(out: string): string {
  const s = out.toLowerCase();
  if (/authentication failed|permission denied \(publickey\)|could not read username|403|401|not logged in|gh auth login/.test(s))
    return "Git couldn't log in to the remote. Check that you're signed in (for example `gh auth login`, or your SSH key), then try again.";
  if (/non-fast-forward|\[rejected\]|fetch first|updates were rejected/.test(s))
    return "The remote branch has commits this one doesn't. Ask the plant to pull and rebase, then push again.";
  if (/hook/.test(s)) return "A git hook in this repo stopped the operation. Its output is above; fix what it reports and try again.";
  if (/index\.lock/.test(s)) return "Another git process is using this repo right now. Wait a moment and try again.";
  if (/nothing to commit|no changes added/.test(s)) return "There was nothing to commit: the chosen files have no changes.";
  if (/could not resolve host|unable to access|timed out|network/.test(s)) return "Git couldn't reach the remote. Check your network connection.";
  if (/already exists/.test(s) && /pull request/.test(s)) return "A pull request for this branch already exists.";
  return "Git stopped with the message above.";
}

/**
 * Splits a diffstat bar of `cells` blocks between insertions and deletions.
 * `max` is the biggest change in the list, so bars are proportional across rows and capped at `cells`.
 */
export function diffBar(ins: number, del: number, max: number, cells = 20): { plus: number; minus: number } {
  const total = ins + del;
  if (total <= 0) return { plus: 0, minus: 0 };
  const sides = (ins > 0 ? 1 : 0) + (del > 0 ? 1 : 0);
  const n = Math.max(sides, Math.min(cells, Math.round((total / Math.max(max, total)) * cells)));
  const plus = Math.min(Math.max(Math.round((ins / total) * n), ins > 0 ? 1 : 0), del > 0 ? n - 1 : n);
  return { plus, minus: n - plus };
}

/** Whole-pixel bar heights for a chart `maxPx` tall. Any non-zero value gets at least 1px. */
export function barHeights(values: number[], maxPx: number): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(1, Math.round((v / max) * maxPx))));
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `n` local days ending at `today`, oldest first, with missing days filled by `empty(day)`. */
export function fillDays<T extends { day: string }>(buckets: T[], n: number, today: Date, empty: (day: string) => T): T[] {
  const byDay = new Map(buckets.map((b) => [b.day, b]));
  const out: T[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDay(d);
    out.push(byDay.get(key) ?? empty(key));
  }
  return out;
}

// ---------- diff lines (the shape diff2html's parse() returns; content keeps its +/-/space prefix) ----------

export interface Line {
  type: "insert" | "delete" | "context";
  oldNumber?: number;
  newNumber?: number;
  content: string;
}

export interface Block {
  oldStartLine: number;
  newStartLine: number;
  header: string;
  lines: Line[];
}

/** Pairs a block's lines for a side-by-side view: runs of deletions sit next to the insertions that follow them. */
export function splitRows(lines: Line[]): { left?: number; right?: number }[] {
  const rows: { left?: number; right?: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      rows.push({ left: i, right: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].type === "delete") dels.push(i++);
    while (i < lines.length && lines[i].type === "insert") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

/**
 * Lines `from..to` (indices into `block.lines`, either order) rebuilt as a mini hunk for a review tag,
 * plus the line range it covers: new-file lines, or old-file lines when only deletions are selected.
 */
export function tagHunk(block: Block, from: number, to: number): { hunk: string; startLine: number; endLine: number } {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const sel = block.lines.slice(a, b + 1);
  // Where a side with no selected lines "starts": just after the last numbered line before the selection.
  const before = (key: "oldNumber" | "newNumber", start: number) => {
    for (let i = a - 1; i >= 0; i--) {
      const n = block.lines[i][key];
      if (n != null) return n;
    }
    return start - 1;
  };
  const olds = sel.filter((l) => l.oldNumber != null).map((l) => l.oldNumber!);
  const news = sel.filter((l) => l.newNumber != null).map((l) => l.newNumber!);
  const oldStart = olds.length ? olds[0] : before("oldNumber", block.oldStartLine);
  const newStart = news.length ? news[0] : before("newNumber", block.newStartLine);
  const header = `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@`;
  const range = news.length ? news : olds;
  return {
    hunk: [header, ...sel.map((l) => l.content)].join("\n"),
    startLine: Math.min(...range),
    endLine: Math.max(...range),
  };
}

/** Whether a tag (as built by tagHunk) covers a diff line. */
export function tagCovers(tag: { startLine: number; endLine: number; hunk: string }, line: Line): boolean {
  const body = tag.hunk.split("\n").slice(1);
  const newRange = body.some((l) => l.startsWith("+") || l.startsWith(" "));
  const n = newRange ? line.newNumber : line.type === "delete" ? line.oldNumber : undefined;
  return n != null && n >= tag.startLine && n <= tag.endLine;
}
