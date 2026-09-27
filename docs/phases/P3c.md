# P3c: Fix list v0 (results only) and the Home cards

Branch: `phase/p3c-home-leaks` (from `phase/p3b-explorer` at 4bef88c). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| 3495544 | feat(shared): fix list v0 with a BH-controlled gate and bottom-up blame attribution |
| 46979ff | feat(shared): repertoire snapshot of the main opponent moves and the owner's answers |
| 0bd15ca | feat(server): GET /api/fixlist and GET /api/snapshot over both colours' trees |
| 225fef0 | test(verify): verify-fixlist checks the leaks against the tree and re-runs the null simulation |
| 8f78256 | fix(shared): take a fix item's example games from the games it is blamed for |
| 33788dd | feat(web): Home shows the biggest leaks and a repertoire snapshot; /leaks lists them all |
| 4a52102 | docs: describe the fix list, the snapshot, /leaks and verify-fixlist |
| (this commit) | docs: add the P3c phase report |

## What was done

### `shared/fixList.ts` (pure)
- **Candidates** (`collectCandidates(tree, games)`): the owner's own moves (edges out of owner-to-move positions) in each colour's tree, within the tree's 20-ply window, with raw n ≥ 8 **and** ESS ≥ 8 in the tree's view.
  - Each candidate carries its move path, from `principalPaths` (see below), and per game: the recency weight, the Elo expectation (pre-game rating), the score, the ply at which it played the move, and the game length.
- **Gate** (`selectLeaks`): per candidate, weighted z = Σw(E−s)/√Σw²E(1−E), and the one-sided p = 1 − Φ(z).
  - A candidate is a **leak** when z ≥ 1.64 **and** it is a Benjamini-Hochberg discovery at q = 0.2 across the whole candidate set. Both colours form one family.
  - Candidates with z ≥ 1.64 that fail BH form a separate **watch** tier. This is the critic's "watch" idea, but at z ≥ 1.64, not 1.0 (see Deviations).
  - `bhAdjusted` gives each item its q-value.
- **Blame attribution**, bottom-up over the nominally significant candidates, deepest move first:
  - A game that an emitted deeper item already explains no longer counts for the items above it in that game. Claims are per game and per ply, so transpositions are handled exactly.
  - An item is emitted only if its residual has ≥ 8 games, loses ≥ 1 weighted point (`FIX_MIN_POINTS`) and has z ≥ 1 (`FIX_MIN_RESIDUAL_Z`). `explainedBy` names the deeper items.
  - Leaks give way only to deeper leaks. Watch items give way to deeper leaks and deeper watch items, so a noise-level child never shrinks a leak.
- **Ranking**: residual recency-weighted points lost (`pointsLost`), then n.
- **`FixItem`** `{kind: 'results-leak', tier, id, color, moves (UCI), sans, line ("1.e4 e5 2.Nf3 Nc6"), name, eco, nameExact, inBook, n, W/D/L, wN, ess, score, ci, expected, delta, deltaPts, z, p, q, confidence (medium | high at z ≥ 2.33), raw {score, delta, deltaPts}, pointsLost, residualN, explainedBy, trend (+ direction), earlyLoss {ply: 40, n, rate}, examples}`.
  - `earlyLoss` counts the games of the line lost within 40 half-moves (by move 20).
  - `examples` are up to 3 of the games the item is blamed for, the most recent losses first, with the ply of the move (for `/review/:id?ply=N`).
  - Every threshold is an exported constant.
- **`buildFixList([{tree, games}, …])`** runs everything over both colours.

### Tree helpers (`shared/openingTree.ts`)
- `principalPaths(tree)` gives one legal move path to every node: the shortest one, and among those the one whose last move the most games played. A transposed position gets its main move order, and `walkMoves` follows the path.
- `formatLine(sans, firstPly)` formats "1.e4 e5 2.Nf3", or "1...e5" when the line starts on Black's move.
- `TreeGame.plyCount` (from `GameRecord.plyCount`) is used for early losses.

### `shared/repertoireSnapshot.ts` (pure)
- `buildSnapshot(tree)` finds the opponent's main moves at his first decision (the top 4 with ≥ 8 games) and the owner's answers to each (up to 3, each with ≥ 5% of the group; the main answer always).
  - As White, the owner's first moves come first ("First move"). The groups are then the replies to his main first move ("vs 1.c4 e5").
- Each answer carries:
  - label, n, share, the view's score and CI, delta, low sample;
  - the recent/older counts and the trend direction;
  - a **usage hint**: "fading" when the move's share of the group's last-90-day games is at most half its older share, "rising" when it is at least double. Both sides need 8 games, and the larger share must be ≥ 15%.

