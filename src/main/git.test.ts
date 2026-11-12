import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commit,
  commonDir,
  compareUrl,
  createWorktree,
  currentBranch,
  defaultBranch,
  deleteRefs,
  diffFiles,
  diffPatch,
  dirtyCount,
  ensureWorktree,
  git,
  isRepo,
  parsePrView,
  pendingPatch,
  potPath,
  push,
  recentSubjects,
  removeWorktree,
  repoRoot,
  restoreTo,
  snapshot,
  unpushedCount,
} from "./git";

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "terrarium-git-")));
  temps.push(d);
  return d;
}
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
/** A repo with one commit (a.txt, b.txt, .gitignore ignoring *.log and ignored/). */
async function repo(opts: { commit?: boolean; autocrlf?: string } = {}): Promise<string> {
  const d = await tmp();
  await g(d, "init", "-q", "-b", "main");
  await g(d, "config", "user.name", "Test");
  await g(d, "config", "user.email", "test@example.com");
  await g(d, "config", "core.autocrlf", opts.autocrlf ?? "false");
  if (opts.commit === false) return d;
  await write(d, "a.txt", "alpha\n");
  await write(d, "b.txt", "bravo\n");
  await write(d, ".gitignore", "*.log\nignored/\n");
  await g(d, "add", "-A");
  await g(d, "commit", "-q", "-m", "init");
  return d;
}
const write = async (root: string, rel: string, data: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), data);
};
const read = (root: string, rel: string) => fs.readFile(path.join(root, rel));
const has = (root: string, rel: string) =>
  fs.stat(path.join(root, rel)).then(
    () => true,
    () => false,
  );
const filesAt = async (cwd: string, ref: string) => (await g(cwd, "ls-tree", "-r", "--name-only", ref)).split("\n").filter(Boolean).sort();
const ok = <T extends object>(r: T | { skipped: string }): T => {
  if ("skipped" in r) throw new Error(`skipped: ${r.skipped}`);
  return r as T;
};

