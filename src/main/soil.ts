// Reads a bed's soil: git state plus the hygiene that helps agents grow well.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SoilReport } from "../shared/types";

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

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
const TEST_CONFIGS = ["vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts", "playwright.config.ts", "pytest.ini", "Cargo.toml", "go.mod"];
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

function present(root: string, candidates: string[]) {
  return candidates.filter((c) => existsSync(join(root, c)));
}

function packageJson(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function findTests(root: string): string[] {
  const found = present(root, TEST_DIRS);
  const pkg = packageJson(root);
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  if (scripts.test && !/no test specified/.test(scripts.test)) found.push("npm test");
  for (const c of present(root, TEST_CONFIGS)) {
    // Cargo and Go have built-in test runners; only count them if a test file exists nearby.
    if (c === "Cargo.toml" || c === "go.mod") continue;
    found.push(c);
  }
  if (found.length === 0) {
    // A quick shallow look for *.test.* / *_test.* files in src.
    const src = join(root, "src");
    try {
      if (statSync(src).isDirectory()) {
        const hit = readdirSync(src, { recursive: true, encoding: "utf8" })
          .slice(0, 5000)
          .find((f) => /(\.test\.|\.spec\.|_test\.)/.test(f));
        if (hit) found.push(`src/${hit}`);
      }
    } catch {
      // ignore
    }
  }
  return found;
}

function findLint(root: string): string[] {
  const found = present(root, LINT);
  const pkg = packageJson(root);
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  if (scripts.lint) found.push("npm run lint");
  if (pkg && (pkg as { prettier?: unknown }).prettier) found.push("package.json prettier");
  return found;
}

export async function readSoil(root: string): Promise<SoilReport> {
  const base: SoilReport = {
    exists: existsSync(root),
    isGitRepo: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    guidance: [],
    ci: [],
    tests: [],
    lint: [],
    checkedAt: Date.now(),
  };
  if (!base.exists) return base;
  const status = await git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=normal"]);
  return {
    ...base,
    isGitRepo: status !== null,
    ...(status !== null ? parseStatus(status) : {}),
    guidance: present(root, GUIDANCE),
    ci: present(root, CI),
    tests: findTests(root),
    lint: findLint(root),
  };
}
