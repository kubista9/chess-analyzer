# P4b: Opening pass, resumable backfill, review on the position cache

Branch: `phase/p4b-backfill` (from `phase/p4a-engine-core` at 5b10f01). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| fc7d0c2 | feat(db): backfill runs, window coverage and merged follow-ups; per-position pool results |
| d68002d | feat(analysis): opening pass protocol and resumable backfill (npm run backfill) |
| 313a38f | feat(server): review from the position cache first; engine check status, start and pause routes |
| 9b662f4 | feat(web): Home engine card with progress, ETA and pause; sidebar chip while it runs |
| 9f86dee | test(verify): verify-evals checks cache hits, the incremental rule and re-queueing |
| 4c6e63e | docs: describe the engine check, its routes and verify-evals |
| (this commit) | docs: add the P4b phase report |

Each code commit typechecks and passes the tests on its own. This was checked on an exported copy of each tree: 300, 322, 321 and 321 tests.

## What was done

### Opening pass (`server/services/openingPass.ts`)
- **Positions.** `openingPositions(moves, ownerColor)` gives positions 0..L−1, where L = min(OPENING_PLY_LIMIT, game length) and position i is the one before ply i+1.
  - Each position carries its mover and tier: owner to move gets the owner tier (MultiPV 3, d15), the opponent the opponent tier (MultiPV 1, d14).
  - It also carries the UCI history, the played move and its SAN.
  - The key is `tier|EPD`.
- **`evaluateOpening(deps, groupId, items, {priority})`** processes one group of positions:
  1. For each item it looks up `getPositionEval` (the tier or higher) first.
  2. A row that already scores every move in `played` is used as is, with no search.
  3. A row that lacks some played moves is passed as `cached`, so only the depth-matched searchmoves follow-up runs.
  4. Everything else goes to the pool as one group.
  5. Each result is stored the moment it arrives (`onResult` → `putPositionEval`).
- **`summariseOpening`** builds `GameOpeningSummary` (`game_analysis.summary_json`, `version: 1`):
  - per side: move count, category counts, mean loss, mean lichess accuracy, `firstError` (the first mistake or worse: ply, SAN, UCI, loss, class) and `worst`;
  - `evalAfter` for plies 12, 16 and 20, from the owner's side (cp, mate, win%). "Eval after ply N" is the played move's score at the ply-N root, from the same search as the best move.
- **`recordOpeningFromStore`** writes a game's row only when every position, read back from the store, is answered. If a concurrent writer replaced a row in the meantime, it writes nothing and the game stays queued.

### Backfill (`server/services/backfill.ts`, `scripts/backfill.ts`)
- **Plan.**
  - The queue is `listAnalysisQueue` (the INCREMENTAL RULE), newest first, optionally `--limit N`.
  - For every (tier, EPD) in the window, the plan collects every move ever played from it in any window game. Each position is then searched once, and every move is scored at the same root. A later game that reaches the EPD is already answered.
  - Each key is assigned to the newest queued game that contains it, which gives one group per game per pass.
  - Keys the cache already answers are counted as `cached` and never searched.
- **Pass A, then pass B.** All owner-to-move groups run first, then the opponent-to-move ones.
  - Groups are handed to the pool with at most `ENGINE_WORKERS` in flight.
  - The pool checks interactive priority between positions (P4a).
  - A game is finalised as soon as its last pending key resolves, so rows appear during pass B, or at once for fully cached games.
