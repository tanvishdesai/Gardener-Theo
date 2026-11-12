// The process pool (PLAN D11, M2e): how many Claude Code processes fit on THIS machine right now.
// Decided from measured free memory and the measured size of a Claude process tree, never a fixed number.
import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import type { PoolInfo } from "../shared/types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
export const SEED_ESTIMATE = 600 * MB;
const MIN_ESTIMATE = 300 * MB;

export interface PoolInputs {
  free: number;
  total: number;
  /** Moving-average bytes per Claude process tree. */
  estimate: number;
  live: number;
  userMax?: number;
}

/** Memory that must stay free for the OS and everything else: max(2 GB, 15% of RAM). */
export function memoryFloor(total: number): number {
  return Math.max(2 * GB, 0.15 * total);
}

/** Sanity ceiling for very large machines: (total − 4 GB) / estimate, at least 2. */
export function ceiling(total: number, estimate: number): number {
  return Math.max(2, Math.floor((total - 4 * GB) / estimate));
}

/** How many more processes can start now. Pure: the whole admission policy lives here. */
export function canAdmit(i: PoolInputs): number {
  const cap = Math.min(ceiling(i.total, i.estimate), i.userMax ?? Infinity);
  const byCap = Math.max(0, cap - i.live);
  const byMemory = Math.max(0, Math.floor((i.free - memoryFloor(i.total)) / i.estimate));
  const n = Math.min(byCap, byMemory);
  // One plant can always run, even on a busy machine.
  return i.live === 0 ? Math.max(1, n) : n;
}

/** Under memory pressure, which idle live plant to close first: the one idle longest. */
export function reapOrder(live: { id: string; busy: boolean; idleSince: number }[]): string[] {
  return live
    .filter((p) => !p.busy)
    .sort((a, b) => a.idleSince - b.idleSince)
    .map((p) => p.id);
}

export interface ProcSample {
  pid: number;
  ppid: number;
  bytes: number;
}

/** Parse `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv` or `ps -A -o pid=,ppid=,rss=`. */
export function parseProcessTable(out: string, format: "csv" | "ps"): ProcSample[] {
  const rows: ProcSample[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (format === "csv") {
      const m = /^"?(\d+)"?,"?(\d+)"?,"?(\d+)"?$/.exec(line.trim());
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) });
    } else {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * 1024 });
    }
  }
  return rows;
}

/** Bytes used by each root pid plus all its descendants. */
export function treeSizes(rows: ProcSample[], roots: number[]): Map<number, number> {
  const children = new Map<number, number[]>();
  const bytes = new Map<number, number>();
  for (const r of rows) {
    bytes.set(r.pid, r.bytes);
    if (r.pid !== r.ppid) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  }
  const out = new Map<number, number>();
  for (const root of roots) {
    if (!bytes.has(root)) continue;
    let sum = 0;
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      sum += bytes.get(pid) ?? 0;
      stack.push(...(children.get(pid) ?? []));
    }
    out.set(root, sum);
  }
  return out;
}

function sampleProcesses(): Promise<ProcSample[]> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const cmd = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 15_000, maxBuffer: 16 * MB }, (err, stdout) =>
        resolve(err ? [] : parseProcessTable(stdout, "csv")),
      );
    } else {
      execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 10_000, maxBuffer: 16 * MB }, (err, stdout) => resolve(err ? [] : parseProcessTable(stdout, "ps")));
    }
  });
}

/** Tracks live Claude processes' memory and answers "can one more start?". */
export class ProcessPool {
  private estimate = SEED_ESTIMATE;
  private pids = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private deps: {
      userMax: () => number | undefined;
      liveCount: () => number;
      queued: () => number;
      onSample: (info: PoolInfo) => void;
      /** Called when free memory drops below the floor. */
      onPressure: () => void;
      free?: () => number;
      total?: () => number;
      sample?: () => Promise<ProcSample[]>;
    },
  ) {}

  register(plantId: string, pid: number | undefined) {
    if (pid) this.pids.set(plantId, pid);
  }

  unregister(plantId: string) {
    this.pids.delete(plantId);
  }

  private free() {
    return (this.deps.free ?? freemem)();
  }

  private total() {
    return (this.deps.total ?? totalmem)();
  }

  canAdmit(): number {
    return canAdmit({ free: this.free(), total: this.total(), estimate: this.estimate, live: this.deps.liveCount(), userMax: this.deps.userMax() });
  }

  info(): PoolInfo {
    return {
      live: this.deps.liveCount(),
      canAdmit: this.canAdmit(),
      ceiling: Math.min(ceiling(this.total(), this.estimate), this.deps.userMax() ?? Infinity),
      freeBytes: this.free(),
      totalBytes: this.total(),
      perProcessBytes: this.estimate,
      queued: this.deps.queued(),
      userMax: this.deps.userMax(),
    };
  }

  /** Measure process trees (one OS query for all), update the moving average, signal pressure. */
  async sample(): Promise<void> {
    if (this.pids.size > 0) {
      const rows = await (this.deps.sample ?? sampleProcesses)();
      const sizes = treeSizes(rows, [...this.pids.values()]);
      for (const size of sizes.values()) {
        if (size > 0) this.estimate = Math.max(MIN_ESTIMATE, Math.round(this.estimate * 0.7 + size * 0.3));
      }
    }
    if (this.free() < memoryFloor(this.total()) && this.deps.liveCount() > 0) this.deps.onPressure();
    this.deps.onSample(this.info());
  }

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample().catch((err) => console.error("[gardener] pool sample failed", err)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
