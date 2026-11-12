// GitService: every git and gh call Terrarium makes goes through here (PLAN D3).
// System git via execFile with argument arrays (never a shell), behind a bounded queue.
// CONTRACT FILE: signatures are fixed; implementations are filled in by the M3/M4/M5 work.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiffFile, PullRequestInfo } from "../shared/types";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to stdin. */
  input?: string;
  maxBuffer?: number;
}

// ── Process queue ─────────────────────────────────────────────────────────────

/** FIFO limiter: at most `max` tasks run at once; a finishing task hands its slot to the next waiter. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const gitQueue = limiter(4);
const ghQueue = limiter(2);

const DEFAULT_TIMEOUT = 60_000;
const LONG_TIMEOUT = 300_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function run(cmd: string, cwd: string, args: string[], opts: GitOptions, baseEnv: Record<string, string | undefined>): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        cmd,
        args,
        {
          cwd,
          // Undefined values are dropped by Node, so opts.env can unset inherited variables.
          env: { ...process.env, ...baseEnv, ...opts.env },
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
          maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
          windowsHide: true,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout, stderr, code: 0 });
          const code = typeof err.code === "number" ? err.code : -1;
          const msg = err.killed && !err.code ? `${cmd} timed out` : err.message;
          resolve({ stdout: stdout ?? "", stderr: code === -1 ? [stderr, msg].filter(Boolean).join("\n") : stderr ?? "", code });
        },
      );
    } catch (e) {
      return resolve({ stdout: "", stderr: (e as Error).message, code: -1 });
    }
    child.stdin?.on("error", () => {}); // EPIPE when the process exits before reading stdin
    child.stdin?.end(opts.input ?? "");
  });
}

// Global -c flags on every git call (cheap, and avoids per-command bookkeeping):
// - core.longpaths=true on Windows so worktrees, snapshots and restores handle paths > 260 chars;
// - core.quotepath=false so non-ASCII paths come back verbatim in non -z output.
const GLOBAL_FLAGS = [...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []), "-c", "core.quotepath=false"];
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  // Background `git status` (soil checks every few minutes) must not take index.lock in the user's
  // checkout, or their own git commands fail with "index.lock: File exists" (same as VS Code does).
  GIT_OPTIONAL_LOCKS: "0",
  // Never let an inherited repo/index (e.g. Terrarium launched from a git hook) redirect our calls.
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

/** Run git in `cwd` through the queue (4 concurrent). Never throws for a non-zero exit; check `code`. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return gitQueue(() => run("git", cwd, [...GLOBAL_FLAGS, ...args], opts, GIT_ENV));
}

function gh(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return ghQueue(() => run("gh", cwd, args, opts, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" }));
}

/** stdout trimmed when the call succeeded, else null. */
async function out(cwd: string, args: string[], opts?: GitOptions): Promise<string | null> {
  const r = await git(cwd, args, opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Throw git's own message when a call failed. */
function must(r: GitResult): GitResult {
  if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`).trim());
  return r;
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";
const lines = (s: string) => s.split(/\r?\n/).filter(Boolean);
const samePath = (a: string, b: string) => {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

/** `git --version`, or null when git is missing. */
export async function gitVersion(): Promise<string | null> {
  return out(process.cwd(), ["--version"]);
}
export async function isRepo(p: string): Promise<boolean> {
  return (await out(p, ["rev-parse", "--is-inside-work-tree"])) === "true";
}
/** `git rev-parse --show-toplevel`. */
export async function repoRoot(p: string): Promise<string | null> {
  const r = await out(p, ["rev-parse", "--show-toplevel"]);
  return r ? path.resolve(r) : null;
}
/** Absolute `git rev-parse --git-common-dir` (shared by all worktrees). */
export async function commonDir(p: string): Promise<string | null> {
  const r = await out(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r ? path.resolve(r) : null;
}
export async function currentBranch(p: string): Promise<string | null> {
  return (await out(p, ["symbolic-ref", "--short", "-q", "HEAD"])) || null;
}
/** origin/HEAD's branch, else "main"/"master" if present, else null. */
export async function defaultBranch(p: string): Promise<string | null> {
  const head = await out(p, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  const cands = ["refs/heads/main", "refs/remotes/origin/main", "refs/heads/master", "refs/remotes/origin/master"];
  const refs = lines((await out(p, ["for-each-ref", "--format=%(refname)", ...cands])) ?? "");
  for (const b of ["main", "master"]) if (refs.some((r) => r.endsWith(`/${b}`) && cands.includes(r))) return b;
  return null;
}
export async function headSha(p: string): Promise<string | null> {
  return (await out(p, ["rev-parse", "--verify", "-q", "HEAD"])) || null;
}

// ── Worktrees (M3) ────────────────────────────────────────────────────────────

/** Deterministic pot path: <plotsRoot>/<repoName>/<branchSlug≤24>-<sha256(commonDir+"\0"+branch)[0:12]>. Pure. */
export function potPath(plotsRoot: string, repoName: string, commonDir: string, branch: string): string {
  const slug =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-/, "")
      .slice(0, 24)
      .replace(/-$/, "") || "pot";
  const hash = createHash("sha256").update(`${commonDir}\0${branch}`).digest("hex").slice(0, 12);
  return path.join(plotsRoot, repoName, `${slug}-${hash}`);
}

export interface CreateWorktree {
  repo: string;
  path: string;
  branch: string;
  /** Branch/commit to start from; default the repo's current HEAD. */
  base?: string;
  /** `git fetch origin <base>` first and start from the fetched commit. */
  fromOrigin?: boolean;
}

/**
 * `git worktree add -b <branch> <path> <base>` (core.longpaths on Windows). Returns the base commit sha.
 * If the branch already exists it is checked out as is, and baseSha is merge-base(base, branch).
 */
export async function createWorktree(o: CreateWorktree): Promise<{ path: string; branch: string; baseSha: string }> {
  let baseSha: string | null;
  if (o.fromOrigin) {
    const base = o.base ?? (await currentBranch(o.repo)) ?? "HEAD";
    must(await git(o.repo, ["fetch", "origin", base], { timeoutMs: LONG_TIMEOUT }));
    baseSha = await out(o.repo, ["rev-parse", "--verify", "-q", "FETCH_HEAD^{commit}"]);
  } else {
    baseSha = await out(o.repo, ["rev-parse", "--verify", "-q", `${o.base ?? "HEAD"}^{commit}`]);
  }
  if (!baseSha) throw new Error(`Can't find the starting point "${o.base ?? "HEAD"}" in this repository.`);

  await fs.mkdir(path.dirname(o.path), { recursive: true });
  await git(o.repo, ["worktree", "prune"]); // stale entries for deleted folders block re-adding
  const branchExists = (await git(o.repo, ["rev-parse", "--verify", "-q", `refs/heads/${o.branch}`])).code === 0;
  const args = branchExists ? ["worktree", "add", o.path, o.branch] : ["worktree", "add", "-b", o.branch, o.path, baseSha];
  must(await git(o.repo, args, { timeoutMs: LONG_TIMEOUT }));
  if (branchExists) baseSha = (await out(o.repo, ["merge-base", baseSha, `refs/heads/${o.branch}`])) || baseSha;
  return { path: o.path, branch: o.branch, baseSha };
}
/** If the worktree folder is missing but the branch exists, re-add it at the same path. No-op when present. */
export async function ensureWorktree(o: CreateWorktree): Promise<void> {
  if (await exists(path.join(o.path, ".git"))) return;
  await createWorktree(o);
}

/** Linked worktree paths of `repo` (the main checkout excluded). */
async function linkedWorktrees(repo: string): Promise<string[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  if (r.code !== 0) return [];
  const paths = r.stdout
    .split("\0")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  return paths.slice(1);
}

/**
 * Removes the worktree folder, then prunes its metadata; optionally `git branch -D`.
 * Deviation from `git worktree remove --force`: Git for Windows follows junctions inside the
 * worktree and deletes their *targets'* contents (caught by git.test.ts). fs.rm unlinks
 * symlinks/junctions without descending, and retries on Windows file locks.
 */
export async function removeWorktree(repo: string, p: string, opts?: { deleteBranch?: string }): Promise<void> {
  if (await exists(p)) {
    // Guard: only delete linked worktrees (listed, or with a `.git` *file*), never a main checkout or an arbitrary folder.
    const isPot = (await linkedWorktrees(repo)).some((w) => samePath(w, p));
    const dotGit = await fs.lstat(path.join(p, ".git")).catch(() => null);
    if (!isPot && !dotGit?.isFile()) throw new Error(`${p} is not a worktree of this repository, so it was left alone.`);
    await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  await git(repo, ["worktree", "prune"]);
  if (opts?.deleteBranch) await git(repo, ["branch", "-D", opts.deleteBranch]);
}
/** Number of changed/untracked paths (porcelain line count). */
export async function dirtyCount(cwd: string): Promise<number> {
  const r = await git(cwd, ["status", "--porcelain"]);
  return r.code === 0 ? lines(r.stdout).length : 0;
}

// ── Checkpoints (M4) ──────────────────────────────────────────────────────────

const IDENT = {
  GIT_AUTHOR_NAME: "Terrarium",
  GIT_AUTHOR_EMAIL: "terrarium@localhost",
  GIT_COMMITTER_NAME: "Terrarium",
  GIT_COMMITTER_EMAIL: "terrarium@localhost",
};

/**
 * Snapshot the working tree (tracked + untracked, not ignored) into a commit under `ref`,
 * using a temporary GIT_INDEX_FILE seeded from the real index, so the user's index and
 * index.lock are never touched. Parent = HEAD. Bounded by `timeoutMs` (default 15 s).
 * Scope is `cwd` (`add -A -- .`); paths outside it are taken from HEAD. `head` is "" in a repo with no commits.
 */
export async function snapshot(cwd: string, ref: string, message: string, timeoutMs = 15_000): Promise<{ commit: string; head: string } | { skipped: string }> {
  const deadline = Date.now() + timeoutMs;
  class Skip extends Error {}
  const step = async (args: string[], extra: GitOptions = {}) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Skip("timed out on a large repo");
    const r = await git(cwd, args, { ...extra, timeoutMs: left });
    if (r.code !== 0 && Date.now() >= deadline) throw new Skip("timed out on a large repo");
    return r;
  };
  let tmp: string | null = null;
  try {
    const info = await step(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", "index"]);
    if (info.code !== 0) throw new Skip(/not a git repository/i.test(info.stderr) ? "not a git repository" : firstLine(info.stderr) || "not a git repository");
    const [common, realIndex] = lines(info.stdout).map((l) => path.resolve(l));
    const head = (await step(["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim();

    tmp = path.join(common, `terrarium-index-${randomBytes(8).toString("hex")}`);
    const env = { GIT_INDEX_FILE: tmp, ...IDENT };
    const fail = (r: GitResult) => {
      if (r.code !== 0) throw new Skip(firstLine(r.stderr) || `git exited with code ${r.code}`);
      return r;
    };
    // Seeding from the real index keeps stat info, so unchanged files aren't rehashed.
    await fs.copyFile(realIndex, tmp).catch(() => {});
    const readTree = () => step(head ? ["read-tree", "--reset", head] : ["read-tree", "--empty"], { env });
    let r = await readTree();
    if (r.code !== 0) {
      await fs.rm(tmp, { force: true }); // an index we can't reuse (odd extensions): start clean
      r = fail(await readTree());
    }
    const addArgs = ["-c", "core.fsmonitor=false", "-c", "core.safecrlf=false", "add", "-A", "--", "."];
    r = await step(addArgs, { env });
    if (r.code !== 0) {
      // Embedded repos without a commit make `add -A` fail; retry once without them.
      const others = await step(["ls-files", "--others", "--exclude-standard", "-z", "--", "."], { env });
      const nested: string[] = [];
      for (const f of others.stdout.split("\0")) if (f.endsWith("/") && (await exists(path.join(cwd, f, ".git")))) nested.push(f.slice(0, -1));
      if (!nested.length) fail(r);
      fail(await step([...addArgs, ...nested.map((d) => `:(exclude,literal)${d}`)], { env }));
    }
    const tree = fail(await step(["write-tree"], { env })).stdout.trim();
    const commit = fail(await step(["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"], { env, input: message })).stdout.trim();
    fail(await step(["update-ref", ref, commit]));
    return { commit, head };
  } catch (e) {
    if (e instanceof Skip) return { skipped: e.message };
    return { skipped: (e as Error).message };
  } finally {
    if (tmp) await Promise.all([fs.rm(tmp, { force: true }), fs.rm(`${tmp}.lock`, { force: true })]).catch(() => {});
  }
}
/** Delete every ref under `prefix` (e.g. "refs/terrarium/<plantId>/"). */
export async function deleteRefs(cwd: string, prefix: string): Promise<void> {
  const refs = lines((await out(cwd, ["for-each-ref", "--format=%(refname)", prefix])) ?? "");
  if (refs.length) must(await git(cwd, ["update-ref", "--stdin"], { input: refs.map((r) => `delete ${r}\n`).join("") }));
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

/** name-status -z → entries of [status letter, path, oldPath?]. */
function parseNameStatus(s: string): { st: string; path: string; oldPath?: string }[] {
  const f = s.split("\0");
  const res: { st: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < f.length && f[i]; ) {
    const st = f[i++][0];
    if (st === "R" || st === "C") {
      const oldPath = f[i++];
      res.push({ st, path: f[i++], oldPath });
    } else res.push({ st, path: f[i++] });
  }
  return res;
}

/** Files changed between two commits (numstat + name-status, renames detected). */
export async function diffFiles(cwd: string, from: string, to: string): Promise<DiffFile[]> {
  const [num, ns] = await Promise.all([
    git(cwd, ["diff", "--numstat", "-z", ...DIFF_FLAGS, from, to]),
    git(cwd, ["diff", "--name-status", "-z", ...DIFF_FLAGS, from, to]),
  ]);
  must(num);
  must(ns);
  // numstat -z: "ins\tdel\tpath\0" or, for renames, "ins\tdel\t\0old\0new\0".
  const counts = new Map<string, [string, string]>();
  const f = num.stdout.split("\0");
  for (let i = 0; i < f.length && f[i]; ) {
    const [ins, del, p] = f[i++].split("\t");
    const key = p || (i++, f[i++]);
    counts.set(key, [ins, del]);
  }
  const STATUS: Record<string, DiffFile["status"]> = { A: "added", C: "added", D: "deleted", R: "renamed" };
  return parseNameStatus(ns.stdout).map(({ st, path: p, oldPath }) => {
    const [ins, del] = counts.get(p) ?? ["0", "0"];
    const binary = ins === "-";
    return {
      path: p,
      ...(oldPath && st === "R" ? { oldPath } : {}),
      status: binary ? "binary" : (STATUS[st] ?? "modified"),
      insertions: binary ? 0 : Number(ins) || 0,
      deletions: binary ? 0 : Number(del) || 0,
    };
  });
}
/** Unified patch for one path between two commits, capped at `maxBytes` (default 1 MB) with a trailing "\n[truncated]". */
export async function diffPatch(cwd: string, from: string, to: string, p: string, maxBytes = 1_000_000): Promise<string> {
  // A rename only pairs up when both sides are in the pathspec.
  const ns = await git(cwd, ["diff", "--name-status", "-z", ...DIFF_FLAGS, from, to]);
  const oldPath = parseNameStatus(ns.stdout).find((e) => e.path === p && e.oldPath)?.oldPath;
  const r = await git(cwd, ["diff", "--patch", ...DIFF_FLAGS, from, to, "--", p, ...(oldPath ? [oldPath] : [])], {
    maxBuffer: maxBytes + 1024 * 1024,
  });
  // code -1 with output = maxBuffer hit: still show what we got.
  if (r.code !== 0 && !(r.code === -1 && r.stdout)) must(r);
  const buf = Buffer.from(r.stdout, "utf8");
  if (buf.length <= maxBytes && r.code === 0) return r.stdout;
  return buf.subarray(0, maxBytes).toString("utf8") + "\n[truncated]";
}
/** Restore the working tree to `commit` (restore --worktree --staged, clean -fd without -x, reset). */
export async function restoreTo(cwd: string, commit: string): Promise<void> {
  must(await git(cwd, ["restore", "--source", commit, "--worktree", "--staged", "--", "."], { timeoutMs: LONG_TIMEOUT }));
  // Without -x, so ignored files (node_modules, .env) survive. Repeat: removing a file can empty a dir.
  for (let i = 0; i < 4; i++) {
    const r = must(await git(cwd, ["clean", "-fd", "--", "."], { timeoutMs: LONG_TIMEOUT }));
    if (!r.stdout.trim()) break;
  }
  must(await git(cwd, ["reset", "-q", "--", "."]));
}

// ── Harvest (M5) ──────────────────────────────────────────────────────────────

/** Stage `files` (or everything with `add -A`) and commit. Returns the new sha. */
export async function commit(cwd: string, message: string, files?: string[]): Promise<string> {
  const only = files?.length ? ["--", ...files] : [];
  must(await git(cwd, ["add", "-A", ...only]));
  // With files, `commit -- <files>` commits only those paths, even if other things were staged.
  must(await git(cwd, ["commit", "-F", "-", ...only], { input: message, timeoutMs: LONG_TIMEOUT }));
  return must(await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}
/** `git push -u origin <branch>`. Throws an Error whose message is git's stderr. */
export async function push(cwd: string, branch: string): Promise<void> {
  const r = await git(cwd, ["push", "-u", "origin", branch], { timeoutMs: LONG_TIMEOUT });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git push exited with code ${r.code}`);
}
/** Commits on HEAD not on its upstream (or on origin/<default> when no upstream). */
export async function unpushedCount(cwd: string): Promise<number> {
  const count = (s: string | null) => (s ? Number(s) || 0 : 0);
  const up = await out(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (up !== null) return count(up);
  const def = await defaultBranch(cwd);
  if (def && (await out(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${def}`]))) {
    return count(await out(cwd, ["rev-list", "--count", `refs/remotes/origin/${def}..HEAD`]));
  }
  return count(await out(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]));
}
export async function remoteUrl(cwd: string, remote = "origin"): Promise<string | null> {
  return (await out(cwd, ["remote", "get-url", remote])) || null;
}
/** GitHub compare URL for a remote (https or ssh form), or null for non-GitHub remotes. Pure. */
export function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const m = remoteUrl
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const enc = (s: string) => encodeURIComponent(s).replace(/%2F/gi, "/");
  return `https://github.com/${m[1]}/${m[2]}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}
/** Last `n` commit subjects (for matching the repo's commit style). */
export async function recentSubjects(cwd: string, n: number): Promise<string[]> {
  return lines((await out(cwd, ["log", "-n", String(n), "--format=%s"])) ?? "");
}
/** `git diff HEAD` (+ untracked files listed) capped to `maxChars`: the input for commit-message generation. */
export async function pendingPatch(cwd: string, maxChars: number): Promise<string> {
  // No commits yet: diff against the empty tree (mktree with no input writes it, in this repo's hash format).
  const base = (await headSha(cwd)) ?? (await out(cwd, ["mktree"])) ?? "HEAD";
  const [stat, patch, untracked] = await Promise.all([
    git(cwd, ["diff", "--stat", ...DIFF_FLAGS, base]),
    git(cwd, ["diff", "--patch", ...DIFF_FLAGS, base]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const parts = [stat.stdout.trim()];
  const files = lines(untracked.stdout);
  if (files.length) parts.push(`Untracked files:\n${files.join("\n")}`);
  parts.push(patch.stdout);
  const text = parts.filter(Boolean).join("\n\n");
  const mark = "\n[truncated]";
  return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - mark.length)) + mark;
}

// ── gh (M5) ───────────────────────────────────────────────────────────────────

/** Host of a remote URL (https, scp-like or ssh://), default github.com. */
function remoteHost(url: string | null): string {
  if (!url) return "github.com";
  const m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i) ?? url.match(/^(?:[^@/]+@)?([^/:]+):/);
  return m?.[1]?.toLowerCase() ?? "github.com";
}

const ghCache = new Map<string, { at: number; ok: boolean }>();
/** `gh auth status` succeeds for the remote's host. Cached for 60 s. */
export async function ghReady(cwd: string): Promise<boolean> {
  const host = remoteHost(await remoteUrl(cwd));
  const hit = ghCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const ok = (await gh(cwd, ["auth", "status", "--hostname", host], { timeoutMs: 20_000 })).code === 0;
  ghCache.set(host, { at: Date.now(), ok });
  return ok;
}
/** `gh pr create --base --head --title --body-file -`. Returns url and number. */
export async function ghCreatePr(cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<{ url: string; number?: number }> {
  const r = await gh(cwd, ["pr", "create", "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", "-"], {
    input: pr.body,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr create exited with code ${r.code}`);
  const url = lines(r.stdout)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^https?:\/\//.test(l));
  if (!url) throw new Error(`gh pr create did not print a URL: ${r.stdout.trim()}`);
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? { url, number: Number(n) } : { url };
}
/** `gh pr view <branch> --json number,url,state,reviewDecision,statusCheckRollup`; null when no PR. */
export async function ghPrView(cwd: string, branch: string): Promise<PullRequestInfo | null> {
  const r = await gh(cwd, ["pr", "view", branch, "--json", "number,url,state,reviewDecision,statusCheckRollup"], { timeoutMs: 30_000 });
  // "no pull requests found" and every other failure (gh missing, offline) → null.
  return r.code === 0 ? parsePrView(r.stdout, Date.now()) : null;
}

const up = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "");
const BAD = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** One statusCheckRollup item: a CheckRun (status + conclusion) or a StatusContext (state). */
function checkState(c: Record<string, unknown>): "failing" | "pending" | "passing" {
  const conclusion = up(c.conclusion);
  const state = up(c.state);
  const status = up(c.status);
  if (BAD.has(conclusion) || BAD.has(state)) return "failing";
  if (state) return state === "PENDING" || state === "EXPECTED" ? "pending" : "passing";
  if (status && status !== "COMPLETED") return "pending"; // IN_PROGRESS, QUEUED, PENDING, WAITING…
  return conclusion ? "passing" : "pending"; // SUCCESS / NEUTRAL / SKIPPED pass; no conclusion yet = pending
}

