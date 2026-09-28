# P2a: SQLite archive import and game store (backend only)

Branch: `phase/p2a-sqlite-import` (from `phase/p1b-honest-interim` at e4b14f6). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| c280673 | build: add better-sqlite3 and the storage/chess.db path |
| 2b3988f | feat(shared): EPD and PGN helpers for archive games |
| 16a8503 | feat(server): derive GameRecords from raw archive months |
| 926752f | feat(db): SQLite game store with numbered migrations |
| 95753ae | feat(server): per-month archive import, GET /api/status and npm run sync |
| b037f15 | test(verify): recount the stored archive months independently |
| 2e70f4e | docs: describe the SQLite game store, sync and status |
| (this commit) | docs: add the P2a phase report |

## What was done

### Storage (SQLite override)
- `better-sqlite3` ^13.0.3 (SQLite 3.53) and `@types/better-sqlite3`. The database is `storage/chess.db` (`config.dbPath`, anchored to the repo root), gitignored together with its `-wal`/`-shm` files.
- **`server/db/`** holds all database access:
  - `connection.ts`: `openDatabase(path, {readonly?})` turns on WAL (file databases), foreign keys and a 5 s busy timeout, then migrates. In read-only mode it opens an existing file with `query_only` and does not migrate. `getDb()`/`closeDb()` manage the app's shared handle.
  - `migrations.ts`: an append-only `MIGRATIONS` list plus `schema_migrations(version, name, applied_at)`. Each migration runs in a transaction, and later phases add entries without editing old ones. Migration 1 creates:
    - `archive_months(username, month, url, etag, last_modified, fetched_at, checked_at, last_status, game_count, raw_json, derive_version, kept_count, skipped_json)`, PK (username, month). `raw_json` is the verbatim month response.
    - `games(id PK, uuid, username, source, url, month, end_time, time_class, time_control, tc_base, tc_inc, rated, color, result, result_code, score, my_rating, opp_rating, opp_name, eco, eco_url, opening_name, termination, ply_count, pgn, derive_version)`. Indices are on (username, end_time), time_class, color and (username, month).
    - `game_plies(game_id, ply, san, uci, epd_before, epd_after, clock_ms, spent_ms)`, PK (game_id, ply), cascade delete, index on epd_before.
    - `sync_runs(id, username, started_at, finished_at, ok, summary_json)`.
  - `archiveMonths.ts`, `games.ts` (`replaceMonthGames`, `countGames`, `listGames`, `getGame`, `getGamePlies`, …) and `syncRuns.ts`.

