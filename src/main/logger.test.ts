import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnostics, installLogger, type Logger } from "./logger";

describe("logger", () => {
  let dir: string;
  let log: Logger | undefined;
  afterEach(async () => {
    log?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("appends timestamped lines and rotates, keeping `files` old logs", async () => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-log-"));
    log = installLogger(dir, { maxBytes: 300, files: 2 });
    for (let i = 0; i < 40; i++) console.info(`line ${i} ${"x".repeat(20)}`);
    console.error(new Error("kaboom"));
    log.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(dir, "terrarium.log"))).toBe(true);
    expect(existsSync(join(dir, "terrarium.1.log"))).toBe(true);
    expect(existsSync(join(dir, "terrarium.2.log"))).toBe(true);
    expect(existsSync(join(dir, "terrarium.3.log"))).toBe(false);
    const current = readFileSync(join(dir, "terrarium.log"), "utf8");
    expect(current).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR Error: kaboom/m);
    expect(readFileSync(join(dir, "terrarium.1.log"), "utf8")).toContain("INFO line 3");
    expect(log.recent(2)[0]).toContain("line 39");
  });

  it("diagnostics redact the home folder and credentials", () => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-log-"));
    log = installLogger(dir);
    console.warn(`could not open ${join(homedir(), "repo")} with token=abc123 sk-ant-api03-secret`);
    const text = diagnostics({ appVersion: "2.0.0", dbBytes: 3 * 1024 * 1024, liveProcesses: 4 });
    expect(text).toContain("App: 2.0.0");
    expect(text).toContain("Database: 3.0 MB");
    expect(text).toContain("could not open ~");
    expect(text).not.toContain(homedir());
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("secret");
  });
});
