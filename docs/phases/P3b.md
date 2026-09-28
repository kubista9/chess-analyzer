# P3b: Explorer UI; the Opening Report and Game History removed

Branch: `phase/p3b-explorer` (from `phase/p3a-opening-tree` at f82e093). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| fe68601 | feat(server): tree nodes by moves= with breadcrumbs, slim rows and GET /api/tree/games |
| af8fffe | feat(shared): leak/strength gate for move rows and the 90-day trend direction |
| 854296d | feat(web): Explorer replaces the Opening Report and Game History |
| aff5411 | refactor: remove the name-based report, the game list endpoint and familyFromOpening |
| 28a36e7 | docs: describe the Explorer, moves= and GET /api/tree/games |
| (this commit) | docs: add the P3b phase report |

## What was done

### API (`server/routes.ts`, `shared/openingTree.ts`, `server/db/games.ts`)
- **`GET /api/tree` takes `moves=`**: comma-separated UCI moves from the start, at most 20, each checked against a UCI pattern. `moves=` (empty) means the start position. `epd=` still works. Passing both gives a 400.
- **Breadcrumbs.** The answer carries `path: TreeBreadcrumb[]`, one entry per move: ply, SAN, UCI, EPD after the move, n and name. It is empty for `epd=`. If a move was never played there, the answer is a 404 that names the move.
- **Slim rows.** Move rows no longer carry `gameIds` (`TreeEdgeView`, `TreeNodeView`, via `nodeView()`). The root node's JSON dropped from about 22 KB to 1.3 KB.
- **`GET /api/tree/games`** takes the same filters plus `uci=`, `page=` and `size=` (1–100, default 20). It pages the edge's `gameIds` (newest first) into slim `TreeGameRow`s:
  - id, url, end time, time class and control, result, both ratings, opponent;
  - `ply`, the first ply at which that game played the move from that position (one query with `json_each`: `listMoveGames`).
  - A page past the end clamps to the last page. A move not played there is a 404.
- `walkMoves(tree, ucis)` (new) returns `{node, path, missingAt}`. `nodeByMoves` now uses it.
- Warm requests take 1–2 ms (node or games page), and the first request about 9 ms.

