# Gardener

Electron + React app that draws Claude Code agents as plants in a garden. Repos are beds, agents are plants.

## Commands

- `npm run dev`: run the desktop app with hot reload
- `npm run demo`: renderer only, in a browser at localhost:5199, with simulated agents (`src/renderer/src/demo.ts`). Use this to check UI changes; `?phase=night|dawn|dusk|day` forces the sky.
- `npm run typecheck`, `npm test`, `npm run build`: run all three before you call a change done. `npm test` runs vitest on Electron's Node (needed for `node:sqlite` + FTS5); `npm test -- <path>` runs one file.
- `node scripts/e2e.mjs` (after `npm run build`): smoke test of the real desktop app on temp data (add bed, sow, catalogue, palette, settings). No Claude turns, not in CI.
- `npm run bench`: 1,000-plant frame-time benchmark in headless Edge (budget p95 ≤ 16 ms; baseline in `bench/baseline.json`).
- `npm run coldstart` (after `npm run build`): cold start to an interactive 1,000-plant garden, median of 5 launches (budget ≤ 1.5 s).
- `npm run soak`: 30 fake agents streaming through the real Greenhouse → store → event queue; checks event-loop p99 ≤ 50 ms and IPC ≤ 60 msg/s. runs alone (skipped by `npm test`, since parallel test files would skew the timing); 5 s by default, `SOAK_SECONDS=600` for the full 10-minute soak.
- `npm run dist:dir`: unsigned unpacked Windows build in `dist/win-unpacked`. Needs Node ≥ 22.12.

## Layout

- `src/shared/`: types (`types.ts`) and the garden vocabulary (`garden.ts`). Both processes import these; keep them free of Node and DOM APIs.
- `src/main/agents.ts`: the only place that talks to the Agent SDK. It turns SDK messages into `Plant` patches and journal `Entry`s. Tests in `agents.test.ts` drive it with a fake `query`.
- `src/main/store.ts` + `db.ts`: SQLite (`node:sqlite`, WAL, FTS5) with group commits every ~100 ms; beds/plants mirrored in memory, journals paged from the db. Every change goes through it so the renderer gets an event. `index.ts` coalesces events into `batch` IPC messages and only forwards journal events for open journals.
- Other main modules: `git.ts` (all git/gh calls, queued; worktrees, checkpoints, diffs), `pool.ts` (memory-based process cap), `harvest.ts` (commit/push/PR + PR watcher), `transcript.ts`/`history.ts`/`volunteers.ts`/`usage.ts` (Claude Code transcripts: import, terminal sessions, Almanac), `soil.ts`/`soilScheduler.ts`/`stakes.ts`, `logger.ts`.
- The V2 design and its decisions live in `docs/v2/PLAN.md` (section 8 decision log, section 9 deviations).
- `src/renderer/src/iso/`: the isometric pixel-art garden on a canvas. `paint.ts` (`paintPlant`, `bubbleFor`) maps plant state to visuals; keep that mapping in step with the table in README.md. `world.ts` is the tile layout and pathfinding (tested in `world.test.ts`).
- `src/renderer/src/demo.ts`: must keep implementing the full `GardenApi`. When you add an API method, add it here too.

## Conventions

- The renderer only knows `GardenApi` (`window.gardener`). No Node or Electron imports in `src/renderer`.
- User-facing copy uses the garden vocabulary (bed, plant, sow, water, bloom, wilt, harvest), but always says plainly what is happening underneath (for example "Being watered" sits next to the running command).
- Pixel art rules: draw on whole pixels only, through `raster.ts` (`px`, `rect`, `poly`, `blit`); never canvas paths, arcs or smoothing, which blur edges. Keep to the palette in `iso/palette.ts`. Zoom stays a whole number.
- UI chrome: pixel fonts, square corners, the 2px ink frame from `styles.css`. No border-radius, gradients only for wood or sky.
- Anything that animates must hold still when `useReducedMotion()` is true or under `prefers-reduced-motion`.
- Don't add tests that only restate the implementation. Test the SDK message to plant state mapping and parsing, where bugs actually show up.
