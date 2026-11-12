import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plant } from "../shared/types";
import { Harvest, parseCommitMessage } from "./harvest";
import { GardenStore } from "./store";

function rmRepo(dir: string) {
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue; // 0o666 on a directory drops its x bit, so POSIX rm then fails with EACCES
    try {
      chmodSync(join(e.parentPath, e.name), 0o666);
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("Harvest", () => {
  let dir: string;
  let repo: string;
  let origin: string;
  let store: GardenStore;
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-harvest-"));
    origin = mkdtempSync(join(tmpdir(), "terrarium-origin-"));
    repo = mkdtempSync(join(tmpdir(), "terrarium-hrepo-"));
    g(origin, "init", "-q", "--bare", "-b", "main");
    g(repo, "init", "-q", "-b", "main");
    g(repo, "config", "user.email", "t@example.com");
    g(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "one\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-q", "-u", "origin", "main");
    g(repo, "switch", "-qc", "garden/fix-1234");
    store = new GardenStore(dir);
    store.putBed({ id: "bed", name: "repo", path: repo, createdAt: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmRepo(repo);
    rmRepo(origin);
  });

  const harvest = () =>
    new Harvest({ store, uncommitted: async () => [], openExternal() {}, wake() {}, wakeOnRedStake: () => false, env: () => ({ ...process.env }) });

  it("marks an open PR's checks as running after a push, so the watcher polls on the fast cadence", async () => {
    const plant: Plant = {
      id: "p",
      bedId: "bed",
      name: "Fix",
      species: "rose",
      seed: "fix",
      origin: "sown",
      plot: "bed",
      cwd: repo,
      branch: "garden/fix-1234",
      permissionMode: "default",
      status: "idle",
      live: false,
      turns: 1,
      toolCalls: 0,
      costUsd: 0,
      runners: 0,
      unread: false,
      pr: { url: "https://github.com/example/repo/pull/7", number: 7, state: "open", checks: "passing", checkedAt: Date.now() },
      createdAt: 0,
      updatedAt: 0,
    };
    store.putPlant(plant);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    const h = harvest();
    await h.commit("p", { subject: "Add two", body: "" });
    expect(store.plants.get("p")!.unpushed).toBe(1);
    await h.push("p");
    const after = store.plants.get("p")!;
    expect(after.unpushed).toBe(0);
    expect(after.pr).toMatchObject({ state: "open", checks: "pending", checkedAt: 0 });
    expect(g(origin, "log", "--oneline", "garden/fix-1234")).toContain("Add two");
  });

  it("parses generated commit messages defensively", () => {
    expect(parseCommitMessage('```\n"Fix the login redirect."\n\n- keep the query string\n```', "fallback")).toEqual({ subject: "Fix the login redirect", body: "- keep the query string" });
    expect(parseCommitMessage("", "Fix login")).toEqual({ subject: "Fix login", body: "" });
  });
});
