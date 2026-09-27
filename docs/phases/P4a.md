# P4a: Engine core (win% maths, crash-safe UCI session, engine pool, engine store)

Branch: `phase/p4a-engine-core` (from `phase/p3c-home-leaks` at a248d5c). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| 2dd86dc | feat(shared): one-root win% loss and loss-only move classes |
| 0fc93d3 | feat(engine): crash-safe UCI session, fixed-depth protocol and engine pool |
| 6b244ca | feat(review): run the interim review on the engine pool; drop the movetime settings |
| 88d3473 | feat(db): engine configs, position evals and the incremental analysis queue |
| 3495ffd | test(verify): engine-smoke runs the real engine on opening positions |
| c613da0 | docs: describe the engine core, the protocol and the engine store |
| (this commit) | docs: add the P4a phase report |

Each commit typechecks and passes the tests on its own (checked on an exported copy of each tree). The first two keep the P1b helpers under a temporary name until the review switches in the third.

## What was done

### Win% maths and classification (`shared/eval.ts`)
- `EngineScore {cp, mate}` is a raw UCI score from the side to move, with exactly one of the two set.
- `cpEquivalent`: a mate is ±1000 (mate 0 means the side to move is mated, so −1000); cp is clamped to ±1000.
- `winPercent(cp)` is the lichess curve, and `scoreWinPercent(score)` applies it to a raw score.
- `rootMoveLoss(best, played)` = max(0, wp(best) − wp(played)), with both scored at the same root, from the mover's side. Mate to mate costs 0, and the maximum is 95.1.
- `classifyLoss(loss)`: best < 1, good < 5, inaccuracy < 10, mistake < 15, blunder ≥ 15.
  - "best" depends on the loss only, never on being the rank-1 move or `bestmove`.
  - NaN and negative losses throw.
- `isOpeningError` (mistake or worse) and `moveAccuracy` (the lichess per-move formula).
- The White-view display helpers (`toWhiteEval`, `formatEval`, `winPercentFor`) stay where they were.
- Deleted: the P1b two-search `winPercentLoss` and `categorizeMove(loss, isTopMove)`.
- Types (`shared/types.ts`):
  - `EngineTier = owner | opponent`.
  - `EngineLine {uci, cp, mate, winPct, depth, pv ≤ 10}`.
  - `PositionEval {epd, tier, depth, nodes, lines, scored, terminal, bestUci, score}`. `lines` are the MultiPV lines of one completed iteration. `scored` holds played moves outside the lines, scored at the same root.

### Crash-safe UCI session (`server/engine/uci.ts`, `multipv.ts`)
- **Startup.** `UciEngine.start`:
  - `fs.access(X_OK)`, then `uci`. `id name` becomes `idName` ("Stockfish 18"), and `parseEngineId` splits it into Stockfish / 18.
  - `uciok`, then Threads and Hash from the protocol, then `isready`, each with a 15 s handshake timeout.
  - A failed start kills the process.
- **Failures.**
  - A process `error` or `exit`, or a stdin `error`, rejects the pending wait with `EngineCrashedError` and marks the engine dead. Every later call fails fast.
  - A second command while one is running is refused ("busy").
- **Per-search watchdog.** At the timeout the session sends `stop` and waits a grace period (1 s) for `bestmove`. With no `bestmove`, it kills the process.
  - Either way the search rejects with `EngineTimeoutError`. A search cut short is not at the requested depth, so its result is never used.
  - After a `stop` that works, the engine stays usable.
- **Search.**
  - `setoption MultiPV` is sent only when the value changes.
  - `position startpos moves …` carries the game history.
  - `go depth D nodes CAP [searchmoves …]`.
  - `ucinewgame` goes out only through `newGame()`: once per game, never per position.
