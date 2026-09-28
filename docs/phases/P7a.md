# P7a: Repertoire model, deterministic seeding, deviation and coverage, and the repertoire page

Branch: `phase/p7a-repertoire` (from `phase/p6-opening-review` at b801c59). Not pushed, not merged.

## Commits

| Hash | Subject |
|---|---|
| 85f406b | feat(repertoire): SQLite repertoire store, deterministic seeding with the results-leak override, deviation and coverage, and the repertoire API |
| 0a9998f | feat(web): repertoire page with tagged lines, a review queue, seed preview, lock and edit; Set as my move in the Explorer; the deviation marker in the review |
| 3687199 | fix(web): scroll the chosen position into view, keep move chips on their row at 375 px, and number the replaced move in the Explorer note |
| d372fc4 | docs: describe the repertoire, its seeding rules, the endpoints and verify-repertoire |
| (this commit) | docs: add the P7a phase report |

Every commit typechecks (web, server, test) and passes the tests.

## What was done

### Store (`server/db/migrations.ts` v4, `server/db/repertoire.ts`)
- `repertoire_entries (username, color, epd, uci, san, source, status, locked, replaced_json, reason, note, ply, updated_at)`, primary key `(username, color, epd)`.
  - One owner move per colour and owner-to-move EPD, so transposed positions share one entry.
  - `source`: `from-games` | `seed-engine` | `edited`. `status`: `active` | `needs-review`.
  - `replaced_json`: `{uci, san, loss, reason}` of the move the entry replaced.
  - `reason`: the seed's explanation, facts only. `note`: the owner's own note.
- `applySeedChanges` writes a diff in one transaction and keeps the row's lock and note.
- `repertoireStamp` (count + Σ updated_at) keys the fix-list memo.

### Seeding (`shared/repertoireSeed.ts`, pure and deterministic)
- **Walk**: breadth-first from the start to `REPERTOIRE_MAX_PLY = 16`.
  - Opponent nodes: it follows replies with 2+ games or a 5% weighted share.
  - Owner nodes: it needs 3+ games to choose a move. A locked or edited entry is kept, and the walk follows its move.
