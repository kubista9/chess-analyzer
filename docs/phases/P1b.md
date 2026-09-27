# P1b: Honest interim numbers (results-only report, opening-only review)

Branch: `phase/p1b-honest-interim` (from `phase/p1a-remove-non-opening` at 8d3f859). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| e2b26bb | feat(store): atomic JSON writes and a versioned reviews-v2 cache |
| d974530 | feat: results-only opening report by colour and an opening-only review |
| 0670e1e | test(verify): print the per-colour opening report over the raw cache |
| 4b2975a | docs: describe the results-only report and the opening review |
| (this commit) | docs: add the P1b phase report |

Net diff against P1a: 30 files, +1,307 / -803 lines (about 600 of the added lines are tests).

## What was done

### Opening report and Games (results only, no engine)
- **The bulk run is results-only.** `runBulkAnalysis` still refreshes `storage/cache/raw-games/kubista9.json` from Chess.com (the existing fetcher, unchanged). It then builds `HistoryGameSummary` for each game with `summarizeGame` (`server/services/gameSummary.ts`). No Stockfish runs, and scans are neither read nor written. `scanCachePath`, the engine loop, `buildGameSummary`, `lineGap`, `onlyMove`/sacrifice and MultiPV for the bulk run are gone. A 25-game run now takes about a second.
- **`HistoryGameSummary` lost its engine fields**: `accuracy`, `avgCentipawnLoss`, `categories` and `firstMajorErrorPly`. `moves` (which held plies) is now `plies`.
- **`buildOpeningReport`** (`server/services/openingReport.ts`):
  - Groups by `${color}|${openingFamily}` and returns `OpeningReportItem = {color, openingFamily, games, wins, draws, losses, scorePct}`.
  - `scorePercent = (W + 0.5D) / n * 100`, so a draw is half a point.
  - Sorted White first, then by games (desc), then by name (`localeCompare`), with no `slice(0, 10)` cap.
  - The accuracy, blunder, first-error and recommendation fields are gone.
- **Opening Report page**:
  - "As White" and "As Black" panels show a W/D/L grid and a score% pill.
  - Card key is `${color}-${family}`, preview boards use `boardOrientation={color}`, and the cards have no `tabIndex`.
  - The `'reti'` match is a single entry. Names are NFD-normalised with the accents stripped, so "Réti" also matches.
  - A hovered section is raised (`.opening-section:hover { z-index }`), so the last White card's preview is not hidden under the Black panel.
- **Game History** drops the accuracy cell. The "Moves" column now shows full moves (`ceil(plies / 2)`), not plies. The unused `?autostart=1` query is dropped from the Review link.
- **Home copy** is honest: "Load your 1, 5, 10, or 25 most recent games", "Results only, no engine", with a "Load games" button.

### Review (first 20 plies, interim movetime engine)
- **`OPENING_PLY_LIMIT = 20`** lives in `shared/constants.ts` and is used by both server and client. Following the critic's minor correction, it has no env override, so the two cannot drift.
- **`shared/eval.ts`** (new):
  - `clampCp` clamps to ±1000 (`CP_CLAMP`).
  - `toWhiteEval` converts a side-to-move UCI score to White's view. A mate keeps its own field (+ means White mates), and its cp becomes ±1000 on the mating side.
  - `checkmateEval` scores a mated position as `mate: 0`.
  - `winPercent` is the lichess curve: wp(100) = 59.1, wp(1000) = 97.54.
  - `winPercentLoss` is the drop in the mover's win%, never negative. Mate-to-mate costs 0.
  - `categorizeMove(lossWinPct, isTopMove)`: `best` for the top move or a loss < 1, then `good` < 5, `inaccuracy` < 10, `mistake` < 15, and `blunder` ≥ 15, per GLOBAL.md.
  - `formatEval` gives `+0.80`, `-1.25`, `M3` or `-M3`, and `1-0`/`0-1` at mate.
- **Protocol** (`server/services/reviewAnalysis.ts`):
  - The existing `StockfishSession`/movetime engine is kept. It runs one search per position (MultiPV 2, `REVIEW_MOVE_TIME_MS`, default 360 ms) over the 21 positions from the start to after ply 20.
  - The eval after ply N is therefore, by construction, the eval before ply N+1.
  - Checkmate and stalemate positions are scored without the engine. Stockfish prints no `pv` for them, and the old code silently dropped the mating move.
  - A position with no engine line now fails the review instead of skipping the move.
- **Pure review maths** (`server/services/reviewMoves.ts`):
  - `analysisFromLines` and `terminalAnalysis`.
  - `toReviewLine` turns the UCI PV into SAN.
  - `annotateMoves` does the loss, category and note for each move.
  - `reviewHeader` builds the header.
