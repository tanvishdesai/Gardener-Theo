# Gardener

A desktop garden for your Claude Code agents.

Every **repository is a bed**. Every **agent is a plant** growing in it. **You are the gardener**: you don't write the code yourself, you keep the beds healthy so the plants grow straight, you answer them when they need you, and you pull the weeds before they spread.

![The demo garden at midday](docs/garden.png)

The idea comes from Theo's "we're not really engineers anymore" argument. The job shifts from growing code to building the environment code grows well in: the right fertilizer (guidance), stakes to grow against (fast CI checks), and constant weeding (slop grows faster than weeds). Most "agents in a game world" UIs put agents in an office or a fantasy village. A garden fits better, because the thing you are really tending is the repo, not the agents.

## What you see

| In the garden | What it means |
| --- | --- |
| Seed mound with a packet | An agent that has not run yet |
| Height and number of leaves | How many turns it has completed |
| Closed bud, swaying | Working on a turn |
| Open flower | Finished its last turn |
| Butterfly and golden glow | A finished turn you have not read yet ("ready to harvest") |
| Drooping, amber `!` sign | Waiting on you: a permission, a question, or a plan to approve |
| Brown and wilted, a weed beside it | The last turn failed (and a rain cloud rolls in) |
| Glowing roots in the glass-fronted soil | Reading or searching the code |
| Watering can | Running a shell command |
| New leaf unfurling, sparkles | Editing files |
| Bee circling the flower | Fetching from the web or an MCP server |
| Little seedlings beside it | Subagents ("runners") at work |
| Tag with `2/5` | Its todo list progress |
| Trellis behind it | It is in plan mode |

Each bed also shows its **soil report**, read from the repo itself:

| Prop | Found when the repo has |
| --- | --- |
| Compost bin | `CLAUDE.md`, `AGENTS.md` or similar agent guidance |
| Bamboo stakes beside every plant | CI config (`.github/workflows`, …) |
| White picket fence | Tests |
| Straw mulch on the soil | Lint or format config |
| Loose soil mounds, "N loose" chip | Uncommitted changes |

Click a bed's sign to see its soil report and **chores**: agents whose job is improving the bed for every agent after them (survey it, add compost, pull weeds, drive a stake).

The sky follows your local clock (dawn, day, dusk, night) and the gardener walks to whatever you select.

![Approving a plan](docs/plan.png)

## Running it

You need Node 22+ and Claude Code logged in on this machine. Gardener runs agents through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which uses the bundled Claude Code and whatever account Claude Code is logged into. If you have never logged in, run `claude` once in a terminal and log in with your Claude subscription. If `ANTHROPIC_API_KEY` is set in your environment, Claude Code will use that instead.

```bash
npm install
```

```bash
npm run dev
```

Then click **Break new ground**, pick a repo folder, and **Sow an agent**.

To preview the interface in a browser with simulated agents (no Electron, no Claude, nothing runs):

```bash
npm run demo
```

Then open http://localhost:5199. Add `?phase=night` (or `dawn`, `dusk`) to the URL to see other times of day.

### Keyboard

- `s` sow an agent (in the selected bed)
- `n` jump to the next plant that needs you
- `Esc` close the panel
- In the composer: `Enter` sends, `Shift+Enter` adds a new line

## How it works

```
src/
  shared/    types and garden vocabulary used by both processes (tool -> activity, chores, soil checks)
  main/      Electron main process
    agents.ts  one Agent SDK query() per plant, streaming input; maps SDK messages to plant state
    store.ts   beds, plants and per-plant journals, persisted as JSON in the app's userData folder
    soil.ts    git status + repo hygiene checks
  preload/   exposes a small typed API (window.gardener) to the renderer
  renderer/  React UI; the garden is hand-drawn SVG
    demo.ts    a scripted fake garden that speaks the same API, for `npm run demo`
```

- Each plant is a long-lived Claude Code session (`query()` with an async-iterable prompt), so follow-ups go to the same session. The session id is saved, so after restarting Gardener the next message resumes the conversation.
- Permissions, `AskUserQuestion` and plan approval (`ExitPlanMode`) all arrive through `canUseTool` and appear as cards in the plant's panel. Replying in the composer while a card is open counts as a "no, do this instead".
- Permission modes are shown as: **Ask me** (`default`), **Trust edits** (`acceptEdits`), **Plan first** (`plan`), **Wild growth** (`bypassPermissions`).
- Your settings, `CLAUDE.md` files, MCP servers and hooks load the same way they do in the CLI.
- When a plant needs you and the window is not focused, you get a system notification, and the dock badge counts plants needing you.
- Animations use transform and opacity only, pause when the window is hidden, and turn off with the system's reduced-motion setting.

## Development

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

Set `GARDENER_DEBUG=1` to print each Claude Code process's stderr.

## Not done yet

- Packaged installers. `npm run build` produces the app in `out/`; an electron-builder config (with the SDK's native binary unpacked from asar) is the next step.
- Worktrees per plant. Today, plants in the same bed share a working tree, like several terminals in one repo.
- Diff view of what a plant changed during a turn.
