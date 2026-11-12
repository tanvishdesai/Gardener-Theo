// Stake runs (PLAN M7): the bed's fast check command, run after a turn in the plant's cwd,
// through a bounded queue with a timeout that kills the whole process tree.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Entry, StakeResult } from "../shared/types";
import type { GardenStore } from "./store";

const TAIL_BYTES = 64 * 1024;

export interface CommandResult {
  code: number;
  /** Last 64 KB of stdout and stderr, interleaved as they arrived. */
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // the child leads its own process group (detached below)
    } catch {
      // already gone
    }
  }
}

/**
 * Runs user-configured command text through the platform shell (`cmd.exe /d /s /c` on Windows via
 * shell: true, `/bin/sh -c` elsewhere). cmd is used rather than PowerShell because `npm test`,
 * `make check` and friends behave the same there as in the user's terminal, and it starts faster.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let timedOut = false;
    let done = false;
    const finish = (r: Omit<CommandResult, "output">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ ...r, output: tail.toString("utf8") });
    };
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (b: Buffer) => {
      tail = Buffer.concat([tail, b]);
      if (tail.length > TAIL_BYTES * 2) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      // A grandchild holding the pipes open must not hang the queue.
      grace = setTimeout(() => finish({ code: -1, timedOut }), 5000);
    }, timeoutMs);
    child.on("error", (err) => finish({ code: -1, timedOut, spawnError: err.message }));
    child.on("close", (code, signal) => {
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
      finish({ code: code ?? (signal ? -1 : 0), timedOut });
    });
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line for a run, e.g. "passed", "3 failures", "2 errors", "exit code 1". Exported for tests. */
export function summarize(r: CommandResult, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (r.spawnError) return `could not start: ${r.spawnError}`;
  if (r.code === 0) return "passed";
  const last = (re: RegExp) => {
    const all = [...r.output.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : undefined;
  };
  // Test runners print a per-file line before the per-test total, so the last match is the total.
  const failed = last(/(\d+)\s+(?:failed|failing|failures?)\b/gi);
  if (failed) return plural(failed, "failure");
  const errors = last(/(\d+)\s+errors?\b/gi) ?? (r.output.match(/error TS\d+/g)?.length || undefined);
  if (errors) return plural(errors, "error");
  return `exit code ${r.code}`;
}

/** FIFO limiter: at most `max` tasks at once. */
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

export class StakeRunner {
  private store: GardenStore;
  private timeoutMs: number;
  private queue: ReturnType<typeof limiter>;

  constructor(deps: { store: GardenStore; concurrency?: number; timeoutMs?: number }) {
    this.store = deps.store;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60_000;
    this.queue = limiter(deps.concurrency ?? Math.max(1, Math.floor(os.availableParallelism() / 4)));
  }

  /** Runs the bed's stake for this plant. Undefined when the bed has no stake command (or the plant is gone). */
  async run(plantId: string, turn?: number): Promise<StakeResult | undefined> {
    const plant = this.store.plants.get(plantId);
    const bed = plant && this.store.beds.get(plant.bedId);
    const command = bed?.stakeCommand?.trim();
    if (!plant || !bed || !command) return undefined;
    const cwd = plant.cwd ?? bed.path;
    const set = (stake: StakeResult) => {
      this.store.updatePlant(plantId, { stake });
      if (turn !== undefined) this.store.updateRing(plantId, turn, { stake });
    };
    const runId = randomUUID();
    const toolEntry = (status: "running" | "ok" | "error", output?: string): Entry => ({
      id: `stake:${runId}`,
      plantId,
      ts: Date.now(),
      kind: "tool",
      text: "",
      tool: { id: `stake:${runId}`, name: "Stake", summary: command, activity: "run", status, output },
    });

    set({ status: "running", command, turn, at: Date.now() });
    this.store.upsertEntry(toolEntry("running"));

    let r: CommandResult;
    try {
      r = await this.queue(() => runCommand(command, cwd, this.timeoutMs));
    } catch (err) {
      r = { code: -1, output: "", timedOut: false, spawnError: (err as Error).message };
    }
    const summary = summarize(r, this.timeoutMs);
    const passing = r.code === 0 && !r.timedOut && !r.spawnError;
    const result: StakeResult = { status: passing ? "passing" : "failing", command, summary, turn, at: Date.now() };
    set(result);
    this.store.upsertEntry(toolEntry(passing ? "ok" : "error", r.output || r.spawnError || ""));
    this.store.upsertEntry({
      id: `stake:${runId}:result`,
      plantId,
      ts: Date.now(),
      kind: passing ? "system" : "error",
      text: passing ? `Checked the stake: \`${command}\` — passed` : `Checks failed after this turn: \`${command}\` (${summary})`,
    });
    return result;
  }
}
