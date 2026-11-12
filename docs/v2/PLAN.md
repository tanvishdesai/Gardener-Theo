# Gardener V2: plan

Status: agreed, ready to start M0 · 2026-11-11 (see [Decision log](#8-decision-log))
Scope: isolation (worktrees), checkpoints and revert, diff review, commit and PR flow, scale, storage, dense mode, usage view, sessions started outside the app, and a soil report that runs checks. Other providers and adapters are out of scope.

This document is the contract for V2. Each milestone below has a goal, a design, how it shows in the garden, acceptance criteria and tests. Nothing gets built until the section covering it is agreed. Research behind each decision is summarized in [References](#references).

---

## 1. What V2 must be

Gardener V1 is a good idea in prototype form. V2 has to be a tool developers trust with real repositories, real money and hundreds of sessions. That means three things, in this order:

1. **It never loses or damages work.** Agents are isolated from each other and from your checkout. Every turn can be inspected and undone. Gardener's own state survives crashes.
2. **It stays fast at real volume.** Cost scales with what is on screen and alive, not with everything you have ever done.
3. **The garden carries information, and the tool stays plain.** Every garden visual has a plain label next to it saying what it is (the V1 rule). Serious tasks like reading a diff or writing a commit get a serious interface, framed in the pixel chrome but never made worse for the sake of the theme.

### 1.1 Budgets (V2 is not done until these hold)

Measured on a mid-range Windows laptop (4 cores, 16 GB, integrated GPU) with a synthetic garden of **100 beds, 1,000 plants (970 idle or historical), 30 live agents streaming**, journals of **10k+ entries**, tool outputs up to **5 MB**.

| Budget | Target |
| --- | --- |
| Pan and zoom, p95 frame time | ≤ 16 ms |
| Idle CPU, nothing alive | ~0% (no redraws when nothing moves) |
| CPU with 30 live plants on screen | ≤ 8% of one core for drawing |
| Cold start to interactive garden | ≤ 1.5 s |
| Open a plant with a 10k-entry journal | ≤ 150 ms to first paint |
| Main-process event-loop lag, p99, 30 live agents | ≤ 50 ms |
| IPC messages to the renderer | ≤ 60 per second regardless of agent count (coalesced) |
| App crash or force-kill while streaming | Loses at most the last ~250 ms of journal; never corrupts state |
| Live Claude processes | Capped by this machine's free memory, not a fixed number (D11); never pushes the system below its memory floor; idle ones closed after 30 min |

### 1.2 What V1 does today (from the scale audit)

At about 50 plants V1 is fine. Around 200 it is sluggish. At 1,000 it breaks:

- **The ground cache is one canvas the size of the world.** One bed with about 100 plants gives a 16,864 px wide, 578 MB canvas, past the GPU texture limit. A bed with 200 is past Chrome's pixel cap, so it renders blank.
- **Every frame redraws everything.** No culling, about 400k `fillRect` calls per frame at 1,000 plants, and an 8 fps redraw even when nothing moves.
- **Saving blocks the main process.** It rewrites `garden.json` and every dirty journal in full every 400 ms, synchronously. That stalls the agent message pumps and permission prompts.
- **Data loss paths.**
  - If `garden.json` fails to parse, the next save overwrites it with an empty garden.
  - `renameSync` on Windows throws EPERM when antivirus or the indexer holds the file, and that throw is uncaught.
  - Journals silently drop everything after 600 entries.
- **Claude processes are never closed.** No concurrency cap; each costs about 250 MB to 1 GB.
- **Updates are oversized and fan out.** Each update sends the whole `Plant` object. Every event re-filters and sorts all plants in React. The journal list isn't virtualized and re-parses Markdown for every entry on every event.
- **Soil checks fan out.** All beds run `git status` at once every 20 s, with sync file I/O on the main thread.
- **Layout isn't stable.** Beds jump when another bed changes size or is removed, so spatial memory can't form.
- **Cost bug.** Resumed plants double-count cost: the SDK's `total_cost_usd` already includes the resumed session's earlier total.

---

## 2. Key decisions

Each decision is short here and expanded in its milestone.

| # | Decision | Why | Rejected alternative |
| --- | --- | --- | --- |
| D1 | **SQLite via `node:sqlite`** (WAL, FTS5) in the main process; heavy scans in a `worker_thread` with its own read connection | Checked inside our Electron 45 (Node 24.22, SQLite 3.53): no flag, WAL and FTS5 work. No native module to rebuild per platform. | better-sqlite3 (native ABI rebuild for every Electron upgrade, no benefit); keeping JSON files |
| D2 | **Mutable tables plus an append-only journal, not full event sourcing** | T3 Code event-sources because it syncs many clients (web, mobile, remote) and replays projections. Gardener is a single-client desktop app. Transactions, migrations and append-only entries give us crash safety and history without CQRS overhead. All writes still go through one `Store` API, so an event log can be added later without touching callers. | T3-style events + projections + outbox (cost without a need) |
| D3 | **System `git` through `execFile`** with argument arrays, behind one queued Git service | Exact semantics for worktrees, plumbing and diffs. Claude Code on Windows already needs Git, so it's present. | isomorphic-git (no worktrees, slow); dugite (+tens of MB, only worth it if git is missing) |
| D4 | **Each plant can live in its own git worktree ("potted"), sown there from its first turn** | Resuming a session in a worktree of the same repo works. Moving a session between folders leaves absolute root paths in its history, so the agent may edit the main checkout. `projectConfigRoot` points settings and MCP at the bed root while cwd is the worktree. | Moving existing sessions into worktrees (unsafe); relying on Claude's own `--worktree` |
| D5 | **Checkpoints are git snapshots under hidden refs, using a temporary index**, captured before and after each turn | They catch Bash and subagent edits, which the SDK's own `rewindFiles` misses. Work survives restarts and doesn't fight the agent's `index.lock`. This is the same approach as T3 Code. | SDK `enableFileCheckpointing` (only Edit/Write/NotebookEdit, needs a live process) |
| D6 | **Conversation rewind with `resumeSessionAt`**, plus `forkSession(upToMessageId)` for "grow a new branch from here" | Supported SDK options; T3 does the same | Replaying history into a new session |
| D7 | **PRs via `gh` when it's logged in, otherwise the browser compare URL.** Gardener stores no tokens. | Simplest secure path; covers most users | Stored PAT and the REST API (later, only if needed) |
| D8 | **Watching terminal sessions is layered.** The transcript tailer is always on and needs no setup. A user-wide HTTP hook is an opt-in upgrade, recommended on first run. | Transcripts can't tell "waiting for your permission" from "a long command is running": a pending tool call looks the same either way. The hook's `PermissionRequest` and `Notification` events can, and "needs you" is the most valuable signal Gardener gives. The hook also gives sub-second state instead of up to 3 s. Because it's an upgrade on top of the tailer, nobody's global settings are changed without consent, and the feature works without them. | Hook required (invasive); tailer only (no reliable "needs you" for terminal sessions); command hooks (one process per tool call on Windows) |
| D9 | **The garden draws only what is active.** History moves to a dense list, the Seed Catalogue (see M2). | The real fix for volume is bounding what is drawn by design, then optimizing that bounded set. | Drawing 1,000 plants and hoping culling saves us |
| D10 | **Costs labeled as estimates everywhere**; usage deduped by `messageId:requestId` | The CLI estimates cost client-side. Summing per content block overcounts about 2.4x (T3 found this). | Showing cost as exact |
| D11 | **The live-process cap is computed from this machine's memory and adapts at runtime** (details in M2e) | Machines differ (8 GB to 64 GB), and so do sessions: a parked process is about 250 MB and a long one can pass 1 GB. A fixed number is wrong on most machines, so admission is based on measured free memory and measured per-process size. | Fixed default cap; total RAM alone (ignores what else is running) |
| D12 | **V2.0 ships on Windows only.** The code stays cross-platform, and macOS and Linux run unit tests in CI without blocking. | Focus: it's where the first user is, and Windows has the most edge cases (long paths, junctions, file locking, `fs.watch`, PowerShell). macOS and Linux packaging come after V2.0. | Shipping all three at once |

### What we deliberately do not copy from T3 Code

These are not just "not yet": they are wrong for this product right now.

- **Remote, web and mobile clients and the WebSocket RPC layer.** Gardener is a desktop app you glance at.
- **Full event sourcing, the outbox and leases.** See D2.
- **Provider adapters.** Out of scope.
- **LLM-generated branch names.** A deterministic `garden/<plant-slug>-<4hex>` is enough. LLM commit and PR text is kept (see M5) because it saves real effort.

---

## 3. Architecture after V2

```
renderer (React, canvas)            ── only knows GardenApi; no Node, no Electron
  │  IPC v2: thin shells, coalesced patches, paged journals, subscriptions
main process
  ├─ Store (SQLite, WAL)            ── single writer; batched transactions every ~100 ms
  ├─ Greenhouse                     ── Agent SDK sessions; process pool (cap, idle reaping, queue)
  ├─ GitService                     ── queued system git: status, worktrees, snapshots, diffs, commit, push
  ├─ Checkpointer                   ── turn start/end snapshots, diff index, prune-back
  ├─ Harvest                        ── commit message, push, PR via gh / compare URL, PR status poller
  ├─ SoilScheduler                  ── bounded, change-driven hygiene checks + stake runs
  ├─ Volunteers                     ── hook HTTP endpoint (127.0.0.1, token) + transcript tailer
  └─ worker_thread "almanac"        ── history import, usage aggregation, FTS indexing backfill (own read connection)
```

Rules:

- **One writer.** Only the main-process `Store` writes. The worker reads and sends results back as messages.
- **Every external process goes through a bounded queue:**
  - git: 4 at a time;
  - `gh`: 2 at a time;
  - stake runs: 2 at a time;
  - Claude: the process pool.
- **No synchronous filesystem work on the main thread after startup.**
- **`src/shared` stays free of Node and DOM APIs** (V1 rule, kept).

---

## 4. Milestones

They are in dependency order. Two tracks can run in parallel after M2:
- **Track A:** M3 → M4 → M5 (isolation, review, harvest).
- **Track B:** M6 → M7 (sessions from outside the app, usage, soil).

Each milestone ends with its acceptance tests green on Windows in CI (macOS and Linux run unit tests, not blocking; D12).

### M0. Groundwork: measure before changing

**Goal:** make the project reproducible on every OS and give V2 a scoreboard.

- **Toolchain:**
  - Regenerate `package-lock.json` so it carries every platform's optional binaries (V1's lockfile misses Rolldown's Windows binding), and verify with `npm ci` in CI.
  - Set `engines.node` to `>=22.12` (Electron 45's installer needs it).
  - Add a startup check for `git --version`.
- **CI (D12):**
  - **Windows is the gate:** typecheck, unit tests, build, Git-service integration tests against temporary repos, the perf benchmark and the soak test.
  - **macOS and Linux** run typecheck and unit tests, not blocking, so the code doesn't drift into Windows-only.
- **Synthetic garden generator.** The `npm run demo` URL `?beds=100&plants=1000&live=30&journal=10000` produces the budget workload from section 1.1, with live plants scripted to stream real-looking tool calls.
- **Perf benchmark.** Playwright drives the demo in Chromium. It scripts a pan, zoom and select loop and records:
  - p50/p95 frame times and `fillRect` count per frame;
  - long tasks;
  - heap size.
  
  Results are stored as a JSON baseline. CI fails on a regression above 15%.
- **Soak harness:** 30 fake `query()` streams for 10 minutes against the real main process, using the existing fake-query test pattern. Records event-loop lag, IPC rate and RSS.
- **V1 fixes that can't wait:**
  - the cost double count;
  - never overwrite `garden.json` after a failed parse (back it up, refuse to save);
  - catch errors in the save timer, and retry renames on Windows (EPERM/EBUSY).

**Acceptance:**
- A clean `npm ci && npm test && npm run build` passes on Windows, and typecheck plus unit tests pass on macOS and Linux.
- Baseline numbers are committed for V1 at 50, 200 and 1,000 plants. These are the "before" for every later milestone.

### M1. Storage v2: SQLite and IPC v2

**Goal:** crash-safe, unbounded, queryable state; small, coalesced IPC.

**Schema (v1 migration):**

```sql
beds(id PK, name, path UNIQUE, created_at, grid_x, grid_y, archived_at)
plants(id PK, bed_id FK, name, species, seed, origin /* sown|imported|volunteer */,
       session_id, cwd, plot /* bed|pot */, worktree_path, branch, base_ref,
       permission_mode, model, status, activity, activity_detail, live, turns, tool_calls,
       cost_usd, unread, last_text, error, pr_url, pr_state, created_at, updated_at, archived_at)
entries(plant_id FK, seq INTEGER, id TEXT, ts, kind, text, tool_name, tool_status, tool_summary,
        tool_activity, output_preview, output_blob, PRIMARY KEY(plant_id, seq), UNIQUE(plant_id, id))
blobs(hash PK, size, bytes)                 -- full tool outputs > 16 KB, zstd/deflate, capped at 5 MB
turns(plant_id, n, started_at, ended_at, user_entry_id, assistant_uuid, ok, cost_usd,
      ckpt_before, ckpt_after, files_changed, insertions, deletions, PRIMARY KEY(plant_id, n))
usage(session_id, message_id, request_id, ts, model, input, output, cache_read, cache_write,
      cost_usd, PRIMARY KEY(message_id, request_id))
soil(bed_id PK, report_json, checked_at)  +  soil_history(bed_id, day, score, stake_ok)
settings(key PK, value_json)
entries_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram')
```

- **Pragmas:**
  - `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`;
  - `temp_store=MEMORY`, `journal_size_limit=64MB`;
  - `auto_vacuum=INCREMENTAL` on new databases.
- **Write path:** `Store` buffers patches and entries and commits one transaction about every 100 ms, plus immediately on a turn end or an ask. Each `entry` upsert is keyed by `(plant_id, id)`, so a tool result updates its call in place. Large outputs go into `blobs`; entries keep a 4 KB preview.
- **Migrations:** numbered, forward-only, each in a transaction, with `PRAGMA user_version`.
  - The first run imports V1's `garden.json` and journals, then renames them to `*.v1.bak`.
  - A failed migration leaves the old files untouched and shows a blocking error. It never starts an empty garden.
- **IPC v2:**
  - `snapshot()` returns **shells** only: plant rows without `seed`, `last_text` or ask bodies. That's about 200 bytes per plant, around 200 KB at 1,000.
  - Plant changes travel as **field diffs**, coalesced per plant and flushed at most every 16 ms.
  - Journals are **subscriptions**: the renderer calls `openJournal(plantId)` and gets the newest 200 entries, then live entries for that plant only. `journalPage(plantId, beforeSeq, limit)` loads older ones. `closeJournal` stops the stream.
  - `toolOutput(plantId, entryId)` fetches the full blob on demand.
  - `search(query)` uses FTS5 trigram over entries, with fuzzy titles done client-side.
- **Retention:** keep everything by default. A Settings → Storage page shows database size and offers "compact journals older than N days", which keeps the text and drops tool outputs.

**Acceptance:**
- Kill the app mid-stream 100 times in the soak harness: zero corruption, at most 250 ms of journal lost.
- 10k-entry journal opens in ≤ 150 ms.
- Main-process event-loop lag p99 ≤ 50 ms with 30 streams.
- V1 data migrates on Windows.

**Tests:** migration from V1 fixtures; crash-reopen; upsert ordering; paging cursors; blob round trip; FTS search.

### M2. A garden that scales

**Goal:** meet the frame and CPU budgets at 1,000 plants. Make the garden readable at a glance, and make every plant reachable in two keystrokes.

**2a. Draw only what matters: the garden and the Seed Catalogue (D9)**

- A plant is **in the ground** if any of these hold:
  - it is live, waiting, failed or unread;
  - it was touched in the last 7 days;
  - it is potted with unharvested changes;
  - it is pinned.
- Every other plant is **in the Seed Catalogue**, a dense list described below. A bed shows at most 14 plants in the ground; the rest show as a "+23 in the catalogue" seed tray on the planter.
- This bounds the canvas by *activity*, not history. Developers never lose anything, because the catalogue is one keystroke away and searchable.

**2b. Rendering**

- **Stable layout.**
  - Beds get a permanent grid slot (`grid_x`, `grid_y`), assigned once by packing them into a roughly square grid around the greenhouse.
  - Beds never move when other beds change.
  - Planters come in fixed sizes: S fits 7 plants, M fits 14. The size changes only at those thresholds, and only inside the bed's own cell.
- **Chunked caches.**
  - The ground is cached in 512 px tiles, built only for tiles in view (plus a 1-tile margin), with an LRU of about 64 tiles.
  - Static props are cached per bed in one layer: planter, fence, sign, compost, trees.
  - Nothing is ever allocated at world size.
- **Plant sprite cache** keyed by `(species, maturity, status, frame)`. Idle plants are a single `drawImage`; only live, selected or hovered plants run the pixel painter.
- **Culling:** draw and hit-test only the beds that intersect the viewport, using a spatial index of bed rectangles.
- **Frame scheduler:**
  - 0 fps when nothing animates;
  - plants with animation tick at 8 fps;
  - 30 fps only while the camera or gardener moves;
  - the sky is cached and repainted once per phase or minute.
- **Level of detail:** zoom 1 (new) is a **map view**. Beds are colored blocks with status pips (amber = needs you, green = growing, gold = ready to harvest) and names, so the whole garden fits on screen.
- **Gardener walk:** teleport with a puff effect when the target is more than 20 tiles away, and walk otherwise.

**2c. Renderer state**

- The store keeps incremental indexes: `plantsByBed`, `needsYou` (sorted by wait time) and `counts`. No component filters all plants.
- Hover lives in a ref plus the canvas dirty flag, never in React state.
- The hidden screen-reader list of every plant is replaced by the Seed Catalogue, which is properly accessible.
- **Journal:** virtualized with `@legendapp/list`, as T3 does, or `content-visibility` if that's enough. Entries are memoized, Markdown is parsed once per entry version, and the list loads older pages when scrolled to the top.

**2d. Dense mode: the Seed Catalogue**

- A left sidebar (toggle `\`) with a virtualized list of every plant, grouped by bed.
- **Order:** sorted by urgency, borrowing T3's priority: needs you (permission > question > plan) > failed > working > ready to harvest > idle.
- **Columns:** status, name, branch or pot, turns, cost, last activity.
- **Filters:** needs you, growing, harvest, potted, catalogue-only, volunteers. Selecting a row moves the camera to the plant, or opens it in place if it isn't in the ground.
- **`Ctrl+K` command palette:**
  - fuzzy search over plant, bed and branch names;
  - full-text search over journals (FTS5);
  - actions ("sow in…", "next needing me").
- **Keys:**
  - `j`/`k` move through the list;
  - `n`/`N` go to the next or previous plant needing you, oldest wait first;
  - `[`/`]` go to the previous or next bed.

**2e. Process pool: a cap based on memory (D11)**

The pool decides *whether one more Claude process fits right now*, from measurements rather than a fixed number.

- **Measure.**
  - Gardener starts Claude Code itself through the SDK's `spawnClaudeCodeProcess` option (a plain `child_process.spawn` with the SDK's command, args, cwd, env and signal), so it knows every process ID.
  - Every 30 s, while at least one plant is live, **one** query (`Get-CimInstance Win32_Process`) reads the working-set size of each Claude process and its child tree (bash tools, MCP servers).
  - The per-process estimate `E` is a moving average of the measured sizes, seeded at 600 MB and never below 300 MB.
- **Admit.** Before starting a process, check `os.freemem()`. On Windows that is "available" physical memory, which includes standby pages.
  - Admit if `free − E ≥ floor`, where `floor = max(2 GB, 15% of total RAM)`, and the live count is under the hard ceiling.
  - Hard ceiling = `max(2, floor((total RAM − 4 GB) / E))`. It's a sanity bound for very large machines, not the limit you normally hit.
  - At least 1 plant can always run, even on a busy machine.
- **Under memory pressure** (free memory falls below `floor`): close the plant that has been **idle** longest first. It resumes on its next message; the only cost is a prompt-cache rebuild.
  - Never kill a plant that is mid-turn.
  - If every live plant is working, stop admitting and queue.
- **Queue.** Messages that can't be admitted wait in FIFO order. The plant shows "Waiting for a free pot · memory is full" with a plain explanation, and starts automatically when memory frees up. A plant that needs you jumps the queue.
- **Visible.** The top bar shows "Pots 5 of ~9 · 6.1 GB free" on hover, with the numbers the decision used. Settings has an optional *maximum*, for users who want fewer, but no fixed default.
- **Idle reaping:** close plants idle for 30 min regardless of memory, and resume them on the next message.
- **Optional `/compact`** before the prompt cache expires, as T3 does; off by default.
- **Example, on the first user's machine** (15.7 GB total, 4.4 GB free while measuring):
  - floor = 2.4 GB, so about 3 more processes fit right now at E = 600 MB;
  - the hard ceiling is 19;
  - on the same machine with other apps closed (say 11 GB free), about 14 fit.
  
  This is why a fixed number can't be right.
- **Stake runs (M7)** use a separate bound based on CPU: `max(1, floor(os.availableParallelism() / 4))`.

**2f. Soil scheduler**

- One queue, 4 git processes at a time.
- **Priority:** beds in view and with activity first, then the rest, refreshed at most every 5 min.
- Hygiene files (CLAUDE.md, CI configs, test and lint configs) are re-checked when `fs.watch` reports a change, with an hourly fallback. File checks are async, with no recursive `readdirSync`.

**Acceptance:**
- The section 1.1 budgets hold on the synthetic garden in the CI benchmark.
- Beds do not move when another bed is added, removed or resized (test asserts positions).
- Any plant can be reached via `Ctrl+K` in ≤ 2 keystrokes plus a query.

**Tests:** layout stability; chunk-cache invalidation; spatial-index hit testing; urgency sort; pool admission as a pure function of `(free, total, E, live, idle times)` with table-driven cases (pressure, all busy, needs-you priority, minimum of 1); reaping order with a fake query.

### M3. Potted plants: per-plant worktrees

**Goal:** parallel agents never collide in the same files, and your checkout is never touched unless you choose that.

**How it shows in the garden**
- **In the bed:** the plant grows directly in the soil and shares your working tree, as in V1.
- **Potted:** the plant grows in its **own terracotta pot** on the planter's edge. The pot carries a tiny branch tag. Label: "Potted · own worktree · `garden/fix-login-3fa2`".
- Pots with unharvested changes show loose soil on the pot rim, the same visual as uncommitted changes on a bed.

**Design**
- **Location:** `<userData>/plots/<repo-name>/<slug>-<sha256(commonDir + branch)[0:12]>`. It is deterministic, so a removed worktree can be recreated at the same path and `resume` keeps working (T3's approach).
- **Branch:** `garden/<plant-slug>-<4hex>`, from a base the user picks when sowing. The default is the bed's current branch. "Start from origin" runs `git fetch` and starts from the fetched commit.
- **Create:** `git worktree add -b <branch> <path> <base>`, with progress streamed to the sow dialog.
- **Session settings:**
  - the plant's `cwd` is the worktree;
  - `projectConfigRoot` is the bed root, so `.claude/settings*.json`, MCP and hooks match the bed;
  - `blockWritesOutsideWorkingDirectories` is enabled.
- **Guard command:** a PreToolUse guard rejects Bash commands that `cd` into or name absolute paths in the bed root. This is defense in depth; it is not a security boundary, and the docs say so.
- **Setup script:** an optional per-bed `gardener.json` at the repo root, or bed settings in the app. For example `{ "pot": { "setup": "npm ci", "env": [".env"] } }`.
  - Copies listed gitignored files (`.env`) from the bed root into the pot.
  - Runs the setup command in the pot with a timeout; output goes to the plant's journal as a "Preparing the pot" system entry.
  - The agent waits for setup by default. An `async` option lets them run side by side.
- **Mode switch:** sowing picks "In the bed" or "Potted". **The default is Potted for every git repo (decided).** Non-git folders can only be In the bed. An existing plant **cannot** move between modes, because its session history holds absolute paths (D4). Instead, "Repot" forks the conversation into a new potted plant via `forkSession` and says so.
- **Cleanup:**
  - "Uproot" on a potted plant asks: keep the branch (default) or delete it. The worktree folder is always removed.
  - A background sweep, hourly, offers to remove pots that are merged, older than N days, or orphaned. It never touches pots with uncommitted changes.
  - Settings → Storage shows the disk used per pot.
- **Windows:** `core.longpaths=true` and junction-safe removal.

**Acceptance:**
- Two potted plants editing the same file in one repo never see each other's changes.
- Uprooting cleans the worktree on Windows, including long paths and junctions.
- Resume works after the worktree is removed and recreated.
- The guard blocks writes into the bed root.

**Tests:** Git-service integration against temporary repos (create, recreate, remove, dirty guard, long paths); session-option mapping with a fake query.

### M4. Growth rings: checkpoints, diff review, pruning back

**Goal:** see exactly what each turn changed, comment on it, and undo it, for both files and conversation.

**How it shows in the garden**
- Each completed turn adds a **growth ring**: a notch on the stem.
- A plant that changed files this turn shows a small **leaf tally** tag beside it, such as `+42 −7`, labeled "Changed 3 files this turn".
- In the plant panel, a new **Rings** tab shows a vertical timeline, one row per turn: the prompt, diffstat bars, cost and time. Click a ring to open its diff.
- **Prune back to here** (shears icon) reverts the files and conversation to that ring. Rings after it turn grey ("pruned"), are kept for audit, and can't be restored after a new turn.

**Checkpoint design (D5)**
- Run before the turn starts (baseline) and when it ends (including interrupted and failed turns):
  1. Point `GIT_INDEX_FILE` at a temporary file in the git common dir.
  2. Seed it from the real index, then `read-tree --reset HEAD` (fast path: unchanged files are not rehashed).
  3. `git add -A -- .` with `core.fsmonitor=false core.safecrlf=false` (+`core.longpaths=true` on Windows).
  4. `write-tree`, then `commit-tree <tree> -p HEAD`, then `update-ref refs/gardener/<plantId>/<n>`.
- **What's captured:** untracked files that aren't ignored. Ignored files (`node_modules`, `.env`) are not captured, and that's stated in the UI.
- **Locking:** a per-worktree lock serializes capture, diff and restore.
- **Per-turn diffstat:** `diff --numstat -z before after`, stored in `turns`.
  - If HEAD moved during the turn (the agent committed or pulled), only paths the agent authored count, compared against both HEADs, as T3 does.
- **Ref cleanup:** delete `refs/gardener/<plantId>/*` on uproot, and refs older than the retention window. T3 doesn't clean these up; we will.

**Diff review**
- **Producing the diff:** `git diff --patch --no-color --no-ext-diff --no-textconv before after`, **streamed per file**:
  - the file list comes from numstat;
  - each file's hunks are fetched when expanded;
  - each file is capped at 1 MB, with a "show anyway" button.
  
  This beats T3's one 10 MB patch for large turns.
- **Diff view:** full-height, split or unified, syntax highlighted, monospace, with a file tree. It uses `@pierre/diffs` (what T3 uses, MIT) or `diff2html`. The choice is made by a spike on bundle size and how far it lets us style the pixel chrome.
- **Scopes:** this turn · since sowing (the pot's base to now) · uncommitted (working tree vs HEAD).
- **Plant tags (review comments):**
  - Select lines and "tie a tag" to them with a note. Tags collect on the composer as chips.
  - On send, they are serialized into the prompt as structured context: file, line range, a mini hunk, and the note (T3's approach).
  - Tags show on the plant as little paper labels until the next turn ends.

**Revert design (D6)**
- **Files:**
  1. `git restore --source <ckpt> --worktree --staged -- .`
  2. `git clean -fd -- .` (without `-x`, so ignored files survive)
  3. `git reset -q -- .`
- **Conversation:** the next turn runs with `resume: sessionId, resumeSessionAt: <assistant uuid recorded for that ring>`. Pruning back to before the first ring starts a fresh session.
- **Safety gate:** file restore is allowed only for potted plants, or for an in-the-bed plant when no other plant is live in that bed. Otherwise only the conversation is pruned, and the UI explains why.
- **"Grow a new branch from here":** fork the conversation at a ring into a new potted plant (`forkSession` with `upToMessageId`), with the pot created from that ring's checkpoint commit.

**Acceptance:**
- **Turn diffs** include Bash-made changes and new untracked files.
- **Pruning** restores files byte-for-byte to the checkpoint (hash test) and continues the conversation from that point.
- **Speed:** checkpoint capture takes ≤ 300 ms on a 50k-file repo with a warm index.
- **Large diffs:** a 20 MB turn diff opens without freezing, because files load lazily.

**Tests:** plumbing integration (ignored, untracked, binary, rename, CRLF, long paths, HEAD moved mid-turn); restore correctness; diff paging; tag serialization.

### M5. Harvest: commit, push, PR

**Goal:** from "the plant finished" to "PR open with a good description" in under a minute, safely.

**How it shows in the garden**
- **Ready to harvest** keeps meaning a finished turn you haven't read. A potted plant with committed or uncommitted changes also gets a **harvest basket** at its pot.
- **Harvest flow, as a wizard in the plant panel** (each step shows the real git operation):
  1. **Review:** the "since sowing" diff from M4.
  2. **Gather:** choose files and generate a commit message.
  3. **Bundle:** commit, shown as `git commit`.
  4. **To market:** push, then open the PR.
- **Open PR:** a little **market stall** sign on the pot with the PR number. CI status shows on the bamboo stake: green ribbon (passing), amber (running), red (failing). Review state shows on the stall: approved ✓ or changes requested.
- **Merged:** the plant is **transplanted**. It moves to the catalogue with a "merged" badge, and its pot is offered for cleanup.

**Design**
- **Commit message:** a one-shot Agent SDK query (fast, cheap model, `maxTurns: 1`, no tools) over the staged summary (≤ 8k characters) and patch (≤ 50k characters), following the repo's recent commit style (`git log -n 20 --format=%s`). The user always edits before committing.
- **Default-branch guard:** refuse to commit directly to the default branch. Offer "create branch `garden/…`" instead (in-the-bed plants hit this).
- **Push:** `git push -u origin <branch>`, with errors (auth, rejected, hooks) shown verbatim and explained.
- **PR (D7):**
  - With `gh auth status` OK: `gh pr create --base <base> --head <branch> --title … --body-file -`. The body is generated like the commit message, plus a "Gardener" footer listing the turns.
  - Otherwise: open the GitHub compare URL in the browser.
  - Non-GitHub remotes get the compare URL where one is known; otherwise the flow stops after push.
- **PR status:** `gh pr view <n> --json state,reviewDecision,statusCheckRollup,mergeable`, polled with backoff (1 min while checks run, 10 min otherwise, paused when the window is hidden for an hour). At most 2 `gh` processes at a time.
- **Optional "wake on red stake":** when checks fail, offer to send the plant a message with the failing check names and logs (`gh run view --log-failed`, truncated). Off by default; opt-in per plant. A loop cap is borrowed from T3.

**Acceptance:**
- Commit, push and PR work end-to-end on a test repo, with `gh` and with the browser fallback.
- Committing to the default branch is impossible without an explicit choice.
- PR status updates on the stake within 2 minutes of a CI change.

**Tests:** guard logic; message-generation prompt assembly (snapshot); `gh` JSON parsing fixtures; poller backoff.

### M6. Volunteers and the Almanac: sessions from outside the app, and usage

**Goal:** Gardener shows *all* your Claude Code work, including sessions in terminals, and what it costs.

**Volunteers (D8)**
- **In the garden:** a session started outside Gardener is a **volunteer**, a plant that sprouted without being sown. It has a wild-flower look and a dashed outline tag. Label: "Volunteer · running in a terminal".
- **Its state is live** (thinking, tools, waiting), but asks can't be answered from Gardener. They show "Waiting for you in your terminal" with the session's cwd.
- **"Adopt"** (resume in Gardener) is offered only after the terminal session ends, so two processes never write the same session.
- **Two layers (D8):**
  - **Layer 1, always on, no setup:** the transcript tailer below. Volunteers appear within about 3 s and show their tools and turns. Without the hook, a pending tool call shows as "Busy or waiting in your terminal", because the transcript can't tell the two apart.
  - **Layer 2, the hook:** offered once on first run, and in Settings, with one sentence on what it changes and a preview of the exact JSON added. It gives sub-second updates and a reliable "Waiting for your permission in the terminal" (from `PermissionRequest` and `Notification` with `permission_prompt` or `idle_prompt`). That turns a terminal session into an amber plant that pings you like a sown one.
- **Hook details:**
  - "Watch terminal sessions" *merges* (never overwrites) an HTTP hook into `~/.claude/settings.json`, after taking a backup. Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, SessionEnd.
  - HTTP, not a command hook: a command hook would start a process for every tool call on Windows.
  - The port is fixed (default 47823, changeable), because the URL is written into settings.
  - If Gardener can't bind the port at startup, it warns, because another program would be receiving the events. Payloads only ever go to `127.0.0.1`.
  - The hook posts to `http://127.0.0.1:<port>/hook` with a random token header.
  - Gardener always replies with an empty 2xx (a JSON body would count as a decision) and ignores session IDs that belong to its own plants.
  - There's a one-click uninstall. If Gardener isn't running, the hook fails silently and the terminal keeps working.
- **Transcript tailer:**
  - For each active volunteer, read `transcript_path` from a stored byte offset, keeping a partial last line, using the lenient parser from `history.ts`.
  - `fs.watch` is treated as a hint, with a 1–2 s poll for active files (Windows reliability). This is also the fallback when the hook isn't installed: scan `~/.claude/projects` for files modified recently.
- **The V1 importer becomes the backfill.** It runs in the almanac worker and streams into SQLite in batches. It no longer holds everything in memory or sends one IPC message per entry.

**The Almanac: usage view**
- **Opening it:** a new top-bar button and a panel; also a pixel-art "almanac" book on the greenhouse table.
- **Shows:**
  - cost and tokens per day (bar chart);
  - totals per bed, model and plant;
  - cache-hit ratio;
  - the most expensive turns (each links to its ring).
- **Sources:**
  - SDK `result.modelUsage` for sown plants;
  - transcript `message.usage`, deduped by `messageId:requestId`, for volunteers and history;
  - the `cost-state` line when it's present.
- **Pricing table:** shipped with the app and updatable; labeled "estimate" everywhere (D10).
- **Weather (rate limits):** `rate_limit_event` from live sessions drives the **sky**. Clear when utilization is low, clouds building toward the limit, rain when you're limited, with "resets at 14:20" on hover. It is subscription-only and hidden otherwise. It's the one place the sky carries information beyond the time of day, and it is always labeled.
- **Optional auto-resume after a limit** (T3's idea): "Continue when the rain stops" queues a message for after `resetsAt`. Off by default.

**Acceptance:**
- A terminal session appears as a volunteer within 1 s of starting (hook) or 3 s (tailer only).
- Its tools animate live.
- Uninstalling the hook leaves `settings.json` exactly as it was before (byte-equal to the backup when nothing else changed).
- Almanac totals match `cost-state` totals within 1% on the real history.

**Tests:** hook payload fixtures for each event; settings merge and unmerge (with and without existing hooks); tailer partial-line and rotation cases; usage dedupe.

### M7. Soil that does something

**Goal:** the soil report stops being a checklist and becomes the feedback loop the README promises. Agents grow against stakes.

- **Stake runs:**
  - **Configuring:** each bed sets a fast check command (detected from `package.json` scripts like `typecheck`, `test` or `lint`, a Makefile, or `pyproject`; editable; stored in bed settings or `gardener.json`).
  - **When it runs:** after each turn that changed files, in that plant's pot or bed, through the stake queue (2 at a time, with a timeout).
  - **What you see:**
    - Pass: a straight stake with a green tie.
    - Fail: the plant **leans away from its stake**, labeled "Checks failed after this turn: `npm test` (3 failures)". The output is in the ring.
    - One click: "Ask the plant to fix it", which sends the failure output as a tagged message.
- **Health score per bed** (compost, stakes, fence, mulch, plus the stake pass rate over the last 20 turns), recorded daily in `soil_history`. A sparkline in the bed panel shows whether the bed is getting healthier. That's the "gardener" job in the README, made measurable.
- **Chores react to evidence:**
  - a bed whose plants keep failing the same stake suggests "Drive a stake" with the failing check named;
  - a bed with no guidance and many wilts suggests "Add compost".
  
  Suggestions only; never automatic.
- **Weeds:** a soil check counts lint warnings or suppressions when a lint command is configured. Mulch thickness reflects it.

**Acceptance:**
- A failing check after a turn shows the plant leaning within the stake's timeout, and "fix it" sends the right context.
- The health sparkline updates daily.

### M8. Release quality

- **Packaging (D12, Windows only for V2.0):**
  - `electron-builder` NSIS installer (per-user install, no admin), with the SDK's native binary unpacked from asar.
  - **Authenticode signing with an OV code-signing certificate** from a public CA (decided; no Azure).
    - **Not EV:** since March 2024 EV no longer skips SmartScreen's reputation check, so OV gives the same install experience for less money.
    - **Key storage:** CA/B Forum rules require the private key in hardware (FIPS 140-2 L2 HSM or token). Use the CA's **cloud signing service** (for example SSL.com eSigner or DigiCert KeyLocker) so GitHub Actions can sign without a USB token.
    - **Validity:** certificates now last at most 460 days, so put a renewal reminder in the release checklist.
    - **First downloads still warn:** reputation builds per file hash with downloads, so expect a "more info → run anyway" prompt for the first releases and say so on the download page.
    - Sign the installer, the app executable and the unpacked SDK binary.
  - macOS dmg (signed and notarized) and Linux AppImage come after V2.0.
- **Updates:** auto-update through GitHub Releases, with a database backup before migrating on update (T3 snapshots state before updates too).
- **First run:**
  - checks for git, Claude Code login and `gh`;
  - offers to import history (with a preview of beds and plants);
  - offers to watch terminal sessions (opt-in).
- **Diagnostics:** local logs with rotation under `userData/logs`, and Help → "Copy diagnostics" (versions, database size, live processes, recent errors). No telemetry by default.
- **Docs:** README updated with the V2 tables (pots, rings, harvest, volunteers, weather), and the CLAUDE.md layout section updated.

---

## 5. New vocabulary (keep `README.md` and `paint.ts` in step)

| In the garden | What it means |
| --- | --- |
| Terracotta pot with a branch tag | Plant runs in its own git worktree on that branch |
| Seed tray "+N in the catalogue" | N older plants live in the Seed Catalogue list |
| Notches on the stem | Completed turns, each a checkpoint you can open or prune back to |
| Leaf tally `+42 −7` | Lines added and removed in the last turn |
| Grey rings | Turns pruned away (kept for audit) |
| Paper tags on a plant | Review comments waiting to be sent with your next message |
| Harvest basket at the pot | Changes ready to commit |
| Market stall with `#123` | Open pull request |
| Stake ribbon green / amber / red | PR checks or bed checks passing / running / failing |
| Plant leaning away from its stake | Checks failed after its last turn |
| Transplanted badge | PR merged |
| Wild flower with dashed tag | Volunteer: a session running in a terminal |
| "Waiting for a free pot" | Live-process cap reached; message queued |
| Clouds and rain | Approaching or at your usage limit (resets time on hover) |
| Map view (zoom 1) | Beds as blocks with status pips |

---

## 6. Risks and how we handle them

| Risk | Mitigation |
| --- | --- |
| Transcript format is internal to Claude Code and changes between versions | Lenient parser that ignores unknown types and logs them; hooks are the main source of live state; fixture tests per CLI version we support |
| Worktrees eat disk (T3 users report hundreds of GB) | Per-pot disk usage visible; cleanup sweep with safe defaults; setup scripts can use shared caches |
| A potted agent still writes outside its pot through Bash | `blockWritesOutsideWorkingDirectories` + PreToolUse guard + stating plainly that it's not a sandbox |
| Checkpoint capture is slow on huge repos | Fast-path index seeding; time budget with a "checkpoint skipped (repo too large)" state rather than blocking the turn |
| `node:sqlite` is "release candidate" | API surface we use is small (prepare/run/all/transactions); wrapped in one module; better-sqlite3 as a drop-in fallback |
| Installing a hook in the user's global settings feels invasive | Opt-in, backed up, merged not replaced, one-click uninstall, explained in plain words |
| The metaphor gets cluttered as features land | Every visual is in the vocabulary table with a plain label; the map view and catalogue carry density so the garden stays calm |
| Scope creep toward "T3 Code with flowers" | Section 2's "do not copy" list; each milestone needs an acceptance test that is about *this* product's goals |

---

## 7. Open questions

All answered as of 2026-11-11. See the [Decision log](#8-decision-log). New questions get added here as milestones raise them.

## 8. Decision log

| Date | Decision | Decided by | Notes |
| --- | --- | --- | --- |
| 2026-11-11 | New plants are potted (own worktree) by default in git repos | User | M3 |
| 2026-11-11 | Watching terminal sessions is layered: transcript tailer always on; HTTP hook opt-in, recommended on first run | Claude (asked to decide) | D8. The hook is the only reliable way to know a terminal session is waiting for permission; making it optional keeps global settings untouched without consent |
| 2026-11-11 | Live-process cap is computed from measured free memory and per-process size, with a user-settable maximum but no fixed default | User (requirement), Claude (method) | D11, M2e |
| 2026-11-11 | V2.0 ships on Windows only; code stays cross-platform | User | D12, M0 CI, M8 |
| 2026-11-11 | Pots (worktrees) live in Gardener's data folder: `<userData>/plots/<repo>/…` | User | M3 |
| 2026-11-11 | PRs are GitHub only for V2: `gh` when logged in, otherwise the browser compare URL; other hosts stop after push | User | D7, M5 |
| 2026-11-11 | History is kept forever; compaction is manual and opt-in only | User | M1 retention |
| 2026-11-11 | One diff-viewer dependency is allowed (`@pierre/diffs` or `diff2html`, picked by a spike in M4) | User | M4 |
| 2026-11-11 | Code signing: OV certificate through a CA cloud signing service; no Azure, no EV | User (OV, no Azure), Claude (OV over EV, cloud HSM) | M8 |

---

## References

Research done on 2026-11-11 against T3 Code at commit `c82e1ba`, `@anthropic-ai/claude-agent-sdk` 0.3.322 (Claude Code 2.1.322) and Electron 45.2.3.

**T3 Code** (paths in `pingdotgg/t3code`):
- Worktrees: `apps/server/src/vcs/GitVcsDriverCore.ts` (`createWorktree`), `vcs/worktreeCheckoutCache.ts`, `storageCleanup.ts`, `vcs/worktreeRemoval.ts`, `orchestration-v2/RuntimePolicy.ts`.
- Checkpoints: `orchestration-v2/CheckpointService.ts`, `vcs/GitVcsDriver.ts` (temporary index capture, restore), `checkpointing/Diffs.ts`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts`.
- Diff review: `checkpointing/CheckpointDiffQuery.ts`, `review/ReviewService.ts`, `apps/web/src/reviewCommentContext.ts`; renderer `@pierre/diffs`.
- Git and PRs: `apps/server/src/git/GitManager.ts`, `packages/source-control-github/…/GitHubSourceControlProvider.ts`, `GitHubCredentials.ts`, `orchestration-v2/pullRequestWatch.ts`.
- Persistence: `persistence/Sqlite.ts` (pragmas), `Migrations/055_OrchestrationV2.ts`, `orchestration-v2/EventSink.ts`, `threadHistoryPaging.ts`, `Migrations/069_ThreadMessageSearch.ts` (FTS5 trigram).
- Usage: `provider/Drivers/claudeUsage.ts` (dedupe by `messageId:requestId`), `usage/usageAggregation.ts`.
- Processes: `ProviderSessionManager.ts` (30 min idle), `IdleCompaction.ts`, `UsageLimitRecoveryWorker.ts`.

**Agent SDK / Claude Code** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and the docs):
- Session storage and resume across worktrees: https://code.claude.com/docs/en/sessions
- `forkSession`, `resumeSessionAt`, `projectConfigRoot`, `blockWritesOutsideWorkingDirectories`, `rate_limit_event`, `modelUsage`: see `sdk.d.ts`.
- File checkpointing limits: https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- Hooks: https://code.claude.com/docs/en/hooks
- Cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Hosting and process cost: https://code.claude.com/docs/en/agent-sdk/hosting

**Gardener V1 scale audit:** probe script and numbers from 2026-11-11, summarized in section 1.2. The worst case was a bed with 200 plants giving a 28,288 × 14,286 px ground canvas (1.6 GB).

**Ecosystem:** [T3 Code deep dive](https://flaviocopes.com/t3-code/), [Better Stack on T3 Code](https://betterstack.com/community/guides/ai/t3-code/), [Continuum review](https://continuumcode.ai/guides/t3-code-review/), [parallel-agent tools roundup](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8), [Abralo comparison](https://abralo.com/alternatives).

---

## 9. Implementation notes (deviations found while building)

| Where | What changed from the plan | Why |
| --- | --- | --- |
| M0 toolchain | Setup trouble root cause: **Node 22.9 < the `>=22.12` engines of Electron 45 and Rolldown**, so npm silently skipped their optional native packages. Fix is `engines.node >=22.12` (set), not a regenerated lockfile. | Lockfile was already complete. |
| Tests | `npm test` runs vitest on **Electron's own Node 24** (`scripts/test.mjs`, `ELECTRON_RUN_AS_NODE`). | Node 22.9's bundled SQLite has no FTS5; tests should run on the runtime we ship. |
| M1 | Usage scanning runs on the main thread in chunks, not a `worker_thread`. | Measured on 209 MB of real history: first scan 633 ms, max event-loop block 17 ms (budget 50 ms). Huge `api-request*` lines are skipped before `JSON.parse`. |
| M3 | Worktree removal never calls `git worktree remove --force`; it deletes the folder without following links, then `git worktree prune`. | Git for Windows follows directory junctions inside a worktree and deletes their targets (data loss, found in tests). |
| M4 | Restore is byte-identical except for one case: with `core.autocrlf=true` (Git for Windows default), LF files the agent wrote come back CRLF. | Conversion happens when git stores the file; the original bytes are gone at snapshot time. Documented, not fixable without breaking diffs. |
| M4 | Snapshot ≈ 300 ms regardless of repo size on Windows. | Dominated by ~6 git process starts (~45 ms each). |
| M5 | PRs via `gh pr create`; T3 uses the REST API. | No stored tokens (D7). |
| M6 | The Almanac includes subagent transcripts, billed to the parent session; duplicate streamed usage lines keep the largest output count. | Needed to match Claude Code's own `cost-state` totals (matches exactly on real history). |
| M6 | Sessions whose transcript `entrypoint` starts with `sdk` are never volunteers. | That covers Gardener's own sessions and other SDK apps. |
| M8 | Packaged app passes `pathToClaudeCodeExecutable` (claude.exe in `app.asar.unpacked`). | The SDK can't spawn a binary from inside the asar archive. Unpacked build: 706 MB (claude.exe 331 MB). |
| M1 storage | WAL checkpoints run in a worker thread (`startCheckpointer` in db.ts); the main connection has `wal_autocheckpoint = 0`. | The 60 s soak showed automatic checkpoints (copy WAL + fsync) on the main thread pushing event-loop p99 to 91 ms. With the worker: 26–29 ms. |
| M1 IPC | Event coalescing moved to `events.ts` (`EventQueue`); flush every 17 ms. | Testable without Electron; 17 ms makes "≤ 60 messages/s" hold by construction (16 ms allowed 62.5). |
| Budgets | Measured (2026-11-12, this machine): cold start 872 ms median with 1,000 plants (`npm run coldstart`); 30 streaming agents at ~40× realistic load: event-loop p99 26–29 ms, 30–35 IPC msg/s (`npm run soak`, 5 s and 60 s); frames p95 2.8 ms (`npm run bench`). One 60 s run showed a single 882 ms stall that did not reproduce in an instrumented rerun (no store call > 70 ms, no gap > 150 ms); suspected GC or antivirus. | Timing budgets run alone (`npm run soak`), not inside the parallel `npm test`. All three now run in the Windows CI job. |
