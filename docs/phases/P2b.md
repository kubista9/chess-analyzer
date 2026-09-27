# P2b: Pages on the store, keyed jobs, robust polling, Sync card

Branch: `phase/p2b-store-pages-jobs` (from `phase/p2a-sqlite-import` at c74d53a). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| e53db69 | fix(engine): reject pending searches when Stockfish exits or errors |
| 8bb7641 | feat: pages on the SQLite store, keyed jobs and a Sync card |
| 2eaca49 | docs: describe the store-driven pages, the job API and polling |
| (this commit) | docs: add the P2b phase report |

Net diff against P2a: 52 files, +2,039 / -1,199 lines (before this report). About 700 of the added lines are tests.

## What was done

### Jobs (server)
- **`server/store/jobStore.ts`** is rewritten as a keyed store.
  - `startOrReuse(key, type, message, run)`: while a job for the key is queued or running, a second call returns that job (`reused: true`); otherwise it starts `run(reporter)`. The keys are `sync` and `review:<gameId>`.
  - The run is deferred, so the caller always gets the job first. A synchronous throw becomes a failed job, not a crash. Progress is clamped below 100 until completion. A failure records `error` and frees the key for a retry.
  - `completed(...)` records an already-finished job (a review served from the reviews-v2 disk cache).
  - `get(id)` returns `undefined` for an unknown id. It hands out copies.
  - Finished jobs are evicted after 30 minutes (lazy sweep); running jobs are never evicted.
  - `active()` lists queued and running jobs.
- **`JobState`** gains `key`, `createdAt` and `updatedAt`. Its type is `"sync" | "game-review"`.
- **Routes** (`server/routes.ts`, now `createApiRouter(deps)` with an injectable db, job store, clock and sync):
  - `POST /api/sync {full?}` answers 202 with the job. The result is `{summary, status}`, with per-month progress from a new `onProgress` option on `syncArchives`.
  - `POST /api/game-review {gameId}`: 404 when the game is not in the store; a completed job when the review is cached; otherwise a deduped job with per-position progress.
  - `GET /api/jobs/active`; `GET /api/jobs/:id` answers **404** "Unknown job (the server may have restarted). Run it again." instead of 500.