- **MultiPV parser** (`MultiPvCollector`, pure):
  - It skips `lowerbound` / `upperbound` lines.
  - It ignores exact lines labelled below the deepest depth seen so far. Stockfish prints the not-yet-re-searched ranks with the previous depth's label when a search stops mid-iteration, and those leftovers caused the duplicates.
  - It keeps the latest line per rank within each depth.
  - It returns the deepest iteration where ranks 1..K all completed at the same depth with K distinct moves. K = min(MultiPV, root moves), so a position with 2 legal moves completes with 2.
  - Only when no iteration completed does it fall back to the deepest partial one, deduped and marked `complete: false`.
  - `bestmove` is returned for information only. `bestmove (none)` gives no lines and `bestmove: null`.

### Search protocol (`server/engine/protocol.ts`, `analysePosition.ts`)
- `ENGINE_PROTOCOL`:
  - `{version 1, threads 1, hashMb 64}`;
  - tiers: owner MultiPV 3 at depth 15, opponent MultiPV 1 at depth 14;
  - `searchmoves: "depth-matched"`;
  - `nodeCap 3M`;
  - `pvMaxMoves 10`.
  - Its canonical JSON (keys sorted) is the engine config key.
- `analysePosition(engine, {moves, tier, played?, cached?})`:
  1. It replays the moves with chess.js. Checkmate returns `terminal: checkmate, score {mate: 0}` and stalemate `cp 0`, with no engine call.
  2. Otherwise it runs one MultiPV search at the tier's depth, with the node cap as a guard. With a `cached` eval it skips this search and reuses the cached lines.
  3. Every played move that is legal and not in the lines gets one follow-up: `go depth <depth of the lines> searchmoves <missing…>` with MultiPV = |missing|, on the same root and warm hash. The scores go to `scored`.
  4. A follow-up that fails to score a move throws. So does an empty result for a live position.
- `lineFor` and `playedLoss` read a move's line and its one-root loss.
- `searchTimeoutMs` = 5 s + nodeCap / 50 ms, which is 65 s.

### Engine pool (`server/engine/pool.ts`, `sharedPool.ts`)
- `EnginePool({size, spawn})`:
  - `analyseGame(groupId, requests, {priority, onProgress})`;
  - `analyse(request, priority)`;
  - `stats()`, `engineIdName()`, `close()` and `killAll()`.
- Scheduling:
  - A game (group) stays on one worker, so its positions run in order on one engine with one `ucinewgame`.
  - Interactive groups run before backfill groups.
  - **The queue is checked between positions.** When interactive work waits, a worker on a backfill game hands the rest of that game back to the front of the backfill queue.
  - Engines are spawned lazily, up to `size`.
- Dedupe: identical requests (tier, EPD, played moves) that are queued or running share one search. The exception is an interactive request whose twin is backfill-only: it gets its own task, so it never waits in the backfill queue.
- Crash: when an engine dies, the pool spawns a new one (with `ucinewgame`) and retries the position once. On a second failure the position and the rest of its game reject with the engine's error, and later games are still served.
- `close()` rejects all queued work with `EnginePoolClosedError` and quits every engine.
- `sharedPool.ts`:
  - The process pool uses `ENGINE_WORKERS` (default 3, clamped to 1-8).
  - `installEngineShutdown()`, called from `server/index.ts`, closes the pool on SIGINT/SIGTERM and kills the engines on `exit`.

### Engine store (migration 2; `server/db/engineConfigs.ts`, `positions.ts`, `gameAnalysis.ts`; `server/engine/engineConfig.ts`)
- **`engine_configs`** follows the override exactly. `getOrCreateEngineConfig` runs in an IMMEDIATE transaction and matches on (engine_version, canonical protocol_json). `currentEngineConfig(db, idName)` builds the key from the detected `id name`, `ENGINE_PROTOCOL` and `OPENING_PLY_LIMIT`.
- **`positions`** follows the override exactly, with PK (epd, config_id, tier).
  - `lines_json` = `{lines, scored, terminal}`.
  - `getPositionEval(db, config, epd, tier)` accepts that tier or a higher one, so an owner-tier row answers an opponent-tier request and never the reverse.
  - `putPositionEval` upserts, so newly scored moves upgrade the row in place.
  - `countPositions` counts per tier.
