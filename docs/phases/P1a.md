# P1a: Remove the non-opening code, hard-code the owner

Branch: `phase/p1a-remove-non-opening` (from `phase/p0-safety-tooling` at 8494356). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| 2fd92bf | refactor(web): remove the Dashboard and Game Plan pages and recharts |
| e60f4dc | style: remove dashboard, game-plan and already-unused CSS |
| ddda113 | refactor(server): rename trainingPlan.ts to openingReport.ts |
| faf3c38 | refactor: delete the whole-game metrics, dead types and dead exports |
| caf9b70 | feat: hard-code the owner kubista9; colour resolution never defaults |
| 91c4301 | docs: describe the app as openings-only for kubista9 |
| 24c37e2 | test: use neutral opponent names in the colour-resolution test |
| (this commit) | docs: add the P1a phase report |

Net diff against P0: 29 files, +250 / -2,066 lines.

## What was done

- **Pages.** `DashboardPage.tsx` and `TrainingPlanPage.tsx` are deleted. `/dashboard` and `/training` redirect to `/openings`. The nav is now Game History and Opening Report, and the brand link goes Home. The mobile drawer logic is unchanged, and the unused lucide icons (`ChartColumnBig`, `Target`) are dropped. Game History stays because it is the only entry to review until P3b. Its empty-state copy no longer points at the deleted dashboard.
- **recharts** is uninstalled. The web JS bundle is now 396 kB (gzip 123 kB), and vite's chunk-size warning is gone.
- **CSS** (`src/styles.css`, 2,052 to 1,655 lines). The audit's DASHBOARD-ONLY, TRAINING-PLAN-ONLY and ALREADY-UNUSED blocks are removed, including their copies in the 1180/760/520 `@media` blocks. Grouped selectors were edited in place: `.panel-summary`, `.focus-card`, `.move-detail`, `.schedule-*`, `.secondary-button`, `.job-inline`, `.pill`/`.detail-pill`/`.focus-target`, `.summary-top` and `.practice-card-header`. The GAME-HISTORY-ONLY blocks stay with their page. Afterwards, a class-usage script over `src/**/*.tsx` flags only dynamically built classes that are in use (`game-row-*`, `history-result-*`, `time-class-*`, `review-board-color-*`, `*-active`, `mobile-menu-open`).
- **trainingPlan.ts to openingReport.ts.** The first commit is a pure `git mv`, so `git log --follow` works. The next commit trims the file to `buildOpeningReport` plus its `averageForCategory`/`winRate` helpers. `buildMetricCards`, `buildTrainingPlan` (including the unrendered weeklySchedule), `buildHighlights` and the practice-drill builders are gone. `buildOpeningReport` itself is unchanged; P1b rewrites it.
- **Types** (`shared/types.ts`):
  - `DashboardSnapshot` is now `OpeningsSnapshot {username, analyzedAt, limit, games, topOpenings}`.
  - `MetricCard`, `TrendPoint`, `TrainingFocusArea`, `TrainingSession`, `PracticeGameRecommendation`, `PracticeDrill`, `TrainingPlan` and `ReviewSideSummary` are deleted.
  - `HistoryGameSummary` loses `phaseAccuracy`, `phaseSignals`, `criticalMoments` and `winProbabilitySwing`.
  - `ReviewSummary` loses `white`, `black` and `keyThemes`, so it is now `{game, moves}`.
  - `AnnotatedMove` loses `alternativeLines`.
  - The client read none of these fields once the two pages were gone.
- **Server trims:**
  - `batchAnalysis.ts` loses the write-only snapshot cache (`snapshotCachePath` and its write), the phase maps and swings (so the `emptyPhaseMap` shared-array bug is gone), `scanOrLoadGameSummary` (dead), `buildSideSummary`, `buildKeyThemes` and the re-exports (`noteForCategory`, `buildGameSummary`). `avgCentipawnLoss` averages the same losses as before; with the shared-array bug, the old three-phase flatten averaged one array three times, which gives the same mean.
  - `reviewAnalysis.ts` imports `noteForCategory` from `shared/notes.js`. Its fallback summary builder drops the phase fields and uses `emptyCategoryCounts()` instead of a literal category object.
  - `chessCom.ts` loses `openingFromPgn`, the always-absent `opening` schema field, `fetchRecentGames` (inlined into `findGameForUser`, with identical behaviour) and its own `resolvePlayerColor`.
  - `routes.ts` derives the bulk `limit` enum from `BULK_ANALYSIS_LIMITS` (`z.literal([...])`, zod 4; checked that 25 passes, and 7 and "5" fail).
