// Reads a bed's soil: git state plus the hygiene that helps agents grow well.
// Fully async (PLAN 2f): no sync fs, and the test-file search is a bounded walk.
import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import type { SoilReport } from "../shared/types";
import { defaultBranch, git } from "./git";

/** Parses `git status --porcelain=v1 -b` output. Exported for tests. */
export function parseStatus(out: string): Pick<SoilReport, "branch" | "dirty" | "ahead" | "behind"> {
  const lines = out.split("\n").filter(Boolean);
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : undefined;
  if (head) {
    if (head.startsWith("No commits yet on ")) branch = head.slice("No commits yet on ".length);
    else if (head.startsWith("HEAD (no branch)")) branch = "detached";
    else branch = head.split("...")[0].split(" ")[0];
    ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
    behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  }
  return { branch, dirty: lines.length, ahead, behind };
}

const GUIDANCE = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", "CLAUDE.local.md", ".cursorrules", ".github/copilot-instructions.md"];
const CI = [".github/workflows", ".gitlab-ci.yml", ".circleci", "azure-pipelines.yml", ".buildkite", "Jenkinsfile", ".woodpecker.yml"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "e2e", "src/test", "src/__tests__"];
const TEST_CONFIGS = ["vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts", "playwright.config.ts", "pytest.ini"];
const LINT = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".oxlintrc.json",
  "biome.json",
  "biome.jsonc",
  ".prettierrc",
  "prettier.config.js",
  "ruff.toml",
  ".rustfmt.toml",
  "rustfmt.toml",
  ".golangci.yml",
  ".editorconfig",
];
/** Files the stake detection reads. Together with the lists above, these are the "hygiene files" the scheduler watches. */
const BUILD_FILES = ["package.json", "Makefile", "pyproject.toml", "Cargo.toml", "go.mod", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
export const HYGIENE_FILES = new Set([...GUIDANCE, ...CI, ...TEST_DIRS, ...TEST_CONFIGS, ...LINT, ...BUILD_FILES].map((f) => f.split("/")[0]));

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const readText = (p: string) => fs.readFile(p, "utf8").catch(() => null);

async function present(root: string, candidates: string[]): Promise<string[]> {
  const hits = await Promise.all(candidates.map((c) => exists(join(root, c))));
  return candidates.filter((_, i) => hits[i]);
}

type Pkg = { scripts?: Record<string, string>; prettier?: unknown } | null;

/** Breadth-first walk of src/ (depth ≤ 4, ≤ 2000 entries); returns the first test file found. */
async function findTestFile(root: string): Promise<string | undefined> {
  const queue: [string, number][] = [["src", 0]];
  let seen = 0;
  while (queue.length) {
    const [rel, depth] = queue.shift()!;
    let names: Dirent[];
    try {
      names = await fs.readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (++seen > 2000) return undefined;
      const child = `${rel}/${d.name}`;
      if (d.isFile() && /(\.test\.|\.spec\.|_test\.)/.test(d.name)) return child;
      if (d.isDirectory() && depth < 4 && d.name !== "node_modules" && !d.name.startsWith(".")) queue.push([child, depth + 1]);
    }
  }
  return undefined;
}

const realTest = (s?: string) => !!s && !/no test specified/.test(s);

async function findTests(root: string, pkg: Pkg): Promise<string[]> {
  const found = await present(root, TEST_DIRS);
  if (realTest(pkg?.scripts?.test)) found.push("npm test");
  found.push(...(await present(root, TEST_CONFIGS)));
  if (found.length === 0) {
    const hit = await findTestFile(root);
    if (hit) found.push(hit);
  }
  return found;
}

async function findLint(root: string, pkg: Pkg): Promise<string[]> {
  const found = await present(root, LINT);
  if (pkg?.scripts?.lint) found.push("npm run lint");
  if (pkg?.prettier) found.push("package.json prettier");
  return found;
}

/** Check commands a bed could use as its stake, most useful first. Exported for tests. */
export async function findStakeCandidates(root: string, pkg: Pkg = null): Promise<string[]> {
  const out: string[] = [];
  const scripts = pkg?.scripts ?? {};
  const [pnpm, yarn, bunb, bun] = await Promise.all(["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].map((f) => exists(join(root, f))));
  const pm = pnpm ? "pnpm" : yarn ? "yarn" : bunb || bun ? "bun" : "npm";
  for (const s of ["typecheck", "check", "lint", "test"]) {
    if (!scripts[s] || (s === "test" && !realTest(scripts.test))) continue;
    // `npm test` is a built-in alias; `bun test` would run bun's own runner, so bun always says `run`.
    out.push(pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : pm === "bun" ? `bun run ${s}` : `${pm} ${s}`);
  }
  const [make, py, cargo, gomod] = await Promise.all([readText(join(root, "Makefile")), readText(join(root, "pyproject.toml")), exists(join(root, "Cargo.toml")), exists(join(root, "go.mod"))]);
  if (make) for (const t of ["check", "test", "lint"]) if (new RegExp(`^${t}\\s*:`, "m").test(make)) out.push(`make ${t}`);
  if (py) {
    if (/pytest/.test(py)) out.push("pytest -q");
    if (/ruff/.test(py)) out.push("ruff check .");
  }
  if (cargo) out.push("cargo check", "cargo test");
  if (gomod) out.push("go vet ./...", "go test ./...");
  return [...new Set(out)];
}

/**
 * 0..100. Compost, stakes, fence and mulch are 20 points each, plus 20 × the stake pass rate
 * over the last 20 stake runs. With no stake runs yet, the four checks scale to 100.
 */
export function healthScore(report: SoilReport, stakePassRate?: number): number {
  const checks = [report.guidance, report.ci, report.tests, report.lint].filter((l) => l.length > 0).length;
  if (stakePassRate === undefined || Number.isNaN(stakePassRate)) return checks * 25;
  return Math.round(checks * 20 + 20 * Math.min(1, Math.max(0, stakePassRate)));
}

type Hygiene = Pick<SoilReport, "guidance" | "ci" | "tests" | "lint" | "stakeCandidates">;

/** The file checks alone (no git). The scheduler reuses the last result when nothing changed. */
export async function readHygiene(root: string): Promise<Hygiene> {
  const pkgText = await readText(join(root, "package.json"));
  let pkg: Pkg = null;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null;
  } catch {
    // a broken package.json counts as none
  }
  const [guidance, ci, tests, lint, stakeCandidates] = await Promise.all([present(root, GUIDANCE), present(root, CI), findTests(root, pkg), findLint(root, pkg), findStakeCandidates(root, pkg)]);
  return { guidance, ci, tests, lint, stakeCandidates };
}

/** Git state only (status + default branch). */
export async function readGitSoil(root: string): Promise<Pick<SoilReport, "isGitRepo" | "branch" | "dirty" | "ahead" | "behind" | "defaultBranch">> {
  let status: string | null = null;
  try {
    const r = await git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=normal"], { timeoutMs: 15_000 });
    status = r.code === 0 ? r.stdout : null;
  } catch {
    // git missing or the service not ready: not a repo as far as soil goes
  }
  if (status === null) return { isGitRepo: false, dirty: 0, ahead: 0, behind: 0 };
  let def: string | undefined;
  try {
    def = (await defaultBranch(root)) ?? undefined;
  } catch {
    def = undefined;
  }
  return { isGitRepo: true, ...parseStatus(status), defaultBranch: def };
}

export async function readSoil(root: string, reuse?: Hygiene): Promise<SoilReport> {
  const checkedAt = Date.now();
  if (!(await exists(root))) return { exists: false, isGitRepo: false, dirty: 0, ahead: 0, behind: 0, guidance: [], ci: [], tests: [], lint: [], checkedAt };
  const [gitState, hygiene] = await Promise.all([readGitSoil(root), reuse ?? readHygiene(root)]);
  return { exists: true, ...gitState, ...hygiene, checkedAt };
}
