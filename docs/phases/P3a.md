# P3a: Opening book, statistics, EPD opening tree and GET /api/tree (no UI)

Branch: `phase/p3a-opening-tree` (from `phase/p2b-store-pages-jobs` at d9d4536). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| 7083521 | chore(data): vendor the lichess chess-openings TSVs (CC0) at c67912be58 |
| 549ccef | feat(shared): Wilson, Elo expectation, recency weights, ESS and leak z |
| 6bef8b7 | feat: EPD-keyed opening book index over the vendored TSVs |
| bffdf43 | feat(shared): per-colour opening tree keyed by EPD |
| aa80da5 | feat(server): treeService over the store and GET /api/tree |
| b6af97a | test(verify): verify-tree asserts the golden tree numbers and path counts |
| a159d0f | perf(server): index the opening book at startup |
| e83393d | docs: describe the opening book, the tree and GET /api/tree |
| (this commit) | docs: add the P3a phase report |

## What was done

### Vendored book
- `data/chess-openings/{a,b,c,d,e}.tsv` and the upstream `COPYING.txt` (CC0-1.0) come from lichess-org/chess-openings at commit `c67912be58` (2026-09-20). They are byte-identical to the plan's probe copies: 3,815 rows plus 5 headers, 388,668 bytes.
- `SOURCE.md` records the commit, the licence, the sha256 of each file, and the note that the dataset names unsound lines as well.
- `scripts/update-opening-book.mjs [--commit <sha>]` re-downloads the files from raw.githubusercontent.com. It checks the headers and prints checksums. It is run by hand only.

### `shared/openingBook.ts` (pure) and `server/services/openingBook.ts`
- `parseBookTsv` and `bookSans` read the files.
- `buildBook(rows)` → `{rows, positions, named, children, lineCount}`:
  - `positions`: 7,864 EPDs, the start position included.
  - `named`: 3,815 EPDs. When two lines end on one position, the shortest line names it.
  - `children`: book moves out of a position, as SAN, UCI and target EPD.
  - `lineCount`: how many lines pass through a position.
  - Rows share prefixes, so a move-prefix cache replays each new move only once. The build takes about 1.2 s.
- `bookChildren`, `nameAt(epds)` (the deepest named position), `openingFamily(name)` (the part before ':') and `bookExit(epdsAfter, color)` → `{lastBookPly, exitBy: owner | opponent | null}`.
- `server/services/openingBook.ts` loads `config.openingBookDir` (new; `data/chess-openings`, anchored to the repo root). `getOpeningBook()` memoises the book, and `server/index.ts` warms it right after listen.

### `shared/stats.ts`
- `wilson(p, n, z = 1.96)`, `eloExpected(me, opp)`.
- `recencyWeight(ageDays, H = 60 | null)`. A null half-life means unweighted, and a future game counts as age 0.
- `ageDays`, `effectiveN` (Kish (Σw)²/Σw²), `LOW_SAMPLE_N = 8`, `isLowSample`.
- `ScoreAccumulator` with `addGame(w, s, E)` keeps Σw, Σw², Σws, ΣwE and Σw²E(1−E).
- `summarize` → `{wN, ess, score, expected, delta, deltaPts = Σw(s−E), ci (Wilson on score and ESS), z}`.
- `leakZ` = Σw(E−s)/sqrt(Σw²E(1−E)), using per-game variances as the critic asked. Positive means below expectation.

### `shared/openingTree.ts`
- `buildTree(games, {color, now, halfLifeDays, maxPly = OPENING_PLY_LIMIT, book})` returns `{color, now, halfLifeDays, maxPly, games, nodes: Map<epd, TreeNode>, repetitionStops}`.
  - It works from the stored plies' EPDs, with no replay.
  - Only games of `color` are used.
  - The root always exists, so an empty filter still has a start node.
- **TreeNode**: `epd, ply` (fewest plies to reach it), `ownerToMove, n, ended, wN, ess, name, eco, nameExact, inBook, edges`.
  - Edges are sorted by n, then weighted n, then SAN.
  - `name` is the position's own book name. If the position has none, it is the deepest name the games passed on the way there (the most common one when move orders differ), with `nameExact: false`.
- **TreeEdge**: `san, uci, toEpd, owner, n, wins, draws, losses`.
  - `raw` and `weighted` are ScoreSummaries (score, expected, delta, deltaPts, CI, z, wN, ess). With no half-life, `weighted` is `raw`.
  - `lowSample`.
  - `trend {days: 90, recentN, recentScore, olderN, olderScore}`.
  - `thinkTime {n, avgMs, avgShareOfBase}`, for owner moves only, from `game_plies.spent_ms`.
  - `name/eco/nameExact/inBook` of the position the move reaches.
  - `gameIds`, newest first.
- **Repetitions.** Each game counts a position once. The walk stops at the first move that returns to a position the game has already visited. So these always hold exactly:
  - node n = Σ incoming edge n (the root: games);
  - node n = Σ outgoing edge n + ended.