### Noise gate for row colours (`shared/moveSignals.ts`)
- A row is coloured only when all of these hold (the P3 critic's gate):
  - raw n ≥ 8 **and** ESS ≥ 8;
  - |z| ≥ 1.64;
  - it is a Benjamini-Hochberg discovery at q = 0.2 across the eligible rows of its table (two-sided p from the per-game-variance z).
- If so, it is "leak" (z > 0, below the Elo expectation) or "strength". Otherwise it is neutral, and rows under 8 games are "low-sample".
- `normalSf` (Abramowitz-Stegun), `benjaminiHochberg` and `trendDirection` are also here. The trend arrow needs 8 games on each side of the 90-day split and a change of at least 5 points; otherwise it shows "·".
- All thresholds are exported constants.

### Explorer (`/explorer`)
- **Files:**
  - `src/pages/ExplorerPage.tsx`;
  - `src/components/{MoveTable,FilterBar,GamesDrawer,boardTheme}.tsx|ts`;
  - `src/hooks/useFilters.ts`;
  - `src/styles/explorer.css`.
- **Filters.** Colour (As White / As Black) and the moves live in the URL (`?color=&moves=`). An illegal or over-long `moves=` is trimmed to its legal prefix. Window (6 mo / 3 mo), time class (Blitz + Rapid / Blitz / Rapid) and "Recent games count more" are kept in localStorage inside try/catch. The weighting toggle is disabled on 3 mo, which the server never weights.
- **Board** (react-chessboard):
  - It is oriented to the owner's colour and follows the path.
  - A move made by click-click or drag descends the tree if the games played it. Clicking a piece highlights the target squares of the moves the games played from it. A legal move that nobody played shows "No game in these filters played 3.Bb5 here."
  - The selected row is drawn as an arrow.
- **Navigation:**
  - Breadcrumbs: Start, `1.e4 e5 2.Nf3 …`. After Back, the moves Forward would retrace show as dashed crumbs.
  - Start, Back and Forward buttons. Forward retraces the last line, or otherwise follows the selected (by default the most-played) move.
  - Keys: ←/→ for Back/Forward, ↑/↓ to select a row, Enter to follow it.
  - The URL is replaced on each step, not pushed, so browser Back still leaves the page.
- **Node panel:** the ECO badge and name, and a note: exact name, "a book position without its own name" (inherited), or "Out of book". Also games here, who is to move, ESS (when weighted), how many games stopped here, and the scope line (colour · window · time class · weighting and half-life).
- **Move table:**
  - The caption says "Your moves" or "Opponent replies", with the mover's colour dot, which each row also carries.
  - Columns:
    - move (`1...e5`, a tag, and the book name / "out of book" / inherited name);
    - games: a frequency bar, n, share, ESS;
    - a W/D/L bar and counts;
    - score % with an SVG whisker: the Wilson CI on ESS, a 50% mid tick, an amber tick at the Elo expectation, and a dot at the score;
    - vs Elo: points per 100 games, plus total points;
    - the trend arrow with recent / older counts;
    - think time (owner moves only);
    - a games-list button.
  - Tooltips give the raw numbers next to the weighted ones and the z.
  - Leak rows are tinted rose with a "Below expectation" tag, and strength rows green. Low-sample rows are dimmed with a tag.
  - The move column is sticky. The table scrolls inside its panel under about 900 px.
- **Games drawer:**
  - It is a side sheet on desktop and a bottom sheet under 760 px, with Escape, the backdrop and a close button. Body scroll is locked while it is open, and the list starts at the top on each page.
  - Each row has a W/L/D badge, the opponent (rating), the time-class icon and control, the date, **Review** → `/review/:id?ply=N` (the review opens at that move), and an external Chess.com link. 20 per page with a pager.
- **Nav and routes.** Nav is Home and Explorer. `/openings`, `/history`, `/dashboard`, `/training` and `/review` (no id) redirect to `/explorer`. The Sync card copy links to the Explorer. The review's empty-state copy points to the Explorer. The review board uses the shared `boardTheme`.

### Deletions
- **Pages:** `OpeningReportPage.tsx`, `GameHistoryPage.tsx` and `WindowToggle.tsx`, plus `gameWindow` in the workspace context.
- **Client:** `fetchGames`, `GameQuery` and `fetchOpeningReport` from the client, and `resultLabel` from `formatters.ts`. `timeClassMeta`, `formatTimeControl` and `resultLabel` now live in `GamesDrawer`.
- **Server:** `GET /api/openings/report`, `GET /api/games` (the list), `server/services/openingReport.ts` and its test, and `scripts/verify/check-report.ts` (superseded by verify-tree). `GET /api/games/:id` stays for the review.
- **Types and helpers:** `OpeningReportItem`, `OpeningReportResponse`, `GamesResponse` and `familyFromOpening` (`shared/chess.ts`), plus the unused `openingFamily` field in the legacy raw-games seed type and the test fixture.
- **CSS:** 87 dead rules from `src/styles.css`:
  - every `history-*`, `opening-*`, `filters-row`, `game-row-*`, `list-panel` and `window-toggle` rule;
  - the `.field` rule left over from P2's AnalysisLauncher.
  - A script lists every class in `styles.css` that no `src/` file uses; only the dynamically built `review-board-color-*` classes remain on that list.

## Deviations from the spec, and why
- **Endpoint names.** The node endpoint stays `GET /api/tree` (P3a's), extended with `moves=` and `path`, rather than a new `/api/tree/node`. The games endpoint is `GET /api/tree/games` as specified, but it takes `moves=|epd=` plus `uci=`: the drawer is per move row, which the spec's `epd=`-only signature cannot express.
- **Row colouring gate.** The plan's rule is "red when n ≥ 8 and (wilsonHi < 50% or z ≥ 1.64); green when the lower bound is above 50%". It is replaced by the critic's gate: n ≥ 8, ESS ≥ 8, |z| ≥ 1.64 and BH q = 0.2 across the table, on the Elo delta rather than on 50%.
  - The BH family here is one table. P3c's fix list should apply it across its whole candidate set.
  - Consequence: 1.c4 c5 (60 games, 37%, −13 per 100) stays neutral in its 15-row table. 1.e4 e5 (z 2.95) and 2.Nf3 after it are coloured.
- **"vs Elo" shows two numbers.** The main one is points per 100 games (−9.8 for 1.e4 e5 unweighted), which is comparable across rows. The small one is total points, the plan's "Δ −20.7" style (−21.2 pts with pre-game ratings). Both follow the weighting toggle, and the tooltip gives the raw values.
- **Score shown is the view's score.** When "Recent games count more" is on (the 6-month default, H = 90), the score, CI, Δ and colour use the weighted summary, and raw n, raw W/D/L and the raw score and Δ (tooltip) stay visible. So 1.e4 e5 reads **216 games, 39%** [33–46] weighted, and **40%** [34–46] with the toggle off.
- **`/api/games` (list) deleted.** It had no consumer left once Game History was removed, and the drawer uses the slim paged endpoint.
- **`.time-class-blitz/rapid` CSS kept.** The spec lists time-class-* for deletion, but the drawer reuses them for the icon colour.
- **Not built:**
  - the optional "show book moves the owner has never played" toggle;
  - fix-list cards and Home cards (P3c);
  - opening the Explorer at a node from elsewhere, which already works by URL (`/explorer?color=black&moves=e2e4,e7e5`) for P3c's "Open in Explorer".
- **URL encoding.** `moves=` shows as `e2e4%2Ce7e5` in the address bar (URLSearchParams escapes commas). Hand-written URLs with raw commas work too.

## Check and verify results
- `npm run check`: typecheck (web, server, test) OK, vitest **219/219** (21 files; P3a had 212: minus 6 report-service tests and 2 route tests for the removed endpoints, plus 15 new), vite build OK.
- New or changed tests:
  - `shared/moveSignals.test.ts` (10):
    - normal tail values;
    - BH step-up;
    - leak / strength / neutral;
    - low sample even with a large z;
    - the ESS gate;
    - the |z| gate when BH alone would pass;
    - FDR across 8 noisy rows;
    - no-variance rows;
    - trend up / down / flat / none.
  - `shared/openingTree.test.ts` (+3): `walkMoves` breadcrumbs with n per step, the missing move index, and `nodeView` stripping game ids from the view only.
  - `server/routes.test.ts`:
    - rows have no `gameIds`;
    - descending by EPD and by `moves=` onto the fixture's transposition node (ply 8, n 2) with 8 breadcrumbs named "English";
    - `moves=` empty is the start;
    - games paging: total = n, newest first, ply 1 at the root and ply 2 one move deeper, size / page clamp, 404 for an unplayed move, 400 without `uci`;
    - 400 for SAN in `moves=` and for `moves=` together with `epd=`;
    - 404 naming the unplayed move;
    - `/games` and `/openings/report` now 404.
- `npx tsx scripts/verify/verify-tree.ts --asof 2026-09-26`: **OK** (golden lines, names, ESS, book exit, path counts unchanged).
- `npx tsx scripts/verify/verify-import.ts --asof 2026-09-26`: **all invariants OK** (the known +3 late games on 09-26).
- **Browser smoke test** (`npm run dev`, then stopped):
  - **1280 px:**
    - As Black: 693 games. The start table ("Opponent replies") lists 1.e4 440 · 63% and 1.d4 169.
    - After 1.e4, 1...e5 is **216 games · 49%**, W/D/L 82/8/126, **39%** [33–46] weighted, tagged "Below expectation" and tinted. With the weighting off it reads **40%** [34–46], −9.8 per 100, −21.2 pts. 1...d5 is 223 at 55%, neutral.
    - ↓ + Enter went to 1...e5 (C20 King's Pawn Game, 2.Nf3 131 also flagged). ← went back, → retraced.
    - A double Back and a double → each took two steps (after the fix, see Notes).
    - Click-to-move 1...c5 showed the "No game … played 1...c5 here" notice. e7→e5 by clicks and g1→f3 by drag both descended.
    - The drawer for 1...e5: 216 games, "Page 1 of 11", Next → page 2. **Review** opened `/review/171055239328?ply=2` ("e5 is best"); the Chess.com link points to the game.
    - Switching to Rapid on a path the rapid games never reached shows "No game in these filters reached this position" with Back / Start.
    - `/openings` and `/history` redirect to `/explorer`.
    - The table fits the panel at 1280 (890 px, no inner scroll).
  - **375 px:**
    - `scrollWidth` 375 on the Explorer and the review, so there is no horizontal page scroll. The table scrolls inside its panel with the move column sticky.
    - The filter chips wrap into rows, and the drawer nav shows Home (active) and Explorer.
    - The games drawer opens as a bottom sheet. Paging resets to the top. Review opened `/review/170687694504?ply=2` and ran to "e5 is best".
  - Servers stopped: no tsx, vite, concurrently or Stockfish processes, and nothing on 3001/5173. The browser viewport was reset and the pane closed.
- **Owner data.** `storage/cache` is untouched apart from the 2 smoke-test reviews added to `reviews-v2` (6 files now). No store writes beyond normal reads.

## Known gaps / notes for P3c and later
- **Router transitions.** react-router v7 commits navigations in a transition, so a second quick Back/Forward saw the old path and repeated the same step. The page keeps the last asked-for path in a ref (`latestMoves`). If P3c adds more navigation helpers, go through `goTo`.
- **Fix list (P3c).**
  - `moveSignals` is per table. The fix list needs the same gate across all owner-move candidates (n ≥ 8, ESS ≥ 8, z ≥ 1.64, BH q = 0.2) plus blame attribution, and `earlyLoss` still has to be collected.
  - Link fix cards to `/explorer?color=<c>&moves=<uci,…>`; the Explorer trims illegal paths and 404s unreached ones gracefully.
- **Drawer data.** `TreeGameRow.myRating` is the post-game rating (the tree uses pre-game ratings for E); the drawer does not show it.
- **Accessibility.** Rows are clickable `<tr>`s with a real button on the SAN and on the games list. Keyboard selection is page-level (↑/↓/Enter), not focus-based.
- **Tests.** No automated UI tests (vitest covers `shared/` and `server/` only, as before).