- **Shared helpers.** From `shared/chess.ts`, `emptyPhaseMap`, `signalFromAccuracy`, `formatPercentage` and `scoreToWinProbability` are deleted. `pieceValue` moves there on top of `PIECE_VALUES`, replacing the duplicate switch in `gameParser.ts` (same values). From `shared/constants.ts`, `CATEGORY_COLORS` is deleted. From `src/utils/formatters.ts`, the unused `formatDate` and `categoryLabel` are deleted.
- **Owner hard-coded:**
  - `OWNER_USERNAME = "kubista9"` lives in `shared/constants.ts`. `config.owner = (process.env.CHESS_OWNER ?? OWNER_USERNAME).trim().toLowerCase()`; the env var is for tests only and documented in the README. `scripts/verify/_lib.ts` `OWNER` now reads `config.owner`.
  - The username input and the `e.g. hikaru` placeholder are removed. The launcher shows "Chess.com player: kubista9", and the footer shows `kubista9 · N games`, or just `kubista9` before any run.
  - `POST /api/bulk-analysis {limit}` and `POST /api/game-review {gameId, gameSummary?}` no longer take a username. zod strips a stray `username` from an old client, so such requests still work.
  - `runBulkAnalysis(limit, onProgress)`, `runGameReview(gameId, fallback)` and `readCachedGameReview(gameId)` use `config.owner`.
  - A stored localStorage snapshot whose `username` is not the owner is ignored.
- **Colour resolution never falls back to black.** One `resolvePlayerColor(owner, white, black)` in `shared/chess.ts` compares trimmed, lower-cased names and returns `PlayerColor | null`. It replaces the chessCom copy and `playerColorForGame`'s old `white ? "white" : "black"` default. `playerColorForGame` now returns `PlayerColor | null`.
  - Bulk analysis resolves colours before any engine work. It skips each unresolvable game with a `console.warn`, says so in the job's progress message ("Skipped N game(s) kubista9 did not play."), and throws if no game is left. `buildGameSummary` now receives the resolved colour.
  - Review throws `Game <id> was not played by kubista9, so it cannot be reviewed from their side.`
  - Tests: `' Kubista9 '` resolves correctly on both colours, unknown or near-miss names (`kubista`, `kubista99`) and a blank owner return null, and the synthetic month's padded `" KuBista9 "` game resolves. The real fixture resolves with `" Kubista9 "`, and an absent player returns null. That is 37 tests in total, up from 33.
- **Docs.** The README intro and the `index.html` meta description now describe an openings-only app for kubista9.

## Deviations from the spec, and why