- **`game_analysis`** `(game_id, config_id, plies, analyzed_at, summary_json)`, PK (game_id, config_id). It has **no foreign key to games**: `replaceMonthGames` deletes and re-inserts a month's games on every changed month, and that must not wipe analysis rows (tested).
- **Work queue** (`listAnalysisQueue` / `countAnalysisQueue`) implements the INCREMENTAL RULE:

  ```sql
  games g LEFT JOIN game_analysis a ON a.game_id = g.id AND a.config_id = :current
  WHERE g.username = :owner AND g.end_time >= :windowStart [AND <= :windowEnd]
    AND (a.game_id IS NULL OR a.plies < MIN(:openingPlies, g.ply_count))
  ORDER BY g.end_time DESC
  ```

  - A game already analysed under the config is excluded.
  - A new config (engine version or protocol) re-queues the whole window by itself, and the old rows stay.
  - The `plies` clause is an addition, explained under Deviations.
  - `recordGameAnalysis` and `getGameAnalysis` are here too.

### Settings and the interim review
- **Fixed depth.** `REVIEW_MOVE_TIME_MS`, `STOCKFISH_THREADS` and `STOCKFISH_HASH_MB` are removed from config, `.env.example` and the README. The only new variable is `ENGINE_WORKERS`. Depth, Threads and Hash are part of the protocol, so they are also part of the config key.
- **The review is the thin adapter.** `runGameReview` sends the 21 positions (the start to after ply 20) through the shared pool as one interactive game.
  - `reviewRequests`: the owner's positions use the owner tier and the opponent's the opponent tier, and each position scores its played move.
  - `annotateMoves` now takes `PositionEval[]`. The loss is `rootMoveLoss(lines[0], lineFor(played))`, at the move's own root and depth, and the class is `classifyLoss`.
  - The White-view evals before and after a move are the two positions' own top lines, so the eval bar still never jumps between plies.
  - A move the engine did not score fails the review.
  - The review cache moves to `reviews-v3` (schemaVersion 3), since the numbers now come from a different protocol.
  - Nothing is written to `positions` yet (P4b).
- `server/services/stockfish.ts` and its test are deleted.

### Tests (241 to 298)
- `server/engine/uci.test.ts` (19):
  - `parseInfoLine`;
  - the collector on the recorded transcripts in `test/fixtures/uci-transcripts/`: multi-depth MultiPV 3 with stop-print leftovers, bound lines with repeated moves, duplicate ranks, mate in 1, fewer legal moves than MultiPV, a partial fallback, bestmove (none), PV truncation;
  - command helpers and `parseEngineId`;
  - the fake engine: the exact command log (Threads 1, Hash 64, one `ucinewgame`, MultiPV re-sent only when it changes, `position startpos moves …`, `go depth 15 nodes 3000000 [searchmoves f8c5]`), bestmove (none), a crash mid-search (rejects, then fails fast), a timeout that obeys `stop` (rejects, engine still usable), a hang that ignores `stop` (killed within the timeout plus grace), a missing binary, an exit before uciok, and a busy engine.
- `test/fake-uci.mjs`: a node script that replays transcript files per `go`. Directives: `#sleep`, `#wait-stop`, `#crash n`, `#hang`. `--log` records the commands it receives.
- `server/engine/analysePosition.test.ts` (12):
  - checkmate and Sam Loyd's stalemate without the engine;
  - the exact main request;
  - depth-matched searchmoves: loss 10.96 → mistake with the critic's d16 numbers; the depth follows the lines when the cap cut them short; several missing moves in one search;
  - a cached eval runs only the follow-up, and an owner-tier row answers an opponent-tier request;
  - expectedRanks = legal moves;
  - no line throws; illegal histories;
  - protocol shape and canonical JSON.
