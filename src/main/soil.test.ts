import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SoilReport } from "../shared/types";
import { findStakeCandidates, healthScore, parseStatus, readSoil } from "./soil";

describe("parseStatus", () => {
  it("reads branch, ahead/behind and dirty count", () => {
    expect(parseStatus("## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? new.txt\n")).toEqual({ branch: "main", dirty: 2, ahead: 2, behind: 1 });
  });
  it("handles a fresh repo and a detached head", () => {
    expect(parseStatus("## No commits yet on trunk\n").branch).toBe("trunk");
    expect(parseStatus("## HEAD (no branch)\n").branch).toBe("detached");
  });
});

describe("stake candidates", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-soil-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const put = (f: string, s = "") => writeFileSync(join(dir, f), s);
  const scripts = (s: Record<string, string>) => ({ scripts: s });

  it("orders package scripts and picks the package manager from the lockfile", async () => {
    const pkg = scripts({ test: "vitest", lint: "eslint .", typecheck: "tsc", build: "vite build" });
    expect(await findStakeCandidates(dir, pkg)).toEqual(["npm run typecheck", "npm run lint", "npm test"]);
    put("pnpm-lock.yaml");
    expect(await findStakeCandidates(dir, pkg)).toEqual(["pnpm typecheck", "pnpm lint", "pnpm test"]);
    rmSync(join(dir, "pnpm-lock.yaml"));
    put("bun.lock");
    expect(await findStakeCandidates(dir, scripts({ test: "bun test" }))).toEqual(["bun run test"]);
  });

  it("skips npm's placeholder test script", async () => {
    expect(await findStakeCandidates(dir, scripts({ test: 'echo "Error: no test specified" && exit 1' }))).toEqual([]);
  });

  it("finds Makefile targets, Python, Rust and Go checks", async () => {
    put("Makefile", "build:\n\tgo build\ntest: build\n\tgo test\ncheck:\n\ttrue\n");
    put("pyproject.toml", "[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n");
    put("Cargo.toml", "[package]\n");
    put("go.mod", "module x\n");
    expect(await findStakeCandidates(dir)).toEqual(["make check", "make test", "pytest -q", "ruff check .", "cargo check", "cargo test", "go vet ./...", "go test ./..."]);
  });
});

describe("healthScore", () => {
  const r = (n: number): SoilReport => ({
    exists: true,
    isGitRepo: true,
    dirty: 0,
    ahead: 0,
    behind: 0,
    checkedAt: 0,
    guidance: n > 0 ? ["CLAUDE.md"] : [],
    ci: n > 1 ? [".github/workflows"] : [],
    tests: n > 2 ? ["test"] : [],
    lint: n > 3 ? ["biome.json"] : [],
  });
  it("scales the four checks to 100 with no stake runs", () => {
    expect(healthScore(r(0))).toBe(0);
    expect(healthScore(r(2))).toBe(50);
    expect(healthScore(r(4))).toBe(100);
  });
  it("gives the stake pass rate the last 20 points", () => {
    expect(healthScore(r(4), 1)).toBe(100);
    expect(healthScore(r(4), 0)).toBe(80);
    expect(healthScore(r(1), 0.5)).toBe(30);
  });
});

describe("readSoil", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gardener-soil-repo-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  it("reads git state, hygiene and stake candidates from a real repo", async () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(join(dir, "CLAUDE.md"), "# guide");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
    mkdirSync(join(dir, "src", "deep", "er"), { recursive: true });
    writeFileSync(join(dir, "src", "deep", "er", "x.test.ts"), "");
    const soil = await readSoil(dir);
    expect(soil).toMatchObject({ exists: true, isGitRepo: true, branch: "main", defaultBranch: "main", dirty: 3, guidance: ["CLAUDE.md"], stakeCandidates: ["npm run typecheck"] });
    expect(soil.tests).toEqual(["src/deep/er/x.test.ts"]);
  });

  it("reports a missing folder and a plain folder", async () => {
    expect((await readSoil(join(dir, "nope"))).exists).toBe(false);
    expect(await readSoil(dir)).toMatchObject({ exists: true, isGitRepo: false, tests: [], stakeCandidates: [] });
  });
});
