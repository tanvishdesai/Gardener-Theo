import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bed, Plant } from "../shared/types";
import { GardenStore } from "./store";
import { hookFragment, Volunteers, type HookPayload } from "./volunteers";

const j = (o: object) => JSON.stringify(o);
const repo = process.cwd(); // a plantable folder (temp dirs are not)
const SID = "11111111-2222-3333-4444-555555555555";
const ts = (s: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, s)).toISOString();
const line = {
  prompt: (text: string, entrypoint = "cli") => j({ type: "user", uuid: `u-${text}`, timestamp: ts(0), cwd: repo, entrypoint, sessionId: SID, message: { content: text } }),
  tool: (id: string) => j({ type: "assistant", uuid: `a-${id}`, timestamp: ts(1), cwd: repo, requestId: `r-${id}`, message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] } }),
  result: (id: string) => j({ type: "user", uuid: `r-${id}`, timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
  done: (text: string) => j({ type: "assistant", uuid: `a-${text}`, timestamp: ts(3), message: { id: `m-${text}`, model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text }] } }),
  title: (t: string) => j({ type: "ai-title", aiTitle: t }),
};

let tmp: string;
let projects: string;
let file: string;
let store: GardenStore;
let clock: number;
let notes: { plant: Plant; why: string }[];
let vols: Volunteers;