### Parsing and derivation
- **`shared/epd.ts`**: `toEpd` (first 4 FEN fields), `START_FEN`, `START_EPD`. Following the critic, it is created here and not in P3.
- **`shared/pgn.ts`** (pure, browser-safe):
  - Headers and SAN tokens come from a small tokenizer that skips comments, variations, NAGs, move numbers and results, and attaches each `%clk` to its move. It matches chess.js SAN for SAN on all 8 real fixture games.
  - `parseTimeControl`: `'180'`, `'180+2'` and `'600'`; daily gives null.
  - `spentSeconds` = previous own clock (the base time for a side's first move) − clock + inc, floored at 0.
  - `replayOpening` replays only the first N plies with chess.js `move()`, so it never calls `loadPgn`.
- **`server/services/gameDerive.ts`**:
  - `DERIVE_VERSION = 1`, `DERIVE_PLY_LIMIT = 30`.
  - The zod `rawGameSchema` is loose, with optional `uuid`, `rules` and `initial_setup`.
  - `skipReason` checks, in order: `variant` (rules ≠ chess or a non-standard Variant header), `custom-start` (non-standard initial_setup, SetUp "1" or a FEN header), `time-class` (not blitz/rapid), then `not-owner`.
  - `deriveMonth` also counts `duplicate` (the same id or uuid within the month) and `malformed` (schema failure or an unreplayable PGN). So kept + Σskipped == archive length by construction.
  - The window is not applied at derive time.
- **`GameRecord`** and **`OpeningPly`** live in `shared/types.ts`. `IMPORTED_TIME_CLASSES = ['blitz', 'rapid']` lives in `shared/constants.ts`.
  - Ratings are Chess.com's post-game ratings; the ~8-point difference is ignored and documented on the type.
  - `openingName` comes from the ECOUrl slug, and `eco` from the PGN ECO header.

### Import (`server/services/archiveImport.ts`)
- **Month selection.** The sync GETs `/pub/player/kubista9/games/archives`, then selects the listed months that overlap `now − 183 days` (UTC), oldest first. It never fetches the full history (GLOBAL rejects that). Stored months that leave the window are kept.
- **Requests are serial.** `REQUEST_GAP_MS = 300` separates requests, and each one sends `config.userAgent`.
- **Closed months** are skipped with no request unless `full` is set. `isClosedMonth` = the month is older than the previous month AND it was last validated more than 48 h after the month ended.
- **Other months** are revalidated with `If-None-Match` only; `If-Modified-Since` is never sent. A 304 updates only `checked_at`/`last_status`. A 200 stores the body, the ETag and Last-Modified (kept for reference), and resets derive_version.
- **Errors:**
  - 429: honour Retry-After (seconds or an HTTP date) or wait 60 s, at most 3 tries.
  - 5xx or a network error on a month: keep the stored month and add a warning.
  - A failing archive list means `offline`: the sync warns and seeds from the raw-games cache.
- **`deriveStaleMonths`** re-derives, from `raw_json`, every month with a NULL or old derive_version. No network is needed.
- **Recording and dedupe.** Each run is recorded in `sync_runs`. `syncOnce` joins an in-flight sync within the process.
- **Offline seed** (`rawGamesSeed.ts`). It reads `storage/cache/raw-games/kubista9.json` read-only, and only fills months that have neither an archive row nor games. The rows are marked `source = 'raw-games-seed'`, and the real month replaces them on the next online sync. The file is never written or deleted.

### API and CLI
- **`GET /api/status`** (`importStatus.ts`):
  - `window {days, start, end}`;
  - `counts {total, byTimeClass, byColor, byTimeClassColor, firstEndTime, lastEndTime}` over the window;
  - `storedTotal`;
  - `lastSync {at, ok, offline, requests, durationMs, warnings, months}` and `lastSuccessfulSyncAt`;
  - `stale` (no successful sync in 24 h);
  - `seededMonths`;
  - per-month rows `{archiveGames, kept, skipped{reason: n}, stored{timeClass: n}, lastStatus, fetchedAt, checkedAt, deriveVersion}`.
- **`POST /api/sync`** (`{full?: boolean}`) runs the sync and answers `{summary, status}`. A concurrent request joins the running sync.
- **`npm run sync`** (`scripts/sync.ts`) takes `--full` (revalidate closed months) and `--offline` (seed and re-derive only). It prints a per-month table and the window line, and exits 1 on warnings.
- The legacy `/api/bulk-analysis`, `/api/game-review` and every page are unchanged.

### Verify
- `scripts/verify/_lib.ts` gains `openStoreReadonly()` and `loadArchiveMonths(db)`, the critic's loader, which reads `archive_months` instead of JSON files.
- `scripts/verify/verify-import.ts --asof YYYY-MM-DD [--days N]` is read-only. It re-implements the filter independently of gameDerive and asserts:
  - per month: raw length == game_count == kept + Σskipped (both the recount and the stored counters). The stored skip reasons equal the recount, and the rows in `games` equal kept.
  - no duplicate uuids across months or in `games`, only blitz/rapid in `games`, and no orphan plies.
  - no month gaps: every calendar month the window touches is stored, unless the last listing shows Chess.com has no archive for it.
  - the window counts from `games` equal the independent recount.
  - for `--asof 2026-09-26`: the golden comparison, a drift of no more than 25, and exactly 3 variant games in 2026-03..09.

## Deviations from the spec, and why
- **No 'too-short' (plyCount < 4) filter.** OVERRIDES.md lists the filter as rules == chess, no SetUp/FEN, and blitz/rapid, and it wins over P2.md. The golden 1,377 also includes one 3-ply game (169123094904, opponent resigned). `ply_count` is stored, so a later phase can exclude short games from statistics if wanted.
- **Two extra skip reasons, `duplicate` and `malformed`.** They are needed for kept + Σskipped == archive length (the fixture's exact duplicate). The fixture then keeps 3 of 7: variant 1, time-class 2, duplicate 1.
- **"Closed" uses the last validation time** (`checked_at`, set by both 200 and 304), not `fetchedAt`. With fetchedAt, a previous month whose last 200 came before its end + 48 h would be revalidated with a 304 forever after it ages out; a 304 confirms the body just as well.
- **SQLite instead of `storage/cache/archives/*.json` and `games-v1/*.json`** (storage override). The derived rows are re-derived when a month's body changes (200) or DERIVE_VERSION changes.
- **`POST /api/sync` is a plain request that returns the summary**, with in-process joining, not a jobStore job. It takes ~10 s for the first sync and ~1-2 s afterwards. Job dedupe and keys, the 404 and polling belong to P2b.
- **Left for P2b**, because the unchanged UI still needs them: `fetchRecentGamesWithCacheStatus`/`findGameForUser`, `SUPPORTED_TIME_CLASSES` (still including bullet and daily for the legacy pages), batchAnalysis and OpeningsSnapshot. `/api/games` and `/api/games/:id` are also P2b; `db/games.ts` already has `listGames`/`getGame`/`getGamePlies`.
- **Derive cost.** A full derive of the 7 months (1,564 raw entries, 1,422 kept) takes ~9 s, almost all of it chess.js `move(SAN)` over 30 plies (~0.23 ms per ply). It runs once per changed month or DERIVE_VERSION bump, so an unchanged sync derives nothing.

## Check and acceptance results
- `npm run check`: typecheck (3 configs) OK, vitest **127/127** (12 files; 75 before), vite build OK. `tsc --noUnusedLocals --noUnusedParameters` on the server and test configs is clean.
- New tests:
  - `shared/pgn.test.ts`: EPD; headers; TimeControl 180 / 180+2 / 600 / daily; %clk; tokenizer vs chess.js on the 8 real games; clock deltas including the first move, increments, the floor at 0 and missing clocks; epd[0] = the start position; EPD chaining; en passant only when legal; an illegal move throws.
  - `server/services/gameDerive.test.ts`: archive-sample keeps 3 of 7 with the exact reason counts; " KuBista9 " resolves to Black; SetUp/FEN is a custom start; chess960 counts as variant; not-owner never guesses; real games (ply counts, score, 30 plies, clocks, ECO/name); malformed PGN; a 400-game month is kept in full; no window at derive time; UTC month.
  - `server/db/db.test.ts`: migrations idempotent; tables; WAL on a file; read-only rejects writes and a missing file; 200/304/reset on archive months; GameRecord and plies round-trip; month replacement (seed to archive, plies cascade); inclusive window counts; sync runs.
  - `server/services/archiveImport.test.ts` (fetch is a `vi.fn` fake api.chess.com):
    - month selection, the closed rule and Retry-After parsing;
    - the first sync (serial requests, a 300 ms gap, UA, no If-Modified-Since, ETags stored, 3 of 7 kept per month);
    - the second sync: exactly the list request plus If-None-Match for 2026-08/09, which get 304s; closed months are skipped;
    - a new ETag re-derives; a full re-check; a 429 with Retry-After 2 s, then 200;
    - three 429s with no Retry-After: two 60 s waits, then a warning, and the sync continues;
    - a 5xx keeps the month; offline seeding, replaced by a later online sync;
    - months that left the window are kept; re-derive with no network; the status output; syncOnce joins.
- **Real sync** (api.chess.com, serial):
  - The first `npm run sync` made 8 requests (list + 2026-03..09, all 200) in 10.5 s: 84 / 149 / 275 / 326 / 324 / 173 / 233 games.
  - The second made 3 requests in 1.0 s: 03-07 were skipped as closed, and 08 and 09 returned **304 not modified** in the log.
  - Two concurrent `POST /api/sync` calls returned the same run (the same startedAt), again 3 requests with 304s.
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26`: **all invariants OK**. Window 2026-03-27T23:59:59Z .. 2026-09-26T23:59:59Z: **1,380 games (1,234 blitz / 146 rapid; 687 White / 693 Black)**. July has 289 + 27 and August 163 + 8 (both exactly golden). There are 3 variant games, no bullet, daily or duplicate games, and no month gaps.
  - **Drift +3 vs the golden 1,377 / 1,231 / 685, explained.** The plan's snapshot of 2026-09 ends at 2026-09-26T14:03:56Z. The owner then played 3 more blitz games that day: 184423304962 (20:37Z, White), 184423442016 (20:45Z, Black) and 184426022102 (22:04Z, White). Hence +3 total, +3 blitz, +2 White and +1 Black. Months 03-08 are identical to the snapshot, uuid for uuid.
  - The current window (asof now, 2026-09-27) also has 1,380 / 1,234 / 146 / 687, matching GLOBAL's live measurement.
- **Server smoke** (`tsx server/index.ts`): `GET /api/status` returned the counts above, `stale: false`, and per-month skip reasons. The legacy `POST /api/bulk-analysis {limit: 1}` still completes. The offline path was checked on an in-memory database with a failing fetch: it warns and seeds 2026-03/04/05/06/09 from the real raw-games cache (256 blitz+rapid games). The server was stopped afterwards; no tsx, vite or Stockfish processes are left.
- **Owner data.**
  - `storage/cache` is untouched by the new code. The legacy bulk smoke rewrote `raw-games/kubista9.json` with the same 299 games (a new createdAt).
  - `scans/kubista9` still holds 270 files, `reviews` 9, `reviews-v2` 2 and `snapshots` 6.
  - `storage/chess.db` is new (~23 MB: raw month bodies ~5.8 MB, PGNs ~3.9 MB, 41,755 ply rows).

## Known gaps / notes for P2b and later
- Point the pages at the store (`/api/games?window=&tc=&color=`, `/api/games/:id`, the report over GameRecords, the Sync card from `/api/status`). Then delete the bulk pipeline, `fetchRecentGamesWithCacheStatus`, `findGameForUser` and `OpeningsSnapshot`, and shrink `SUPPORTED_TIME_CLASSES` to `IMPORTED_TIME_CLASSES`.
- Make the sync a deduped job (`startOrReuse('sync')`) with progress. It is synchronous now, with in-process joining only; a CLI sync and a server sync can overlap, and WAL plus the busy timeout make that safe but wasteful.
- Review should load the game through `getGame` and the PGN from `games.pgn` instead of the raw-games cache.
- `game_plies` holds 30 plies; OPENING_PLY_LIMIT (20) readers should take `ply <= 20`. If P3's tree wants a different EPD normalisation, it needs a DERIVE_VERSION bump (then re-derive, with no network).
- Chess.com amending an old month (fair play) is only noticed with `npm run sync -- --full` / `{full: true}`.
- `npm install` reports 13 npm audit findings in the dependency tree (not investigated in this phase).