- `server/engine/pool.test.ts` (12):
  - one engine and one `ucinewgame` per game;
  - interactive work jumping in between positions of a backfill game (exact execution order);
  - interactive games ahead of queued backfill games;
  - 3 workers, one game per engine;
  - shared start-position dedupe; in-flight dedupe, where interactive does not reuse a backfill twin;
  - respawn and retry after one crash; failure after a second crash, with the game's remaining positions dropped and later games still served;
  - illegal history; close; engine id;
  - a real-process pool against the crashing fake engine, which fails visibly after one respawn with both processes dead.
- `server/db/engineStore.test.ts` (12):
  - config getOrCreate: same key gives the same row; a new version or protocol gives a new row and the old ones stay; key order does not matter;
  - positions: round trip, tier fallback in one direction only, upgrade in place, configs kept apart, terminal rows;
  - work queue: newest first; analysed games excluded; limit; **a new config re-queues all 8 games while the old config stays at 0**; window bounds; short games done at their length; a larger opening window re-queues only the longer games; rows survive a month re-derive.
- Also changed:
  - `shared/eval.test.ts`: cpEquivalent, rootMoveLoss (mate to mate 0, the 95.1 cap), classifyLoss (boundaries, best by loss, NaN), opening errors, accuracy, and the acceptance values wp(0) = 50, wp(100) = 59.1 ± 0.1, wp(1000) = 97.55 ± 0.05;
  - `server/services/reviewMoves.test.ts`, rewritten on PositionEval: requests by tier, best by loss even when rank 1 is another move, one-root charging (3...Qa5 26.8 → blunder), the mate chain;
  - `server/config.test.ts`: ENGINE_WORKERS parsing;
  - `fileStore.test.ts`: reviews-v3.

## Depth choice (measured on the owner's M1, battery, Stockfish 18, Threads 1, Hash 64)

The measurement scripts are in the session scratchpad (`p4a/depthbench.mjs`, `gamebench.mjs`, `oppbench.mjs`). They use a fixed-seed sample from `storage/chess.db`: 8,246 unique owner-to-move and 7,976 opponent-to-move EPDs at ply ≤ 20 in the 6-month window.

| Search | Sample | Mean nodes | p90 | Max | Mean time |
|---|---|---|---|---|---|
| Owner MultiPV 3, **d14** | 40 unique EPDs, cold hash | 262k | 483k | 624k | 444 ms |
| Owner MultiPV 3, **d15** | 40 unique EPDs, cold hash | 392k | 659k | 873k | 644 ms |
| Owner MultiPV 3, **d16** | 40 unique EPDs, cold hash | 568k | 1,018k | 1,196k | 915 ms |
| Owner MultiPV 3, d15 | 6 games in order, warm hash (60 positions) | 349k | | | 568 ms |
| searchmoves, depth-matched d15 | played move outside the top 3: 19/40 unique, 24/60 in games | 89-104k | | | 154-173 ms |
| Opponent MultiPV 1, **d14** | 40 unique EPDs cold / 60 in games warm | 86k / 42k | 155k | 234k | 142 / 68 ms |

**Estimate for the full window at 20 plies:**

8,246 × (349-392k) + 0.45 × 8,246 × (89-104k) + 7,974 × (42-86k) ≈ **3.5-4.3G nodes**.

- At the critic's measured 1.12M nps for 3 workers on battery, that is **52-64 min**. On mains power it is roughly half (about 25-30 min at ~2.4M nps).
- Depth 16 for the owner tier alone (plus its searchmoves) would be about 5.3G nodes, about 80 min, so depth 15 is the deepest owner depth that fits the ~65-minute target.
- The opponent tier stays at depth 14. If P4b also scores the opponent's played moves outside the top 1 (about 75% of those positions, at ~78k nodes each), add about 0.47G, roughly +7 min.

## Real-engine smoke (`npx tsx scripts/verify/engine-smoke.ts --store`, battery)

