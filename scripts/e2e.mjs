// End-to-end smoke test of the built desktop app (run `npm run build` first): `node scripts/e2e.mjs`.
// Temp user data and a temp git repo; no Claude turns, no network, no real ~/.claude settings touched.
// Exits 1 on the first failed check.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";

const root = mkdtempSync(join(tmpdir(), "terrarium-e2e-"));
const userData = join(root, "data");
const repo = join(root, "repo");
const sh = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
sh("config", "user.email", "e2e@example.com");
sh("config", "user.name", "e2e");
writeFileSync(join(repo, "a.txt"), "one\n");
sh("add", "-A");
sh("commit", "-qm", "init");

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, TERRARIUM_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
// TERRARIUM_E2E_EXE=<packaged app executable> tests a packaged build instead of out/ (the release workflow does this).
const packaged = process.env.TERRARIUM_E2E_EXE;
const app = await _electron.launch(
  packaged ? { executablePath: packaged, args: [], env } : { executablePath: join("node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"), args: ["."], env },
);
const errors = [];
try {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {};
  });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await win.waitForSelector(".app");
  const g = (method, ...args) => win.evaluate(([m, a]) => window.terrarium[m](...a), [method, args]);

  check("first run screen on a new garden", (await win.locator(".v2-firstrun").count()) === 1);
  check("no web-demo Download button in the desktop app", (await win.getByRole("button", { name: "Download", exact: true }).count()) === 0);
  await g("setSettings", { onboarded: true });
  await win.keyboard.press("Escape");

  const bed = await g("addBed", repo);
  // Sow straight away, before the soil report lands: a git repo must still default to a pot.
  const plant = await g("sow", { bedId: bed.id, prompt: "", permissionMode: "default", name: "Smoke" });
  check("sown immediately after adding a git bed: potted", plant.plot === "pot", plant.plot);
  let p;
  for (let i = 0; i < 100 && !(p?.worktreePath && p.status === "idle"); i++) {
    await sleep(150);
    p = (await g("snapshot")).plants.find((x) => x.id === plant.id);
  }
  check("pot worktree prepared under the data folder", !!p?.worktreePath && p.worktreePath.startsWith(userData), p?.worktreePath);

  await win.keyboard.press("\\");
  await win.waitForSelector(".catalogue");
  check("Seed Catalogue lists the plant", (await win.locator(".catalogue").innerText()).includes("Smoke"));
  await win.keyboard.press("\\");

  await win.keyboard.press("Control+k");
  await win.keyboard.type("Smoke");
  await sleep(300);
  await win.keyboard.press("Enter");
  await win.waitForSelector("aside.panel");
  check("Ctrl+K jumps to the plant", (await win.locator("aside.panel h2").innerText()).toLowerCase() === "smoke");
  await win.keyboard.press("Escape");

  await win.getByRole("button", { name: "Settings", exact: true }).click();
  await sleep(300);
  const s = await g("setSettings", { idleMinutes: 12 });
  check("settings saved", s.idleMinutes === 12);
  await win.getByLabel("Theme").selectOption("dark");
  await win.getByLabel("Text size").selectOption("150");
  await sleep(300);
  const look = await win.evaluate(() => `${document.documentElement.dataset.theme} ${getComputedStyle(document.documentElement).getPropertyValue("--text")}`);
  const saved = (await g("snapshot")).settings;
  check("accessibility settings applied and saved", look === "dark 1.5" && saved.theme === "dark" && saved.textSize === 150, `${look} / ${saved.theme} ${saved.textSize}`);
  await win.keyboard.press("Escape");

  await g("uproot", plant.id, { deleteBranch: true });
  check("no renderer errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  check("script ran", false, String(err));
} finally {
  await app.close().catch(() => {});
  await sleep(1000);
  // Git marks object files read-only, which Windows refuses to delete.
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    try {
      chmodSync(join(e.parentPath, e.name), 0o666);
    } catch {
      // gone already
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
