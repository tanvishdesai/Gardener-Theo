// Local logs with rotation and Help → "Copy diagnostics" (PLAN M8). Nothing leaves the machine.
import { createWriteStream, fstatSync, mkdirSync, openSync, renameSync, rmSync, type WriteStream } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { format } from "node:util";

const KEEP = 200;
const METHODS = ["log", "info", "warn", "error"] as const;
let recentLines: string[] = [];

export interface Logger {
  file: string;
  recent(n: number): string[];
  /** Restores the original console methods and closes the file. */
  close(): void;
}

/**
 * Mirrors console.log/info/warn/error into <dir>/terrarium.log (appended through a write stream).
 * When the file passes maxBytes it is rotated to terrarium.1.log … terrarium.<files>.log (oldest dropped).
 * Never throws: if the file can't be written, logging carries on in memory and on the console.
 */
export function installLogger(dir: string, opts: { maxBytes?: number; files?: number } = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const files = opts.files ?? 5;
  const file = join(dir, "terrarium.log");
  let stream: WriteStream | null = null;
  let size = 0;

  const open = () => {
    try {
      mkdirSync(dir, { recursive: true });
      // Open synchronously so the file exists before the first rotation can try to rename it.
      const fd = openSync(file, "a");
      size = fstatSync(fd).size;
      const s = createWriteStream("", { fd });
      s.on("error", () => {
        if (stream === s) stream = null;
      });
      stream = s;
    } catch {
      stream = null;
    }
  };

  /** Lines written while a rotation waits for the old file to close. */
  let pending: string[] | null = null;
  let closed = false;

  const write = (line: string) => {
    if (pending) return void pending.push(line);
    if (!stream) return;
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > maxBytes && size > 0) {
      rotate();
      return void pending!.push(line);
    }
    stream.write(`${line}
`);
    size += bytes;
  };

  // Rare (once per maxBytes), so plain sync renames, done once the old stream has closed:
  // Windows refuses to rename a log whose handle is still open.
  const rotate = () => {
    pending = [];
    const old = stream!;
    stream = null;
    const shift = () => {
      try {
        rmSync(join(dir, `terrarium.${files}.log`), { force: true });
        for (let i = files - 1; i >= 1; i--) {
          try {
            renameSync(join(dir, `terrarium.${i}.log`), join(dir, `terrarium.${i + 1}.log`));
          } catch {
            // that slot was empty
          }
        }
        renameSync(file, join(dir, "terrarium.1.log"));
      } catch {
        // keep appending to the same file rather than lose lines
      }
      open();
      const queued = pending ?? [];
      pending = null;
      for (const l of queued) write(l);
      if (closed) stream?.end();
    };
    if (old.closed) shift();
    else {
      old.once("close", shift);
      old.end();
    }
  };

  open();
  const originals = Object.fromEntries(METHODS.map((m) => [m, console[m]])) as Record<(typeof METHODS)[number], (...a: unknown[]) => void>;
  for (const m of METHODS) {
    const level = m === "log" ? "INFO" : m.toUpperCase();
    console[m] = (...args: unknown[]) => {
      originals[m].apply(console, args);
      try {
        const line = `${new Date().toISOString()} ${level} ${format(...args)}`;
        recentLines.push(line);
        if (recentLines.length > KEEP) recentLines = recentLines.slice(-KEEP);
        write(line);
      } catch {
        // logging must never take the app down
      }
    };
  }

  return {
    file,
    recent: (n) => recentLines.slice(-n),
    close: () => {
      for (const m of METHODS) console[m] = originals[m];
      closed = true;
      if (!pending) stream?.end(); // a rotation in flight ends the new file once it has flushed

    },
  };
}

/** Replaces the home directory with ~ and masks anything that looks like a credential. */
export function redact(s: string): string {
  const home = os.homedir();
  let out = s;
  if (home) {
    for (const h of new Set([home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")])) {
      out = out.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g"), "~");
    }
  }
  return out
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…")
    .replace(/\bgh[pousr]_\w+/g, "gh…")
    .replace(/(bearer|token|authorization|api[_-]?key|password)(["':=\s]+)[^\s"',]+/gi, "$1$2…");
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/**
 * Plain-text report for bug reports. `extra` carries what only the caller knows, e.g.
 * { appVersion, dbBytes, liveProcesses }. No environment variables; paths and tokens redacted.
 */
export function diagnostics(extra: Record<string, unknown> = {}): string {
  const { appVersion, dbBytes, liveProcesses, ...rest } = extra;
  const v = process.versions as Record<string, string | undefined>;
  const lines = [
    `Terrarium diagnostics, ${new Date().toISOString()}`,
    `App: ${appVersion ?? "unknown"}`,
    `Electron ${v.electron ?? "-"} · Node ${v.node} · Chrome ${v.chrome ?? "-"} · V8 ${v.v8}`,
    `OS: ${os.type()} ${os.release()} (${process.platform} ${process.arch})`,
    `Memory: ${gb(os.freemem())} free of ${gb(os.totalmem())} · ${os.cpus().length} CPUs`,
    `Database: ${typeof dbBytes === "number" ? `${(dbBytes / 1024 ** 2).toFixed(1)} MB` : "unknown"}`,
    `Live processes: ${liveProcesses ?? "unknown"}`,
    ...Object.entries(rest).map(([k, val]) => `${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`),
    "",
    "Recent warnings and errors:",
    ...recentLines.filter((l) => / (WARN|ERROR) /.test(l)).slice(-50),
  ];
  return redact(lines.join("\n"));
}