- `treeGameFrom(record, plies, myRating)`, `nodeByMoves(tree, ucis)`, and `preGameRatings(games)`, which gives the previous post-game rating in the same time class. A time class's first stored game keeps its own rating.

### `server/services/treeService.ts` and the API
- **Loading.** `loadTreeGames(db, owner, bounds, {color, timeClass}, ratings = "pre-game")` loads everything in one query each for games, plies (`listOpeningPlies`, ply ≤ 20) and rating history (`listRatingHistory`). It lives in `server/db/games.ts`, together with `gamesStamp`.
- **Memoising.** `createTreeService({db, owner, book})` memoises by (color, window, tc, half-life), with at most 16 entries.
  - An entry is rebuilt when `gamesStamp` changes (game count, max rowid, max end_time and finished sync runs), so a server or CLI sync invalidates it without an explicit hook. It is also rebuilt after 10 minutes, so the window keeps moving.
- **Route.** `GET /api/tree?color=white|black&epd=&window=6m|3m&tc=blitz|rapid&hl=<days>|off` answers `TreeResponse {window, color, timeClass, halfLifeDays, maxPly, games, node}`.
  - `epd` defaults to the start position.
  - 400 for a missing or invalid color, EPD, hl or window; 404 when the games never reached the EPD.
  - `ApiDeps` gains `book`.
- **Kept working.** The name-based report (`/api/openings/report`, `familyFromOpening`, `OpeningReportItem`) is unchanged; P3b replaces it.

## Deviations from the spec, and why
- **Default half-life per window: 90 days on 6m, off on 3m.** GLOBAL and the task list say H = 60. The P3 critic correction (which overrides the plan) says a 60-day half-life inside a 90-day window discounts twice, and asks for H = 90 on 6 months and none on 3 months.
  - The primitive's default stays 60 (`DEFAULT_HALF_LIFE_DAYS`), and `?hl=60` gives the GLOBAL view.
  - verify-tree checks ESS at H = 60 (the golden), and prints the service's default view.
- **Pre-game ratings for the Elo expectation** (critic correction). The service rates the owner by his previous post-game rating in the same time class and keeps the opponent's rating as it is.
  - The plan's golden deltas were measured with post-game ratings, so verify-tree asserts them in `post-game` mode and prints the pre-game delta next to them.
  - As the critic predicted, this moves 1.e4 e5 from −20.7 to −21.2 and 1.c4 c5 from −8.2 to −8.4.
- **Golden numbers on the plan's snapshot, plus the full day.** The plan's archives end at 2026-09-26T14:03:56Z, and the owner played 3 more blitz games that evening (the same ones P2a found). verify-tree asserts the goldens with the window ending at that last snapshot game, where they match **exactly**. It prints the whole `--asof` day next to them and lists the 3 games:
  - 184423304962 (W, 1.c4 e5 …, loss): 1.c4 goes to 687 at 54.6%;
  - 184423442016 (B, Scandinavian main line, win): 1.e4 d5 goes to 223 at 54.9%, Δ +10.3;
  - 184426022102 (W, 1.c4 g6, loss).
  - Every other golden line is unchanged on the full day.
