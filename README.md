# Chess Analyst

Local-first opening analysis for one Chess.com account, `kubista9` (hard-coded as `OWNER_USERNAME` in `shared/constants.ts`). The app imports every standard blitz and rapid game of the last 6 months into a local SQLite store (about 1,380 games) and shows:

- Home: a Sync card with the stored games (`1,380 games · 1,234 blitz / 146 rapid · Mar 28 – Sep 27 · synced 5 min ago`), the Sync button and a Full re-check; the top 3 "Biggest leaks" from the fix list (below); and a repertoire snapshot per colour (`vs 1.e4: 1...d5 55% (223) mostly lately · 1...e5 39% (216) rarely played lately`), each move linking into the Explorer.
- Leaks (`/leaks`): the whole results-only fix list, a "worth watching" list and how the list is made.
- An Explorer (`/explorer`): pick As White or As Black, then walk the opening move by move on a board (click or drag a move, click a row, or use the arrow keys). Each position shows its book name and ECO, and each move row shows raw n with its share (and the effective n when recent games count more), W/D/L, the score with a 95% interval whisker, the score against the Elo expectation, the 90-day trend, your average think time and the book name or "out of book". A row is coloured as below or above expectation only when the difference clears the noise gate (see below). Each row opens a games drawer that links every game to its review and to Chess.com. It is built from game results only; no engine runs for it.
- An opening review of a selected game: Stockfish looks at the first 20 plies (10 moves each) at a fixed depth. Evals are shown from White's side (`+0.80`, `M3`, `-M3`), and each move is labelled `best`, `good`, `inaccuracy`, `mistake` or `blunder` by the lichess win% it gives away against the best move in the same position (< 1, < 5, < 10, < 15, >= 15).

## Stack

- React + TypeScript + Vite
- Express + TypeScript API server
- Stockfish 18 downloaded into the repo during `npm install`
- SQLite game store in `storage/chess.db` (better-sqlite3, WAL), plus the file-based cache under `storage/cache`

## Run locally

```bash
npm install
npm run dev
```

