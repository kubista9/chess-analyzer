# P7b: Offline alternatives, the deep tier, the alternatives panel and the rest of P7

Branch: `phase/p7b-alternatives` (from `phase/p7a-repertoire` at bb7ae77). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| cc85476 | feat(alternatives): a lazy deep engine tier outside the protocol and the pure offline alternatives ranking |
| b14e474 | feat(server): GET /api/alternatives with the deep search as an interactive job, only-move checks, and Set as my move with the replaced move |
| 9391e1f | feat(repertoire): seed replacements from the alternatives ranking, and keep a results leak that is the engine's best move for review |
| 98a3ba4 | test(verify): verify-alternatives prints the panel for the main leaks, checks the Albin and 2...Bc5 acceptance lines and times the per-open deep search |
| 6636a70 | feat(web): the alternatives panel with a steppable sample line and Set as my move; See alternatives from the Explorer, fix cards, the review and the repertoire; Unset, notes, unreachable entries and Home's coverage line |
| 0267049 | test(server): the coverage endpoint; the Unset button keeps its visible name |
| c6b414d | docs: describe the alternatives panel, the deep tier, the endpoints and verify-alternatives |
| (this commit) | docs: add the P7b phase report |

## What was done

### Deep tier (`server/engine/protocol.ts`, `server/db/positions.ts`)
- `DEEP_TIER = {multipv: 4, depth: 18, nodeCap: 3M}` lives **outside** `ENGINE_PROTOCOL`. `protocol_json` is unchanged, so the config id stays the same and no game is re-queued. A test checks this.
- Deep results are stored as `positions` rows with `tier = 'deep'` under the same config. Only the new `getDeepEval` reads them.
- `TIER_ORDER` is still owner > opponent, so an owner or opponent lookup never answers from a deep row. `countPositions`, `averageNodes` (the backfill ETA), `positionsStamp` and `listPositionEvals` (the analysis index) all ignore the deep tier. A deep search therefore never invalidates the tree or fix-list memos.
- `SearchTier = EngineTier | "deep"` is used for `PositionEval.tier` and `PositionRequest.tier`. `tierSpec` and `tierNodeCap` know the deep tier, and the pool and `analysePosition` needed no other change. A cached deep row gets its missing moves scored by the usual depth-matched searchmoves follow-up.
- Measured on the M1 on battery, single thread: MultiPV 4 at depth 18 took 0.9-1.9M nodes (1.4-3.1 s). Depth 16 took 0.4-1.0M.

### Ranking (`shared/alternatives.ts`, pure)
- **Candidates**, collected at an owner node:
  - the engine's lines (the deep top 4);
  - the 6 book children with the most book lines behind them;
  - the owner's moves with 3+ games;
  - the questioned move.
- **Gate**: the move must be scored at the root and be at most 5 win% below the best line, from the owner's side. An unscored book move is listed as "Not scored"; it never passes on its name.
- **Kinds**: `owned`, `book`, or `engine-idea` (neither owned nor a book move). Engine ideas are always ranked last, which follows the critic's point about b2b4-style moves.
- **Features**. Each one adds points and a reason written only from measured facts:

  | Feature | Rule | Points |
  |---|---|---|
  | owned | 3+ games at a weighted score ≥ 50% | +4 |
  | owned | any game | +2 |
  | named | the child position is named in the book | +3 |
  | named | the child position is only on a book line | +1 |
  | mainstream | the book's lineCount share of the move is ≥ 25% (the critic's popularity stand-in) | +2 |
  | mainstream | the share is ≥ 8% | +1 |
  | results | 20+ games each, and the move beats the questioned move vs expectation with z ≥ 1.64 | +2 |
  | familiar | pawn Jaccard ≥ 0.85 after the move plus 4 PV plies, against owner nodes with wN ≥ 3 at a later ply (see below) | +2 |
  | transposes | a move not yet played reaches a tree node with 3+ games within 6 plies | +2 |
  | simplicity: only-moves | each only-move on the sample line (the second-best is ≥ 10 win% worse, at the owner plies 3 and 5) | −1 each |
  | simplicity: forcing | 3+ of the 6 plies are checks or captures | −1 |
  | eval gap (soundness margin) | win% below the best line | −1 per win% |

  - familiar leaves out three kinds of node: the root's own path, the questioned move's subtree, and exact transpositions.
  - The two simplicity penalties together are capped at −3.
