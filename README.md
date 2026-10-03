# Opening Trainer

A local-first chess opening trainer that runs entirely in your browser. It helps you learn,
practise and retain a practical repertoire:

- **White:** the English Opening (1.c4) with a Nc3 / g3 / Bg2 setup, organised by Black's first reply.
- **Black:** the Scandinavian against 1.e4, the Queen's Gambit Declined and solid ...Nf6 systems
  against 1.d4, 1...e5 against 1.c4 and 1...d5 against 1.Nf3, plus optional chapters (such as
  1...e5 against 1.e4) that you switch on yourself.

Main lines come first. The content is a sound practical starting point, not complete theory.

No account, no server and no paid API: progress is stored in the browser (IndexedDB) and the
optional engine (Stockfish 19 lite, WebAssembly) runs in a Web Worker on your machine.

## Run it

Requires Node 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173. Other commands:

| Command | What it does |
|---|---|
| `npm run build` | Typecheck and build the static site into `dist/` (deploy it to any static host). |
| `npm run preview` | Serve the built site locally at http://localhost:4173. |
| `npm test` | Run the unit tests (Vitest, Node). |
| `npm run typecheck` | TypeScript for the app, the tests and the scripts. |
| `npm run content:check` | Validate every repertoire file in `content/` (legality, FEN checkpoints, notes, hints, conflicts, opening names). |
| `npm run check` | All of the above: typecheck, tests, content check and a production build. |
| `npm run engine:verify` | Verify the vendored Stockfish files against their pinned checksums. |

The build is a plain static site. `scripts/spa-fallback.mjs` copies `index.html` to `404.html`
so hosts without rewrite rules (such as GitHub Pages) still open deep links; serve it from the
domain root.

## What is in the app

| Page | What it is for |
|---|---|
| **Home** | What is due today, a Start practice button, your practice streak, first-try accuracy, weakest positions and recent mistakes. |
| **Repertoire** | White and Black tabs. Opening families, chapters and named lines with a short description, key ideas, typical plans, depth, ECO code and mastery. Switch lines on or off and mark them learning, reviewing or mastered. Add lines of your own from moves or PGN. |
| **Line page** | Step through a line with an explanation of every move, try other moves on the board, see plans and traps, export PGN or content JSON. |
| **Practice** | Four modes (below). |
| **Progress** | Accuracy by opening, mastery per line, mistakes, weakest positions, the review schedule and daily activity. |
| **Settings** | Board colours, coordinates, legal-move dots, animation; sound; engine on/off, thinking time and sparring strength; new positions per day and when the move is shown; backup export/import and reset. |

### Practice modes

- **Next move**: a position from your lines; find your move. This is the spaced-review session
  that Start practice opens.
- **Play the line**: play a whole variation from move one; the trainer plays the opponent's
  moves and explains what they intend.
- **Position recall**: a position from one of your lines; name the line, or pick the plan that
  belongs to it.
- **Sparring**: play a game from move one. The trainer answers with the replies your lines
  prepare for; when you or it leave the lines it continues with known opening moves (from the
  opening list) or the engine, and labels your moves as you go.

### Feedback and hints

A wrong move never reveals the answer. The piece goes back, the trainer says what kind of move
it was, and hints escalate:

1. the idea (development, the centre, king safety, preventing a plan…), without the move;
2. the piece or the area of the board;
3. the move itself, only when you ask for it or after repeated wrong tries (three by default).

When a move is shown or found, the trainer explains what it achieves, why it fits the opening
and what common mistake it avoids. Moves are labelled **Book move**, **Acceptable
alternative**, **Inaccuracy**, **Mistake** or **Not in your repertoire**. An unfamiliar legal
move is never called bad just because it is not in your lines: "inaccuracy" and "mistake" need
evidence from the engine (or a mistake listed in the content). With the engine off, such a move
is simply "not in your repertoire". Engine results are translated into plain chess language
(material won or lost on the reply, threats, opening principles), not raw evaluations.

### Spaced review

Every repertoire position you must find a move in is a review item, and so is every line. Items
move through Leitner boxes (1, 3, 7, 16, 35, 60 days). A clean answer moves an item up; a
hinted answer keeps it in place with a shorter interval; a missed or revealed answer sends it
back to tomorrow, and the session asks it again a few positions later. The queue puts overdue
items and recent errors first, then new positions in teaching order: main lines before
sidelines, earlier moves first, a daily cap on new positions.

## Your data

Everything lives in this browser's IndexedDB: progress per position and per line (attempts,
correct and incorrect answers, retries, hints, reveals, last practised, mastery, weak moves,
next review date), every answer, your settings, line choices and own lines. Clearing site data
or using a private window removes it, so use **Settings → Export a backup** now and then. A
backup imports back with merge or replace.

## Adding or revising lines

All built-in content is JSON in `content/white/` and `content/black/`, one file per chapter, no
code involved. The format, every field and the writing rules are in
[content/README.md](content/README.md). In short:

1. Add a line to the chapter's `lines` with a new `id`, a `name`, a `priority` and the `moves`
   from the start (`"1.c4 e5 2.Nc3 Nf6 3.g3 d5"`).
2. Add `notes` for your new moves: the idea, two hints that do not give the move away, and what
   the move achieves, why it fits and what it avoids.
3. Run `npm run content:check` and reload the app.

Line ids are where your progress is stored, so keep them stable. Lines you add in the app
(Repertoire → Add a line) stay in your browser; a line's page can export it as content JSON for
the repertoire files.

## Sources and licences

- Opening principles follow the ideas of *Chess Opening Fundamentals* by GM Igor Smirnov. The
  explanations are original; no text from the book is reproduced.
- Opening names and ECO codes: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
  (CC0), vendored in `data/chess-openings/`. The list names unsound lines too, so a name is
  never treated as a recommendation.
- Engine: [Stockfish.js](https://github.com/nmrugg/stockfish.js) 19 lite single-threaded build of
  [Stockfish](https://github.com/official-stockfish/Stockfish), GPL-3.0, vendored in
  `public/stockfish/` (see its `SOURCE.md`; `node scripts/update-stockfish.mjs` re-vendors it).
- Chess rules, SAN and PGN: [chess.js](https://github.com/jhlywa/chess.js). Board:
  [react-chessboard](https://github.com/Clariity/react-chessboard).

The repertoire content was written and engine-checked with AI assistance and is marked as a
draft in each chapter's `review` block until you have reviewed it.

## Project layout

```
content/            repertoire chapters (JSON) and the format guide
data/chess-openings lichess opening names (CC0)
public/stockfish/   the WASM engine (GPL-3.0)
scripts/            content check, vendoring scripts, SPA fallback
src/core/           pure logic: chess helpers, content compiler and repertoire tree, opening names,
                    engine protocol and explanations, training (judging, hints, scheduling,
                    mastery, queue, recall, sparring, statistics)
src/engine/         the Stockfish Web Worker client
src/storage/        IndexedDB store, backups
src/app/            app state provider, engine hooks, sounds
src/practice/       the exercise logic shared by the practice modes
src/components/     board, move list, dialogs and other UI pieces
src/pages/          Home, Repertoire, line page, Practice modes, Progress, Settings
```