- **Choice at an owner node**, in order:
  1. **The owner's most-played move.** Ranked by recency-weighted n, then Δ per game, then loss, then UCI. The engine loss must be below 5 → `from-games`, `active`.
     - A move the cache has not scored is accepted on results alone and marked `needs-review`.
  2. **Engine hole.** When the most-played move loses 5 or more, the best sound move the owner also plays replaces it (e.g. 2...Bc5 → 2...Nc6), else the engine's best line → `seed-engine`, `needs-review`.
     - `replaced` records the move and its loss. The reason says "engine hole" at 7+ and "inaccuracy" below that.
  3. **Consolidation.** A sound or unknown sibling with 8+ games that scores better replaces the choice when z = ΔΔ/√(0.24/ess_s + 0.24/ess_c) ≥ 1.64 → `needs-review`, with `replaced`.
     - **Close rival**: a sibling played in at least half as many games (8+) keeps the choice, but marks it `needs-review` with the rival as `replaced`. This is how 1...d5 (220 games) over 1...e5 (216) shows up, with z 3.18.
  4. **Results-leak override** (the critic's rule). The chosen move may be a fix-list leak or watch-tier edge with n ≥ 15, such as the Albin: 29 games, 34%, z 1.65, engine loss 4.3.
     - An engine-sound (< 5), unflagged sibling then replaces it. A move the owner plays is preferred (by wN), else the engine's lowest-loss line → `seed-engine`, `needs-review`.
     - `replaced` = the flagged move, with the results evidence.
- `seedDiff` gives, per colour:
  - the changes: `add`, `change` (another move), `update` (same move, other status/source/reason) and `remove` (a non-protected entry the walk no longer reaches);
  - the counts of `kept` (locked or edited entries) and `unchanged` entries;
  - each change's `line` in SAN.
- `seedFlags` turns fix-list items into `epd|uci` flags by replaying their moves.

### Deviation, coverage, unprepared (`shared/repertoire.ts`, computed at read time)
- **`walkRepertoire(game, entries)`** walks the first 16 plies and stops at the first event:
  - `deviation {ply, epd, played, expected}`: an owner move that differs from its entry;
  - `unprepared {ply (the opponent's), parentEpd, opp, epd}`: an opponent move into an owner position without an entry.
  - It also returns `inRepThrough`. A game that ends inside the repertoire counts as staying in it. White games are not measured when the start has no entry.
- **`repertoireStats`** gives:
  - coverage through **ply 8 and 12** per colour;
  - the deviations table and the unprepared table (n, raw score, recency-weighted points lost, example games);
  - `byGame` (deviationPly / unpreparedPly / inRepThrough).
- **Fix list**: a new kind, `unprepared` (`UnpreparedItem`).
  - An item needs n ≥ 3 and points lost > 0; its impact is the points lost. It is merged into `ranked` with leaks and holes.
  - `FixListResponse.unprepared` counts them. The memo also keys on the repertoire stamp.

### API (`server/routes.ts`, `server/services/repertoireService.ts`)
- **`GET /api/repertoire?window&tc&hl`** gives, per colour:
  - the lines walked from the start, as nodes with their entry, the entry's games/score/loss, the options (the owner's moves and the engine's lines, with loss) and the children;
  - the coverage and the tables;
  - `offTree`: entries the walk no longer reaches.
- **`POST /api/repertoire/seed {apply?, window, tc, hl}`**: a dry-run diff; `apply: true` writes it.
- **`GET | PUT | DELETE /api/repertoire/entry`**:
  - the EPD travels in the body (PUT) or the query (GET, DELETE), never in a path segment (critic);
  - PUT with `uci`/`san` sets an **edited, locked, active** entry, and the old move goes into `replaced`;
  - PUT without a move changes only `locked` / `status` / `note`. An unchanged PUT writes nothing, not even `updatedAt`, so the round trip is lossless;
  - errors: 400 for an illegal move or the wrong side to move, 400 for a new entry without its `ply`, 404 for a DELETE of nothing.
- **`GET /api/repertoire/export?color=`**: PGN with variations. The main line follows the most common reply, and comments carry "edited", "suggested, replaces X" and "needs review". chess.js reads it back.
- **Other responses**:
  - `GET /api/tree` carries the node's entry (`repertoire`);
  - `GET /api/games/:id/analysis` carries `repertoire {entries, deviation, unprepared, inRepThrough}`.

### UI
- **`/repertoire`** (nav: Repertoire):
  - **Summary card**: per colour, the moves, the number to review, "through move 4: 45% · through move 6: 4%" and a PGN download.
  - **Seed / Re-seed**: opens a preview with the counts and the changed lines, then "Apply N changes". Locked and edited entries are never changed.
  - **Line tree** per colour:
    - rows of the opponent's reply and the owner's answer, with the replies ordered by games;
    - collapsible, open to ply 5, with Expand all / Collapse;
    - transpositions link to where the position is shown;
    - every owner move is chipped **"from your games"**, **"suggested · replaces 2...e5"** or **"edited"**, plus "needs review" and a lock icon;
    - a position without an entry shows "no move yet · N games".
  - **Position panel**, sticky on desktop and above the tree on phones:
    - the board with the move's arrow and the name;
    - "Your move: 2...e6", with the replaced move and its reason, and the seed's reason;
    - games, score and engine loss;
    - **Accept** (active + locked), **Lock/Unlock** and **Explorer**;
    - "Change your move": the owner's moves and the engine's, with games, score and loss, the engine star and **"Set as my move"**.
  - **Needs-review queue**: "Suggested changes" (entries with a replaced move) first, then a fold of the entries "chosen on your results only, until the engine checks them". Choosing one selects it and scrolls it into view.
  - **Tables**: "Where you leave it" (deviations, with a review link) and "Not prepared".
- **Explorer**:
  - the owner's rows show **"My move"** on the entry, or a **"Set as my move"** button (an edited, locked entry);
  - the position panel shows "Repertoire: 2...e6 (suggested (replaces your 2...e5), needs review). Open the repertoire".
- **Review**:
  - a note: "You left your repertoire here: played 6...Bf5, repertoire says 6...Qc7", with "Go there" from other plies. Or "Opponent move you have not prepared: 4.Nf3", with a link to that Explorer position. Or "You followed your repertoire through move N";
  - the move is underlined in the move list (amber for a deviation, violet for an unprepared reply), with the text in its aria-label.
- **/leaks**: violet "Unprepared reply" cards, and the header counts them separately ("2 leaks · 5 theory holes").

### Verify (`scripts/verify/verify-repertoire.ts`, read-only)
Seeds in memory from the store and prints:
- the lines to ply 10 per colour (replies with 5+ games);
- the review queue with its reasons;
- the coverage;
- the top deviations and unprepared replies.

It checks:
- determinism;
- no seeded move with a known loss ≥ 5;
- unique EPDs;
- on the golden date: White root 1.c4; 1.c4 e5 → 2.Nc3; vs 1.e4 1...d5 as a needs-review consolidation over 1...e5; vs 1.d4 1...d5;
- 1.d4 d5 2.c4 ∈ {e6, c6, dxc4}, as a `seed-engine` needs-review replacement of 2...e5;
- an entry after 1.e4 d5 2.exd5 Qxd5 3.Nc3;
- 2...Nc6 after 1.e4 e5 2.Nf3, whenever that position is reached.

## The seeded repertoire (store as of 2026-09-26, 6 months, H = 90, engine config #1 with 697 positions)

The seed takes 22 ms. White gets **198 entries** (157 need review) and Black **88** (65 need review). Almost all of the review items are "results only": only 48 games are engine-checked.

- **White**: 1.c4.
  - 1...e5 2.Nc3, then 2...Nf6 or 2...Nc6 3.g3 and 4.Bg2 (4.cxd5 against 3...d5; 4.Qc2 against 3...Bb4).
  - 1...d5 2.cxd5 Qxd5 3.Nc3.
  - 1...e6 2.Nc3 (needs review). 1...c5 2.Nc3 with 3.g3 (needs review).
  - One suggestion: 3.g3 over 3.e3 in 1.c4 e5 2.Nc3 Bc5 (a close rival).
- **Black against 1.e4**: 1...d5, suggested with needs-review against 1...e5 (220 vs 216 games; +5% vs −10% against expectation, z 3.18; engine loss 4.0 vs 0.0).
  - 2.exd5 Qxd5 3.Nc3 Qa5, with 4.Nf3 Nf6 5.d4 c6, 4.d4 c6 5.Bd2 Qc7, 4.b4 Qxb4 and 4.d3 c6. 3.Nf3 Nf6. 3.d4 Nc6.
  - 2.e5 c5: 3.Nf3 Bf5 4.d4 e6, 3.c3 Bf5, and **3.d4 cxd4, suggested for 3...Bf5** (an 11.1 loss).
  - 2.Nf3 dxe4 3.Ng5 Bf5. 2.Nc3 dxe4 3.Nxe4 Bf5.
- **Black against 1.d4**: 1...d5.
  - **2.c4 e6, suggested for the Albin 2...e5** ("Watch-tier results: you score 34% over 29 games (expected 50%, z 1.65)"; you play 2...e6 in 11 games at 50%, loss 0.0), 3.Nc3 Nf6.
  - 2.Bf4 c5 (a close rival of 2...Bf5, 17 vs 18 games), 3.c3 Nf6 (suggested for 3...Bf5). 2.Nf3 c5 (a close rival of 2...Bf5). 2.e3 Bf5 (a rival of 2...c5). 2.Nc3 Bf5.
- **Black against other first moves**: 1.e3 e5, 1.c4 e5, 1.Nf3 d5, 1.d3 d5, 1.b3 e5. 1.g3 d5 2.Bg2 **e5, suggested for 2...Bf5** (an 8.2 loss, engine hole).
- **Coverage** of the window's games against this seed:
  - White: through move 4 **45%**, through move 6 **4%**.
  - Black: **16%** and **2%**. 216 of the 1.e4 games play 1...e5 (deviation at ply 2), and 29 play the Albin.
- **Unprepared replies**: every row has 2 games or fewer, because the seed follows every reply with 2+ games. So there are no unprepared fix items yet (see Deviations).

## Deviations from the spec, and why

- **The model follows the brief**: `from-games` / `seed-engine` / `edited` and `active` / `needs-review`, stored in SQLite (OVERRIDES), not in `repertoire.json`. The table adds `reason` (the seed's explanation), `ply` and `username`.
- **Consolidation also covers the "close rival" case.** Against 1.e4, 1...d5 is already the most-played move, by raw count (220 vs 216) and weighted (150 vs 88). The z rule (which only fires for a less-played sibling) therefore never runs there. The spec's acceptance still wants 1...d5 marked needs-review, and the risk section says the default must stay visible. So a sibling played in at least half as many games (8+) marks the choice for review, with the rival as `replaced`. A consolidation sibling needs 8+ games, so a 3-game 100% line cannot trigger it.
- **The results-leak override uses n ≥ 15 for both the leak and the watch tier** (the critic's gate). A replacement the owner plays is preferred, else the engine's lowest-loss line.
- **Replacement starts at loss 5, not 7.** "The most-played move whose loss is below 5" means a 5-7 inaccuracy is replaced too. The reason text still says "engine hole" at 7+ and "inaccuracy" below that.
- **1.e4 e5 2.Nf3 is not reached in the real data**, because 1.e4 is answered by 1...d5. The 2...Bc5 → 2...Nc6 replacement is covered by the unit test, and verify checks it only when the position is reached.
  - Note for P7b: in the real data **1.e4 e5 2.Nf3 Nc6 is itself a fix-list leak** (n 115). So if the owner edited 1...e5 back in, the override would replace 2...Nc6 by an engine-sound sibling. The spec's "the entry is 2...Nc6" and the critic's override disagree there. P7b's alternatives panel ("where the points are lost": the leak sits in the 3.Bc4 lines) is the place to settle it.
- **`deviationPly` / `unpreparedPly` are not fields of `GameOpeningAnalysis`.** That analysis is memoised per position-cache generation, and the repertoire changes independently. They live in `RepertoireStats.byGame` and in the review response's `repertoire` block instead.
- **Coverage is through ply 8 and 12**, per colour (the brief), and not per month at plies 4/8/12/16 (the spec).
- **Unprepared fix items need n ≥ 3 and points lost > 0.** Right after a seed there are none (see above). They appear as new games arrive, or after an edit leaves positions without a move.
- **The seed uses the request's filters** (default 6 months, H = 90). The page seeds with the filters it shows.
- **"Unset" is API-only.** `DELETE /api/repertoire/entry` exists, but there is no remove button yet. "See alternatives" and "Why?" are P7b.
- **Home has no coverage line.** It is not in the P7a brief; coverage is on /repertoire. P7b can add it.
- **Owner data**:
  - The smoke test seeded, edited and accepted entries in `storage/chess.db`, then **cleared `repertoire_entries`**. The owner's database now has migration 4 and an empty repertoire: one click on "Seed from my games" → Apply builds it.
  - Opening two partial reviews during the smoke test ran their P6 jobs: positions went from 675 to 697 and game_analysis from 46 to 48.
  - `storage/cache` is untouched, and no backfill was run.

## Check and verify results

- **`npm run check`**: typecheck (web, server, test) OK, vitest **359/359** (35 files; P6 had 331), vite build OK.
- **`shared/repertoireSeed.test.ts`** (15), on synthetic trees with a stub engine:
  - the most-played sound move;
  - results-only needs-review;
  - **2...Bc5 → 2...Nc6** (seed-engine, replaced Bc5 with loss > 10, "engine hole");
  - the engine's move when no sound sibling is played;
  - the Albin kept without a flag;
  - **the Albin override** through the real `buildFixList` → `seedFlags` → 2...e6 (seed-engine, needs-review, replaced e5 with "you score 30% over 20 games");
  - the override with the engine's line when the owner never played a sound sibling;
  - no override under 15 games;
  - consolidation (z 2.xx) and no consolidation under 8 games;
  - the close rival;
  - the 3-game and 2-reply gates;
  - transpositions giving one entry;
  - **byte-identical output** for reversed input;
  - **locked and edited entries never overwritten**, and followed by the walk;
  - the diff kinds.
- **`shared/repertoire.test.ts`** (9):
  - the deviation;
  - the unprepared reply;
  - staying in to the end and past the depth;
  - **deviation detection across transpositions**;
  - an unmeasured White game;
  - coverage 8/12 and both tables (points lost, examples, `byGame`);
  - an added entry updating coverage at once;
  - unprepared items in the fix list;
  - `repTag`.
- **`server/services/repertoireService.test.ts`** (2):
  - the line walk (children, leaves with options, unprepared);
  - the exact PGN with variations and comments, read back by chess.js;
  - edit semantics (lock/note apart from the move, replaced, ply required).
- **`server/routes.test.ts`** (+2; its helper now parses JSON by content type):
  - dry-run seed then apply, and a second seed with no changes;
  - PUT sets an edited, locked entry, and GET matches it;
  - **the PUT round trip is lossless** (same `updatedAt`);
  - **a re-seed keeps the edit**;
  - the tree node carries the entry, and the PGN export works;
  - 400 for an illegal move and for the wrong side, 204 then 404 on DELETE;
  - the review's `repertoire` block gives the deviation at ply 1.
- **Verify scripts** (`--asof 2026-09-26`):
  - `verify-import` OK, `verify-tree` OK, `verify-fixlist` OK (now prints the `unprepared` kind), `verify-analysis` OK;
  - **`verify-repertoire` OK** (above);
  - `verify-evals` OK, `engine-smoke` OK.
- **Browser smoke** (`npm run dev` in the background, http://localhost:5173, then stopped):
  - **1280 px, /repertoire?color=black**:
    - The empty state leads to "Seed from my games", a preview ("286 new · 0 changed · 0 removed …") and Apply.
    - The summary shows 198 / 88 moves.
    - The tree has chips and transpositions, e.g. "…Nf6 transposes to 1.c4 e5 2.Nc3 Nf6 3.g3 Nc6".
    - The 1.e4 panel reads "suggested (replaces your 1...e5) · needs review", with the rival's reason and the options (1...e5 216 · 40% loss 0.0 ★, 1...e6 "engine idea" 0.2).
    - The queue's Albin item selects and scrolls to 2...e6, with "Replaces 2...e5 (engine loss 4.3): Watch-tier results…". **Accept** gave "2...e6 accepted and locked." (the lock icon; 64 left to review).
  - **Explorer** `?color=black&moves=d2d4,d7d5,c2c4`:
    - the rows showed "2...e6 My move" and "Set as my move" on 2...e5 and 2...dxc4;
    - **Set as my move** on 2...dxc4 gave "2...dxc4 is now your repertoire move here." and "Repertoire: 2...dxc4 (edited)".
  - **Re-seed dry run after the edits**: White 0 changes; Black kept 1 (the edit), with 1 `remove` (3...Nf6 after 2...e6 3.Nc3, now unreached).
  - **PGN export**: headers plus variations, e.g. "(2. c4 dxc4 {edited} 3. e4)".
  - **Review 184065000138**: "You left your repertoire at 6...Bf5: played 6...Bf5, repertoire says 6...Qc7. Go there". Go there selects the ply ("You left your repertoire here: …"), and the move is underlined in amber.
  - **Server restart**: the edited 2...dxc4 entry was still there (GET /api/repertoire/entry).
  - **375 px**:
    - /repertoire has scrollWidth 375, and the panel sits above the tree. The owner-move chips once wrapped onto their own line; they now wrap inside the chip (3687199).
    - The Explorer rows ("1...d5 My move", "Set as my move") fit in its scroll container.
    - /leaks reads "2 leaks · 5 theory holes".
  - **Console**: no errors.
  - **Afterwards**:
    - no vite, tsx, concurrently or Stockfish processes, and nothing listening on 3001/5173;
    - the viewport reset to desktop;
    - the smoke test's repertoire rows deleted.

## Known gaps / notes for P7b

- **Alternatives** (P7b): the ranking, the panel, "See alternatives" / "Why?" on fix cards and Explorer rows, "Where the points are lost", "Change earlier", the mainstream feature and the honesty block. The seed's replacement choice (the owner's sound sibling by wN, else the engine's lowest-loss line) is deliberately simple. P7b's ranked top alternative could replace it (`replacement()` in `shared/repertoireSeed.ts`).
- **The 2...Nc6 leak conflict** (see Deviations): decide whether the override applies when the flagged edge is the owner's main line and the points are lost deeper (blame attribution).
- **Unset / remove UI**, the note field in the UI (the API supports both), and a list of the `offTree` entries (only their count is shown).
- **Home coverage line** ("stayed in repertoire through move 4: 45% (W) / 16% (B)"); the numbers are in `GET /api/repertoire`.
- **Needs-review volume**: 157 W / 65 B, mostly "results only" because only 48 games are engine-checked.
  - After the owner's full backfill, a re-seed turns unlocked results-only entries into `active` ones (an `update` in the diff).
  - Holes and leaks found later come back as `change` suggestions.
- **The repertoire's positions are not queued for the engine.** P7b's deep search (MultiPV 4) could also score the owner nodes the seed marked "results only".
- `REPERTOIRE_MAX_PLY` (16) is below `OPENING_PLY_LIMIT` (20). The tree and review windows are unchanged.
