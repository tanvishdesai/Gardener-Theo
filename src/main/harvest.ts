// Harvest (PLAN M5): from "the plant finished" to "PR open", safely.
// Commit message → commit (never straight onto the default branch) → push → PR via gh or the browser.
// Also watches open PRs and shows their checks on the plant's stake.
import { randomBytes, randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { oneLine, potBranch } from "../shared/garden";
import type { CommitMessage, DiffFile, HarvestInfo, Plant, PullRequestInfo } from "../shared/types";
import * as git from "./git";
import type { GardenStore } from "./store";

export interface HarvestDeps {
  store: GardenStore;
  /** Files the commit would include (working tree vs HEAD, untracked included). */
  uncommitted(plantId: string): Promise<DiffFile[]>;
  openExternal(url: string): void;
  /** Send the plant a message (used by "wake on red stake"). */
  wake(plantId: string, text: string): void;
  wakeOnRedStake(): boolean;
  env(): Record<string, string | undefined>;
  /** True while nobody is looking (window hidden for an hour): poll less. */
  idle?(): boolean;
  query?: typeof query;
  claudeExecutable?: string;
}

const COMMIT_SYSTEM = `You write git commit messages. Reply with only the message: a subject line (imperative, at most 72 characters, no trailing period), a blank line, then a short body of plain sentences or "- " bullets explaining what changed and why. Match the style of the repository's recent subjects when they follow a convention (for example "feat: …"). No code fences, no quotes, no sign-off.`;

export function parseCommitMessage(text: string, fallback: string): CommitMessage {
  const clean = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const [first, ...rest] = clean.split(/\r?\n/);
  const subject = (first ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.$/, "")
    .trim()
    .slice(0, 72);
  return { subject: subject || fallback, body: rest.join("\n").trim() };
}

export class Harvest {
  private wakes = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: HarvestDeps) {}

  private ctx(plantId: string): { plant: Plant; cwd: string } {
    const plant = this.deps.store.plants.get(plantId);
    if (!plant) throw new Error("That plant is gone");
    const cwd = plant.cwd ?? this.deps.store.beds.get(plant.bedId)?.path;
    if (!cwd) throw new Error("That plant's bed is gone");
    return { plant, cwd };
  }

  private note(plantId: string, text: string, kind: "system" | "error" = "system") {
    this.deps.store.upsertEntry({ id: randomUUID(), plantId, ts: Date.now(), kind, text });
  }

  async info(plantId: string): Promise<HarvestInfo> {
    const { plant, cwd } = this.ctx(plantId);
    if (!(await git.isRepo(cwd))) return { isGitRepo: false, onDefaultBranch: false, files: [], unpushed: 0, hasRemote: false, ghReady: false };
    const [branch, def, remote] = await Promise.all([git.currentBranch(cwd), git.defaultBranch(cwd), git.remoteUrl(cwd)]);
    const [files, unpushed, ghReady] = await Promise.all([this.deps.uncommitted(plantId).catch(() => []), git.unpushedCount(cwd), remote ? git.ghReady(cwd) : Promise.resolve(false)]);
    return {
      isGitRepo: true,
      branch: branch ?? undefined,
      base: def ?? undefined,
      onDefaultBranch: !!branch && !!def && branch === def,
      files,
      unpushed,
      hasRemote: !!remote,
      remoteUrl: remote ?? undefined,
      ghReady,
      pr: plant.pr,
    };
  }

  async commitMessage(plantId: string): Promise<CommitMessage> {
    const { plant, cwd } = this.ctx(plantId);
    const fallback = oneLine(plant.name, 72);
    const [patch, subjects] = await Promise.all([git.pendingPatch(cwd, 50_000), git.recentSubjects(cwd, 20)]);
    if (!patch.trim()) return { subject: fallback, body: "" };
    const prompt = `Recent commit subjects in this repository:\n${subjects.map((s) => `- ${s}`).join("\n") || "(none)"}\n\nThe task the agent was given:\n${oneLine(plant.seed, 600)}\n\nThe changes to commit:\n${patch}`;
    let text = "";
    try {
      const q = (this.deps.query ?? query)({
        prompt,
        options: {
          cwd,
          model: "haiku",
          maxTurns: 1,
          ...(this.deps.claudeExecutable ? { pathToClaudeCodeExecutable: this.deps.claudeExecutable } : {}),
          tools: [],
          settingSources: [],
          persistSession: false,
          systemPrompt: COMMIT_SYSTEM,
          env: this.deps.env(),
        },
      });
      for await (const m of q) {
        if (m.type === "result" && m.subtype === "success") text = m.result;
      }
    } catch (err) {
      console.error("[terrarium] commit message generation failed", err);
    }
    return parseCommitMessage(text, fallback);
  }

  async commit(plantId: string, message: CommitMessage, files?: string[]): Promise<{ sha: string }> {
    const { plant, cwd } = this.ctx(plantId);
    const [branch, def] = await Promise.all([git.currentBranch(cwd), git.defaultBranch(cwd)]);
    if (branch && def && branch === def) {
      // Never commit straight onto the default branch: give the work its own branch first.
      const fresh = potBranch(plant.name, randomBytes(2).toString("hex"));
      const r = await git.git(cwd, ["switch", "-c", fresh]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `Could not create branch ${fresh}`);
      this.deps.store.updatePlant(plantId, { branch: fresh });
      this.note(plantId, `Created branch ${fresh} so the commit doesn't land on ${def}.`);
    }
    const subject = message.subject.trim();
    if (!subject) throw new Error("The commit needs a subject line.");
    const sha = await git.commit(cwd, message.body.trim() ? `${subject}\n\n${message.body.trim()}` : subject, files?.length ? files : undefined);
    const [dirty, unpushed] = await Promise.all([git.dirtyCount(cwd), git.unpushedCount(cwd)]);
    this.deps.store.updatePlant(plantId, { potDirty: dirty, unpushed });
    this.note(plantId, `Committed ${sha.slice(0, 8)}: ${subject}`);
    return { sha };
  }

  async push(plantId: string): Promise<void> {
    const { cwd } = this.ctx(plantId);
    const branch = await git.currentBranch(cwd);
    if (!branch) throw new Error("Not on a branch (detached HEAD), so there is nothing to push.");
    await git.push(cwd, branch);
    // New commits restart the PR's checks: show them as running and poll on the fast (1 min) cadence.
    const pr = this.deps.store.plants.get(plantId)?.pr;
    this.deps.store.updatePlant(plantId, { unpushed: 0, branch, ...(pr?.state === "open" ? { pr: { ...pr, checks: "pending" as const, checkedAt: 0 } } : {}) });
    this.note(plantId, `Pushed ${branch} to origin.`);
  }

  async openPullRequest(plantId: string, pr: { title: string; body: string }): Promise<{ url: string; viaBrowser: boolean }> {
    const { cwd } = this.ctx(plantId);
    const [branch, def, remote] = await Promise.all([git.currentBranch(cwd), git.defaultBranch(cwd), git.remoteUrl(cwd)]);
    if (!branch) throw new Error("Not on a branch, so there is nothing to open a pull request for.");
    const base = def ?? "main";
    if (branch === base) throw new Error(`${base} is the base branch. Commit on a feature branch first.`);
    const body = `${pr.body.trim()}\n\n---\nOpened from Terrarium.`;
    if (remote && (await git.ghReady(cwd))) {
      const made = await git.ghCreatePr(cwd, { base, head: branch, title: pr.title.trim(), body });
      const info: PullRequestInfo = { url: made.url, number: made.number, state: "open", checks: "pending", checkedAt: Date.now() };
      this.deps.store.updatePlant(plantId, { pr: info });
      this.note(plantId, `Opened pull request${made.number ? ` #${made.number}` : ""}: ${made.url}`);
      return { url: made.url, viaBrowser: false };
    }
    const url = remote ? git.compareUrl(remote, base, branch) : null;
    if (!url) throw new Error("This remote isn't on GitHub, so Terrarium stopped after pushing. Open the pull request on your git host.");
    this.deps.openExternal(url);
    this.note(plantId, `Opened GitHub's compare page for ${branch} in your browser.`);
    return { url, viaBrowser: true };
  }

  // ── PR watching ───────────────────────────────────────────────────────────

  /** Poll open PRs: every minute while checks run, every 10 minutes otherwise (slower when idle). */
  async tick(now = Date.now()) {
    for (const plant of [...this.deps.store.plants.values()]) {
      const pr = plant.pr;
      if (!pr || pr.state !== "open" || !plant.branch) continue;
      const every = (pr.checks === "pending" ? 60_000 : 600_000) * (this.deps.idle?.() ? 6 : 1);
      if (now - pr.checkedAt < every) continue;
      const cwd = plant.cwd ?? this.deps.store.beds.get(plant.bedId)?.path;
      if (!cwd) continue;
      const next = await git.ghPrView(cwd, plant.branch);
      if (!next) {
        this.deps.store.updatePlant(plant.id, { pr: { ...pr, checkedAt: now } });
        continue;
      }
      const patch: Partial<Plant> = { pr: next };
      if (next.state === "merged") {
        patch.archivedAt = now;
        this.note(plant.id, `Pull request${next.number ? ` #${next.number}` : ""} merged: transplanted into the bed.`);
      }
      this.deps.store.updatePlant(plant.id, patch);
      if (next.checks === "failing" && pr.checks !== "failing" && this.deps.wakeOnRedStake()) {
        const key = `${plant.id}:${next.number ?? next.url}`;
        const n = this.wakes.get(key) ?? 0;
        if (n < 3) {
          this.wakes.set(key, n + 1);
          const logs = await git.failedCheckLogs(cwd, plant.branch, 12_000);
          this.deps.wake(plant.id, `The pull request's checks are failing. Please look at the failures, fix them, and push again.\n\n${logs || "(Terrarium could not read the logs; run the checks locally.)"}`);
        }
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => console.error("[terrarium] PR watch failed", err)), 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
