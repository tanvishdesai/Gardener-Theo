// A deterministic synthetic garden for benchmarks and the demo (`?beds=100&plants=1000&live=30`).
// Most plants are old and idle (they belong in the Seed Catalogue); `live` of them are streaming.
import { potBranch, spiralSlot } from "../../shared/garden";
import type { Activity, Bed, Plant, SoilReport } from "../../shared/types";
import { SPECIES } from "../../shared/types";

/** mulberry32: small seeded PRNG, good enough for test data. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPOS = ["api", "web", "mobile", "infra", "docs", "billing", "search", "auth", "sync", "cli", "design", "data", "ml", "edge", "admin", "notify"];
const VERBS = ["Fix", "Add", "Refactor", "Speed up", "Remove", "Document", "Test", "Port", "Clean up", "Investigate"];
const THINGS = ["login flow", "retry logic", "cache layer", "date parsing", "upload queue", "rate limiter", "error toasts", "search index", "webhooks", "dark mode", "settings page", "CSV export"];
const ACTIVITIES: Activity[] = ["think", "read", "search", "edit", "run", "web", "delegate", "todo", "edit", "run"];
const DAY = 86_400_000;

export function syntheticGarden(o: { beds: number; plants: number; live: number; journal?: number; seed?: number; now?: number }): {
  beds: Bed[];
  plants: Plant[];
  soil: Record<string, SoilReport>;
} {
  const r = prng(o.seed ?? 42);
  const now = o.now ?? Date.now();
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const nBeds = Math.max(1, o.beds);

  const beds: Bed[] = [];
  const soil: Record<string, SoilReport> = {};
  for (let i = 0; i < nBeds; i++) {
    const s = spiralSlot(i + 1);
    const name = i < REPOS.length ? REPOS[i] : `${pick(REPOS)}-${i}`;
    const id = `bed-${i}`;
    beds.push({ id, name, path: `~/code/${name}`, createdAt: now - (nBeds - i) * DAY, gridX: s.x, gridY: s.y });
    soil[id] = {
      exists: true,
      isGitRepo: true,
      branch: r() < 0.6 ? "main" : `feature/${pick(THINGS).replace(/ /g, "-")}`,
      defaultBranch: "main",
      dirty: r() < 0.4 ? Math.floor(r() * 9) : 0,
      ahead: 0,
      behind: 0,
      guidance: r() < 0.6 ? ["CLAUDE.md"] : [],
      ci: r() < 0.7 ? [".github/workflows"] : [],
      tests: r() < 0.6 ? ["vitest.config.ts"] : [],
      lint: r() < 0.5 ? ["eslint.config.js"] : [],
      health: Math.floor(r() * 100),
      checkedAt: now,
    };
  }

  // Uneven: the first bed gets 20% (200 of 1,000), the rest fall off like a long tail.
  const big = nBeds > 1 ? Math.round(o.plants * 0.2) : o.plants;
  const weights = beds.slice(1).map((_, i) => 1 / (1 + i * 0.15) + r() * 0.3);
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const bedOf: string[] = [];
  for (let i = 0; i < big; i++) bedOf.push(beds[0].id);
  for (let i = big; i < o.plants; i++) {
    let x = r() * wsum;
    let k = 0;
    while (k < weights.length - 1 && x > weights[k]) x -= weights[k++];
    bedOf.push(beds[k + 1]?.id ?? beds[0].id);
  }

  // Spread the live ones over the plant list (so the big bed gets a few too).
  const live = new Set<number>();
  const nLive = Math.min(o.live, o.plants);
  for (let i = 0; live.size < nLive; i++) live.add(Math.floor(((i * 0.618034) % 1) * o.plants));

  const plants: Plant[] = [];
  for (let i = 0; i < o.plants; i++) {
    const name = `${pick(VERBS)} ${pick(THINGS)}`;
    const turns = Math.floor(r() * r() * 20);
    const createdAt = now - Math.floor((60 + r() * 120) * DAY) + i * 1000;
    const p: Plant = {
      id: `p-${i}`,
      bedId: bedOf[i],
      name,
      species: pick(SPECIES),
      seed: `${name} in this repo`,
      origin: "sown",
      permissionMode: r() < 0.1 ? "plan" : r() < 0.5 ? "acceptEdits" : "default",
      status: "idle",
      live: false,
      turns,
      toolCalls: turns * 9 + Math.floor(r() * 9),
      costUsd: Math.round(turns * r() * 60) / 100,
      runners: 0,
      unread: false,
      plot: r() < 0.35 ? "pot" : "bed",
      createdAt,
      // Weeks old: these go to the catalogue.
      updatedAt: now - Math.floor((14 + r() * 60) * DAY),
      lastText: "Done. Tests pass.",
    };
    if (p.plot === "pot") {
      p.branch = potBranch(name, Math.floor(r() * 65536).toString(16).padStart(4, "0"));
      p.worktreePath = `~/.gardener/plots/${p.bedId}/${p.branch.slice(7)}`;
    }
    const roll = r();
    if (live.has(i)) {
      const activity = pick(ACTIVITIES);
      Object.assign(p, {
        live: true,
        status: activity === "think" ? "thinking" : "working",
        activity,
        activityDetail: activity === "run" ? "npm test" : activity === "edit" ? "src/index.ts" : undefined,
        runners: activity === "delegate" ? 1 + Math.floor(r() * 3) : 0,
        turns: Math.max(1, turns),
        updatedAt: now - Math.floor(r() * 60_000),
      });
    } else if (roll < 0.012) {
      const kind = pick(["permission", "question", "plan"] as const);
      Object.assign(p, {
        status: "waiting",
        live: true,
        updatedAt: now - Math.floor(r() * 600_000),
        ask: { id: `ask-${i}`, kind, toolName: kind === "plan" ? "ExitPlanMode" : "Bash", title: "Claude wants to run a command", detail: "npm run migrate", canAlwaysAllow: kind === "permission", createdAt: now - 60_000 },
      });
    } else if (roll < 0.02) {
      Object.assign(p, { status: "error", error: "The turn failed: tool returned exit code 1", updatedAt: now - Math.floor(r() * DAY) });
    } else if (roll < 0.035) {
      Object.assign(p, { unread: true, turns: Math.max(1, turns), updatedAt: now - Math.floor(r() * 3_600_000) });
    } else if (roll < 0.04) {
      Object.assign(p, { queued: true, updatedAt: now - 30_000 });
    } else if (roll < 0.1) {
      p.updatedAt = now - Math.floor(r() * 5 * DAY); // recent but idle: still in the ground
    }
    if (p.turns > 0 && r() < 0.6) {
      const files = 1 + Math.floor(r() * 6);
      p.lastDiff = { files, insertions: Math.floor(r() * 200), deletions: Math.floor(r() * 60) };
      p.ring = p.turns;
    }
    if (p.plot === "pot") {
      p.potDirty = r() < 0.4 ? 1 + Math.floor(r() * 5) : 0;
      p.unpushed = r() < 0.2 ? 1 + Math.floor(r() * 3) : 0;
      if (r() < 0.25) {
        const n = 100 + i;
        p.pr = {
          number: n,
          url: `https://github.com/acme/${p.bedId}/pull/${n}`,
          state: r() < 0.8 ? "open" : "merged",
          checks: pick(["passing", "failing", "pending", "none"] as const),
          review: pick(["approved", "changes_requested", "review_required", undefined] as const),
          checkedAt: now,
        };
      }
    }
    if (p.turns > 0 && r() < 0.15) {
      const failing = r() < 0.4;
      p.stake = { status: failing ? "failing" : r() < 0.2 ? "running" : "passing", command: "npm test", summary: failing ? "3 failures" : undefined, turn: p.turns, at: p.updatedAt };
    }
    if (r() < 0.03) {
      p.origin = "volunteer";
      p.watchedBy = r() < 0.5 ? "hook" : "transcript";
      p.cwd = `~/code/${p.bedId}`;
      p.plot = "bed";
      p.pr = undefined;
      if (!p.live) p.ended = true;
    }
    plants.push(p);
  }
  return { beds, plants, soil };
}
