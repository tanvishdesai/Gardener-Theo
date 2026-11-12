// Load budget, measured alone (timing budgets can't be measured while other test files share the CPU).
// Usage: npm run soak            (5 s)
//        SOAK_SECONDS=600 npm run soak   (the full 10-minute soak; on Windows: $env:SOAK_SECONDS=600)
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["scripts/test.mjs", "src/main/soak.test.ts", "--silent=false"], {
  stdio: "inherit",
  env: { ...process.env, TERRARIUM_SOAK: "1" },
});
process.exit(r.status ?? 1);