- **Repetitions stop the game's walk.** The spec only says "a per-game visited set counts repeated positions once". Stopping at the repeating move keeps both count identities exact. It happens in 0 of the 1,380 window games within 20 plies.
- **Not built** (not in P3a's scope, or left to later phases):
  - edge `earlyLoss` and fix-list fields (P3c);
  - `/api/tree/node?moves=`, breadcrumbs and `/api/tree/games` (P3b; `nodeByMoves` exists for them);
  - deleting `familyFromOpening` (P3b, together with the report);
  - storing raw `spentFrac[]` per edge (the average and the share of base time are kept instead).
- **The book is built from the TSVs at startup** (about 1.2 s) rather than from a precomputed index, as the spec says ("memoised at startup, 1-3 s").

## Check and verify results
- `npm run check`: typecheck (web, server, test) OK, vitest **212/212** (21 files; 159 before), vite build OK. `--noUnusedLocals --noUnusedParameters` is clean on all three configs.
- New tests:
  - `shared/stats.test.ts` (15):
    - Wilson: the textbook values, the golden [34, 46], edges, n = 0, fractional n;
    - Elo expectation;
    - half-life halving, unweighted, future games, a bad half-life;
    - Kish ESS;
    - weighted summaries;
    - z with per-game variances;
    - low sample.
  - `shared/openingBook.test.ts` (12), on a mini TSV:
    - positions and names;
    - the shortest line wins a shared position;
    - an en-passant EPD (`… w KQkq d6` only when the capture is legal);
    - children with UCI; line counts; an illegal move throws;
    - nameAt, family and bookExit.
  - `server/services/openingBook.test.ts` (5), on the vendored book:
    - the pinned sizes 3,815 / 7,864 / 3,815;
    - B01 Scandinavian Main Line, D08 Albin, C40 Busch-Gass, D00 Accelerated London, A30 Symmetrical;
    - the Albin reached through 1.c4 e5 2.d4 d5;
    - the Latvian and the Damiano are named;
    - the book replies to 1.e4.
  - `shared/openingTree.test.ts` (12):
    - **the fixture pair 174004846670 / 174085063610 meets on one node at ply 8 with n = 2**; the ply-7 nodes stay apart, and the two incoming edges have one game each;
    - the plan's synthetic English transposition (1.c4 e5 2.Nc3 Nc6 3.g3 Nf6 4.Bg2 d6 vs 1.c4 d6 …) lands on one node with n = 3;
    - counts, W/D/L and colours;
    - path identities on a small DAG, including 1.Nf3 d5 2.d4 = 1.d4 d5 2.Nf3;
    - the repetition stop; maxPly;
    - fixed `now` weights and the 90-day split;
    - Elo delta; newest-first ids; think time; exact and inherited names;
    - preGameRatings.
  - `server/services/treeService.test.ts` (5): loading with 20 plies, pre- vs post-game ratings, memo hits, a rebuild after new games, a rebuild after a finished sync run, a rebuild after the maximum age, the 3m window.
  - `server/routes.test.ts` (+4):
    - the start node;
    - descending by EPD to the fixture's transposition node (n 1 → 2 at ply 8);
    - the window, tc and hl defaults and overrides;
    - an empty rapid tree;
    - 400s and a 404.
- `npx tsx scripts/verify/verify-tree.ts --asof 2026-09-26`: **OK**.
  - Snapshot vs golden, all exact:

    | Line | n | Score | Δ | CI |
    |---|---|---|---|---|
    | 1.c4 | 685 | 54.7% | | |
    | 1.c4 c5 | 60 | 36% | −8.2 | |
    | 1.c4 Nf6 | 56 | 65% | | |
    | 1.e4 e5 | 216 | 40% | −20.7 | [34, 46] |
    | 1.e4 d5 | 222 | 55% | +9.8 | |
    | 1.d4 d5 | 161 | 44% | −8.9 | |
    | Albin | 29 | 33% | | |
    | 2.Bf4 | 48 | 53% | | |
    | 2.Nf3 Bc5 | 16 | 46.9% | | |

  - Snapshot games: 685 White / 692 Black (1,377).
  - ESS at H = 60: **1,070** over 1,380 games (Σw 583; golden ≈ 1,069).
  - English Opening family: 661 of 687 White games.
  - Names: B01 Scandinavian Defense: Main Line, D08 Albin Countergambit, C40 Busch-Gass Gambit, D00 Accelerated London System.
  - Book exit: median **4**, p90 **7** (p75 6). The opponent left the book first in 845 games, the owner in 530, and 5 games never left it. This matches GLOBAL exactly.
  - Counts are consistent along every path over 18,004 edges (8,387 White and 9,198 Black positions). Blitz + rapid = all for each colour and each first move.
  - Service timing: a cold 6m build takes **143 ms**, and a warm node request 1.1 ms.
  - At the default H = 90, Black vs 1.e4 shows 1...e5 at wN 89 / ESS 209, 39.5% [33, 46], weighted Δ −9.1, z 2.95, trend "32 vs 184". 1...d5 shows 55% and "200 vs 23".
- **Server smoke** (`PORT=3099 tsx server/index.ts`, live store, then stopped):
  - `/api/tree?color=black`: 200. With the book warmed at startup, the first request takes 180 ms; a memo hit takes 3 ms.
  - Descending by EPD works. The 3m/blitz and hl=60 variants return 200, and a bad EPD returns 400.
  - `/api/openings/report` and `/api/status` still answer 200.
  - `check-report.ts` and `verify-import.ts --asof 2026-09-26` still pass.
  - No tsx, vite or Stockfish processes are left.
- **Owner data.** `storage/cache` is untouched (scans 270, reviews 9). verify-tree opens the store read-only.

## Known gaps / notes for P3b and P3c
- **P3b (Explorer)**:
  - Add `moves=` (UCI) and breadcrumbs to the node endpoint (`nodeByMoves` exists), and a games endpoint that pages an edge's `gameIds` into slim rows.
  - The root node JSON is about 22 KB, mostly game ids; a slimmer `gameIds` or a count may be enough for the table.
  - Then delete the report, `familyFromOpening` and `OpeningReportItem`.
- **P3c (fix-list)**:
  - Candidate stats are already on the edges: `weighted.deltaPts` is PL with the sign flipped, and `weighted.z` is the per-game-variance z.
  - The critic's gate asks for ESS ≥ 8 as well as n ≥ 8, z ≥ 1.64 plus Benjamini-Hochberg or shrinkage, and T_PL relative to wN.
  - `earlyLoss` is not collected yet.
- The default H = 90 / off per window is a single constant (`DEFAULT_HALF_LIFE_BY_WINDOW`), if the owner prefers GLOBAL's H = 60.
- Trees use the owner's pre-game rating. A Chess.com rating change from a game that is not stored (for example a skipped custom-start rated game) would make it slightly off; none was seen.
