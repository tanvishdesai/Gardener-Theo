// Unsigned unpacked Windows build (dist/win-unpacked) for local testing: `npm run dist:dir`.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["electron-builder", "--win", "--dir", "-c", "electron-builder.yml"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, TERRARIUM_UNSIGNED: "1" },
});
process.exit(r.status ?? 1);