- **Each card carries**: the eval (White-view, the owner's win% and the gap), the name and ECO, the owner's record (n, score, Wilson CI, low-sample flag), a 6-ply SAN sample line, and typical replies (the owner's opponents' moves, then the book's, then the engine's), each with its reasons and total score.
- **Where the points are lost**: the questioned move's games, split by the opponent's reply and the owner's next answer. Each row is recency-weighted Σw(E − s).
- **Change earlier** (`ancestorSuggestions`), at each earlier owner node on the path:
  - *results*: a sibling the owner plays in 20+ games, with z ≥ 1.64 and not gated out;
  - *leak*: the path move is a flagged results leak or watch line (n ≥ 15) and is **not** the engine's best there (gap ≥ 1). The gated alternatives come from the cached deep row, else the owner-tier row.
- **Honesty block**, always present:
  - there is no popularity data, and "mainstream" only counts book lines;
  - moves are engine-gated, and a book name is not a recommendation;
  - moves are ranked by fit, not strength;
  - the owner's record is a low sample below 8 games.
- **Deterministic**: every sort has a total order. Tests cover identical JSON and reversed game order.

### Server (`server/services/alternatives.ts`, `GET /api/alternatives`)
- `?color=&moves=|epd=&uci=&window&tc&hl`. It answers 400 at an opponent-to-move node or for an illegal `uci`.
- **200** when the deep row scores every candidate and every only-move position is cached.
- **202** otherwise, with a *preliminary* ranking on the owner-tier cache and the job `alternatives:<color>:<epd>:<uci>` (type `alternatives`, interactive priority). The job:
  - runs one deep search. `played` holds the book children, the owned moves, the repertoire's move and the most-played move, so every candidate is scored at one root and depth;
  - then runs owner-tier searches of the only-move positions for up to 8 gated candidates, in a fixed order (book and owned before engine ideas, then by gap). One pool group per position spreads them over the workers. The order does not depend on the only-move results, so a second open never finds new work;
  - returns the complete response with its `cost` (ms, deep and only-move nodes, positions searched).
- **The flags** come from the router's memoised fix list (leak and watch items via `seedFlags`).
- **`PUT /api/repertoire/entry`** takes an optional `replaces: {uci, loss?, reason?}`. "Set as my move" from an alternative records the questioned move there. The entry becomes `edited`, locked and active.
- **`GET /api/repertoire/coverage`** gives Home's line: per colour, the entries, the number needing review and the coverage at plies 8 and 12.

### Seed (`shared/repertoireSeed.ts`)
- **The P7a conflict, resolved.** In the real data 1.e4 e5 2.Nf3 Nc6 is a results leak (115 games, 36%, z 2.91), and 2...Nc6 is also the engine's best move there (gap 0.0 on the deep tier). When the flagged move loses less than `SEED_BEST_LOSS = 1`, the results-leak override now keeps it: `needs-review`, with the evidence and the note "It is the engine's best move here, so the points are lost later in the line; its alternatives are suggestions, not a replacement." The panel offers 2...Nf6 and 2...d6 as suggestions, shows where the points go (3.Bc4 Bc5 and 3.d4 exd4), and points to 1...d5 at 1.e4 under "Change earlier". The Albin (gap 2.8-4.3) is still replaced.
- **Replacements use the ranking.** With the book, which the server now passes, a replacement (engine hole or leak override) is the top engine-sound, unflagged move of the alternatives ranking. Without the book, P7a's rule applies. On the golden data the result is the same as before: 2...e6 for the Albin and 2...Nc6 for 2...Bc5. A new test shows the difference: the Slav wins over a non-book engine line.

### UI
- **`/alternatives?color=&moves=&uci=`** (`src/pages/AlternativesPage.tsx`, `src/components/AlternativesPanel.tsx`, `src/styles/alternatives.css`):
  - **Header**: the line and name, "Your move: 2...e5" with its engine gap or hole and its results flag (for an engine-best flagged move: "suggestions only"), links to the Explorer and the repertoire, and the engine tier, depth, nodes, gate and this open's cost.
  - **Deep check running**: a spinner with the job's progress, while the preliminary cards stay visible and dimmed.
  - **Cards**: rank, kind chip (you play it / book move / engine idea), eval and gap, name, your record with CI, reason bullets with their points, typical replies, "Show line" and **"Set as my move"**. Others are listed after the top 3, followed by the moves not offered.
  - **Board**: a mini-board with the steppable SAN sample line (chips; back to the position).
  - **Where the points are lost**: bars per reply, with the owner's answers.
  - **Change earlier**: "Set 2...e6" buttons at the ancestor (replacing the path's move) and "Alternatives there".
  - **"How to read this"**: the honesty block.
- **Entry points**:
  - Explorer owner rows get an "Alternatives" link per move, and the position panel gets "See alternatives".
  - Fix cards get a primary **"Try this instead"** (leaks and holes) or "See suggestions" (unprepared).
  - The review callout gets "See alternatives to 2...Bc5" on owner plies. The deviation note gets "See alternatives", and the unprepared note "See suggestions".
  - The repertoire panel gets "See alternatives", or "See suggestions" where there is no move.
- **P7a gaps**:
  - an **Unset** button, which asks for confirmation and then calls DELETE;
  - a **note field** (Save note);
  - a **"Not reached by the lines"** table of `offTree` entries, with Remove;
  - Home's **coverage line**: "Repertoire: stayed in it through move 4: 45% (W) / 1% (B) · through move 6: … · N moves to review · Open the repertoire", or a seed prompt when the repertoire is empty.
- `explorerHref` and `alternativesHref` moved to `src/utils/links.ts`. FixCard re-exports `explorerHref`.

### Verify (`scripts/verify/verify-alternatives.ts`)
- **Positions**: it prints the panel for the Albin, 2...Bc5, 2...Nc6, 1...e5 vs 1.e4, 1...d5 vs 1.d4, a node deep in the Albin, and 1.c4 c5 (White).
- **Checks** (on the golden date):
  - two of e6, c6 and dxc4 are among the Albin's top 3, each within the gate with 6 SAN plies and 2+ reasons;
  - the Albin is questioned with its flag;
  - after 2...Bc5, Nc6 comes first with "owned", and Bc5 is a deep-tier hole;
  - the 2...Nc6 leak gets alternatives, and "change earlier" points to 1...d5;
  - vs 1.d4, the points lost are in 2.c4, and there is no "change earlier" at the start;
  - deep in the Albin, "change earlier" points to 2.c4's moves.
- **Also**: determinism and the honesty block at every position.
- **Engine use**: it runs the missing deep searches with a 2-worker pool and stores them; `--cached` makes it read-only. It also prints the per-open cost.

## Results: the top alternatives for the owner's main leaks (store as of 2026-09-26, 6 months, H = 90, deep tier)

| Position (questioned move) | Deep best | Top alternatives (score; gap in win%) | Notes |
|---|---|---|---|
| **1.d4 d5 2.c4, Albin 2...e5** (watch: 34% over 29, z 1.65; gap 2.8) | e6 | **2...e6** QGD (9.0; 0.0; you play it 11×, 50%) · **2...dxc4** QGA (4.7; 1.3; 2×) · **2...c6** Slav (4.5; 0.6) | Also gated: 2...c5 (Austrian; forcing −1) and 2...Nc6 (Chigorin, 2.9). Points lost: 3.cxd5 −0.51, 3.e3 −0.50, 3.e4 −0.30, 3.dxe5 −0.23. |
| **1.e4 e5 2.Nf3, 2...Bc5** (hole, gap 10.8; 16×, 47%) | Nc6 | **2...Nc6** (7.0; 0.0; 115×, 37%) · **2...Nf6** Petrov (5.7; 0.3; familiar with your Giuoco Piano) · **2...d6** Philidor (4.1; 0.9) | Rejected: d5 (5.5), f5, f6. |
| **1.e4 e5 2.Nf3, 2...Nc6** (leak: 36% over 115, z 2.91; the engine's best) | Nc6 | **2...Nf6** Petrov (5.7; 0.3) · **2...d6** Philidor (2.1; 0.9) | Suggestions only. Points lost: 3.Bc4 −3.16 (then 3...Bc5 −2.84), 3.d4 −2.33 (3...exd4 −2.19), 3.Bb5 −1.18. Change earlier: at 1.e4, 1...d5 (55%, 223×, +5% vs −10%, z 3.12). |
| **1.e4, 1...e5** (leak: 39% over 216, z 2.95; the engine's best) | e5 | **1...d5** Scandinavian (7.2; 3.8; 223×, 55%, "results" +2) · **1...e6** French (6.0; 0.0) · **1...c6** Caro-Kann (4.4; 0.6) | Then 1...c5 and 1...Nf6. Points lost after 1...e5: 2.Nf3 −6.73 (almost all in 2...Nc6), 2.Nc3 −1.08, 2.Bc4 −0.99. |
| **1.c4 c5 (White), 2.Nc3** (60×, 36%; gap 1.1) | Nf3 | **2.Nf3** Symmetrical (7.0; 0.0) · **2.g3** (1.9; 1.1; familiar with your Anglo-Indian g3 lines) · **2.e4** Staunton-Cochrane (0.7; 3.3) | 2.e3 is an engine idea (gap 0.8), listed last. Rejected: 2.b4 (11.2). Points lost after 2.Nc3: 2...Nc6 −1.87 (3.g3 −2.52), 2...Nf6 −1.52, 2...e6 −0.76. |
| **1.d4, 1...d5** (161×, 44%; the engine's best) | d5 | 1...Nf6, 1...e6, 1...c6 | The loss sits in the replies: 2.e3 −2.15 (2...Bf5 −1.34) and 2.c4 −1.72 (2...e5 −1.92, while 2...e6 is +0.30). Nothing flags 1...d5, and there is no "change earlier". |

**Per-open cost** (cold, verify's 2-worker pool, on battery; deep root plus only-move checks):

| Position | Time | Nodes | Searches |
|---|---|---|---|
| Albin | 8.4 s | 6.1M | 11 |
| 2...Bc5 | 7.2 s | 5.4M | 7 |
| 1...e5 vs 1.e4 | 7.4 s | 5.7M | 10 |
| 1...d5 vs 1.d4 | 7.3 s | 5.3M | 9 |
| deep Albin | 5.9 s | 4.3M | 7 |
| 1.c4 c5 | 4.8 s | 3.8M | 9 |

- The deep root alone is 1.5-3.0M nodes, about 2-5 s.
- In the dev server, the Scandinavian 3.Nc3 node took **10.4 s** for 7 searches.
- A second open is answered from the cache: the `--cached` rerun of verify took 3.1 s in total for all 7 positions, with identical output.

## Deviations from the spec, and why

- **The panel is a route, `/alternatives`**, rather than an overlay inside the Explorer. It can be opened from Home, /leaks, the review and the repertoire with a deep link and Back. The panel itself is the reusable `AlternativesPanel` component.
- **The deep tier is depth 18 with a 3M node cap**, not "3M nodes" alone. That is the brief's depth with a cap, and fixed depth keeps the follow-ups depth-matched. When the cap stops a search early, the stored depth is the last completed iteration.
- **The only-move check uses ordinary owner-tier searches** (MultiPV 3 at depth 15) of the sample line's owner positions (plies 3 and 5), not a special search. They are stored like any other owner-tier row and are reused by the tree and the review. The check covers up to 8 gated candidates.
- **The "forcing sharpness" measure** counts checks and captures in the 6-ply line. This is the brief's "measured cheaply on the PV". It shares the −3 cap with the only-moves.
- **Features added by the critic or the brief**:
  - *mainstream*: the book's lineCount share;
  - *results*: better than the questioned move with z ≥ 1.64 over 20+ games. This is the spec's "change earlier" z applied at the node itself, so 1...d5 gets +2 against 1...e5.
- **Engine ideas** are listed and can be set, but they always rank after book and owned moves (the critic's rule). The spec's "require candidates to be book children or owned moves" would hide them entirely. At the deep Albin node they are the only gated moves.
- **Typical replies** are the owner's opponents' moves with 2+ games, then the book's, then the engine's reply. That is the critic's local popularity proxy; there is no online popularity data.
- **The owner's record** is shown from 1 game, with a "low sample" mark below 8. The spec's honesty wording, "results once there are at least 8 games", is kept in the honesty block.
- **Resolving the 2...Nc6 conflict** (P7a) is a seed rule plus the panel's wording: a flagged move that is the engine's best is kept for review, and its alternatives are suggestions. The "leak" kind of "change earlier" skips such moves for the same reason. The Albin, where the flagged move is not the engine's best, is still replaced.
- **The seed's replacement comes from the ranking** only when the book is passed (the server and verify-repertoire now pass it). The P7a unit tests without a book keep the old rule.
- **Adopt** is "Set as my move" (the P7a name).
- **`verify-alternatives` writes deep-tier rows**, like `verify-analysis`, because the brief asks it to check the deep ranking. `--cached` keeps it read-only.

## Check and verify results

- **`npm run check`**: typecheck (web, server, test) OK, vitest **385/385** (36 files; P7a had 359), vite build OK.
  - **`shared/alternatives.test.ts`** (19), on a synthetic book and games:
    - the Albin: the question, flag and gap; e6, c6 and dxc4 in order, with 6-ply lines;
    - the feature points: owned 4, named 3, mainstream 2, eval gap 0; the Slav's only move −1, with `onlyMoves {2, 1, 1}`; dxc4's forcing −1;
    - the gate: an unscored Baltic is rejected, an engine idea comes last despite a smaller gap, and a move 5+ win% down is dropped;
    - points lost by reply and answer;
    - the repertoire move and an asked move;
    - the honesty block, and determinism (identical JSON, and reversed game order);
    - 2...Bc5 → Nc6 first as owned, with typical replies from the games;
    - "change earlier": absent with no better sibling; 1...d5 over 1...e5 (z); the leak kind deep in the Albin; none for an engine-best flagged move;
    - transposes and familiar, pawn sets and Jaccard, and the candidates and only-move positions.
  - **`shared/repertoireSeed.test.ts`** (+2):
    - an engine-best flagged 2...Nc6 is kept, needs-review, with the reason;
    - with the book, the Albin override takes the named Slav over a non-book engine line (without the book, still the old choice).
  - **`server/db/engineStore.test.ts`** (+1): the deep tier's separation (the lookups, counts, stamp, listing and ETA ignore it, `protocol_json` does not contain it, and the same config id).
  - **`server/routes.test.ts`** (+4):
    - the first open is 202 with the job; the job completes with `cost` and a deep row of 4 lines under the one config; the second open is 200 with no search and the same result;
    - 400 at an opponent node and for an illegal move;
    - PUT with `replaces`, and 400 for an illegal replaced move;
    - the coverage endpoint.
- **Verify** (`--asof 2026-09-26`):
  - verify-import, verify-tree, verify-fixlist, verify-analysis and verify-repertoire: OK. The repertoire now seeds with the book and gives the same golden lines;
  - **verify-alternatives: OK**;
  - verify-evals: OK; engine-smoke: OK.
- **Browser smoke** (`npm run dev` in the background, http://localhost:5173, then stopped):
  - **1280 px, the Albin panel**:
    - the header reads "Your move: 2...e5 · Engine: +0.6 after it, 2.8 win% below the best move · Watch-tier results: you score 34% over 29 games";
    - the cards are e6, dxc4 and c6, plus c5 and Nc6, with their reasons, and the board shows the sample line;
    - **Set as my move** on 2...c6 gave "2...c6 is now your repertoire move there (edited, locked)". The row is `edited`, locked, with `replaced` = e5 (loss 2.83, "Set from the alternatives: 2...c6 (named, mainstream).");
  - **A cold node** (1.e4 d5 2.exd5 Qxd5 3.Nc3): the spinner showed "Deep engine check of the position (MultiPV 4, depth 18) · 5%" over the preliminary cards, then "This open searched 7 positions in 10.4 s";
  - **Explorer** at 1.e4 e5 2.Nf3: links "See alternatives to 2...Nc6" and "…2...Bc5". The Bc5 panel ranks 2...Nc6 first ("You have played it: 115 games, 37%"), then Petrov and Philidor;
  - **/leaks**: 8 "Try this instead" links, e.g. the Albin card → `/alternatives?color=black&moves=d2d4,d7d5,c2c4&uci=e7e5`;
  - **The review** of 170668883708 at 2...Bc5: "2...Bc5 is a mistake (−12% win chance) · See alternatives to 2...Bc5". Opening it ran that game's P6 review job;
  - **/repertoire**:
    - before seeding, the edited c6 entry appeared under "Not reached by the lines · 1";
    - after Seed → Apply 284 changes, the edit was kept;
    - on the 1.e4 panel, "Save note" gave "Note saved.";
    - **Unset** gave "1...d5 removed. A re-seed may suggest a move here again.";
  - **Home**: "Repertoire: stayed in it through move 4: 45% (W) / 1% (B) · through move 6: 4% (W) / 0% (B) · 220 moves to review";
  - **375 px**: scrollWidth 375 on /alternatives (no element past the viewport; the board stacks above the cards, and the loss bars wrap under their labels), /explorer, /repertoire and Home;
  - **Console**: no errors;
  - **Afterwards**:
    - no vite, tsx, concurrently or Stockfish processes, and nothing on 3001/5173; viewport reset; pane closed;
    - **`repertoire_entries` cleared again**: the owner's repertoire is empty, as P7a left it.
- **Owner data**:
  - `positions` gained 7 deep rows and about 20 owner and opponent rows (only-move checks and one review);
  - `game_analysis` went from 48 to 49 rows (the reviewed game);
  - `storage/cache` is untouched, and **no backfill was run**.

## Known gaps / notes for P8

- **Owner-tier coverage is still thin**: 49 of 1,375 games are engine-checked. The panel's own positions are fine, because the deep tier is searched on demand. Run the full backfill (on mains) before judging the seed's "results only" entries.
- **Tune the ranking weights**. The points are the spec's; they were not tuned. Two known effects:
  - "familiar" fires often at early plies: one different pawn out of 16 already passes 0.85, e.g. the French "as your 1.e4 d5 2.e5 c5 … e6";
  - the eval-gap text says "as good as the best (within 1 win%)" while still subtracting the gap.
- **The only-move check** looks at the sample line only, not every reply, and uses depth 15. Forcing is a SAN count.
- **The panel does not compute a deep tier for the ancestors.** "Change earlier (leak)" uses a cached deep row if one exists, else the owner-tier MultiPV 3 row. Unscored book moves there are skipped.
- **P8 drills can reuse**:
  - `AlternativesResult.alternatives[i].sampleLine`, the steppable SAN line, as a drill line;
  - `PlayableBoard` (P6) with `judgeRetry`;
  - the deep tier, via `getDeepEval` and `analyseGame` with `tier: "deep"`, for "is this move good enough" checks off the owner tier.
- **`JobType`** gained `alternatives`. The client only follows sync jobs across reloads, so an alternatives job interrupted by a reload restarts (joins) on the next open.
- **"Set as my move" at an ancestor** (Change earlier) writes that entry, but leaves the deeper entries of the old line in place. They show up under "Not reached by the lines", where the owner can remove them.
