// Load budget (PLAN 1.1): 30 plants streaming at once through the real Greenhouse → store → event queue.
// Runs only via `npm run soak` (alone, so other test files don't steal CPU from the measurement).
// 5 s by default; SOAK_SECONDS=600 is the full 10-minute soak.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GardenEvent } from "../shared/types";
import { Greenhouse } from "./agents";
import { EventQueue } from "./events";
import { GardenStore } from "./store";

const SECONDS = Number(process.env.SOAK_SECONDS ?? 5);
const PLANTS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Claude that never stops working: tool call, result, a bit of text, and a finished turn every 8 tools. */
function busyQuery(stop: { now: boolean }) {
  return ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: `s-${Math.random()}`, model: "fake", cwd: params.options.cwd, permissionMode: "default", claude_code_version: "0" } as unknown as SDKMessage;
      const it = params.prompt[Symbol.asyncIterator]();
      await it.next();
      let n = 0;
      let cost = 0;
      while (!stop.now) {
        const id = `t${n++}`;
        yield { type: "assistant", uuid: `a-${id}`, session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: n % 3 ? "Read" : "Bash", input: { file_path: `src/f${n}.ts`, command: "npm test" } }] } } as unknown as SDKMessage;
        await sleep(15 + Math.random() * 35);
        yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(2000) }] } } as unknown as SDKMessage;
        yield { type: "assistant", uuid: `b-${id}`, session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "text", text: `Step ${n} done.` }] } } as unknown as SDKMessage;
        if (n % 8 === 0) {
          cost += 0.01;
          yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 8, duration_ms: 1000, total_cost_usd: cost } as unknown as SDKMessage;
        }
        await sleep(10 + Math.random() * 30);
      }
    }
    const gen = run() as unknown as Query;
    Object.assign(gen, { interrupt: async () => undefined, setPermissionMode: async () => undefined, close: () => (gen as unknown as AsyncGenerator).return(undefined) });
    return gen;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
}

describe.skipIf(!process.env.TERRARIUM_SOAK)("load budget: 30 plants streaming (npm run soak)", () => {
  let dir: string;
  let store: GardenStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terrarium-soak-"));
    store = new GardenStore(dir);
    store.putBed({ id: "bed", name: "soak", path: join(dir, "no-such-repo"), createdAt: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it(
    `keeps the main thread responsive and IPC ≤ 60 msg/s for ${SECONDS}s`,
    async () => {
      const stop = { now: false };
      let messages = 0;
      let events = 0;
      const queue = new EventQueue((m: GardenEvent) => {
        messages++;
        events += m.type === "batch" ? m.events.length : 1;
      });
      store.on((e) => queue.push(e));
      const gh = new Greenhouse(store, { onTurnEnd() {}, onNeedsYou() {}, env: () => ({}), query: busyQuery(stop) });
      const ids = Array.from({ length: PLANTS }, (_, i) => gh.sow({ bedId: "bed", prompt: `task ${i}`, permissionMode: "default" }).id);
      queue.openJournals.add(ids[0]); // the renderer has one plant open

      await sleep(500); // warm up
      messages = 0;
      events = 0;
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      const rss0 = process.memoryUsage().rss;
      const t0 = Date.now();
      await sleep(SECONDS * 1000);
      lag.disable();
      const secs = (Date.now() - t0) / 1000;
      stop.now = true;
      gh.shutdown();
      await sleep(300);
      queue.flush();

      const p99 = lag.percentile(99) / 1e6;
      const perSec = messages / secs;
      const turns = ids.reduce((s, id) => s + (store.plants.get(id)?.turns ?? 0), 0);
      const growthMb = (process.memoryUsage().rss - rss0) / 1024 ** 2;
      console.log(
        `[soak] ${secs.toFixed(1)}s · ${PLANTS} plants · ${turns} turns · ${events} store events → ${messages} IPC messages (${perSec.toFixed(1)}/s) · event-loop p99 ${p99.toFixed(1)} ms, max ${(lag.max / 1e6).toFixed(1)} ms · RSS +${growthMb.toFixed(0)} MB`,
      );
      expect(perSec).toBeLessThanOrEqual(60);
      expect(p99).toBeLessThanOrEqual(50);
      expect(events).toBeGreaterThan(messages); // coalescing actually happened
      expect(store.entryCount(ids[0])).toBeGreaterThan(10);
    },
    SECONDS * 1000 + 60_000,
  );
});