| Position | Time | Nodes | Result |
|---|---|---|---|
| Start | 283 ms | 186k | +0.45; e4 45, d4 34, Nf3 34 (d15) |
| 1.e4 e5 2.Nf3 Bc5 (White to move) | 595 ms | 388k | **+1.55, Nxe5** (then c3 +0.59, Nc3 +0.43) |
| 1.e4 e5 2.Nf3, played 2...Bc5 | 735 ms | 447k | top 3: Nc6 −45, Nf6 −52, d6 −63; searchmoves Bc5 −152 at d15 → **loss 9.5, inaccuracy** |
| Albin 1.d4 d5 2.c4 e5 (White to move) | 136 ms | 81k | **+0.80, dxe5** (d14) |
| 1.d4 d5 2.c4, played 2...e5 | 597 ms | 380k | top 3: e6 −31, dxc4 −38, c6 −39; e5 −78 → loss 4.3, good |
| 1.c4 d5 2.cxd5 Qxd5 3.Nc3, played 3...Qa5 | 500 ms | 307k | +0.81 for White; Qd6 −81, **Qa5 −82 (rank 2, loss 0.1, best)**, Qd8 −93 |
| 1.f3 e5 2.g4 | 104 ms | 62k | M1 by Qh4#, cp null |
| 1.f3 e5 2.g4 Qh4# | 0 ms | 0 | checkmate, no search |

- One worker, cold hash per position: 2.95 s and 1.85M nodes, 0.63M nps.
- The same 8 positions through a 3-worker pool: 2.1 s. That is too little work to measure pool throughput; the table above is the calibration.
- SIGKILL mid-search: rejects with EngineCrashedError after 307 ms.
- `--store`: engine config #1 (Stockfish 18) was created, and **1,380 window games are queued**.
- The results are deterministic: two runs gave identical nodes and scores.

## Deviations from the spec, and why

- **Depth, not nodes.** The caller's P4a brief asks for fixed depth. The P4 plan text had `go nodes` and ENGINE_NODES_* variables. So there are no ENGINE_NODES_*, no AUTO_BACKFILL (P4b) and no settingsId. The config key is engine_configs (the override).
- **Maths stay in `shared/eval.ts`,** not a new `shared/winPercent.ts`. P1b had already put win% and the categories there, so consolidating meant extending that file, not splitting it.
- **Best threshold = 1 win%.** The brief allows 1-2; GLOBAL and the P4 spec say 1. It is a single constant (`CATEGORY_THRESHOLDS.best`).
- **engine_version** is the `id name` without its first word ("18"), and engine_name is the first word ("Stockfish"), as the column names suggest.
- **Two tiers of one EPD are two rows.** They are not one row "upgraded" from opponent to owner, because the PK includes the tier. A lookup takes the best tier present. "In place" applies within a tier: newly scored moves overwrite the row.
- **`game_analysis.plies` and the plies clause in the queue.** These are an addition to the override's columns. GLOBAL wants raising the opening window to reuse the position cache instead of starting over. Putting the plies into the config key would make it start over. With the clause, a larger window keeps the same config and re-queues only the games it adds plies to. For today's fixed 20-ply window, the query is exactly the override's rule.
- **No foreign key from game_analysis to games** (see above). Otherwise every month re-derive would delete the analysis rows and break the incremental rule.
- **A timed-out search always rejects,** even when `bestmove` arrives after `stop`. The plan returned whatever it had. A cut-short fixed-depth search would be stored as if it were at full depth.
- **The watchdog is 5 s + nodeCap/50 ms (65 s).** The spec's formula depended on the node budget. Depth plus the 3M cap already bound the work, so the watchdog only catches hangs.
- **The review uses the pool now,** with interactive priority, per-root loss and reviews-v3. P4b wires in the position cache. The spec listed the review switch and the reviews-v3 bump under P4b, but the review had to leave the deleted movetime wrapper in this phase.
- **Dedupe key** = tier + EPD + played moves, not EPD alone. Two requests with different played moves need different searchmoves follow-ups. P4b's backfill should merge all the owner's played moves per EPD into one request.
- **`verify-evals.ts` is not built** (it needs the backfill, P4b). **`engine-smoke.ts` expectations are adapted to depth 15:**
  - 2...Bc5 is asserted to lose 8-15 win% (measured 9.5, an *inaccuracy* at d15; the critic measured 9.9-11.5 and 10.96 at d16). The plan's "classifies as a mistake" does not hold at d15.
  - GLOBAL's "1.c4 d5 2.cxd5 Qxd5 3.Nc3: −69 to −83 for White" is the side-to-move (Black) score. White is +0.8, so the smoke checks +0.40..+1.30 for White.
