# Gardener

Electron + React app that draws Claude Code agents as plants in a garden. Repos are beds, agents are plants.

## Commands

- `npm run dev`: run the desktop app with hot reload
- `npm run demo`: renderer only, in a browser at localhost:5199, with simulated agents (`src/renderer/src/demo.ts`). Use this to check UI changes; `?phase=night|dawn|dusk|day` forces the sky.
- `npm run typecheck`, `npm test`, `npm run build`: run all three before you call a change done.

## Layout

- `src/shared/`: types (`types.ts`) and the garden vocabulary (`garden.ts`). Both processes import these; keep them free of Node and DOM APIs.
- `src/main/agents.ts`: the only place that talks to the Agent SDK. It turns SDK messages into `Plant` patches and journal `Entry`s. Tests in `agents.test.ts` drive it with a fake `query`.
- `src/main/store.ts`: in-memory state + JSON persistence. Every change goes through it so the renderer gets an event.
- `src/renderer/src/iso/`: the isometric pixel-art garden on a canvas. `paint.ts` (`paintPlant`, `bubbleFor`) maps plant state to visuals; keep that mapping in step with the table in README.md. `world.ts` is the tile layout and pathfinding (tested in `world.test.ts`).
- `src/renderer/src/demo.ts`: must keep implementing the full `GardenApi`. When you add an API method, add it here too.

## Conventions

- The renderer only knows `GardenApi` (`window.gardener`). No Node or Electron imports in `src/renderer`.
- User-facing copy uses the garden vocabulary (bed, plant, sow, water, bloom, wilt, harvest), but always says plainly what is happening underneath (for example "Being watered" sits next to the running command).
- Pixel art rules: draw on whole pixels only, through `raster.ts` (`px`, `rect`, `poly`, `blit`); never canvas paths, arcs or smoothing, which blur edges. Keep to the palette in `iso/palette.ts`. Zoom stays a whole number.
- UI chrome: pixel fonts, square corners, the 2px ink frame from `styles.css`. No border-radius, gradients only for wood or sky.
- Anything that animates must hold still when `useReducedMotion()` is true or under `prefers-reduced-motion`.
- Don't add tests that only restate the implementation. Test the SDK message to plant state mapping and parsing, where bugs actually show up.