Frontend: [http://localhost:5173](http://localhost:5173)

The backend API runs on `http://127.0.0.1:3001` and Vite proxies `/api` requests automatically. The API listens on loopback only by default; it has no auth.

`.env` in the repo root is loaded by `server/config.ts`, so the server, CLI and verify scripts all see it. Variables already set in the shell win. See `.env.example`.

### Testing from a phone on the LAN

```bash
npm run dev:web -- --host
```

Vite then serves the UI on your LAN IP, and the API itself stays bound to 127.0.0.1. Note that the Vite proxy forwards `/api/*` for every LAN client, so anyone on the network can use the API through Vite while `--host` is on (including endpoints that start long engine jobs). Only use it on a network you trust, and stop it when done.

To expose the API port itself (not recommended), opt in explicitly:

```bash
HOST=0.0.0.0 npm run dev:server   # prints: API exposed on LAN; no auth
```

## Game store (SQLite)

```bash
npm run sync              # fetch kubista9's Chess.com archive months into storage/chess.db
npm run sync -- --full    # also revalidate closed months (in case Chess.com amended them)
npm run sync -- --offline # no network: seed empty months from storage/cache/raw-games
```

The sync lists the archives, then requests the months that overlap the last 183 days, one at a time with a 300 ms gap and the configured User-Agent. Each month's raw response is kept in `archive_months` with its ETag, so re-deriving never needs the network. A closed month (older than the previous month, validated more than 48 h after it ended) is fetched once; the current and previous months are revalidated with `If-None-Match` (a 304 costs nothing). On a 429 the sync waits for `Retry-After` (or 60 s), at most 3 tries; on a 5xx or a network error it keeps the stored month and reports a warning.

Only standard games are imported: `rules == "chess"`, no `SetUp`/`FEN` start position, and time class blitz or rapid. Each skipped game is counted under one reason (variant, custom-start, time-class, not-owner, duplicate, malformed), so kept + skipped always equals the month's archive length. Kept games go to `games`, and their first 30 plies (SAN, UCI, EPD before/after, clock, time spent) go to `game_plies`. The 6-month window is applied when querying, not when fetching or deriving. Ratings are Chess.com's post-game ratings.

- `GET /api/status`: window counts by time class and colour, the date range, the last sync, a stale flag (no successful sync in 24 h) and per-month rows with skip reasons and the last HTTP status.
- `POST /api/sync` (`{"full": true}` optional): starts the sync as a background job keyed `sync` and answers 202 with the job. A second request while it runs gets the same job. The completed job's result is `{summary, status}`.
- `GET /api/games/:id` returns one stored game, or 404.
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26` recounts the stored raw months independently and checks the invariants and the golden window numbers (read-only).

The pages read only from the store; the browser keeps no snapshot of games (just the id of a running sync job and the Explorer's filters). `storage/chess.db` is gitignored and can be deleted and re-synced at any time; the app never deletes the caches under `storage/cache`.

## Opening tree and book

Opening names come from the [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) TSVs (CC0), vendored in `data/chess-openings/` at a pinned commit (see `SOURCE.md` there; re-vendor by hand with `node scripts/update-opening-book.mjs [--commit <sha>]`). The server indexes them by EPD once at startup (about 1 s). The dataset is a list of names, not a theory book: it names unsound lines too, so a "named line" is never a quality mark.

The opening tree is built in memory per colour from `game_plies` (the first 20 plies), keyed by EPD, so move orders that transpose land on one node. Each game counts a position once. Every move row carries raw n and W/D/L, the score against the Elo expectation (the owner's pre-game rating, taken from his previous game in the same time class) as a delta in points, a Wilson 95% interval, recency-weighted versions of those with the effective n, a leak z-score, the 90-day trend, the owner's average think time and the book name. Nothing is persisted; trees are memoised per filter set until the stored games change.

The Explorer colours a row only when it has at least 8 raw games and an effective n of at least 8, |z| >= 1.64, and it survives Benjamini-Hochberg at q = 0.2 across the rows of its table (`shared/moveSignals.ts`). A plain "n >= 8 and z >= 1" gate flags about as many lines on simulated no-leak data as on the real games. Rows under 8 games are greyed as low sample; the trend arrow needs 8 games on each side of the 90-day split.

- `GET /api/tree?color=white|black&moves=<uci,uci,...>|epd=<EPD>&window=6m|3m&tc=blitz|rapid&hl=<days>|off`: one node (the start position by default) with its move rows, and with `moves=` the breadcrumbs of the path (each step's SAN, n and name). Rows carry no game ids. The default half-life is 90 days on the 6-month window and off on the 3-month window. 404 when the games never reached the position.
- `GET /api/tree/games?<the same filters>&uci=<move>&page=N&size=20`: the games that played `uci` from that node, newest first, 20 per page, with opponent, ratings, result, date, time control, the Chess.com URL and the ply of the move (the drawer links to `/review/:id?ply=N`).
- `npx tsx scripts/verify/verify-tree.ts --asof 2026-09-26` checks the golden lines, names, effective n, book exit and the counts along every path (read-only).

## Fix list

`shared/fixList.ts` lists the owner's moves that lose points against his Elo expectation, from results (the leaks), and the moves the engine refutes (theory holes):

- Candidates are the owner's own moves in both colours' trees (the first 20 plies) with at least 8 raw games and an effective n of 8.
- A candidate is a leak when z >= 1.64 and it is a Benjamini-Hochberg discovery at q = 0.2 across the whole candidate set (one-sided p). Nominally significant lines that fail BH are a separate "watch" list; on simulated no-leak results about as many lines land there as on the real games.
- Blame attribution runs bottom-up: a game counted for an emitted deeper move no longer counts for the moves before it, so a line and its continuation are never listed for the same points. A shorter line is still listed when its residual has 8 games, loses at least 1 weighted point and has z >= 1.
- Items are ranked by those recency-weighted points lost and carry the CI, the expectation and delta, the 90-day trend, the share of games lost by move 20 and up to 3 recent losing games.

- **Theory holes** (`kind: "engine-hole"`): an owner move played at least 3 times that loses at least 7 win% against the engine's best at its root, or at least 5 when the opponent's best reply is then +100 cp or more for him. They are listed whatever the results (2...Bc5 after 1.e4 e5 2.Nf3 scores 47% but loses about 12 win% to 3.Nxe5) and sit outside the BH family. Impact = recency-weighted games x loss / 100, the points the move itself gives away.
- Leaks and holes are merged by impact (a leak's impact is its points lost); /leaks shows the first 10 and "Show all". Leak cards also carry engine facts about their games (the mean eval at move 10, the share with a first mistake by move 10, the most common first mistake and the engine's move there), shown only with enough coverage.

- `GET /api/fixlist?window=6m|3m&tc=blitz|rapid&hl=<days>|off`: `{tested, significant, items (leaks and holes by impact), holes, watch, engine (coverage and first-mistake shares per colour), cap, thresholds, games, ...}`.
- `GET /api/snapshot?<the same filters>`: per colour, the opponent's main moves at his first decision and the owner's answers with score, n, trend and a usage hint.
- `npx tsx scripts/verify/verify-fixlist.ts --asof 2026-09-26 [--sims 200]` checks the items against the tree and re-runs the null simulation (every result redrawn at its Elo expectation): the plan's gate emits about 11-13 lines on no-leak data, the fix list about 0.15.

## Production build

```bash
npm run build
npm start
```

## Checks

```bash
npm run typecheck   # web, server and test tsconfigs
npm test            # vitest (shared/ and server/ tests)
npm run check       # typecheck, then test, then build:web
```

`npm run build` also runs the typecheck first, because `vite build` does not type-check `src/`.

Verify scripts live in `scripts/verify/` and are read-only (except `verify-analysis.ts`, which may store the evals of two targeted lines). They take `--asof YYYY-MM-DD`, meaning the end of that UTC day, inclusive (see `scripts/verify/_lib.ts`). `verify-import.ts` recounts the stored months, `verify-tree.ts` checks the opening tree's golden numbers and path counts, and `verify-fixlist.ts` checks the fix list and its null simulation, and `verify-analysis.ts` the engine insights. `engine-smoke.ts` and `verify-evals.ts` (below) are the opt-in real-engine checks.

## Jobs

Syncs and reviews run as in-memory background jobs with a dedupe key (`sync`, `review:<gameId>`): starting a key that is still running joins that job, so a double click or a second tab never starts a second sync or a second Stockfish review. Finished jobs are kept for 30 minutes, then evicted. `GET /api/jobs/:id` answers 404 for an unknown job, and `GET /api/jobs/active` lists the running ones.

The client polls one request at a time (a timeout chain, every 1.4 s) and stops when the job completes or fails, on a 404, or after 5 consecutive errors. After a server restart the job is gone, so the page shows "Job lost (the server restarted), run again." with a Retry instead of polling forever. A failed job shows its reason and a Retry.

## Stockfish

The install script downloads Stockfish automatically into:

```text
storage/engines/stockfish/current/stockfish
```

You can override the binary path with:

```bash
STOCKFISH_PATH=/absolute/path/to/stockfish
```

### Engine core (`server/engine/`)

- **Protocol** (`protocol.ts`): fixed depth, single thread, Hash 64. The owner's positions get MultiPV 3 at depth 15, the opponent's MultiPV 1 at depth 14. A move played from a position but outside its lines is scored with `go depth <depth of the lines> searchmoves <move>` on the same root and warm hash, so the best and the played move always come from one root at one depth. A 3M-node cap guards against pathological positions. The depth was chosen from measurements on the owner's M1 so that the full 6-month backfill (about 16k positions) takes about an hour on battery, roughly half that on mains power (see `docs/phases/P4a.md`).
- **UCI session** (`uci.ts`): reads the engine version from `id name`; any process error, exit or stdin error rejects the pending search and marks the engine dead; each search has a watchdog (`stop`, a grace period, then kill). MultiPV is only re-sent when it changes, and `ucinewgame` is sent once per game, never per position.
- **MultiPV parser** (`multipv.ts`): skips lowerbound/upperbound lines and returns the deepest iteration in which all ranks completed at the same depth with distinct moves, ignoring the previous-depth leftovers Stockfish prints when a search stops mid-iteration. `bestmove` is informational only.
- **Checkmate and stalemate** are resolved with chess.js without searching (mate 0 / cp 0).
- **Pool** (`pool.ts`): `ENGINE_WORKERS` (default 3) single-thread workers. Work comes in games; a worker keeps a game on one engine. Interactive work (the review) runs before backfill work and is checked between positions. A crashed engine is respawned and the position retried once; a second failure fails the job with the engine's error. The server closes the engines on SIGINT/SIGTERM, so `tsx watch` restarts leave none behind.
- **Store** (`server/db/engineConfigs.ts`, `positions.ts`, `gameAnalysis.ts`): `engine_configs` has one row per (engine version, protocol); `positions` holds the evals per (EPD, config, tier); `game_analysis` marks a game as fully analysed under a config. The analysis work queue is every window game without a `game_analysis` row for the current config, newest first, so a game is never analysed twice under one config, and a new engine or protocol re-queues the window automatically (old rows are kept).

### Engine check (backfill)

`npm run backfill` analyses the openings (the first 20 plies) of every window game that has no `game_analysis` row under the current engine config, newest first. It runs outside `tsx watch`, so code edits do not restart it.

- **Positions.** Each (tier, EPD) of the queued games is searched once, with every move ever played from it in a window game scored at the same root, so later games reaching it are already answered. The position cache is read before each search and every result is stored as it arrives. The owner-to-move positions (MultiPV 3, depth 15) come first, then the opponent-to-move ones (MultiPV 1, depth 14). A game's row, with its summary (first owner error, worst move, accuracy, category counts, evals after plies 12/16/20 from the owner's side), is written once all its positions are answered.
- **Resumable.** Ctrl-C pauses (the games in progress finish; a second Ctrl-C stops at once). An interrupted game has no row and is simply redone from the cache on the next run.
- **Flags.** `--limit N` (the N newest queued games), `--dry-run` (queue size, positions to search, estimated time; nothing is searched), `--allow-battery` (it otherwise asks before running on battery, from `pmset -g batt`).
- **One at a time.** `storage/backfill.lock` holds the running process's pid and progress (a lock whose pid is gone or whose heartbeat is older than 2 min is taken over). The server refuses to start while the CLI runs, and shows the CLI's progress on Home.
- **Speed.** Every run is recorded in `backfill_runs`; the next estimate uses the last completed run's measured nodes per second and the stored mean nodes per position.

Home has an **Engine check** card: coverage per colour, "Start engine check (~N min)" / "Analyse N new games", and while it runs "Engine check: X / Y of your positions · then opponent positions · ~N min left [Pause]", with a chip in the sidebar. `AUTO_BACKFILL=1` also starts it after every server sync (on mains power only).

- `GET /api/analysis/status`: engine and config, state (`idle`, `running`, `pausing`, `paused`, `failed`), who runs it (server or CLI), progress with nps and ETA, games analysed per colour, window positions cached per tier, the estimate for the queue, the power state.
- `POST /api/analysis/backfill` (`{"allowBattery": true}` optional): starts or resumes it; 409 with `code: "on-battery"` on battery, or `code: "locked"` while another process runs it.
- `POST /api/analysis/pause`: the games in progress finish, the rest stays queued. The paused state lives in memory; after a restart the card offers Start again.

The review reads every position from the cache first and only sends the rest to the engine pool (interactive priority, ahead of the backfill), storing what it computes; a backfilled game's review opens at once. A review that completes a game also writes its `game_analysis` row.

`npx tsx scripts/verify/verify-evals.ts [--games N]` reports coverage and the measured throughput, checks every analysed game against the store, and on a temporary copy of the database checks cache hits (a sample redone with an engine that may not search), the incremental rule (a second run analyses 0 games), a cached review and the re-queueing under a new engine config.

`npx tsx scripts/verify/engine-smoke.ts [--store]` runs the real engine on a few opening positions, prints timings, checks the evals, runs them through the pool and kills an engine mid-search. With `--store` it also creates the current engine config in `storage/chess.db` and prints the work-queue size. It never runs the backfill.

### Engine insights (from the position cache)

Nothing new is stored: `shared/openingAnalysis.ts` derives each game's opening analysis from the cached positions and its plies (the owner's moves with best move, loss and class, the first mistake, opponent errors and missed punishments, the owner's eval after plies 10/16/20, the book exit, think time). A position the cache cannot answer is `pending`, never a number. `server/services/analysisIndex.ts` keeps the current config's positions in memory, reloading only rows written since the last load, and memoises the analyses by the cache generation, so the numbers follow a running backfill.

- `GET /api/tree` rows carry `engine`: the eval after the move from White's side (M# for mates), and for the owner's moves the win% loss, the class and the engine-best star (loss < 1). The node carries its eval, the engine's move (a blue arrow on the board at the owner's positions), the owner's first-mistake hotspot over his next 3 moves ("your first mistake comes within 3 moves in 41% of games · usually 6...Bc5 (best 6...Nf6)"), the mean eval at move 10, and `engine: {complete, games}` for "engine data for X of Y games".
- Claims about a set of games (hotspots, mistake rates, mean evals) need at least 5 games and half of them known (`ENGINE_MIN_GAMES`, `ENGINE_MIN_COVERAGE`); a rate only counts games where every owner move of its span is scored.
- `npm run backfill -- --line e2e4,e7e5,g1f3,f8c5 --color black` checks one line only: every position along it, with every move the colour's window games played there. No game is marked analysed.
- `npx tsx scripts/verify/verify-analysis.ts --asof 2026-09-26` prints coverage, the class distribution, the most frequent mistakes and the first-mistake shares per colour, and asserts 2...Bc5 (loss >= 8, best Nc6/Nf6/d6, reply 3.Nxe5) and the Albin. When those two lines are not cached it checks just them with one engine (seconds, stored in the cache). `verify-fixlist.ts` then prints the ranked v1 list with the gates each item passed.

## Notes on move labels

Centipawn evals are clamped to +/-1000 and mates are kept separately, so a mate counts as a clamped eval of the mating side and a mate-to-mate move costs 0. The loss of a move is the drop in the mover's lichess win% between the best line and the played move, both scored in the position before the move (`shared/eval.ts`). The class depends on that loss only: `best` < 1, `good` < 5, `inaccuracy` < 10, `mistake` < 15, `blunder` >= 15. Whether the move was the engine's rank-1 move does not matter, since near-equal moves swap ranks between runs. The win% curve was fitted on much stronger players, so read it as the engine's win chance.

Reviews are built from the position cache (`positions` in `storage/chess.db`) under the current engine config, so a new engine or protocol never serves old numbers. The older `storage/cache/reviews*/` and `storage/cache/scans/` directories are no longer read or written, and the app never deletes them.

## Tunable environment variables

```bash
PORT=3001
HOST=0.0.0.0 # opt-in LAN exposure; default 127.0.0.1
STOCKFISH_PATH=/absolute/path/to/stockfish
ENGINE_WORKERS=3 # single-thread Stockfish workers, 1-8 (per process: the server and npm run backfill each)
AUTO_BACKFILL=1 # analyse new games after each server sync (mains power only); off by default
CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD=1
```

`CHESS_OWNER` overrides the owner on the server side. It exists for tests only; the UI always uses `kubista9`.
