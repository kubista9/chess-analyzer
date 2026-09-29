# Chess Analyst

An offline opening trainer for one Chess.com account, `kubista9` (hard-coded as `OWNER_USERNAME` in `shared/constants.ts`). It imports your standard **blitz and rapid** games of the **last 6 months** into a local SQLite file, checks their **first 10 moves** (20 plies) with Stockfish, and turns that into:

- **Leaks**: the moves that cost you points, from results and from the engine;
- **Explorer**: your own opening tree, move by move, with scores against your Elo expectation;
- **Review**: the opening of any one game, with the engine's view of every move;
- **Repertoire**: one written-down move for each of your positions, seeded from your games;
- **Alternatives**: engine-sound moves you could play instead, ranked by how well they fit your games;
- **Train**: two kinds of spaced-repetition drill, your repertoire lines and positions from your games.

Everything runs on your machine. The only network calls are the Chess.com archive sync (and the one-time Stockfish download). Nothing is fetched from Lichess, there is no popularity data from other players, and there is no account.

## First run checklist

1. `npm install` (downloads Stockfish 18 into `storage/engines/`).
2. `npm run sync` (a few seconds to a minute: fetches the last 6 months from Chess.com into `storage/chess.db`).
3. **Plug the laptop in**, then `npm run backfill` (about 30-35 min on mains, about an hour on battery; see [Engine check](#engine-check-the-backfill)).
4. `npm run dev` and open [http://localhost:5173](http://localhost:5173).
5. Repertoire → **Seed from my games**, then accept or change the suggestions that need review.
6. Train → **Start session**. Come back daily; the badge in the sidebar counts what is due.
7. Optional, once: `npm run cleanup` to see what legacy files can go (a dry run; see [Legacy cleanup](#legacy-cleanup)).

## Setup

Requirements: Node.js 22 or newer (better-sqlite3 13 needs it), macOS or Linux. Stockfish is downloaded by `npm install` (the `postinstall` script); `npm run setup:engine` repeats it. The binary lands in `storage/engines/stockfish/current/stockfish`; `STOCKFISH_PATH` points elsewhere.

```bash
npm install
cp .env.example .env   # optional; every variable has a default
npm run dev            # API on http://127.0.0.1:3001, UI on http://localhost:5173 (proxies /api)
```

Production build: `npm run build && npm start` serves the built UI and the API together on `http://127.0.0.1:3001`.

The API listens on loopback only and has no auth. `npm run dev:web -- --host` shows the UI on your LAN (the Vite proxy then forwards `/api` for every LAN client, so only do it on a trusted network). `HOST=0.0.0.0` exposes the API port itself and prints a warning.

## The workflow

### 1. Sync

```bash
npm run sync              # the current and previous month are revalidated; closed months are fetched once
npm run sync -- --full    # also revalidate closed months (in case Chess.com amended one)
npm run sync -- --offline # no network: seed empty months from storage/cache/raw-games
```

Home's **Sync** card does the same as a background job. Requests are serial, 300 ms apart, with a polite User-Agent, and use ETags, so a repeat sync costs almost nothing. Only standard chess is kept: `rules == "chess"`, no custom start position, blitz or rapid. Each skipped game is counted by reason. The 6-month window (183 days, with a 3-month filter) is applied when reading, so older games stay stored.

### 2. Engine check (the backfill)

The engine check scores every position of the first 20 plies of every window game, once. Run it **plugged in**: on mains power the full 6-month window (about 1,380 games, 16k positions) takes about **30-35 minutes**; on battery it takes about an hour, and it asks first.

```bash
npm run backfill -- --dry-run   # queue size, positions to search and the estimated time; searches nothing
npm run backfill                # the full run (Ctrl-C pauses; run it again to resume)
npm run backfill -- --limit 20  # only the 20 newest queued games
npx tsx scripts/verify/verify-evals.ts   # afterwards: coverage, measured Mnps and time per game
```

Home's **Engine check** card starts, pauses and shows the same run ("Start engine check (~N min)", later "Analyse N new games" after a sync). `AUTO_BACKFILL=1` starts it after every server sync, on mains power only. Only one backfill runs at a time (`storage/backfill.lock`), whether started from the server or the CLI.

It is incremental: a game with an analysis row under the current engine config is never analysed again. New games from a sync are queued automatically. A game you open in the review before the backfill reaches it is analysed on the spot (a few seconds).

### 3. Leaks

`/leaks` (top 3 on Home) lists what to fix first, by impact:

- **Results leaks**: your moves that score clearly below your Elo expectation. A move needs at least 8 games, z ≥ 1.64 and a Benjamini-Hochberg discovery at q = 0.2 across all candidates. Lines that are only nominally significant are shown as "worth watching".
- **Theory holes**: moves you played 3+ times that Stockfish refutes (a loss of 7+ win%, or 5+ when the reply is +1 or better for the opponent), whatever the results.
- **Unprepared replies**: opponent moves your repertoire has no answer to and that cost points.

Each card links to the Explorer, to the alternatives and to a drill.

### 4. Explorer

`/explorer`: pick As White or As Black and walk your own games move by move (click or drag on the board, click a row, or use the arrow keys). Positions are keyed by EPD, so transpositions merge. Each move row shows games, W/D/L, score with a 95% interval, the score against your Elo expectation, the 90-day trend, your think time, the book name and the engine's eval and loss. A row is coloured only when the difference clears the noise gate above. Every row opens its games, and each game links to its review and to Chess.com. **Set as my move** writes the move to your repertoire.

### 5. Review

`/review/:gameId` (from the Explorer's games list, a leak card or a drill): the first 10 moves of one game. It opens at your first opening mistake, or at the book exit for a clean game. It shows an eval bar (White's side), the SAN move list with classes, the book exit, and "2...Bc5 is a mistake (−12% win chance). Best was 2...Nc6". Engine lines are steppable chips. **Retry** lets you play your move again from the position before it. Keys: ← → moves, ↑ ↓ previous/next mistake, S/B/R Show/Best/Retry, F flip.

Move classes follow the lichess win% loss against the best move in the same position: `best` < 1, `good` < 5, `inaccuracy` < 10, `mistake` < 15, `blunder` ≥ 15.

### 6. Repertoire

`/repertoire`: one move per position where it is your turn, per colour, up to move 8. **Seed from my games** proposes your most-played move where Stockfish accepts it (loss < 5 win%). An engine hole such as 2...Bc5 is replaced by a sound move you also play, else by the engine's move, and a leaking line with 15+ games (the Albin) gets an engine-sound sibling. Suggestions you have not reviewed are marked. Accept locks a move, and a move you set yourself is never changed by a re-seed. The page shows where your games leave the repertoire (coverage through moves 4 and 6) and exports PGN.

### 7. Alternatives

`/alternatives?color=&moves=&uci=` (from the Explorer, leak cards, the review and the repertoire): for one of your positions, the moves within 5 win% of the engine's best, ranked by fit: moves you already play, named book lines, mainstream book moves, better results, a familiar pawn structure, transpositions into your games, and fewer forcing or only-move lines. Each card has a 6-ply sample line, typical replies and **Set as my move**. "Where the points are lost" splits the questioned move's games by the reply, and "Change earlier" points at an earlier move when the problem starts there. The position is searched once in the deep tier (about 5-10 s the first time, cached after).

### 8. Train

`/train` has two drill kinds with their own colours and wording:

- **Your repertoire line** (blue): a run from move 1 through your repertoire. The opponent's replies are sampled by how often your opponents played them. Only your repertoire move is correct.
- **Position from your game** (amber): the position before a game's first opening error. The engine's best move, any move within 3 win% of it, or a sound repertoire move is accepted. New cards are confirmed by a deep search before they are shown.

One Leitner scheduler for both: lines 1/3/7/16/35/60 days, positions 2/5/14/30/90 days (retired after 3 correct in a row at 21+ days), a wrong answer is due tomorrow, and at most 5 new cards per kind and day. Cards regenerate by themselves after a sync, a backfill or a repertoire edit and keep their schedule.

## Architecture

```text
server/        Express API (routes.ts), SQLite access (db/), engine core (engine/), services/
shared/        pure logic used by both sides: tree, fix list, eval maths, repertoire, alternatives, training/
src/           React UI (pages/, components/, styles/)
scripts/       sync.ts, backfill.ts, clean-legacy-cache.mjs, install-stockfish.mjs, verify/
data/          vendored opening names (lichess-org/chess-openings, CC0)
storage/       chess.db (all app data), engines/ (Stockfish), cache/raw-games (offline seed); gitignored
```

**SQLite** (`storage/chess.db`, better-sqlite3, WAL). Numbered migrations in `server/db/migrations.ts` (`schema_migrations`); a new version only adds migrations.

| Table | Holds |
|---|---|
| `archive_months` | each Chess.com month's raw response with its ETag (re-deriving never needs the network) |
| `games`, `game_plies` | the kept games and their first 30 plies (SAN, UCI, EPD before/after, clocks) |
| `sync_runs` | one row per sync |
| `engine_configs` | one row per (engine version, protocol) |
| `positions` | evals per (EPD, engine config, tier): cp or mate, best move, lines, depth, nodes |
| `game_analysis` | "this game is fully analysed under this config", with its opening summary |
| `backfill_runs` | measured speed of each run, for the next estimate |
| `repertoire_entries` | your repertoire, per colour and EPD |
| `drill_cards`, `drill_reviews`, `drill_meta` | drill cards with their Leitner state, the answer log, the regeneration stamp |

`storage/chess.db` can be deleted and rebuilt with `npm run sync` and `npm run backfill`, but that loses your repertoire and drill history.

**Engine config and the incremental rule.** The engine version (from the UCI `id name` line) and the search protocol (`server/engine/protocol.ts`) form one `engine_configs` row. The work queue is every window game without a `game_analysis` row for the current config, newest first. A new Stockfish binary or a protocol change creates a new config and re-queues the window by itself; the old rows are kept, never mixed in.

**Tiers** (fixed depth, single thread, Hash 64, so results do not depend on machine load):

| Tier | Search | Used for |
|---|---|---|
| `owner` | MultiPV 3, depth 15 | your positions; every move you played there is scored at the same depth (`searchmoves`) |
| `opponent` | MultiPV 1, depth 14 | the opponent's positions (a quicker search, so their classes are approximate) |
| `deep` | MultiPV 4, depth 18, 3M nodes | on demand: the alternatives panel and drill confirmation; not part of the protocol, so it never re-queues games |

The engine pool (`ENGINE_WORKERS` single-thread Stockfish processes) serves interactive work (a review, an alternatives search, a drill check) ahead of the backfill, and restarts a crashed engine once. The server closes its engines on exit.

**Jobs.** Syncs, reviews, alternatives and drill checks are in-memory background jobs with a dedupe key, so a second click or tab joins the running job. The client polls one request at a time. After a server restart a job is gone and the page offers Retry.

## Environment variables

Set them in `.env` (loaded by `server/config.ts` for the server, CLI and verify scripts) or in the shell (the shell wins).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | API port |
| `HOST` | `127.0.0.1` | bind address; `0.0.0.0` opts in to LAN exposure (no auth; prints a warning) |
| `ENGINE_WORKERS` | `3` | single-thread Stockfish workers, 1-8, per process (the server and `npm run backfill` each have their own) |
| `AUTO_BACKFILL` | off | `1` starts the engine check after every server sync, on mains power only |
| `STOCKFISH_PATH` | `storage/engines/stockfish/current/stockfish` | the engine binary |
| `CHESS_COM_USER_AGENT` | `chess-analyst-local/0.1 (...)` | User-Agent of the archive requests |
| `STOCKFISH_RELEASE_TAG`, `STOCKFISH_DOWNLOAD_URL` | `sf_18` | what `npm run setup:engine` downloads |
| `CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD` | unset | `1` skips the download in `npm install` |
| `CHESS_OWNER` | `kubista9` | tests only; the UI always uses kubista9 |

The window (183 days, `shared/window.ts`), the ply limit (20, `OPENING_PLY_LIMIT` in `shared/constants.ts`) and the engine protocol are constants in code, not environment variables.

## Honesty notes

- **No popularity data.** "Mainstream" and "named line" come from the lichess-org/chess-openings name list only (vendored at commit `c67912be58`, CC0; see `data/chess-openings/SOURCE.md`). It names unsound lines too, so a name is never a quality mark, and there are no move frequencies of other players.
- **The engine budget is modest.** Depth 15 for your moves and 14 for the opponent's keeps the full backfill near half an hour. Losses near a class boundary (for example 2...Bc5 at about 9.5-12 win%) can move by a class between runs or depths.
- **Ratings.** Chess.com archives store post-game ratings. The Elo expectation uses your pre-game rating, taken from your previous game in the same time class.
- **Win% is lichess's curve**, fitted on much stronger players; read it as the engine's win chance, not yours.
- **Small samples.** Results claims need 8+ games and pass a multiple-testing gate; engine claims about a set of games need 5+ games with half of them analysed. Until the full backfill has run, many cards say "engine data for X of Y games".

## Legacy cleanup

Earlier versions left caches that the app no longer reads (`storage/cache/scans`, `reviews*`, `snapshots`), about 220 MB of Stockfish installer leftovers in `storage/tmp`, and stale build output in `dist/` (including a stray `dist/storage` copy). The app never deletes them itself.

```bash
npm run cleanup                   # dry run: lists each item with its size; deletes nothing
npm run cleanup -- --yes          # deletes the listed items
npm run cleanup -- --include-raw  # also lists storage/cache/raw-games (the offline seed; kept by default)
```

It uses a fixed allow-list and never touches `storage/chess.db` or `storage/engines`. After it removes `dist/`, run `npm run build` before `npm start` (`npm run dev` does not need it).

## Checks

```bash
npm run check   # typecheck (web, server, test), vitest, vite build
```

The verify scripts in `scripts/verify/` check the real data. They take `--asof YYYY-MM-DD` (the end of that UTC day) and are read-only unless noted:

| Script | Checks |
|---|---|
| `verify-import.ts --asof D` | recounts the stored months independently; the golden window numbers |
| `verify-tree.ts --asof D` | the opening tree: golden lines, names, effective n, path counts |
| `verify-fixlist.ts --asof D` | the fix list against the tree, and its null simulation |
| `verify-analysis.ts --asof D` | engine insights; may store the evals of two target lines |
| `verify-repertoire.ts --asof D` | the repertoire seed, in memory |
| `verify-cards.ts --asof D` | the drill cards, in memory |
| `verify-alternatives.ts --asof D [--cached]` | the alternatives panel; stores deep searches unless `--cached` |
| `verify-evals.ts [--games N]` | backfill coverage and speed, the incremental rule, re-queueing on a new config |
| `engine-smoke.ts [--store]` | the real engine: evals, timings, the pool, a killed engine |

Run them with `npx tsx scripts/verify/<script>`.