- **Types:**
  - `AnnotatedMove` gains `whiteCpBefore/After`, `mateBefore/After` and `lossWinPct`, and loses `phase`, `scoreBeforeCp/AfterCp` and `lossCp`.
  - `bestLine` is a `ReviewLine {uci, san, pvSan, whiteCp, mate}`.
  - `MoveCategory` is `best | good | inaccuracy | mistake | blunder`. brilliant/great/miss, their heuristics and `categorizeMove`'s old cp branch are gone.
  - The phase model is gone: `classifyPhase`, `CHESS_PHASES`, `ChessPhase`, `PIECE_VALUES`, `pieceValue`, `ParsedMove.phase/piece/captured`, plus `calculateAccuracy`, `average` and `emptyCategoryCounts`.
- **Notes.** `noteForCategory(category, lossWinPct, isOwnerMove)`. "Engine agrees with your move" appears only on the owner's moves; opponent moves get "Engine agrees with this move." Losses read as "-x% engine win chance", following the GLOBAL domain note. The Best mode's "Your move was already…" is also owner-only.
- **Review UI:**
  - Labels are Best, Good, Inaccuracy, Mistake and Blunder (the good→Excellent and mistake→Inaccuracy mislabels are fixed), and the fake "Book" heuristic is deleted.
  - Evals come from White's side, and the eval bar width is White's win% on a dark track. The old bar was a 50/50 gradient inside a variable-width fill.
  - Black's rail moves read `1... e5`, and the eyebrow reads "Opening review".
