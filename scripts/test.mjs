// Runs vitest on Electron's own Node (24, with node:sqlite + FTS5), the runtime Terrarium ships on.
// Usage: npm test [-- vitest args]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const r = spawnSync(electron, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(r.status ?? 1);