const addBed = (path: string): Bed => {
  for (const b of store.beds.values()) if (b.path === path) return b;
  return store.putBed({ id: `bed-${store.beds.size}`, name: basename(path), path, createdAt: 0 });
};
const write = (...lines: string[]) => appendFileSync(file, lines.map((l) => `${l}\n`).join(""));
const vol = () => store.plants.get(`vol-${SID}`);
const settled = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gardener-vol-"));
  projects = join(tmp, "projects");
  mkdirSync(join(projects, "C--repo"), { recursive: true });
  file = join(projects, "C--repo", `${SID}.jsonl`);
  store = new GardenStore(join(tmp, "data"));
  clock = Date.now();
  notes = [];
  vols = new Volunteers({ store, addBed, notify: (plant, why) => notes.push({ plant, why }), projectsDir: projects, settingsPath: join(tmp, "claude", "settings.json"), now: () => clock });
});
afterEach(() => {
  vols.stop();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Volunteers from the transcript (layer 1)", () => {
  it("sprouts a volunteer, follows its turn and ends it after 15 quiet minutes", async () => {
    write(line.prompt("fix the build"), line.tool("t1"));
    await vols.tick();
    expect(vol()).toMatchObject({
      origin: "volunteer",
      plot: "bed",
      cwd: repo,
      sessionId: SID,
      live: true,
      ended: false,
      status: "working",
      activity: "run",
      activityDetail: "Busy or waiting in your terminal",
      watchedBy: "transcript",
      name: "Fix the build",
      turns: 1,
      toolCalls: 1,
      model: "claude-opus-5-5",
    });
    expect(store.journalPage(vol()!.id).entries.map((e) => e.tool?.status ?? e.kind)).toEqual(["user", "running"]);

    write(line.result("t1"));
    await vols.tick();
    expect(vol()).toMatchObject({ status: "thinking", activity: "think" });

    write(line.done("Fixed."), line.title("Build fix"));
    await vols.tick();
    expect(vol()).toMatchObject({ status: "idle", unread: true, name: "Build fix", lastText: "Fixed." });
    expect(store.journalPage(vol()!.id).entries.map((e) => e.tool?.status ?? e.kind)).toEqual(["user", "ok", "text"]);
    expect(vols.adoptable(vol()!.id)).toBe(false);

    clock += 16 * 60_000;
    await vols.tick();
    expect(vol()).toMatchObject({ ended: true, live: false, status: "idle" });
    expect(vols.adoptable(vol()!.id)).toBe(true);

    write(line.prompt("again"));
    await vols.tick();
    expect(vol()).toMatchObject({ ended: false, live: true, status: "thinking", turns: 2 });
  });

  it("ignores old transcripts, SDK sessions and sessions Gardener sowed", async () => {
    clock += 11 * 60_000;
    write(line.prompt("old"));
    await vols.tick();
    expect(vol()).toBeUndefined();

    clock = Date.now();
    rmSync(file);
    write(line.prompt("from an app", "sdk-cli"));
    await vols.tick();
    expect(vol()).toBeUndefined();
  });

  it("never duplicates a sown plant, and watches an imported one in place", async () => {
    const bed = addBed(repo);
    const base: Plant = { id: "p1", bedId: bed.id, name: "Mine", species: "rose", seed: "x", origin: "sown", sessionId: SID, permissionMode: "default", status: "idle", live: false, turns: 1, toolCalls: 0, costUsd: 0, runners: 0, unread: false, plot: "bed", createdAt: 0, updatedAt: 0 };
    store.putPlant(base);
    write(line.prompt("fix"), line.tool("t1"));
    await vols.tick();
    vols.handleHook({ session_id: SID, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(vol()).toBeUndefined();
    expect(store.plants.get("p1")).toMatchObject({ status: "idle", live: false });

    store.close();
    rmSync(join(tmp, "data"), { recursive: true, force: true });
    store = new GardenStore(join(tmp, "data2"));
    vols = new Volunteers({ store, addBed, notify: () => {}, projectsDir: projects, now: () => clock });
    const bed2 = addBed(repo);
    store.putPlant({ ...base, id: SID, bedId: bed2.id, origin: "imported" });
    await vols.tick();
    expect(vol()).toBeUndefined();
    expect(store.plants.get(SID)).toMatchObject({ status: "working", live: true, watchedBy: "transcript" });
    expect(store.entryCount(SID)).toBe(2);
    clock += 16 * 60_000;
    await vols.tick();
    expect(store.plants.get(SID)).toMatchObject({ status: "idle", live: false, watchedBy: undefined });
    expect(store.plants.get(SID)?.ended).toBeUndefined();
  });

  it("ends volunteers left running by a previous run on start", async () => {
    const bed = addBed(repo);
    store.putPlant({ id: "vol-x", bedId: bed.id, name: "v", species: "rose", seed: "", origin: "volunteer", sessionId: "x", permissionMode: "default", status: "idle", live: false, ended: false, turns: 0, toolCalls: 0, costUsd: 0, runners: 0, unread: false, plot: "bed", createdAt: 0, updatedAt: 0 });
    await vols.start();
    expect(store.plants.get("vol-x")?.ended).toBe(true);
  });
});

describe("Volunteers from hook events (layer 2)", () => {
  const ev = (hook_event_name: string, extra: Partial<HookPayload> = {}): HookPayload => ({ session_id: SID, transcript_path: file, cwd: repo, hook_event_name, permission_mode: "default", ...extra });

  it("maps each event to the plant's state", async () => {
    vols.handleHook(ev("SessionStart", { source: "startup", model: "claude-opus-5-5" } as HookPayload));
    expect(vol()).toMatchObject({ origin: "volunteer", status: "idle", live: true, watchedBy: "hook", model: "claude-opus-5-5", name: "Volunteer" });

    vols.handleHook(ev("UserPromptSubmit", { prompt: "fix the build" }));
    expect(vol()).toMatchObject({ status: "thinking", activity: "think", seed: "fix the build" });

    vols.handleHook(ev("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }));
    expect(vol()).toMatchObject({ status: "working", activity: "edit", activityDetail: "src/a.ts" });

    vols.handleHook(ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    expect(vol()).toMatchObject({ status: "waiting", ask: { kind: "permission", title: "Waiting for your permission in the terminal", detail: "rm -rf build", canAlwaysAllow: false } });
    vols.handleHook(ev("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
    expect(notes.map((n) => n.why)).toEqual(["Waiting for your permission in the terminal"]);
    expect(notes[0].plant.status).toBe("waiting");
    expect(vol()?.ask?.detail).toBe("rm -rf build");

    vols.handleHook(ev("PostToolUse", { tool_name: "Bash" }));
    expect(vol()).toMatchObject({ status: "thinking", ask: undefined });

    vols.handleHook(ev("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use WebFetch" }));
    expect(vol()).toMatchObject({ status: "waiting", ask: { detail: "Claude needs your permission to use WebFetch" } });
    expect(notes).toHaveLength(2);

    vols.handleHook(ev("Stop", { last_assistant_message: "Done." } as HookPayload));
    expect(vol()).toMatchObject({ status: "idle", unread: true, ask: undefined });

    store.updatePlant(vol()!.id, { unread: false });
    vols.handleHook(ev("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }));
    expect(vol()).toMatchObject({ status: "idle", unread: true });

    vols.handleHook(ev("SessionEnd", { reason: "prompt_input_exit" }));
    expect(vol()).toMatchObject({ ended: true, live: false, status: "idle" });
    expect(vols.adoptable(vol()!.id)).toBe(true);
  });

  it("lets the hook own the live state while the transcript fills the journal", async () => {
    vols.handleHook(ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" } }));
    write(line.prompt("fix"), line.tool("t1"));
    await vols.tick();
    expect(vol()).toMatchObject({ status: "waiting", watchedBy: "hook", turns: 1, name: "Fix" });
    expect(store.entryCount(vol()!.id)).toBe(2);
  });

  it("serves POST /hook on 127.0.0.1 with a token check and an empty 204", async () => {
    const port = 40000 + Math.floor(Math.random() * 9000);
    expect(await vols.listen(port, "secret")).toBe(true);
    const post = (token: string, body: object) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/hook", method: "POST", headers: { "content-type": "application/json", "X-Gardener-Token": token } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    expect(await post("wrong!", ev("SessionStart"))).toEqual({ status: 403, body: "" });
    expect(vol()).toBeUndefined();
    expect(await post("secret", ev("UserPromptSubmit", { prompt: "hi" }))).toEqual({ status: 204, body: "" });
    await settled();
    expect(vol()).toMatchObject({ status: "thinking", watchedBy: "hook" });
    expect((await vols.status()).listening).toBe(true);

    const other = new Volunteers({ store, addBed, notify: () => {}, projectsDir: projects });
    expect(await other.listen(port, "x")).toBe(false);
  });
});

describe("hook install / uninstall in settings.json", () => {
  let settings: string;
  beforeEach(() => {
    settings = join(tmp, "claude", "settings.json");
    mkdirSync(join(tmp, "claude"), { recursive: true });
  });
  const read = () => readFileSync(settings, "utf8");

  it("creates the file when missing and deletes it again on uninstall", async () => {
    rmSync(join(tmp, "claude"), { recursive: true });
    const st = await vols.install(47823, "tok");
    expect(st).toMatchObject({ installed: true, settingsPath: settings });
    expect(JSON.parse(read())).toEqual(hookFragment(47823, "tok"));
    expect(JSON.parse(st.preview)).toEqual(hookFragment(47823, "tok"));
    expect(JSON.parse(st.preview).hooks.PreToolUse[0]).toEqual({ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:47823/hook", headers: { "X-Gardener-Token": "tok" }, timeout: 2 }] });
    expect(Object.keys(JSON.parse(st.preview).hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"]);
    expect((await vols.status()).installed).toBe(true);
    expect(await vols.installedHook()).toEqual({ port: 47823, token: "tok" });
    expect((await vols.uninstall()).installed).toBe(false);
    expect(existsSync(settings)).toBe(false);
  });

  it("merges next to existing hooks and keys, backs up once, and uninstall restores the exact bytes", async () => {
    const original =
      '{\r\n    "model": "opus",\r\n    "hooks": {\r\n        "PreToolUse": [\r\n            {\r\n                "matcher": "Bash",\r\n                "hooks": [{ "type": "command", "command": "echo hi" }]\r\n            }\r\n        ]\r\n    },\r\n    "env": {}\r\n}';
    writeFileSync(settings, original);
    await vols.install(47823, "tok");
    const merged = JSON.parse(read());
    expect(Object.keys(merged)).toEqual(["model", "hooks", "env"]);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(read()).toContain('\r\n    "model"');
    expect(readFileSync(`${settings}.gardener-backup`, "utf8")).toBe(original);

    // Reinstalling (new port) replaces Gardener's entries instead of adding more, and keeps the first backup.
    await vols.install(47999, "tok2");
    expect(JSON.parse(read()).hooks.PreToolUse).toHaveLength(2);
    expect(JSON.parse(read()).hooks.Stop[0].hooks[0].url).toBe("http://127.0.0.1:47999/hook");
    expect(readFileSync(`${settings}.gardener-backup`, "utf8")).toBe(original);

    await vols.uninstall();
    expect(read()).toBe(original);
  });

  it("round-trips a file with no hooks byte for byte, and keeps later edits by others", async () => {
    const original = '{\n\t"theme": "dark"\n}\n';
    writeFileSync(settings, original);
    await vols.install(47823, "tok");
    await vols.uninstall();
    expect(read()).toBe(original);

    await vols.install(47823, "tok");
    const edited = JSON.parse(read());
    edited.theme = "light";
    writeFileSync(settings, `${JSON.stringify(edited, null, "\t")}\n`);
    await vols.uninstall();
    expect(read()).toBe('{\n\t"theme": "light"\n}\n');
  });

  it("refuses invalid JSON and leaves it untouched", async () => {
    writeFileSync(settings, "{ not json");
    const st = await vols.install(47823, "tok");
    expect(st.installed).toBe(false);
    expect(st.note).toMatch(/not valid JSON/);
    expect(read()).toBe("{ not json");
    expect(existsSync(`${settings}.gardener-backup`)).toBe(false);
    expect((await vols.uninstall()).note).toMatch(/not valid JSON/);
    expect((await vols.status()).installed).toBe(false);
  });
});