/** Pure parser for `gh pr view --json number,url,state,reviewDecision,statusCheckRollup`. */
export function parsePrView(json: string, now: number): PullRequestInfo | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || typeof d.url !== "string") return null;
  const STATE: Record<string, PullRequestInfo["state"]> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
  const REVIEW: Record<string, PullRequestInfo["review"]> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes_requested",
    REVIEW_REQUIRED: "review_required",
  };
  const rollup = Array.isArray(d.statusCheckRollup) ? (d.statusCheckRollup as Record<string, unknown>[]) : [];
  const states = rollup.filter((c) => c && typeof c === "object").map(checkState);
  const checks: PullRequestInfo["checks"] = !states.length
    ? "none"
    : states.includes("failing")
      ? "failing"
      : states.includes("pending")
        ? "pending"
        : "passing";
  const review = REVIEW[up(d.reviewDecision)];
  return {
    ...(typeof d.number === "number" ? { number: d.number } : {}),
    url: d.url,
    state: STATE[up(d.state)] ?? "open",
    checks,
    ...(review ? { review } : {}),
    checkedAt: now,
  };
}
/** Names + truncated logs of failed checks (`gh run view --log-failed`), for "wake on red stake". */
export async function failedCheckLogs(cwd: string, branch: string, maxChars: number): Promise<string> {
  try {
    // `gh pr checks` exits non-zero when checks fail or are pending, so read stdout regardless.
    const r = await gh(cwd, ["pr", "checks", branch, "--json", "name,state,link"], { timeoutMs: 30_000 });
    const checks = JSON.parse(r.stdout || "[]") as { name?: string; state?: string; link?: string }[];
    const failed = checks.filter((c) => BAD.has(up(c.state)));
    if (!failed.length) return "";
    const runs = new Map<string, string[]>(); // run id → check names
    for (const c of failed) {
      const id = c.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
      if (id) runs.set(id, [...(runs.get(id) ?? []), c.name ?? "?"]);
    }
    const parts = [`Failed checks: ${failed.map((c) => c.name ?? "?").join(", ")}`];
    const budget = Math.max(200, Math.floor(maxChars / Math.max(1, runs.size)));
    for (const [id, names] of runs) {
      const log = await gh(cwd, ["run", "view", id, "--log-failed"], { timeoutMs: 60_000 });
      if (log.code !== 0 || !log.stdout.trim()) continue;
      // The end of a failed log is where the error is.
      const text = log.stdout.length > budget ? `[…]\n${log.stdout.slice(-budget)}` : log.stdout;
      parts.push(`── ${names.join(", ")} (run ${id}) ──\n${text.trim()}`);
    }
    const all = parts.join("\n\n");
    return all.length <= maxChars ? all : `${all.slice(0, Math.max(0, maxChars - 12))}\n[truncated]`;
  } catch {
    return "";
  }
}
