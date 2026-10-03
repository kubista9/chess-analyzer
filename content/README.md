# Repertoire content

Every opening line the trainer teaches lives in this folder as plain JSON, one file per chapter:

```
content/
  white/   chapters you play as White (the English Opening, 1.c4)
  black/   chapters you play as Black, grouped by White's first move
```

The app picks up every `*.json` file here automatically. You never need to change code to add,
remove or revise a line. After editing, run:

```bash
npm run content:check
```

It replays every move with chess.js and reports illegal moves, wrong FEN checkpoints, notes that
point nowhere, hints that give the move away, and two enabled lines that disagree about your
move in the same position.

## The quickest way to add a line

1. Open the chapter file it belongs to (or copy an existing file to start a new chapter).
2. Add an entry to `lines` with a new, never-used `id`, a `name`, a `priority` and the `moves`
   from the start position.
3. Add `notes` for your own moves that are new in this line (shared moves already have notes).
4. Run `npm run content:check`, then reload the app.

You can also add a line inside the app (Repertoire → Add a line, from moves or a PGN). Those
lines are stored in your browser; the line page can export one as JSON for this folder.

## A chapter file

```json
{
  "schemaVersion": 1,
  "id": "white-english-example",
  "side": "white",
  "group": "English Opening",
  "family": "English Opening",
  "chapter": "1...e5: the Reversed Sicilian",
  "order": 10,
  "summary": "One or two sentences on what this chapter is about.",
  "ideas": ["Short strategic ideas that hold for the whole chapter."],
  "source": {
    "kind": "editorial",
    "references": ["Opening principles: Chess Opening Fundamentals (I. Smirnov), ideas only, no text reproduced"]
  },
  "review": { "status": "draft", "confidence": "medium", "checkedWith": ["chess.js legality"] },
  "notes": {
    "1.c4": {
      "idea": "centre",
      "hint": "Start by taking a share of the centre without committing your central pawns.",
      "narrow": "A flank pawn on the queenside can control d5.",
      "why": "Controls d5 from the side and keeps the d- and e-pawns flexible.",
      "fits": "The English builds pressure on the light squares before deciding the centre.",
      "avoids": "Rushing a fixed pawn centre that gives Black an early target."
    },
    "1.c4 e5": { "why": "Black takes the centre directly, a Sicilian with colours reversed." }
  },
  "lines": [
    {
      "id": "eng-example-closed",
      "name": "Closed system with g3 and Bg2",
      "eco": "A25",
      "priority": "main",
      "moves": "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3",
      "description": "A short, original description of the line.",
      "plans": ["A typical plan once the opening is over."],
      "traps": [],
      "checkpoints": []
    }
  ]
}
```

### Fields

Chapter (the file):

| Field | Meaning |
|---|---|
| `id` | Unique chapter id (lower-case words joined by hyphens). |
| `side` | `white` or `black`: the colour you play in every line of the chapter. |
| `group` | The top grouping on the Repertoire page, e.g. `English Opening`, `Against 1.e4`. |
| `family`, `chapter` | The opening family and the chapter title. |
| `order` | Sort order within the side (lower first). |
| `summary`, `ideas` | What the chapter is about and its key strategic ideas. |
| `source`, `review` | Where the content comes from and how far it has been checked. |
| `notes` | Move explanations (below). |
| `lines` | The lines. |

Line:

| Field | Meaning |
|---|---|
| `id` | Stable id. Your progress is stored under it, so never reuse an id for a different line. |
| `name`, `eco` | Display name and ECO code (optional). |
| `priority` | `main`, `secondary` or `sideline`. Main lines are taught first. |
| `defaultEnabled` | `false` for an optional line you switch on yourself on the Repertoire page. |
| `moves` | The whole line from the start, e.g. `"1.c4 e5 2.Nc3 Nf6 3.g3"`. End on your own move. |
| `description`, `plans`, `ideas` | What the line is about and how play continues after it. |
| `traps` | `{ "name", "moves" (full path), "side": "for" or "against", "description" }`. |
| `checkpoints` | `{ "ply", "fen" }`: the position after that many plies, checked by `content:check`. |
| `recall` | `{ "ply" }`: the position Position Recall shows (default: the end of the line). |
| `source`, `review` | Optional overrides of the chapter's values. |

### Notes

A note is keyed by the move path that ends with the move it explains: `"1.c4 e5 2.Nc3"`
explains 2.Nc3. Lines that share moves share their notes, and the trainer finds a note by
position, so it also applies after a transposition.

| Field | Shown | Rule |
|---|---|---|
| `idea` | first hint | One of `centre`, `development`, `king-safety`, `prevention`, `space`, `structure`, `recapture`, `tempo`, `flank`, `activity`. |
| `hint` | first hint | Names the idea only. Never the move, its SAN or its target square. |
| `narrow` | second hint | Narrows to a piece or an area of the board, still without the exact move. |
| `why` | after the move | What the move achieves. For an opponent move: what they intend. |
| `fits` | after the move | Why it fits this opening. |
| `avoids` | after the move | The common mistake it avoids. |
| `alternatives` | when you play one | `{ "san", "note" }`: sound moves that are not your repertoire move here. |
| `mistakes` | when you play one | `{ "san", "note" }`: known errors in this position, e.g. a move that walks into a trap. |

Without a `hint` or `narrow`, the trainer writes a generic one from the move (the piece, its
area of the board, whether it develops, castles or fights for the centre).

### Writing style

- Original, concise sentences. Do not copy text from books or websites.
- Plain chess language: what a move controls, attacks, prepares or prevents. No engine numbers.
- British spelling, second person ("your knight"), SAN without spaces ("2...Nc6").
- Be honest about uncertainty: set `review.confidence` and mark unchecked chapters `draft`.

## Opening names

`data/chess-openings/` holds the lichess opening name list (CC0). `content:check` compares each
line's `eco` with the deepest named position on it and warns on a mismatch. The list names
unsound lines too, so a name is never a recommendation.
