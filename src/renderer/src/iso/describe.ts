// Plain words for every garden visual (PLAN section 5): what the hover tooltip says next to the picture.
import { statusLabel } from "../../../shared/garden";
import type { Plant, Weather } from "../../../shared/types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The lines shown when hovering a plant, after its name. `tags` = review comments waiting on it. */
export function describePlant(p: Plant, tags: number, now = Date.now()): string[] {
  const out: string[] = [statusLabel(p)];
  if (p.status === "waiting" && p.origin === "volunteer") out[0] = "Waiting for you in your terminal";
  if (p.queued) out.push("Waiting for a free pot · memory is full");
  if (p.origin === "volunteer") {
    if (p.ended) out.push("Volunteer · terminal session ended (you can adopt it)");
    else out.push(p.watchedBy === "transcript" ? "Volunteer · running in a terminal (busy or waiting there)" : "Volunteer · running in a terminal");
  }
  if (p.plot === "pot") out.push(`Potted · own worktree${p.branch ? ` · ${p.branch}` : ""}`);
  if (p.turns > 0) out.push(`${plural(p.turns, "ring")} on the stem (completed turns)`);
  const d = p.lastDiff;
  if (d && d.insertions + d.deletions > 0 && (p.unread || now - p.updatedAt < 600_000))
    out.push(`Changed ${plural(d.files, "file")} this turn (+${d.insertions} −${d.deletions})`);
  if (tags > 0) out.push(`${plural(tags, "review comment")} waiting to be sent with your next message`);
  const pr = p.pr;
  if (pr?.state === "open") {
    const checks = pr.checks === "none" ? "" : ` · checks ${pr.checks}`;
    const review = pr.review === "approved" ? " · approved" : pr.review === "changes_requested" ? " · changes requested" : "";
    out.push(`PR${pr.number ? ` #${pr.number}` : ""} open${checks}${review}`);
  } else if (pr?.state === "merged") out.push(`Transplanted · PR${pr.number ? ` #${pr.number}` : ""} merged`);
  if (p.plot === "pot" && ((p.potDirty ?? 0) > 0 || (p.unpushed ?? 0) > 0) && pr?.state !== "open") {
    const parts = [(p.potDirty ?? 0) > 0 ? `${plural(p.potDirty!, "uncommitted file")}` : "", (p.unpushed ?? 0) > 0 ? `${plural(p.unpushed!, "unpushed commit")}` : ""].filter(Boolean);
    out.push(`Harvest basket · changes ready to commit (${parts.join(", ")})`);
  }
  const s = p.stake;
  if (s?.status === "failing") out.push(`Checks failed after its last turn: ${s.command}${s.summary ? ` (${s.summary})` : ""}`);
  else if (s?.status === "running") out.push(`Checks running: ${s.command}`);
  else if (s?.status === "passing" && pr?.state !== "open") out.push(`Checks passing: ${s.command}`);
  return out;
}

const time = (t: number) => new Date(t < 1e12 ? t * 1000 : t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The weather as words: usage-limit state for subscription users. Null when the sky is clear. */
export function weatherLabel(w: Weather | undefined): string | null {
  if (!w || w.status === "clear") return null;
  const resets = w.resetsAt ? ` · resets at ${time(w.resetsAt)}` : "";
  if (w.status === "rain") return `Rain: you've hit your usage limit${resets}`;
  const used = w.utilization !== undefined ? ` (${Math.round(w.utilization <= 1 ? w.utilization * 100 : w.utilization)}% used)` : "";
  return `Clouds: nearing your usage limit${used}${resets}`;
}