- **Slim ReviewSummary** (critic major #1): `{gameId, color, header, moves}`. The header `{url, endTime, timeClass, openingName, result, white, black}` comes from the archive game, with no engine fields. `reviewSchema.gameSummary: z.any()`, the fallback summary builder and the client's `gameSummary` parameter are gone.
  - The review page no longer needs the Games snapshot. It starts the review for the URL's gameId, takes orientation and names from the review, and so works for games outside the 25-game snapshot. This fixes the critic's "no review after the STORAGE_KEY bump" issue.
  - A failed job now shows its error instead of "Preparing" forever.
- **Caches:**
  - Reviews go to `storage/cache/reviews-v2/<owner>/<id>.json` as `{schemaVersion: 2, data}`. A mismatch, an unversioned file or a missing file is a miss.
  - `writeJsonFile` writes a tmp file and renames it into place, and removes the tmp file on failure.
  - The legacy `reviews/` (9 files) and `scans/` (270 files) are never read, written or deleted.
- **Client storage.** `STORAGE_KEY` is `chess-analyst-workspace-v2`. Reviews are kept in memory only, with no localStorage review cache. The v1 keys (`chess-analyst-workspace-v1`, `chess-analyst-reviews-v1`) are removed once on load, and all storage access is in try/catch.
- **Config.** `BATCH_MOVE_TIME_MS`, `BATCH_REPLY_TIME_MS` and `REVIEW_REPLY_TIME_MS` are removed from config, `.env.example` and the README, since nothing uses them any more.

## Deviations from the spec, and why

- **Report scope.** The report covers the bulk run's 1/5/10/25 most recent games, exactly as before, and the Chess.com fetcher and its limits are untouched. The full import and the blitz+rapid and 6-month filters are P2a's importer. The verify script reads the whole raw cache and can apply `--time-class blitz,rapid --asof …`.
- **No scans-v2 and no check-scans.ts.** Per the critic, the scan pipeline is replaced by results-only summaries rather than patched, so there is nothing to version or verify. `check-report.ts` replaces it.
- **One search per position instead of "best at fenBefore + reply at fenAfter".** The engine is still the same movetime engine. This is 21 searches at 360 ms instead of 40 at 360 + 180 ms, and consecutive evals agree by construction, which the "sign never flips" check relies on. P4 replaces the protocol anyway.
- **"Moves" label kept.** P1.md said to relabel it "Length". The caller's P1b brief says "show moves rather than plies", so the column is still labelled "Moves" but now counts moves.
- **No separate Home nav item** (same as P1a). The brand link goes Home.
- **Dev-only double start.** Under React StrictMode the review effect ran twice, so two Stockfish reviews of the same game ran side by side; this was observed in the smoke test. A `useRef` guard now starts each game's review once. Server-side job dedupe is still P2b.
- **localStorage v1 keys are removed.** Per P1.md, "remove the old keys once on load". These are browser keys, not `storage/` caches; the same review data remains on disk in the legacy `reviews/` directory. The Browser pane's v1 keys (30 kB snapshot, 48 kB reviews from the P1a smoke) were removed by this code during the smoke test.

## Check and acceptance results

- `npm run check`: typecheck (3 configs) OK, vitest **75/75** (8 files; 37 before), vite build OK (396 kB JS). `tsc --noUnusedLocals --noUnusedParameters` on web and server is clean.
- New tests:
  - `shared/eval.test.ts`: clampCp, win% reference values, symmetry and clamping, White-view conversion including mates and mate 0, loss (mate-to-mate is 0, a mate blunder is capped at 95.1), the 1/5/10/15 boundaries, top move is best, and formatEval.
  - `server/services/openingReport.test.ts`: score% with draws; the owner's 8 real games split by colour (English only as White, Scandinavian only as Black; English is 0W 1D 3L = 12.5%); W+D+L = n; per-colour totals; one family played with both colours gives two items; deterministic sort with no cap.
  - `server/services/reviewMoves.test.ts`: at most 20 plies; a constant White +0.50 stays +0.50 on both colours' moves; the mover is charged from its own side (3...Qa5 into +4.00 costs 26.8 win%); second-person copy only on the owner's moves; SAN lines; fool's mate (terminal eval, `-M1`, mating move costs 0, 2.g4 is a blunder, |cp| ≤ 1000).
  - `server/store/fileStore.test.ts`: version round-trip, version mismatch is a miss, legacy unversioned file is a miss, atomic write leaves no tmp file, and reviews-v2 path.
- `npx tsx scripts/verify/check-report.ts` over the raw cache (299 games, 2026-03-29 to 2026-09-26): As White 149 games, 75W 7D 67L, score 52.7% (English 121 games, 57W 6D 58L, 49.6%). As Black 150 games, 60W 6D 84L, 42.0% (Scandinavian 37 games, 55.4%; Giuoco Piano 22, 68.2%). 47 items, all invariants OK. With `--time-class blitz,rapid --asof 2026-09-26`: 256 games, 127 as White. English also appears under Black (5 games): that is the opponent opening 1.c4 against the owner, not a colour mix, and within the 25-game app sample English appears only under White.
- `git grep` for `recharts|DashboardSnapshot|brilliant|emptyPhaseMap|classifyPhase|trainingPlan|CATEGORY_COLORS|phaseAccuracy|ChessPhase|CHESS_PHASES|"miss"|accuracy|scanCachePath|REVIEW_STORAGE_KEY` over src, server, shared and scripts finds nothing.
- **Browser smoke test** (`npm run dev`, 1280 px and 375 px):
  - The v1 localStorage keys are gone after the first load.
  - Home loads 25 games (results only, about 1 s).
  - Opening Report shows As White (English 13, 5W 0D 8L, 38%) and As Black (Scandinavian 7, Queens Pawn 4, Kings Fianchetto 1). Preview boards start at a8 as White and at h1 as Black, and the cards have no tabindex.
  - Game History has no accuracy text, and 184405952510 shows 64 moves (127 plies).
  - Review of 184405952510 (owner as Black) has 20 plies with a Black-oriented board. The White-view eval never flips sign between consecutive plies: +0.47, +0.86, +0.75, +0.84, +0.71, +0.72, +0.17, … and 9...e6 is a blunder at +2.55 (-21.2%). Lines are in SAN. A reload is served from the reviews-v2 cache.
  - Review of the miniature 167570851038 (not in the snapshot, so this also checks review without the snapshot): 3...Nf6 is a blunder into `M1`, and 4.Qxf7# is best and shows `1-0`.
  - At 375 px there is no horizontal scroll and no console errors.
  - The servers were stopped afterwards; no vite, tsx or Stockfish processes are left, and the viewport was reset.
- **Owner data.** `scans/kubista9` still holds 270 files (the bulk run wrote none), `reviews/kubista9` 9 and `snapshots` 6. The raw cache is still 299 games (no new games on refresh). New files: `reviews-v2/kubista9/184405952510.json` and `167570851038.json`.

## Known gaps / notes for later phases

- **The owner re-runs "Load games" once** after this update (the v2 key starts empty). It takes seconds and runs no engine. Reviews can be opened directly by URL without it.
- **Movetime noise is visible.** Two runs of the same game differed by a few win% per move (e.g. 1...d5 at 2.6 vs 3.5), and PVs cut off by `stop` can be a single move. P4a's node/depth-matched protocol and position cache replace this.
- **`categorizeMove` uses identity with the top move for `best`.** This follows GLOBAL.md. The overrides' "best by loss < 1-2 win%, not identity" is meant for P4's protocol.
- **Server-side review job dedupe** (two tabs, or double clicks in production) is still P2b.
- **The fetcher is unchanged** (bullet/daily kept, 25-game early exit), so the bulk limit enum stays [1, 5, 10, 25]. That is P2a.
- `stockfish.ts` is untouched (P4a rewrites it). `EngineLine` is now used only as the raw engine type.
- The legacy `storage/cache/{reviews,scans,snapshots}` directories remain for P9's owner-run cleanup.
