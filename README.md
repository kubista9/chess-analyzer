# Chess Analyst

Local-first opening analysis for one Chess.com account, `kubista9` (hard-coded as `OWNER_USERNAME` in `shared/constants.ts`). The app imports every standard blitz and rapid game of the last 6 months into a local SQLite store (about 1,380 games) and shows:

- Home: a Sync card with the stored games (`1,380 games · 1,234 blitz / 146 rapid · Mar 28 – Sep 27 · synced 5 min ago`), the Sync button and a Full re-check.
- An Opening Report split into "As White" and "As Black", with W/D/L and score% (a draw counts 0.5) per opening family, over every stored game in the last 6 months (or 3 months). It is built from game results only; no engine runs for it.
- A game list of the same window with opening/ECO search plus result, colour and time-class filters, which links into review
- An opening review of a selected game: Stockfish looks at the first 20 plies (10 moves each). Evals are shown from White's side (`+0.80`, `M3`, `-M3`), and each move is labelled `best`, `good`, `inaccuracy`, `mistake` or `blunder` by the lichess win% it gives away (< 1, < 5, < 10, < 15, >= 15).

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
- `GET /api/games?window=6m|3m&tc=blitz|rapid&color=white|black`: every stored game in the window (6 months by default), newest first, with no cap. `GET /api/games/:id` returns one stored game, or 404.
- `GET /api/openings/report?window=6m|3m`: the results-only report over the window, with the games per colour.
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26` recounts the stored raw months independently and checks the invariants and the golden window numbers (read-only).

The pages read only from the store; the browser keeps no snapshot of games (just the id of a running sync job). `storage/chess.db` is gitignored and can be deleted and re-synced at any time; the app never deletes the caches under `storage/cache`.

## Opening tree and book

Opening names come from the [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) TSVs (CC0), vendored in `data/chess-openings/` at a pinned commit (see `SOURCE.md` there; re-vendor by hand with `node scripts/update-opening-book.mjs [--commit <sha>]`). The server indexes them by EPD once at startup (about 1 s). The dataset is a list of names, not a theory book: it names unsound lines too, so a "named line" is never a quality mark.

The opening tree is built in memory per colour from `game_plies` (the first 20 plies), keyed by EPD, so move orders that transpose land on one node. Each game counts a position once. Every move row carries raw n and W/D/L, the score against the Elo expectation (the owner's pre-game rating, taken from his previous game in the same time class) as a delta in points, a Wilson 95% interval, recency-weighted versions of those with the effective n, a leak z-score, the 90-day trend, the owner's average think time and the book name. Nothing is persisted; trees are memoised per filter set until the stored games change.

- `GET /api/tree?color=white|black&epd=<EPD>&window=6m|3m&tc=blitz|rapid&hl=<days>|off`: one node (the start position by default) with its move rows, newest game ids first. The default half-life is 90 days on the 6-month window and off on the 3-month window. 404 when the games never reached the position.
- `npx tsx scripts/verify/verify-tree.ts --asof 2026-09-26` checks the golden lines, names, effective n, book exit and the counts along every path (read-only).

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

Verify scripts live in `scripts/verify/` and are read-only. They take `--asof YYYY-MM-DD`, meaning the end of that UTC day, inclusive (see `scripts/verify/_lib.ts`). `npx tsx scripts/verify/check-report.ts` prints the per-colour Opening Report over the game store and checks that each colour's items add up to its games (options: `--time-class blitz|rapid`, `--asof`, `--days`; without `--asof` the window ends today).

## Jobs

Syncs and reviews run as in-memory background jobs with a dedupe key (`sync`, `review:<gameId>`): starting a key that is still running joins that job, so a double click or a second tab never starts a second sync or a second Stockfish review. Finished jobs are kept for 30 minutes, then evicted. `GET /api/jobs/:id` answers 404 for an unknown job, and `GET /api/jobs/active` lists the running ones.

The client polls one request at a time (a timeout chain, every 1.4 s) and stops when the job completes or fails, on a 404, or after 5 consecutive errors. After a server restart the job is gone, so the page shows "Job lost (the server restarted), run again." with a Retry instead of polling forever. A failed job shows its reason and a Retry.

## Stockfish

The install script downloads Stockfish automatically into:

```text
storage/engines/stockfish/current/stockfish
```

If the engine process fails to start, exits or errors, the running review fails with that reason instead of hanging.

You can override the binary path with:

```bash
STOCKFISH_PATH=/absolute/path/to/stockfish
```

## Notes on move labels

Centipawn evals are clamped to +/-1000 and mates are kept separately, so a mate counts as a clamped eval of the mating side and a mate-to-mate move costs 0. The loss of a move is the drop in the mover's lichess win% (`shared/eval.ts`); the engine's top move is always `best`. The win% curve was fitted on much stronger players, so read it as the engine's win chance.

Reviews are cached on disk in `storage/cache/reviews-v2/` with a `schemaVersion`; a file with another version is ignored and recomputed. The legacy `storage/cache/reviews/` and `storage/cache/scans/` directories are no longer read or written, and the app never deletes them.

## Tunable environment variables

```bash
PORT=3001
HOST=0.0.0.0 # opt-in LAN exposure; default 127.0.0.1
STOCKFISH_PATH=/absolute/path/to/stockfish
STOCKFISH_THREADS=4
STOCKFISH_HASH_MB=192
REVIEW_MOVE_TIME_MS=360
CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD=1
```

`CHESS_OWNER` overrides the owner on the server side. It exists for tests only; the UI always uses `kubista9`.