- **Pause.** The abort signal stops handing out groups, and the groups in flight finish. Anything unfinished stays queued. When the pool closes (server shutdown), the run also counts as paused.
- **Failures.** A group that fails (after the pool's one respawn and retry) leaves its games without rows, so they stay queued. The run then reports `failed` with the errors, and the other games still complete.
- **Measurement.** Every run gets a `backfill_runs` row (migration 3): source, pid, config, workers, battery, games, positions searched, nodes, search wall-time and status.
  - `ThroughputMeter` computes pool-wide nps over the last 200 searches, and the mean nodes per tier for this run.
  - Until those exist, it falls back to priors: the stored means per tier, then 420k / 120k nodes, and the last completed run's nps, then 1.12M.
  - The ETA is Σ remaining × mean nodes ÷ nps.
- **Lock.** `storage/backfill.lock` is created with O_EXCL and holds `{pid, source, startedAt, updatedAt, progress}`.
  - The holder rewrites it atomically (temp file + rename): with progress every 2 s, and as a heartbeat every 15 s.
  - A lock whose pid is dead, or whose heartbeat is more than 2 min old, is taken over.
  - The lock is released on finish, on the process `exit`, and on the second Ctrl-C. A holder never overwrites or removes a lock that another process has taken over.
- **Battery.** `pmset -g batt` (source and %) and `pmset -g` (lowpowermode) feed `readPowerState`.
- **CLI (`npm run backfill`).**
  - Flags: `--limit N`, `--dry-run` (queue, unique positions, cached, per-tier to-search, partial rows, estimated nodes and time, and the basis of the speed), `--allow-battery`.
  - On battery without the flag it asks y/N, or refuses when stdin is not a TTY.
  - It builds its own pool (`ENGINE_WORKERS`) and logs the engine, config id and database at start.
  - Progress is a rewritten TTY line ("Engine check: your positions 91 / 170, then 163 opponent positions · 0 / 20 games · 1.24 Mnps · ~42 s left"), or a line every 10 s when not on a TTY.
  - The first Ctrl-C pauses, the second kills. Engines and the DB are closed in `finally`.
- **Server (`BackfillService`, `server/services/backfillService.ts`).** It runs the same `runBackfill` on the server's shared pool at backfill priority, under the same lock.
  - `start({allowBattery, limit})`, `pause()`, and `autoStart()` (AUTO_BACKFILL=1 after a sync: only when not running or paused, and on mains).
  - `status()`:
    - engine and config, and the state (`idle`, `running`, `pausing`, `paused`, `failed`);
    - the runner (this server, or the CLI read from the lock file with its progress);
    - games analysed per colour (`analysisCoverage`) and window positions cached per tier (`windowPositionCoverage`);
    - the estimate for the queue, the last run, and the power state (pmset cached for 30 s).
- **Routes.**
  - `GET /api/analysis/status`.
  - `POST /api/analysis/backfill {allowBattery?, limit?}` answers 202, or 409 with `code: "on-battery"` or `"locked"`. `HttpError` now carries an optional `code`, and the client's `ApiError` reads it.
  - `POST /api/analysis/pause`.

### Review on the position cache
- **`runGameReview(db, pool, configId, gameId)`.** It builds the 20 positions with `openingPositions` and runs `evaluateOpening` at interactive priority, which stores whatever the pool computes. It then annotates the moves.
  - A review that completes a game also writes its `game_analysis` row, so the backfill skips that game.
- **`cachedGameReview`** builds the review from the store alone, or returns null.
  - `POST /api/game-review` answers a completed job at once when this works.
  - The engine id is detected once per server process with a short-lived engine (`installedEngineIdName`), so a cached review never keeps a Stockfish process around.
- **`annotateMoves` takes L evals** (one per position before a move), no longer L+1.
  - The eval after the last move is the played line's score at its root.
  - When the game ended there, it is checkmate (M0) or stalemate (0.00) instead.
- **The reviews-v3 file cache is gone** (`cachePaths.ts`, versioned JSON helpers and their test). A config change can no longer serve old numbers. The files already on disk are untouched.

### Store changes
- `putPositionEval` merges scored moves when the stored row has identical MultiPV lines. This covers two writers (e.g. the review and a CLI backfill) that extended the same cached search with different follow-ups. A different main search replaces the row.
- `listOpeningMoves(db, owner, windowStart, maxPly)` returns every window game's colour, end time and opening plies in one query.
- `averageNodes` and `windowPositionCoverage` in `positions.ts`, and `analysisCoverage` in `gameAnalysis.ts`.
- The pool's `GameOptions.onResult(index, eval)`: a consumer that throws fails that game; the error never escapes as an unhandled rejection.

### UI
- **Home "Engine check" card** (`src/components/EngineCard.tsx`, `src/styles/engine.css`), below the Sync card:
  - The eyebrow reads "Stockfish 18 · first 10 moves · config #1", followed by the coverage "As White 22 / 686 · As Black 22 / 692 games".
  - **Idle, most games unchecked:** "1,334 of 1,378 games not engine-checked yet" and **Start engine check (~64 min)**, with a battery / Low Power Mode note.
  - **Idle, a few new games:** "N new games to analyse" and **Analyse N new games (~M min)**.
  - **Paused:** **Resume**.
  - **Failed:** **Retry**, with the error shown.
  - **Running:**
    - the headline "Engine check: 31 / 7,928 of your positions · then opponent positions · ~68 min left";
    - a progress bar;
    - "4 / 1,338 games done · 181 positions were already cached · 1.04M nodes/s";
    - **Pause** (server runs), or "Running in a terminal (npm run backfill, pid N). Press Ctrl-C there to pause." for CLI runs.
  - **Done:** "All N games are engine-checked · X positions stored. Last run …".
  - Starting on battery shows `window.confirm` with the server's message, then retries with `allowBattery`.
- **Sidebar chip** while a run is active: "Engine check 0% · ~61 min" (with "· pausing" while pausing), linking to Home. Its pulse dot respects reduced motion.
- **`WorkspaceProvider`** polls `/api/analysis/status` one request at a time: every 2 s while running or pausing, otherwise every 20 s, so a CLI run shows up. It restarts after a sync (`dataVersion`) and after a start or pause.

### Verify (`scripts/verify/verify-evals.ts [--games N]`)
It is read-only on `storage/chess.db`.
1. It prints coverage (games per colour; positions, cached rows and mean nodes per tier) and the last completed run's throughput (s per game, Mnps).
2. It checks every analysed game of the current config: each move is scored in the store, win% values are finite, and the summary is sane (plies, move counts, losses in [0, 95.1], evalAfter).
3. On a temporary `db.backup()` copy, with the N newest window games (unanalysed ones are backfilled in the copy first):
   - it deletes their rows and re-runs the backfill with an engine pool that throws on any search. All N games must be redone with 0 searches and identical summaries;
   - a second run must analyse 0 games;
   - `cachedGameReview` must return the full review;
   - a config with a changed protocol must re-queue all window games, while the old config's queue and rows stay as they were.

   The copy is deleted afterwards.

### Tests (298 to 321)
- `openingPass.test.ts` (6): positions and tiers; `isAnswered`; the summary (first error, worst, categories, owner-view evalAfter, an unscored move refused); `evaluateOpening` (no search when cached; a new move at a cached position runs only `searchmoves h2h3`); rows only when every position is stored.
- `backfill.test.ts` (7), on the 8 real fixture games with a legal-move fake engine (`test/fakeEngine.ts`):
  - the plan (each key once, merged played sets, the start position in both tiers, limit);
  - a full run (8 games, all MultiPV 3 searches before any MultiPV 1, one main search per position, every move scored, run row) and a second run with 0 games and 0 searches;
  - an interrupted game redone with 0 searches;
  - pause and resume with no position searched twice;
  - newest-first limit;
  - a new engine version re-queues all 8 and keeps the old rows;
  - an engine that crashes on one position fails only the affected games and leaves them queued.
- `backfillLock.test.ts` (4): exclusive acquire and release; progress via the file; takeover of a dead pid or a stale heartbeat; no removal of someone else's lock.
- `power.test.ts` (3) and `backfillMeter.test.ts` (2).
- `routes.test.ts` (+4):
  - status shape; the 409 `on-battery` error, then a run with `allowBattery` to completion;
  - pause, then resume;
  - an instant cached review with 0 searches;
  - an unanalysed game's review writes its row.
- `pool.test.ts` (+1, `onResult` and a throwing consumer), `engineStore.test.ts` (+1, the scored-move merge), `reviewMoves.test.ts` (L evals, the eval after the last move).
- Removed: `fileStore.test.ts` (reviews-v3 path and versioned JSON).

## Sample backfill (real engine, on battery at 60-62% with Low Power Mode on)

| Run | What | Games | Positions searched | Nodes | Wall | Per game | Pool nps |
|---|---|---|---|---|---|---|---|
| #1 | `npm run backfill -- --limit 20 --allow-battery` | 20 | 333 (170 owner + 163 opponent) | 107M | 86 s | **4.3 s** | 1.23M |
| #2 | the same command again | 20 (the *next* 20) | 266 (181 already cached) | 82M | 64 s | **3.2 s** | 1.27M |
| #3 | browser smoke: Start, then Pause | 4 (drained) | 51 | 19M | 21 s | | 0.93M (drain) |

- **The incremental rule held.** Run #2 re-analysed none of run #1's games: the 20 rows from run #1 kept their `analyzed_at`, and no game has two rows.
  - `--limit 20` means "the 20 newest queued games", so the second run moved on to the next 20. It did not do nothing.
  - The literal "second run analyses 0 games" is shown by verify-evals (on a copy) and by the tests.
- The ETA was accurate: planned 81 s against 86 s actual for run #1.
- **Measured cost per position** (stored means): owner **434k** nodes, opponent **189k**. The opponent figure is above the 120k prior because every opponent move ever played from an EPD is scored.
- **`npm run backfill -- --dry-run` after run #2:** 1,340 queued games; 15,801 unique positions, 181 cached; 7,940 owner + 7,680 opponent to search; ~4.90G nodes at the measured 1.27 Mnps = **~64 min on battery with Low Power Mode**. Mains power should take roughly half, **~30-35 min**.
- **The full window from zero** (the first dry-run, before any run): 16,222 positions (8,246 + 7,976), ~66 min at the default speed.
- The newest games' positions include the busiest EPDs (the start position and the first moves, with many played moves each), so the per-position means from this sample probably overstate the full run slightly.
- **The owner should run the full backfill on mains:** `npm run backfill`, or Home → Start engine check. **It was not run here.**
- **DB now:** 44 games analysed under config #1 (22 per colour); 357 owner and 292 opponent position rows; `backfill_runs` rows #1-#3.

## Deviations from the spec, and why

- **SQLite, not JSONL.** Positions and runs live in `storage/chess.db` (the override). The lock is `storage/backfill.lock`, not `storage/cache/positions/backfill.lock`. There is no compaction question: SQLite WAL handles concurrent writers. The read-modify-write race on one row is covered by the lines-equal merge.
- **The opponent's played moves are scored too**, at the same root, not only MultiPV 1. The review annotates every move, and P5 needs opponent errors and missed punishments, so an opponent position without its played move scored would make every review run follow-ups. The cost is part of the measured 189k per opponent position.
- **Every move played from an EPD in the window is merged into one request**, for the owner's and the opponent's positions alike. That is the brief's "per EPD, merge the moves" applied to both tiers.
- **"Eval after ply N" (the summary, and the review's last move) is the played move's score at its root.** The position after ply 20 is never searched. This saves about 1,380 extra searches, and the number comes from the same search as the best move.
- **The review file cache (reviews-v3) is removed.** The spec says to read the position cache first, and the file cache was config-agnostic.
- **AUTO_BACKFILL is opt-in (off by default)**, although P4 said on by default. The brief makes it optional and the Home button required. With it on by default, the first sync would start the hour-long first run on its own (on mains).
- **The paused state lives in server memory.** After a restart the card shows Start again, and the queue is DB-driven, so nothing is lost.
- **The server backfill is not a jobStore job.** It has its own state behind `/api/analysis/status`, which also reports CLI runs through the lock file.
- **No pre-flight calibration or budget tier.** P4a fixed the depths. The estimate uses the last completed run's measured nps (paused runs are excluded, since their drain understates it) and the stored mean nodes.
- **Ordering is newest games first**, as in the brief. The critic's "last 90 days, then n ≥ 2" refinement was not added; newest first already does the last 90 days first.
- **"Positions cached" on Home counts rows that exist.** A row that lacks a move first played after it was written counts as cached, and the game queue picks up the follow-up.
- **The review writes `game_analysis`** when it completes a game (same config, same protocol), so the backfill skips it.
- **A run killed hard (SIGKILL)** leaves its `backfill_runs` row as `running`. The estimate only reads completed runs.

## Check and verify results

- `npm run check`: typecheck (web, server, test) OK, vitest **321/321** (30 files), vite build OK. `tsc --noUnusedLocals` reports only the two pre-existing P3 leftovers in `routes.ts`.
- `npx tsx scripts/verify/verify-evals.ts`: **OK**.
  - Coverage White 20/686 and Black 20/692 (before the browser run).
  - 40 analysed games and 795 moves checked, every one scored in the store.
  - Redo from the cache: 5 games, 0 searched, 0 attempted, 89 cached.
  - Second run: 0 games.
  - Cached review: 20 moves in 115 ms.
  - New config #2 (in the copy): 1,378 of 1,378 window games re-queued; the old config's queue (1,338) and its 40 rows unchanged.
- `verify-import --asof 2026-09-26` **OK** (the known +3), `verify-tree` **OK**, `verify-fixlist` **OK**, `engine-smoke` **OK**.
- **Browser smoke** (`npm run dev`, then stopped):
  - **Home at 1280 px:** the Engine check card sits under the Sync card with "1,338 of 1,378 games not engine-checked yet", **Start engine check (~64 min)** and the battery / Low Power Mode note.
  - **Start:** the server's 409 turned into the confirm "The Mac is on battery (60%), Low Power Mode on. … Start the engine check on battery?". After accepting, the card showed "Engine check: 7 / 7,928 of your positions · then opponent positions · ~61 min left", the bar, "4 / 1,338 games done · 181 positions were already cached · 1.11M nodes/s" and **Pause**. The sidebar showed "Engine check 0% · ~61 min".
  - **Pause:** "Pausing…", then "Paused · 1,334 games still to check" with **Resume**, and the chip disappeared.
  - **Review of the backfilled 184443513568:** `POST /api/game-review` answered **200 with a completed job** and rendered at once. A timed fetch took **82 ms** for 20 moves.
  - **375 px:** no horizontal scroll (scrollWidth 375). The only console error is the expected 409.
  - Afterwards: no vite, tsx, concurrently or Stockfish processes, nothing listening on 3001/5173, no lock file, and the viewport was reset.
- **Owner data.** Only `storage/chess.db` gained rows: positions, 44 game_analysis rows and 3 backfill_runs. `storage/cache` is untouched, including the old `reviews-v3` files.

## Known gaps / notes for P5 and later

- **The full backfill still has to be run by the owner on mains** (~30-35 min expected). `verify-evals` afterwards prints the measured Mnps and the time per game.
- **P5 inputs.**
  - `game_analysis.summary_json` (`GameOpeningSummary`) per game.
  - `positions` rows: the owner's positions hold the top 3 lines plus every owner move ever played, all at one root. The opponent's positions hold the top line plus every opponent move.
  - `lineFor` / `playedLoss` read a move's loss. Engine-hole items can aggregate them per (EPD, move) straight from `positions`, without the games.
- **When a sync brings new games**, the queue grows; Home offers "Analyse N new games", and AUTO_BACKFILL=1 does it by itself on mains.
- **Borderline classes** (P4a note): 2...Bc5 is about 9.5 win% at d15, an inaccuracy. Thresholds near 10 are soft.
- Pause only takes effect between groups (games), so draining can take a few seconds (up to about 20 positions per worker).
- `engineIdName` detection is memoised per server process. If the Stockfish binary is replaced while the server runs, restart the server to pick up the new config.