- **The battery warning** is only printed by engine-smoke. The pre-backfill warning (`pmset -g batt`) belongs to P4b's backfill runner.

## Check and verify results

- `npm run check`: typecheck (web, server, test) OK, vitest **298/298** (26 files; P3c had 241), vite build OK.
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26`: **all invariants OK** (the known +3 late games on 09-26).
- `verify-tree.ts --asof 2026-09-26`: **OK**. `verify-fixlist.ts --asof 2026-09-26`: **OK**.
- `npx tsx scripts/verify/engine-smoke.ts [--store]`: **OK** (above).
- **Server smoke** (`PORT=3098 tsx server/index.ts`, API only; no UI changes in this phase):
  - `POST /api/game-review` for 184405952510 (uncached) completed in **~12 s** on battery with one worker, and the progress read "Stockfish: n of 21 positions". The same known blunder shows: 9...e6, loss 19.7.
  - `pkill -9 -f current/stockfish` once during a review: the pool respawned the engine and the review **completed**.
  - `pkill -9` every 0.25 s during a review: the job **failed visibly after 4 s** with "Engine exited unexpectedly (signal SIGKILL)", and no promise hung.
  - SIGTERM to the server during a review left 0 Stockfish processes.
  - `tsx watch server/index.ts` with a review running, then 3 × `touch server/index.ts`: at most 1 engine was alive before each restart and 0 after the restarts.
- No Stockfish, tsx or vite processes are left running.
- **Owner data.**
  - `storage/chess.db` has migration 2 applied and engine config #1 (Stockfish 18), from `engine-smoke --store`. `positions` and `game_analysis` are empty. **No backfill was run.**
  - `storage/cache/reviews-v3/` has the 2 completed reviews from the server smoke (184405952510, 184406246766).
  - The older review/scan caches are untouched.

## Known gaps / notes for P4b

- **Cache wiring.** Look up `getPositionEval(currentConfig, epd, tier)` before each request, passing it as `cached` so that only new played moves are searched. Write `putPositionEval` after each position, and `recordGameAnalysis` (plies = min(20, plyCount)) after a game completes. The review should also read and write the cache.
- **Engine config per run.** `currentEngineConfig(db, await pool.engineIdName())`, and log the config id at startup in both the server and the CLI.
- **Backfill.**
  - Owner positions come first.
  - Merge every move the owner played from an EPD in the window into one request.
  - Skip cached EPDs (and in-flight ones: the pool dedupes identical requests only).
  - Pass B, or opponent searchmoves, only if the budget allows (see the estimate).
  - Keep the process lock, pause/resume and ETA, and warn on battery or Low Power Mode before starting.
- **Budget.** On battery the estimate sits just under the 65-minute target, so the owner should run the full backfill on mains power (about 25-30 min expected). P4b's verify should log nps to confirm.
- **Pool in the CLI.** `npm run backfill` should build its own `EnginePool` with `engineOptions()`. `ENGINE_WORKERS` then applies per process, so the server's pool and the CLI's add up if both run at once.
- **Borderline classes.** 2...Bc5 sits at 9.5 (inaccuracy) at d15 and about 11 (mistake) at d16. Fixed-depth results also depend slightly on hash state (warm vs cold). Fix-list or engine-hole thresholds near 10 should not be treated as sharp.
- **Unrelated, noticed.** `tsc --noUnusedLocals` flags `gamesQuerySchema` and `queryWindow` in `server/routes.ts`, both left over from P3b/P3c. They were already there on phase/p3c-home-leaks, are not part of `npm run check`, and are not touched here.