- **brilliant/great are not dropped (left for P1b).** They cannot be removed cleanly yet: the 9 cached reviews on disk (`storage/cache/reviews/kubista9`) and the localStorage review cache hold moves with `category: "brilliant" | "great"`. `GameReviewPage` looks labels up with `reviewCopy[move.category]`, so a cached review would crash on `undefined.tone` once the keys are gone. The clean fix needs the `reviews-v2` cache versioning and the STORAGE_KEY bump, and both belong to P1b. So `categorizeMove`'s brilliant/great branch, `lineGap`, `onlyMove`/`isSacrificeLike`, `ParsedMove.piece/captured`, `pieceValue` and bulk MultiPV 3 all stay for now, and P1b removes them together with the category rename (best/good/inaccuracy/mistake/blunder).
- **Phase model kept.** `classifyPhase`, `PIECE_VALUES`, `CHESS_PHASES`, `ChessPhase`, `ParsedMove.phase` and `AnnotatedMove.phase` stay, because the review page's "Book" heuristic reads `move.phase`. Deleting it is a visible review change, and it is listed under P1b's review tasks. Only the phase *maps* (the whole-game metrics) are gone.
- **Left for P1b because they change behaviour.** P1a's rule is "no behaviour change beyond the removed nav/username box", so these stay:
  - The Game History accuracy cell and the 'Moves' label.
  - The Opening Report accuracy/blunders/recommendation fields, its `tabIndex`, the missing `boardOrientation` and the duplicate `'reti'` match.
  - `reviewSchema.gameSummary` and `ReviewSummary.game`, with its fallback builder (the critic's slim ReviewSummary).
  - Review MultiPV 4.
  - `STORAGE_KEY`/`REVIEW_STORAGE_KEY`.
  - `OPENING_PLY_LIMIT`, clamping and the White-view eval.
- **Nav.** The nav has no separate "Home" item, which P1's final nav (Home, Opening Report, Games) would add. P1a only removes items; the brand link already goes Home.
- **`stockfish.ts` untouched.** The inventory lists its unused `searchMoves` option as dead code, but P4a's protocol needs `searchmoves`, and P4a rewrites the UCI session anyway. The per-position `ucinewgame` and the MultiPV re-send are performance changes, not deletions.
- **`ArchiveGame.openingUrl`** still holds the ECO URL, as the inventory says to keep it.

## Check and acceptance results

- `npm run check`: typecheck (3 configs) OK, vitest 37/37 passed, vite build OK.
- `tsc --noUnusedLocals --noUnusedParameters` on the web and server configs: clean, so no unused imports are left behind.
- `git grep -nE` over `src server shared scripts test package.json index.html README.md` for every removed symbol finds nothing. The symbols checked were `recharts|DashboardSnapshot|emptyPhaseMap|trainingPlan|CATEGORY_COLORS|buildMetricCards|buildTrainingPlan|buildHighlights|buildSideSummary|buildKeyThemes|scanOrLoadGameSummary|signalFromAccuracy|formatPercentage|scoreToWinProbability|phaseAccuracy|phaseSignals|criticalMoments|winProbabilitySwing|ReviewSideSummary|MetricCard|TrendPoint|TrainingPlan|PracticeDrill|PracticeGameRecommendation|TrainingFocusArea|TrainingSession|alternativeLines|keyThemes|snapshotCachePath|openingFromPgn|fetchRecentGames\(|formatDate|categoryLabel|DashboardPage|TrainingPlanPage|hikaru|ChartColumnBig`. (P1's full acceptance grep also lists `brilliant`, which remains by design until P1b.)
- **Browser smoke test** (`npm run dev`, 1280 px and 375 px):
  - `/dashboard` and `/training` land on `/openings`. The nav shows Game History and Opening Report, and the footer shows `kubista9 · 25 games`.
  - Opening Report and Game History render the stored pre-P1a (v1-shaped) snapshot, and the CSS is intact, including the opening preview popover on focus.
  - Review of 184406246766 loads from the localStorage cache and, with that cache cleared, from the server (`POST /api/game-review` → 200, no username in the body).
  - Home (no username box, "Chess.com player: kubista9") starts a 1-game bulk analysis. It completes, and the resulting snapshot has exactly the OpeningsSnapshot keys, with `color: "white"` for 184426022102. Opening Report and Game History render it.
  - The mobile drawer opens at 375 px, and the console shows no errors.
  - The pane's original localStorage snapshot and reviews were restored afterwards. The servers are stopped, and no Stockfish, Vite or tsx processes are left.
- **Side effects of the smoke run** (the owner's data was added to, never deleted). The bulk run fetched from Chess.com: "found 3 new stored game(s)" in `storage/cache/raw-games/kubista9.json`. It also wrote **one new legacy scan**, `storage/cache/scans/kubista9/184426022102.json`, so that directory now holds **270** files, not 269. Reviews are still at 9. `storage/cache/snapshots` still holds 6 files, because the snapshot is no longer written.

## Known gaps / notes for P1b

- P1b's acceptance line "scans/kubista9 still holds exactly 269 files after a bulk run" must use 270 as the baseline, or better, count before and after its own run.
- brilliant/great, `miss`, the new `inaccuracy`, the Book heuristic, the phase model, `pieceValue`/`piece`/`captured`, `lineGap` and MultiPV all go together with `reviews-v2` and the STORAGE_KEY bump. After that, `PIECE_VALUES`/`classifyPhase`/`CHESS_PHASES` can go too, if the ply window replaces the phase.
- `ReviewSummary.game` and `reviewSchema.gameSummary: z.any()` are still in place (the critic's slim ReviewSummary is P1b).
- The per-colour report, W/D/L and score%, and results-only summaries from raw games (replacing the engine scan) are not started.
- The client uses `OWNER_USERNAME` directly. If a test sets `CHESS_OWNER`, only the server changes, which is fine for tests but worth knowing.