describe("pure helpers", () => {
  it("potPath is deterministic and slugs the branch", () => {
    const a = potPath("/plots", "repo", "/r/.git", "garden/Fix_Login--3FA2");
    expect(a).toBe(potPath("/plots", "repo", "/r/.git", "garden/Fix_Login--3FA2"));
    const hash = createHash("sha256").update("/r/.git\0garden/Fix_Login--3FA2").digest("hex").slice(0, 12);
    expect(a).toBe(path.join("/plots", "repo", `garden-fix-login-3fa2-${hash}`));
    expect(potPath("/p", "r", "/x", "garden/fix")).not.toBe(potPath("/p", "r", "/y", "garden/fix"));
    const slug = path.basename(potPath("/p", "r", "/x", "garden/a-very-long-branch-name-that-goes-on")).slice(0, -13);
    expect(slug).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(slug.endsWith("-")).toBe(false);
    expect(path.basename(potPath("/p", "r", "/x", "///"))).toMatch(/^pot-[0-9a-f]{12}$/);
  });

  it("compareUrl handles GitHub remote forms", () => {
    const want = "https://github.com/o/r/compare/main...garden/fix%20it?expand=1";
    for (const u of ["https://github.com/o/r", "https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://user@github.com/o/r.git/"]) {
      expect(compareUrl(u, "main", "garden/fix it"), u).toBe(want);
    }
    expect(compareUrl("https://gitlab.com/o/r.git", "main", "x")).toBeNull();
    expect(compareUrl("git@bitbucket.org:o/r.git", "main", "x")).toBeNull();
  });

  describe("parsePrView", () => {
    const pr = (extra: object) => JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", reviewDecision: "", statusCheckRollup: [], ...extra });
    const run = (status: string, conclusion: string | null) => ({ __typename: "CheckRun", name: "ci", status, conclusion });
    const ctx = (state: string) => ({ __typename: "StatusContext", context: "ext", state });

    it("no checks", () => {
      expect(parsePrView(pr({}), 5)).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", state: "open", checks: "none", checkedAt: 5 });
    });
    it("passing", () => {
      expect(parsePrView(pr({ statusCheckRollup: [run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED"), ctx("SUCCESS")] }), 0)?.checks).toBe("passing");
    });
    it("failing beats pending", () => {
      expect(parsePrView(pr({ statusCheckRollup: [run("IN_PROGRESS", null), run("COMPLETED", "FAILURE")] }), 0)?.checks).toBe("failing");
      expect(parsePrView(pr({ statusCheckRollup: [ctx("ERROR")] }), 0)?.checks).toBe("failing");
    });
    it("pending", () => {
      expect(parsePrView(pr({ statusCheckRollup: [run("COMPLETED", "SUCCESS"), run("QUEUED", null)] }), 0)?.checks).toBe("pending");
      expect(parsePrView(pr({ statusCheckRollup: [ctx("PENDING")] }), 0)?.checks).toBe("pending");
    });
    it("merged and approved", () => {
      const p = parsePrView(pr({ state: "MERGED", reviewDecision: "APPROVED" }), 0);
      expect(p?.state).toBe("merged");
      expect(p?.review).toBe("approved");
      expect(parsePrView(pr({ reviewDecision: "CHANGES_REQUESTED" }), 0)?.review).toBe("changes_requested");
      expect(parsePrView(pr({ state: "CLOSED" }), 0)?.state).toBe("closed");
    });
    it("garbage → null", () => {
      expect(parsePrView("not json", 0)).toBeNull();
      expect(parsePrView("{}", 0)).toBeNull();
    });
  });
});

describe("repo info", () => {
  it("isRepo, repoRoot, commonDir, currentBranch, recentSubjects", async () => {
    const r = await repo();
    const plain = await tmp();
    expect(await isRepo(r)).toBe(true);
    expect(await isRepo(plain)).toBe(false);
    expect(await repoRoot(r)).toBe(path.resolve(r));
    expect(await commonDir(r)).toBe(path.join(r, ".git"));
    expect(await currentBranch(r)).toBe("main");
    expect(await recentSubjects(r, 5)).toEqual(["init"]);
  });
});

describe("worktrees", () => {
  it("create, ensure after deletion, dirtyCount, remove + delete branch", async () => {
    const r = await repo();
    const plots = await tmp();
    const wt = path.join(plots, "repo", "pot-1");
    const head = (await g(r, "rev-parse", "HEAD")).trim();
    const made = await createWorktree({ repo: r, path: wt, branch: "garden/pot-1" });
    expect(made.baseSha).toBe(head);
    expect(await currentBranch(wt)).toBe("garden/pot-1");
    expect(await commonDir(wt)).toBe(path.join(r, ".git"));

    expect(await dirtyCount(wt)).toBe(0);
    await write(wt, "a.txt", "changed\n");
    await write(wt, "new.txt", "n\n");
    await write(wt, "x.log", "ignored\n");
    expect(await dirtyCount(wt)).toBe(2);
    await commit(wt, "pot work");

    // Folder disappears (user deleted it): ensureWorktree brings it back on the same branch.
    await ensureWorktree({ repo: r, path: wt, branch: "garden/pot-1" }); // no-op
    await fs.rm(wt, { recursive: true, force: true });
    await ensureWorktree({ repo: r, path: wt, branch: "garden/pot-1" });
    expect((await read(wt, "a.txt")).toString()).toBe("changed\n");
    expect(await currentBranch(wt)).toBe("garden/pot-1");

    await removeWorktree(r, wt, { deleteBranch: "garden/pot-1" });
    expect(await has(wt, "")).toBe(false);
    expect(await g(r, "branch", "--list", "garden/pot-1")).toBe("");
    expect(await g(r, "worktree", "list", "--porcelain")).not.toContain("pot-1");
  });

  it("refuses to delete the main checkout", async () => {
    const r = await repo();
    await expect(removeWorktree(r, r)).rejects.toThrow();
    expect(await has(r, "a.txt")).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("removal does not follow junctions and handles long paths", async () => {
    const r = await repo();
    const outside = await tmp();
    await write(outside, "precious.txt", "keep me");
    const wt = path.join(await tmp(), "pot");
    await createWorktree({ repo: r, path: wt, branch: "garden/j" });
    await fs.symlink(outside, path.join(wt, "link"), "junction");
    await write(wt, path.join(...Array.from({ length: 6 }, (_, i) => `long-folder-name-number-${i}-padding-padding`), "f.txt"), "x");
    await removeWorktree(r, wt);
    expect(await has(wt, "")).toBe(false);
    expect((await read(outside, "precious.txt")).toString()).toBe("keep me");
  });
});

describe("snapshot", () => {
  it("captures tracked, untracked, deleted and shell-made changes, not ignored files; real index untouched", async () => {
    const r = await repo();
    await write(r, "staged.txt", "staged\n");
    await g(r, "add", "staged.txt");
    const indexPath = path.join(r, ".git", "index");
    const before = { cached: await g(r, "diff", "--cached", "--name-only"), mtime: (await fs.stat(indexPath)).mtimeMs };

    await write(r, "a.txt", "alpha 2\n"); // modified tracked
    await write(r, "dir/new.txt", "new\n"); // new untracked
    await fs.rm(path.join(r, "b.txt")); // deleted
    await write(r, "debug.log", "noise\n"); // ignored
    await write(r, "ignored/big.bin", "x");

    const s = ok(await snapshot(r, "refs/terrarium/p1/1", "turn 1"));
    expect(s.head).toBe((await g(r, "rev-parse", "HEAD")).trim());
    expect(await filesAt(r, s.commit)).toEqual([".gitignore", "a.txt", "dir/new.txt", "staged.txt"]);
    expect(await g(r, "show", `${s.commit}:a.txt`)).toBe("alpha 2\n");
    expect((await g(r, "rev-parse", "refs/terrarium/p1/1")).trim()).toBe(s.commit);
    expect((await g(r, "rev-parse", `${s.commit}^`)).trim()).toBe(s.head);

    // A change made outside any tool (a "shell" write) shows up in the next snapshot.
    await write(r, "a.txt", "from bash\n");
    const s2 = ok(await snapshot(r, "refs/terrarium/p1/2", "turn 2"));
    expect(await g(r, "show", `${s2.commit}:a.txt`)).toBe("from bash\n");

    expect(await g(r, "diff", "--cached", "--name-only")).toBe(before.cached);
    expect((await fs.stat(indexPath)).mtimeMs).toBe(before.mtime);
    expect((await fs.readdir(path.join(r, ".git"))).filter((f) => f.startsWith("terrarium-index"))).toEqual([]);

    await deleteRefs(r, "refs/terrarium/p1/");
    expect(await g(r, "for-each-ref", "refs/terrarium/")).toBe("");
  });

  it("works in a linked worktree, in a repo with no commits, and skips non-repos", async () => {
    const r = await repo();
    const wt = path.join(await tmp(), "pot");
    await createWorktree({ repo: r, path: wt, branch: "garden/s" });
    await write(wt, "pot-only.txt", "p\n");
    const s = ok(await snapshot(wt, "refs/terrarium/w/1", "wt"));
    expect(await filesAt(r, s.commit)).toContain("pot-only.txt");
    expect(await dirtyCount(r)).toBe(0); // main checkout untouched

    const empty = await repo({ commit: false });
    await write(empty, "first.txt", "1\n");
    const e = ok(await snapshot(empty, "refs/terrarium/e/1", "empty"));
    expect(e.head).toBe("");
    expect(await filesAt(empty, e.commit)).toEqual(["first.txt"]);

    expect(await snapshot(await tmp(), "refs/terrarium/x/1", "nope")).toEqual({ skipped: "not a git repository" });
  });

  it("skips embedded repos that have no commit instead of failing", async () => {
    const r = await repo();
    const nested = path.join(r, "vendor", "lib");
    await fs.mkdir(nested, { recursive: true });
    await g(nested, "init", "-q");
    await write(nested, "x.txt", "x");
    await write(r, "top.txt", "t");
    const s = ok(await snapshot(r, "refs/terrarium/n/1", "nested"));
    expect(await filesAt(r, s.commit)).toContain("top.txt");
  });
});

describe("diffs and restore", () => {
  it("diffFiles and diffPatch between two snapshots", async () => {
    const r = await repo();
    await write(r, "rename-me.txt", "line one\nline two\nline three\nline four\n");
    await write(r, "gone.txt", "bye\n");
    await write(r, "img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    const a = ok(await snapshot(r, "refs/terrarium/d/1", "a"));

    await fs.rename(path.join(r, "rename-me.txt"), path.join(r, "renamed.txt"));
    await fs.rm(path.join(r, "gone.txt"));
    await write(r, "a.txt", "alpha\nmore\n");
    await write(r, "added.txt", "hi\nthere\n");
    await write(r, "img.bin", Buffer.from([0, 9, 9, 9, 0, 1]));
    const b = ok(await snapshot(r, "refs/terrarium/d/2", "b"));

    const files = (await diffFiles(r, a.commit, b.commit)).sort((x, y) => x.path.localeCompare(y.path));
    expect(files).toEqual([
      { path: "a.txt", status: "modified", insertions: 1, deletions: 0 },
      { path: "added.txt", status: "added", insertions: 2, deletions: 0 },
      { path: "gone.txt", status: "deleted", insertions: 0, deletions: 1 },
      { path: "img.bin", status: "binary", insertions: 0, deletions: 0 },
      { path: "renamed.txt", oldPath: "rename-me.txt", status: "renamed", insertions: 0, deletions: 0 },
    ]);

    const patch = await diffPatch(r, a.commit, b.commit, "a.txt");
    expect(patch).toContain("+more");
    expect(patch).not.toContain("added.txt");
    expect(await diffPatch(r, a.commit, b.commit, "renamed.txt")).toContain("rename from rename-me.txt");
    const cut = await diffPatch(r, a.commit, b.commit, "a.txt", 40);
    expect(cut.endsWith("\n[truncated]")).toBe(true);
    expect(cut.length).toBe(40 + "\n[truncated]".length);
  });

  it("restoreTo makes the tree byte-identical to the snapshot, removes new files, keeps ignored ones", async () => {
    const r = await repo();
    await write(r, "untracked-then.txt", "u\n");
    const a = ok(await snapshot(r, "refs/terrarium/r/1", "a"));
    const hashes = async () => {
      const out: Record<string, string> = {};
      for (const f of ["a.txt", "b.txt", "untracked-then.txt"]) out[f] = createHash("sha256").update(await read(r, f)).digest("hex");
      return out;
    };
    const want = await hashes();

    await write(r, "a.txt", "mangled\n");
    await fs.rm(path.join(r, "b.txt"));
    await fs.rm(path.join(r, "untracked-then.txt"));
    await write(r, "later/new.txt", "should go\n");
    await write(r, "keep.log", "ignored survives\n");
    await g(r, "add", "a.txt");

    await restoreTo(r, a.commit);
    expect(await hashes()).toEqual(want);
    expect(await has(r, "later")).toBe(false);
    expect((await read(r, "keep.log")).toString()).toBe("ignored survives\n");
    expect(await g(r, "diff", "--cached", "--name-only")).toBe(""); // index back to HEAD
    expect((await g(r, "status", "--porcelain")).trim()).toBe("?? untracked-then.txt");
  });

  it.each(["false", "true"])("CRLF files round-trip byte-identically (autocrlf=%s)", async (autocrlf) => {
    const r = await repo({ autocrlf });
    const crlf = Buffer.from("one\r\ntwo\r\nthree\r\n");
    await write(r, "win.txt", crlf);
    await write(r, "tracked-crlf.txt", crlf);
    await g(r, "add", "tracked-crlf.txt");
    await g(r, "commit", "-q", "-m", "crlf");
    const a = ok(await snapshot(r, "refs/terrarium/c/1", "a"));
    await write(r, "win.txt", "lf only\n");
    await write(r, "tracked-crlf.txt", "lf only\n");
    await restoreTo(r, a.commit);
    expect((await read(r, "win.txt")).equals(crlf)).toBe(true);
    expect((await read(r, "tracked-crlf.txt")).equals(crlf)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("long paths (> 260 chars) work in snapshot and restore", async () => {
    const r = await repo();
    const rel = path.join(...Array.from({ length: 6 }, (_, i) => `deeply-nested-folder-number-${i}-with-a-long-name`), "file-with-a-long-name.txt");
    expect(path.join(r, rel).length).toBeGreaterThan(260);
    await write(r, rel, "deep\n");
    const a = ok(await snapshot(r, "refs/terrarium/l/1", "a"));
    await write(r, rel, "changed\n");
    await restoreTo(r, a.commit);
    expect((await read(r, rel)).toString()).toBe("deep\n");
  });
});

describe("harvest", () => {
  it("commit, push to a bare origin, unpushedCount, defaultBranch, pendingPatch", async () => {
    const origin = await tmp();
    await g(origin, "init", "-q", "--bare", "-b", "main");
    const r = await repo();
    await g(r, "remote", "add", "origin", origin);
    await g(r, "push", "-q", "-u", "origin", "main");
    await g(r, "remote", "set-head", "origin", "main");
    expect(await defaultBranch(r)).toBe("main");

    await g(r, "switch", "-q", "-c", "garden/h");
    expect(await unpushedCount(r)).toBe(0); // no upstream: vs origin/main
    await write(r, "a.txt", "alpha\nchange\n");
    await write(r, "fresh.txt", "fresh\n");
    const patch = await pendingPatch(r, 10_000);
    expect(patch).toContain("a.txt");
    expect(patch).toContain("Untracked files:\nfresh.txt");
    expect(patch).toContain("+change");
    const short = await pendingPatch(r, 30);
    expect(short.length).toBe(30);
    expect(short.endsWith("[truncated]")).toBe(true);

    const sha = await commit(r, "Subject line\n\nBody line one.\nBody line two.\n", ["a.txt"]);
    expect(sha).toBe((await g(r, "rev-parse", "HEAD")).trim());
    expect(await g(r, "log", "-1", "--format=%B")).toBe("Subject line\n\nBody line one.\nBody line two.\n\n");
    expect(await filesAt(r, "HEAD")).not.toContain("fresh.txt"); // only the chosen files
    expect(await unpushedCount(r)).toBe(1);
    await expect(commit(r, "nothing", ["a.txt"])).rejects.toThrow();

    await push(r, "garden/h");
    expect(await unpushedCount(r)).toBe(0); // upstream now set
    await commit(r, "rest");
    expect(await unpushedCount(r)).toBe(1);
    await expect(push(r, "no-such-branch")).rejects.toThrow(/no-such-branch/);
  });

  it("unpushedCount with no remote counts every commit; defaultBranch falls back to local main", async () => {
    const r = await repo();
    expect(await unpushedCount(r)).toBe(1);
    expect(await defaultBranch(r)).toBe("main");
    expect(await pendingPatch(await repo({ commit: false }), 100)).toBe("");
  });
});