### API
- **`GET /api/fixlist?window=6m|3m&tc=blitz|rapid&hl=<days>|off`** → `FixListResponse {window, timeClass, halfLifeDays, maxPly, games {white, black}, tested, significant, items, watch, thresholds}`.
  - It uses both memoised trees. The list is recomputed only when either tree object changes (a memo of at most 16 filter sets). A repeat request took 45 ms wall-clock, curl included; the list itself takes about 80 ms to compute cold.
- **`GET /api/snapshot?<same filters>`** → `SnapshotResponse {…scope, white, black}`.
- `BuiltTree` keeps the games the tree was built from.
- Route filter parsing is shared (`queryFilters`, `halfLifeSchema`). Bad window, tc or hl values give a 400.

### UI
- **Home**: the Sync card (unchanged), then the scope line, then the two new cards. All of them use the Explorer's stored filters (window, time class, weighting), so the numbers match the Explorer.
  - **Biggest leaks**: the top 3 fix cards, plus "All N leaks / Full list + K to watch →" linking to /leaks.
  - **Repertoire snapshot**: White and Black columns. Each group label links to the Explorer at that position. Each answer chip shows "1...d5 55% (223)", a trend arrow and a hint ("mostly lately", "rarely played lately", "low sample", "leak"), and links to the Explorer with the move selected. Answers that are leaks are outlined rose.
- **Fix card** (`src/components/FixCard.tsx`):
  - rank, colour, and a tier tag with the confidence (the tooltip gives z, p and q);
  - the line and its ECO and name;
  - games and ESS; score with the CI and the Explorer's whisker; the expectation; Δ per 100 games and in total points (tooltips give the raw values);
  - the trend sentence ("15 in the last 90 days vs 100 before"), early losses, and the blame note ("Ranked on 2.5 points lost in the 101 games not covered by 1.e4 e5 2.Nf3 Nc6.");
  - **Open in Explorer** and up to 3 recent-loss chips linking to the review at the move's ply.
- **Explorer `?select=<uci>`**: fix cards link to `/explorer?color=&moves=<parent path>&select=<the move>`, so the table of the position where the owner chose the move opens with that (red) row selected and its arrow on the board.
  - The parameter is dropped from the URL once applied, and `goTo` also clears it.
- **`/leaks`** (new, in the nav as "Leaks"):
  - the filter bar, without the colour switch (`FilterBar`'s `color` is now optional);
  - every leak;
  - a "Worth watching" section that states its lines are about as likely as not noise;
  - a "How the list is made" section.
- **Empty and low-data states**, the same on Home and /leaks:
  - no games in the filters ("Sync above …");
  - no move reaches 8 games ("Not enough games yet …");
  - nothing survives the gate ("No leak stands out from noise: N of your moves with 8+ games were tested …", plus the watch count).
  - The snapshot says "No games as White in these filters" or "Too few games".
- `ScoreWhisker` now takes `{score, expected, ci}`. `pct`, `pctOne`, `formatDelta` and `formatPoints` moved to `src/utils/formatters.ts`.
- New styles are in `src/styles/leaks.css`, in the existing theme; they reuse the Explorer's tags, dots, whisker and trend colours. The cards stack below 900 px and 760 px.

## The actual leaks (store as of 2026-09-26, 6 months, H = 90, pre-game ratings, blitz + rapid)

89 candidates were tested (52 White, 37 Black); 2 are significant, giving **2 leaks** and **4 watch** lines.

**Leaks:**

| # | Colour | Line | Name | n | ESS | Score [CI] | Exp. | Δpts (line) | z | q | Blamed pts | Early losses | 90-day trend |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Black | 1.e4 e5 2.Nf3 Nc6 | C44 King's Knight Opening: Normal Variation | 115 | 112 | 35.9% [28–45] | 49.7% | −6.58 | 2.91 | 0.080 | 6.58 | 21 / 115 | 15 vs 100 |
| 2 | Black | 1.e4 e5 | C20 King's Pawn Game | 216 | 209 | 39.5% [33–46] | 49.6% | −9.08 | 2.95 | 0.080 | 2.50 (the 101 games that are not 2.Nf3 Nc6) | 30 / 216 | 32 vs 184 |

**Watch** (z ≥ 1.64 alone, q ≈ 0.45–0.54; the null produces about 3.4 such lines):

| Colour | Line | Name | n | Score | Δpts | z |
|---|---|---|---|---|---|---|
| Black | 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 | C50 Giuoco Piano | 55 | 37% | −2.84 | 1.86 |
| White | 1.c4 c5 2.Nc3 Nc6 3.g3 | A36 English, Symmetrical, Two Knights Fianchetto | 21 | 25% | −2.52 | 2.11 |
| Black | 1.e4 e5 2.Nf3 Nc6 3.d4 exd4 | C44 Scotch Game | 22 | 28% | −2.19 | 2.05 |
| Black | 1.d4 d5 2.c4 e5 | D08 Albin Countergambit | 29 | 34% | −1.92 | 1.65 |

- The same ranking holds unweighted (101 candidates) and at H = 60 (84).
- The 3-month view tests 53 candidates and lists nothing; 3 months of rapid only tests 3 and lists nothing (the low-data state).
- **Snapshot:**
  - As Black: "vs 1.e4: 1...d5 55% (223) mostly lately · 1...e5 39% (216) rarely played lately, leak"; "vs 1.d4: 1...d5 47% (161)".
  - As White: "1.c4 53% (687)"; "vs 1.c4 e5: 2.Nc3 54% (261)"; "vs 1.c4 c5: 2.Nc3 37% (60)".

## Null simulation (verify-fixlist)
- Every game's result is redrawn as a win with probability E (else a loss). One draw per game is shared by every line the game passes through, and the whole fix list is recomputed. The seeded PRNG (mulberry32, seed 1) makes the 200 runs reproducible.
- **Critic's setup re-run** (H = 60, post-game ratings, n ≥ 8, no ESS gate; 101 candidates, against the critic's 105 nodes):

  | Gate | Real | Null (mean) | Critic's numbers |
  |---|---|---|---|
  | plan: z ≥ 1 or hi < 50% | 8 | 11.1 | 9 / 11.8 |
  | plan: z ≥ 1.64 or hi < 50% | 6 | 4.3 | 7 / 4.5 |
  | fix list v0: leaks | 2 | 0.15 | |
  | fix list v0: watch | 3 | 3.5 | |

  7.5% of null runs emit any leak (the BH bound is 20%).