- **`server/app.ts`** builds the Express app, and `index.ts` only listens. `HttpError` maps to its status and a zod error to 400.
- **Stockfish** (`stockfish.ts`, minimal fix): it listens for `error`/`exit` on the process and `error` on stdin. A pending search or a readiness wait rejects with the reason, and later calls fail fast. The constructor takes an optional `{path, args}` (for the tests' fake engines).

### Store API and review
- `GET /api/games?window=6m|3m&tc=blitz|rapid&color=white|black`: every stored game in the window, newest first, no cap.
- `GET /api/games/:id` returns `{game}`, or 404.
- `GET /api/openings/report?window=`: `{window, totals: {white, black}, items}`, results only.
- `listGames` takes an optional `{timeClass, color}` filter. `getGamePgn` is new.
- `shared/window.ts`: `GAME_WINDOWS = {6m: 183, 3m: 90}` days, `DEFAULT_GAME_WINDOW = 6m`, `parseGameWindow`.
- **`buildOpeningReport`** takes `{color, result, openingName}` (GameRecords) and groups by `familyFromOpening(openingName)`.
- **The review** finds its game with `getGame` and replays the full PGN from `games.pgn` (`parseGame(pgn)`). `reviewHeader(GameRecord, owner)` builds the header from the stored record.

### Deleted legacy pipeline
- `server/services/batchAnalysis.ts`, `chessCom.ts` (`fetchRecentGamesWithCacheStatus`, `findGameForUser`, the old zod schema) and `gameSummary.ts`.
- `POST /api/bulk-analysis`, `BULK_ANALYSIS_LIMITS`/`BulkAnalysisLimit`, `SUPPORTED_TIME_CLASSES`, `OpeningsSnapshot`, `HistoryGameSummary` and `ArchiveGame`.
- `countPlies` and `playerColorForGame`, plus `syncOnce` (replaced by the job dedupe).
- `src/components/AnalysisLauncher.tsx`.
- `TimeClass` is now blitz | rapid (`IMPORTED_TIME_CLASSES`), and `ImportedTimeClass` is merged into it.
- The legacy raw-games shape lives on only as `LegacyRawGame` in `rawGamesSeed.ts`, the read-only offline seed.
- The import/status types (`SkipCounts`, `GameCounts`, `SyncSummary`, `MonthSyncResult`, `ImportStatus`, …) and `SKIP_REASONS` moved to `shared/`, so the client can use them.

### Client
- **`shared/jobPolling.ts`** (pure, so vitest covers it; the React hook is a thin wrapper):
  - `pollJob` waits 1.4 s, sends one request, and only then schedules the next. Requests never overlap.
  - It stops on completed/failed, on a **404** (`lost`), after **5 consecutive failures** (`unreachable`; a success resets the count), or on abort.
  - `endedJobState` turns lost/unreachable into a failed job: "Job lost (the server restarted), run again." or "Lost contact with the server (…)".
- **`useJobPolling`** keeps `onUpdate` and the job in refs. Its effect depends on the job id and its active state only, and it aborts on cleanup.
- **`WorkspaceProvider`** owns `status` (GET /api/status), `syncJob`/`startSync` (polled at provider level, so a sync keeps going across pages), a `dataVersion` that is bumped when a sync completes (pages refetch), the shared `gameWindow`, and the review jobs and reviews in memory.
  - The sync job id is persisted in localStorage (`chess-analyst-sync-job`, try/catch, ignored after 30 min).
  - On load, a stored id is fetched: running resumes polling, and a 404 shows "Job lost". Without a stored id, `/api/jobs/active` is checked.
  - The v2 snapshot key (`chess-analyst-workspace-v2`) is removed with the v1 keys. No game data is kept in the browser.
  - A ref guard makes one click send one POST; the server dedupes across tabs.
- **Home / `SyncCard`**:
  - The headline and summary read "1,381 games" and "1,235 blitz / 146 rapid · Mar 28 – Sep 27 · synced just now", with a stale note.
  - It has **Sync** and **Full re-check** buttons and a progress bar.
  - A failure shows "Sync failed: <reason>" and **Retry**. The last sync's warnings are listed.
  - The AppShell footer reads "kubista9 · 1,381 games · synced 1 min ago".
- **Opening Report**:
  - It shows all window games, "As White · 687 games" / "As Black · 694 games", with a 6/3-month toggle.
  - Cards say "N games" rather than "in sample".
  - With about 80 cards, each preview board now mounts on the first hover or focus only.
- **Game History**:
  - It shows every window game from `/api/games`, newest first.
  - Filters: result, colour, a new time class filter (blitz/rapid) and opening or ECO search. The title shows "(N of M)".
  - Bullet and daily are gone from `timeClassMeta`.
  - Rows use `content-visibility: auto`.
- **Review**:
  - It loads the game with `GET /api/games/:id`, so the subtitle shows before the engine finishes and an unknown id shows "Game not found".
  - Auto-start waits for the game and keeps the ref guard. The empty panel shows job progress.
  - A failed or lost job shows its reason and **Retry**.

### Verify
- `scripts/verify/check-report.ts` now reports over the store (`listGames` in the `--asof` window, `--time-class blitz|rapid`). It also checks that each colour's items add up to that colour's games and to `countGames`. `loadRawGames` is removed from `_lib.ts`.

## Deviations from the spec, and why
- **3 months = 90 days.** GLOBAL measures "the last 90 days"; 6 months stays WINDOW_DAYS = 183.
- **Both a persisted job id and `/api/jobs/active`.** P2.md asks for both. The stored id gives "Job lost" after a reload plus a restart. `/active` resumes a sync started in another tab.
- **Cached reviews** return a fresh completed job per request (`completed()`), not a deduped one: they are instant and cost nothing.
- **The CLI `npm run sync` is not a job**, so it can overlap a server sync. WAL and the busy timeout keep that safe (as in P2a).
- **Lazy preview boards and `content-visibility`** were not in the spec. The report went from about 10-20 cards to 79, and the history from 25 rows to 1,381, so these keep the pages responsive. The Opening Report and Game History are deleted in P3b anyway.
- **`gameDerive.test.ts` "400 games" got a 30 s timeout.** It is CPU-bound (1.5 s alone) and hit the 5 s default once with 16 test files in parallel on battery.
- **The report still groups by `familyFromOpening`** of Chess.com's opening name, which yields families like "Queens Gambit Declined 3.cxd5 exd5 4.Nc3 c6" and one "Undefined". P3's EPD tree replaces the grouping.

## Check and acceptance results
- `npm run check`: typecheck (web, server, test) OK, vitest **159/159** (16 files; 127 before), vite build OK. `tsc --noUnusedLocals --noUnusedParameters` is clean on all three configs. The stockfish commit (e53db69) also typechecks and passes on its own.
- New or changed tests:
  - `server/store/jobStore.test.ts`: dedupe (same id, one run), independent keys, a new job after completion, failure with its reason plus a retry, a sync throw, clamped progress, unknown id → undefined, active list, 30-minute eviction without evicting running jobs, copies.
  - `server/routes.test.ts`: a real HTTP server on an in-memory store with the 8 fixture games.
    - Jobs: unknown job → 404; two concurrent `POST /api/sync` → one job, one run, listed as active; a failed sync keeps its reason; a review of an unstored game → 404.
    - Games and report: `/games` 6m = 8 and 3m = 5, newest first, the colour filter, 400 for `window=12m`/`tc=bullet`; `/games/:id` and its 404; per-colour report sums.
  - `shared/jobPolling.test.ts`:
    - completes one request at a time (max in flight = 1), stops on failed;
    - a 404 → lost, stopping immediately;
    - 5 failures → unreachable, with the count reset after a success;
    - abort stops without further updates; the interval is honoured before each request;
    - `abortableSleep`, `endedJobState` and `isNotFoundError`.
  - `server/services/stockfish.test.ts` (fake Node engines): exit during `go` rejects and later calls fail fast; exit before readyok rejects `initialize`; a missing binary rejects; a working engine still returns lines.
  - `shared/window.test.ts` covers `parseGameWindow`. The report, review-header and parser tests now run on GameRecords and PGNs.
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26`: **all invariants OK**. The +3 drift against the golden 1,377 is P2a's explained games played late on 09-26.
- `npx tsx scripts/verify/check-report.ts --asof 2026-09-26`: 1,380 games (1,234 blitz / 146 rapid). As White 687, As Black 693, 79 items; all invariants OK.
- **Browser smoke test** (`npm run dev`, then stopped):
  - **Home**: "1,380 games · 1,234 blitz / 146 rapid · Mar 28 – Sep 27 · synced 22 min ago". localStorage was empty after load (the old snapshot key is gone).
  - **Double-clicked Sync**: exactly one `POST /api/sync` and one job, which completed (the log shows 304s). One new game arrived, so the card then read 1,381 games and "synced just now". Two concurrent `fetch` POSTs from the page got the **same job id**, and the job did 3 requests (list plus 304 for 08 and 09; 03-07 cached-closed).
  - **Opening Report**: As White · 687 games (19 cards, whose counts sum to 687) and As Black · 694 games (60 cards, sum 694), 1,381 in total. The hover preview board works. The 3-month toggle gives 706 games.
  - **Game History**: 1,381 rows, Sep 27 to Mar 28. July has 316 (289 + 27).
  - **Review of July games**: 171795727042 (not cached) ran with visible progress ("Stockfish: position 2 of 21", 9%) and finished ("c4 is good").
  - **Restart mid-review**: during the review of 171795454046, `touch server/index.ts` restarted the server. The poller saw one proxy 500, then a 404, stopped polling, and showed "Opening review failed · Job lost (the server restarted), run again." with Retry. Retry reran the review to completion. No orphaned Stockfish process was left.
  - **Reload with a job id the server no longer knows**: the Sync card showed "Sync failed: Job lost (the server restarted), run again." with Retry, and the stored id was cleared. A Full re-check afterwards (7 × 304) cleared the message.
  - **375 px**: no horizontal scroll on Home or History. The console shows only the expected 500/404s from the restart test.
  - Servers stopped. No vite, tsx, concurrently or Stockfish processes are left, nothing listens on 3001/5173, and the viewport was reset.
- **Owner data.** `storage/cache` is untouched: scans 270, reviews 9, snapshots 6, raw-games unchanged (10:56 mtime). reviews-v2 gained the 2 smoke-test reviews (4 files).

## Known gaps / notes for P3 and later
- `/api/games` sends full GameRecords: about 836 KB of JSON for 1,381 games, with no compression middleware. That is fine on loopback; P3b's Explorer drawer can request slimmer rows.
- P3b deletes the Opening Report and Game History. Review entry moves to the Explorer's games drawer, and `GET /api/games/:id` plus the review page stay.
- Jobs are in memory only. A restart loses them by design, and the client says so.
- The review still uses the interim movetime engine and the reviews-v2 cache. The Stockfish wrapper only has the exit/error fix; P4a replaces it (crash-safe UCI session, pool).
- `WindowToggle` state is per session (not persisted). The report and history share it.
- `familyFromOpening` grouping is crude (see Deviations); P3's tree supersedes it.
- The `npm install` audit findings from P2a were not looked at.