- **App default** (H = 90, pre-game ratings, ESS gate; 89 candidates): the plan's gates give 14 real vs 12.7 null and 7 vs 4.3. **Leaks: 2 real vs 0.16 null** (9.5% of runs emit any). Watch: 4 real vs 3.4 null.
- Asserted: null leaks per run ≤ 0.5, runs with any leak ≤ q + 5%, and real leaks > null leaks.

## Deviations from the spec, and why
- **The gate is the critic's, not the plan's.** The plan's gate was "PL ≥ 1 and (z ≥ 1 or Wilson hi < 50%)"; the fix list uses z ≥ 1.64 plus BH at q = 0.2 over all candidates, with ESS ≥ 8.
  - **The acceptance line "the fix list includes 1.c4 c5 and the Albin" therefore does not hold for the leak list.** Both are on the watch list: 1.c4 c5 as 2.Nc3 Nc6 3.g3, since 2.Nc3 itself (60 games, z 1.92) is mostly explained by that child and its residual z falls under 1. The null simulation shows that lines at this level turn up about as often on coin-flip results, so presenting them as leaks would be dishonest. verify-fixlist asserts they are on the watch list.
  - "Does not include 2.Bf4 or the Scandinavian" holds on both lists. 2.Bf4 is an opponent move and never a candidate. No owner move after it, and no 1...d5 line against 1.e4, is flagged.
- **One-sided p for BH.** The fix list only tests "below expectation", so its p is one-sided. The Explorer's per-table gate (P3b) is two-sided because it colours both directions. With two-sided p the two leaks would still pass (q ≈ 0.16 against 0.2; one-sided 0.08), but with less margin.
- **The watch tier is at z ≥ 1.64, not the critic's z ≥ 1.0.** A z ≥ 1.0 tier would list about 12 lines on no-leak data. Even at 1.64 the watch list is at the null's level (4 against 3.4), so the UI labels it "may be noise" and keeps it off Home.
- **T_PL is absolute (1.0 weighted point) on the residual**, together with residual n ≥ 8 and residual z ≥ 1, rather than the critic's "relative to wN". The significance gate already scales with n. The residual z keeps a large parent from being listed for a thin per-game residual; with H = 90 the 1.0-point floor only removes old, tiny residuals.
- **The half-life follows P3a**: H = 90 on the 6-month view and none on the 3-month view (critic correction), with `hl=` as an override. The endpoint takes `window=`, `tc=` and `hl=` (the spec lists `window` and `tc`).
- **Fix cards open the Explorer at the parent position with the move selected** (`?select=`), not at the position after the move. The red row, its alternatives and the arrow are then all visible; Enter or → follows it.
- **The watch list, /leaks and the "Leaks" nav entry** are additions. The spec allowed "a /leaks page or a Home section"; the nav entry keeps the page reachable with an active nav state.
- **`earlyLoss` is computed in the fix list** from `GameRecord.plyCount`, not stored on tree edges. Only the fix list uses it.

## Check and verify results
- `npm run check`: typecheck (web, server, test) OK, vitest **241/241** (23 files; P3b had 219), vite build OK.
- New tests:
  - `shared/fixList.test.ts` (16):
    - BH q-values match `benjaminiHochberg`;
    - candidates are the owner's moves only (both colours, never the opponent's), with the n and ESS gates and the per-game weight, E and ply;
    - `principalPaths` on a transposition, and `formatLine`;
    - the gate: a clear leak is listed and noise and strengths are not; z ≥ 1.64 is required even when BH alone would pass; BH works across the whole candidate set, so a lone z = 2.0 line is a leak and goes to watch among 19 null lines;
    - **blame attribution**: a child explaining about 70% emits only the child; two 40% children also emit the parent's residual of 2.0 points, with `explainedBy` and the points summing to the parent's 10; ranking is by residual points (a fully explained 1.c4 is dropped); a watch-level child does not shrink a leak;
    - early losses; examples are the newest losses among the games the item is blamed for; the weighted view with the raw values kept; the score-override hook.
  - `shared/repertoireSnapshot.test.ts` (3): Black groups with "rising"/"fading" hints and the 5% share cut; White "First move" then the replies to 1.c4; empty.
  - `server/routes.test.ts` (+3): the fix list shape, thresholds and memo, the 3m/blitz scope, the snapshot per colour, and 400s.
- `npx tsx scripts/verify/verify-fixlist.ts --asof 2026-09-26`: **OK**. Every item matches its tree edge (n, SAN, Δpts, z). The blame ids exist, the examples are at the move's ply, the expectations above hold, and the null simulation is as described.
- `verify-tree.ts --asof 2026-09-26`: **OK** (unchanged). `verify-import.ts --asof 2026-09-26`: **all invariants OK**.
- **Browser smoke test** (`npm run dev`, then stopped):
  - **1280 px, Home**: the Sync card, the scope line, **Biggest leaks** (#1 1.e4 e5 2.Nf3 Nc6: 115 · ESS 112, 36% [28–45], expected 50%, −13.8 / 100 · −6.5 pts, 18% lost by move 20; #2 1.e4 e5 with the blame note), "Full list + 4 to watch →", and the repertoire snapshot as quoted above.
    - **Open in Explorer on #1** → `/explorer?color=black&moves=e2e4,e7e5,g1f3&select=b8c6`. The breadcrumbs read Start · 1.e4 · e5 · 2.Nf3 ("King's Knight Opening", 131 games). The **2...Nc6 row is selected and red** ("Below expectation", 115, 36% [28–45], −13.8, −6.5 pts), and the URL drops `select`.
  - **/leaks**: 2 leaks, 4 watch cards and the method. 3 mo shows "No leak stands out from noise: 53 … tested", and 3 mo + Rapid shows 3 tested. Home follows the same stored filters; the filters were reset to the default afterwards.
  - **375 px**: Home and /leaks have `scrollWidth` 375 (no horizontal scroll, no element past the viewport). Stats are 2 × 2 and the snapshot columns stack.
    - #2's Open in Explorer → `/explorer?color=black&moves=e2e4` with **1...e5 selected and red**.
    - A recent-loss chip → `/review/172233179250?ply=4`, and the review ran to "Nc6 is best".
  - Servers stopped: no tsx, vite, concurrently or Stockfish processes, and nothing on 3001/5173. The viewport was reset and the browser pane closed.
- **Owner data.** `storage/cache` is untouched apart from the one smoke-test review added to `reviews-v2` (7 files now). No store writes.

## Known gaps / notes for later phases
- **Results only.** A leak says where points go, not why. P5's engine-hole items should join the same `FixItem` list (another `kind`). They should probably not count towards the BH family, since the engine is not a statistical test.
- **Watch items can sit inside a leak's games** (for example 3.Bc4 Bc5 under 2...Nc6). This is by design, but P7's alternatives panel ("Where the points are lost") should treat them as hints within the leak.
- **Home uses the Explorer's stored filters** with no filter bar of its own; /leaks has the filter bar. Changing the filters on /leaks or in the Explorer changes Home on the next visit.
- **The example chips show date and result only**; the opponent is not in `FixExample`. `GET /api/tree/games` has it if needed.
- `principalPaths` picks one move order for a transposed position; the card does not say that other move orders reach it too.
- Repertoire seeding (P7a) can use the fix list directly. The critic's "results-leak override" for the Albin will need the watch tier or its own rule, because the Albin is only on the watch list with the current data.
