import { describe, expect, it } from "vitest";
import { FIXTURE_FENS, fixtureFile } from "../../test/content";
import { START_EPD, START_FEN, toEpd } from "../chess/position";
import type { CustomLineRecord } from "../training/types";
import { CUSTOM_CHAPTER_ORDER, CUSTOM_GROUP, compileChapter, compileCustomLines, parseContentFile, slugify } from "./compile";
import type { ContentFile, ContentFileInput } from "./schema";

/** Validates a fixture (or a modified copy) and fails the test if it does not parse. */
function parsed(json: ContentFileInput): ContentFile {
  const result = parseContentFile(json);
  expect(result.issues).toEqual([]);
  return result.file!;
}

/** The E5 chapter with only the given line kept (by id), optionally modified. */
function withLine(id: string, change: (line: ContentFileInput["lines"][number]) => void = () => {}): ContentFile {
  const file = fixtureFile("white-english-e5");
  file.lines = file.lines.filter((line) => line.id === id);
  change(file.lines[0]);
  return parsed(file);
}

const messages = (issues: readonly { message: string }[]) => issues.map((issue) => issue.message);

describe("parseContentFile", () => {
  it("accepts a valid chapter and applies the schema defaults", () => {
    const file = parsed(fixtureFile("white-english-e5"));
    expect(file.id).toBe("white-english-e5");
    const closed = file.lines.find((line) => line.id === "eng-e5-closed")!;
    expect(closed.defaultEnabled).toBe(true);
    expect(closed.traps).toEqual([]);
    expect(closed.ideas).toEqual([]);
    expect(file.notes["1.c4 e5"].alternatives).toEqual([]);
    expect(file.notes["1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2"].mistakes[0].severity).toBe("inaccuracy");
    expect(file.lines.find((line) => line.id === "eng-e5-four-knights-e3")!.defaultEnabled).toBe(false);
  });

  it("reports every schema problem as an error with its path, line id and file id", () => {
    const file: Partial<ContentFileInput> & Pick<ContentFileInput, "lines"> = fixtureFile("white-english-e5");
    delete file.summary;
    file.lines[1].eco = "Z99";
    file.lines[2].id = "Not An Id";
    file.notes!["1.c4"].why = "";
    const { file: result, issues } = parseContentFile(file, "white/broken.json");
    expect(result).toBeNull();
    expect(issues.every((issue) => issue.level === "error" && issue.fileId === "white-english-e5")).toBe(true);
    expect(issues.map((issue) => issue.path).sort()).toEqual(["lines.1.eco", "lines.2.id", 'notes."1.c4".why', "summary"]);
    expect(issues.find((issue) => issue.path === "lines.1.eco")?.lineId).toBe("eng-e5-closed");
    expect(issues.find((issue) => issue.path === "lines.2.id")?.lineId).toBe("Not An Id");
    expect(issues.find((issue) => issue.path === "summary")?.lineId).toBeUndefined();
    for (const issue of issues) {
      expect(issue.message.startsWith(`${issue.path}: `)).toBe(true);
    }
  });

  it("names the file by its file name when it has no usable id", () => {
    const { issues } = parseContentFile({ schemaVersion: 1, lines: [] }, "black/untitled.json");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.fileId === "black/untitled.json")).toBe(true);
  });

  it("rejects JSON that is not a chapter at all", () => {
    for (const json of [null, "text", [], 42]) {
      const { file, issues } = parseContentFile(json);
      expect(file).toBeNull();
      expect(issues).toHaveLength(1);
      expect(issues[0].message.startsWith("(file): ")).toBe(true);
      expect(issues[0].fileId).toBeUndefined();
    }
  });

  it("rejects an unknown schema version", () => {
    const file = { ...fixtureFile("white-english-e5"), schemaVersion: 2 };
    expect(messages(parseContentFile(file).issues)).toEqual([expect.stringMatching(/^schemaVersion: /)]);
  });
});

describe("compileChapter: lines", () => {
  const compiled = compileChapter(parsed(fixtureFile("white-english-e5")), "builtin", 100);
  const line = (id: string) => compiled.lines.find((candidate) => candidate.id === id)!;

  it("compiles every line of a clean chapter without issues", () => {
    expect(compiled.issues).toEqual([]);
    expect(compiled.lines.map((candidate) => candidate.id)).toEqual([
      "eng-e5-bc5",
      "eng-e5-closed",
      "eng-e5-four-knights",
      "eng-e5-four-knights-e3"
    ]);
    expect(compiled.chapter.lineIds).toEqual(compiled.lines.map((candidate) => candidate.id));
    expect(compiled.chapter).toMatchObject({
      id: "white-english-e5",
      side: "white",
      group: "English Opening",
      chapter: "1...e5: the Reversed Sicilian",
      order: 10,
      origin: "builtin"
    });
  });

  it("replays the moves into canonical SAN, positions and the final FEN", () => {
    const fourKnights = line("eng-e5-four-knights");
    expect(fourKnights.sans).toEqual(["c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6", "g3", "d5", "cxd5", "Nxd5", "Bg2", "Nb6", "O-O"]);
    expect(fourKnights.moves).toHaveLength(13);
    expect(fourKnights.epds).toHaveLength(14);
    expect(fourKnights.epds[0]).toBe(START_EPD);
    fourKnights.moves.forEach((move, index) => {
      expect(fourKnights.epds[index]).toBe(move.epdBefore);
      expect(fourKnights.epds[index + 1]).toBe(move.epdAfter);
    });
    expect(fourKnights.finalFen).toBe("r1bqkb1r/ppp2ppp/1nn5/4p3/8/2N2NP1/PP1PPPBP/R1BQ1RK1 b kq - 3 7");
    expect(fourKnights.moves[12].castle).toBe("short");
  });

  it("lists the user's plies, the recall ply and the teaching order", () => {
    expect(line("eng-e5-closed").userPlies).toEqual([1, 3, 5, 7, 9, 11]);
    expect(line("eng-e5-closed").recallPly).toBe(11);
    expect(line("eng-e5-four-knights").recallPly).toBe(9);
    expect(compiled.lines.map((candidate) => candidate.order)).toEqual([100, 101, 102, 103]);
  });

  it("copies the line's fields and fills in the chapter's group, family, source and review", () => {
    const closed = line("eng-e5-closed");
    expect(closed).toMatchObject({
      chapterId: "white-english-e5",
      side: "white",
      group: "English Opening",
      family: "English Opening",
      chapter: "1...e5: the Reversed Sicilian",
      name: "Closed system with g3, Bg2 and d3",
      eco: "A26",
      priority: "main",
      defaultEnabled: true,
      origin: "builtin"
    });
    expect(closed.source).toEqual(compiled.chapter.source);
    expect(closed.review).toEqual(compiled.chapter.review);
    expect(closed.checkpoints).toEqual([{ ply: 8, fen: FIXTURE_FENS.closedAfterBg7, label: "Both bishops fianchettoed" }]);
    // A line's own source wins over the chapter's.
    expect(line("eng-e5-four-knights-e3").source).toEqual({ kind: "editorial", references: [], note: "Optional line." });
    expect(line("eng-e5-four-knights-e3").defaultEnabled).toBe(false);
  });

  it("gives a line without an ECO code eco null", () => {
    const result = compileChapter(
      withLine("eng-e5-closed", (def) => delete def.eco),
      "builtin",
      0
    );
    expect(result.lines[0].eco).toBeNull();
  });

  it("compiles a Black chapter with Black's plies as the user's", () => {
    const black = compileChapter(parsed(fixtureFile("black-scandinavian")), "builtin", 0);
    expect(black.issues).toEqual([]);
    expect(black.lines[0].side).toBe("black");
    expect(black.lines[0].userPlies).toEqual([2, 4, 6, 8]);
    expect(black.lines[1].userPlies).toEqual([2, 4, 6]);
  });

  it("replays the traps of a line", () => {
    const [trap] = line("eng-e5-bc5").traps;
    expect(trap.name).toBe("Mate on f2");
    expect(trap.sans).toEqual(["c4", "e5", "Nc3", "Bc5", "g3", "Qf6", "Bg2", "Qxf2#"]);
    expect(trap.played).toHaveLength(8);
    expect(trap.played[7].checkmate).toBe(true);
    expect(trap.moves).toBe("1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf2#");
  });
});

describe("compileChapter: errors and warnings", () => {
  it("leaves out a line with an illegal move and says which move and where", () => {
    const file = fixtureFile("white-english-e5");
    file.lines[0].moves = "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg3";
    const result = compileChapter(parsed(file), "builtin", 0);
    expect(result.lines.map((line) => line.id)).toEqual(["eng-e5-closed", "eng-e5-four-knights", "eng-e5-four-knights-e3"]);
    expect(result.chapter.lineIds).not.toContain("eng-e5-bc5");
    expect(result.issues).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        lineId: "eng-e5-bc5",
        path: "moves",
        message: "moves: 4.Bg3 is not legal after 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6"
      }
    ]);
    // The other lines keep their teaching order slots.
    expect(result.lines.map((line) => line.order)).toEqual([1, 2, 3]);
  });

  it("reports an illegal first move and a black move out of turn", () => {
    const first = compileChapter(withLine("eng-e5-closed", (def) => (def.moves = "1.Ke2")), "builtin", 0);
    expect(messages(first.issues)).toEqual(["moves: 1.Ke2 is not legal in the starting position"]);
    const outOfTurn = compileChapter(withLine("eng-e5-closed", (def) => (def.moves = "1.c4 2.Nc3")), "builtin", 0);
    expect(messages(outOfTurn.issues)).toEqual(["moves: 1...Nc3 is not legal after 1.c4"]);
  });

  it("reports movetext without moves", () => {
    const result = compileChapter(withLine("eng-e5-closed", (def) => (def.moves = "1. 2.")), "builtin", 0);
    expect(result.lines).toEqual([]);
    expect(messages(result.issues)).toEqual(["moves: no moves found"]);
  });

  it("checks checkpoints against the replayed positions", () => {
    const wrong = compileChapter(
      withLine("eng-e5-closed", (def) => (def.checkpoints = [{ ply: 7, fen: FIXTURE_FENS.closedAfterBg7 }])),
      "builtin",
      0
    );
    expect(wrong.lines).toEqual([]);
    expect(wrong.issues).toHaveLength(1);
    expect(wrong.issues[0]).toMatchObject({ level: "error", lineId: "eng-e5-closed", path: "checkpoints.0" });
    expect(wrong.issues[0].message).toMatch(/^checkpoints\.0: the position after 4\.Bg2 is "r1bqkbnr\/.* b KQkq - 1 4", not "/);

    const beyond = compileChapter(withLine("eng-e5-closed", (def) => (def.checkpoints = [{ ply: 12, fen: START_FEN }])), "builtin", 0);
    expect(messages(beyond.issues)).toEqual(["checkpoints.0: ply 12 is beyond the end of the line (11 plies)"]);

    const broken = compileChapter(withLine("eng-e5-closed", (def) => (def.checkpoints = [{ ply: 2, fen: "not a fen" }])), "builtin", 0);
    expect(messages(broken.issues)).toEqual(['checkpoints.0: "not a fen" is not a valid FEN']);
  });

  it("accepts a checkpoint FEN with other clocks or an en-passant square that cannot be used", () => {
    // After 1.c4 there is no black pawn to capture on c3: chess.js writes "-", the author wrote "c3".
    const result = compileChapter(
      withLine("eng-e5-closed", (def) => {
        def.checkpoints = [
          { ply: 1, fen: "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1" },
          { ply: 8, fen: `${toEpd(FIXTURE_FENS.closedAfterBg7)} 7 30` }
        ];
      }),
      "builtin",
      0
    );
    expect(result.issues).toEqual([]);
    expect(result.lines).toHaveLength(1);
  });

  it("rejects a recall ply beyond the end of the line", () => {
    const result = compileChapter(withLine("eng-e5-closed", (def) => (def.recall = { ply: 12 })), "builtin", 0);
    expect(result.lines).toEqual([]);
    expect(messages(result.issues)).toEqual(["recall.ply: ply 12 is beyond the end of the line (11 plies)"]);
  });

  it("uses the end of the line when recall has no ply", () => {
    const result = compileChapter(withLine("eng-e5-closed", (def) => (def.recall = {})), "builtin", 0);
    expect(result.lines[0].recallPly).toBe(11);
  });

  it("drops an illegal trap but keeps the line", () => {
    const result = compileChapter(
      withLine("eng-e5-bc5", (def) => {
        def.traps = [
          { name: "Broken", moves: "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf3", side: "against", description: "Not a move." },
          ...(def.traps ?? [])
        ];
      }),
      "builtin",
      0
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].traps.map((trap) => trap.name)).toEqual(["Mate on f2"]);
    expect(result.issues).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        lineId: "eng-e5-bc5",
        path: "traps.0",
        message: 'traps.0: trap "Broken": 4...Qxf3 is not legal after 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2; the trap is left out'
      }
    ]);
  });

  it("warns about a line that ends on the opponent's move but keeps it", () => {
    const result = compileChapter(
      withLine("eng-e5-closed", (def) => {
        def.moves = "1.c4 e5 2.Nc3 Nc6 3.g3 g6";
        def.checkpoints = [];
      }),
      "builtin",
      0
    );
    expect(result.lines).toHaveLength(1);
    expect(result.issues).toEqual([
      {
        level: "warning",
        fileId: "white-english-e5",
        lineId: "eng-e5-closed",
        path: "moves",
        message: "moves: the line ends on the opponent's move 3...g6; end it on your own move"
      }
    ]);
  });
});

describe("compileChapter: notes", () => {
  const compiled = compileChapter(parsed(fixtureFile("white-english-e5")), "builtin", 0);
  const note = (key: string) => compiled.notes.find((candidate) => candidate.key === key)!;

  it("binds every note to the position and move it annotates", () => {
    expect(compiled.notes).toHaveLength(Object.keys(fixtureFile("white-english-e5").notes ?? {}).length);
    expect(note("c4")).toMatchObject({
      chapterId: "white-english-e5",
      epdBefore: START_EPD,
      uci: "c2c4",
      san: "c4",
      mover: "white",
      idea: "centre",
      hint: "Start by taking a share of the centre without committing your central pawns.",
      why: "Controls d5 from the side and keeps the d- and e-pawns flexible."
    });
    const reply = note("c4 e5");
    expect(reply).toMatchObject({ uci: "e7e5", mover: "black", idea: null, hint: null, narrow: null, fits: null, avoids: null });
    expect(reply.epdBefore).toBe("rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq -");
    expect(note("c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O")).toMatchObject({ uci: "e1g1", san: "O-O" });
  });

  it("keeps legal alternatives and mistakes in canonical SAN", () => {
    expect(note("c4").alternatives).toEqual([{ san: "Nf3", note: "Just as flexible; it often transposes after a later c4.", transposes: true }]);
    expect(note("c4").mistakes).toEqual([{ san: "g4", note: "Weakens your kingside and does nothing for the centre.", severity: "mistake" }]);
    expect(note("c4 e5 Nc3 Bc5 g3 Qf6 e3").mistakes.map((mistake) => mistake.san)).toEqual(["Bg2"]);
  });

  it("drops alternatives and mistakes that are illegal, the move itself or listed twice", () => {
    const file = fixtureFile("white-english-e5");
    file.notes!["1.c4"].alternatives = [
      { san: "g1f3", note: "UCI is read and stored as SAN." },
      { san: "Nf6", note: "Not White's move." },
      { san: "c4!", note: "The annotated move itself." },
      { san: "Nf3", note: "A second entry for 1.Nf3." }
    ];
    file.notes!["1.c4"].mistakes = [{ san: "Nf3", note: "Already an alternative." }, { san: "Ke2", note: "Not legal." }, { san: "f3?!", note: "Kept." }];
    const result = compileChapter(parsed(file), "builtin", 0);
    const c4 = result.notes.find((candidate) => candidate.key === "c4")!;
    expect(c4.alternatives).toEqual([{ san: "Nf3", note: "UCI is read and stored as SAN." }]);
    expect(c4.mistakes).toEqual([{ san: "f3", note: "Kept.", severity: "mistake" }]);
    expect(result.issues.every((issue) => issue.level === "warning" && issue.path === 'notes."1.c4"')).toBe(true);
    expect(messages(result.issues)).toEqual([
      'notes."1.c4": alternative "Nf6" is not legal in that position; it is left out',
      'notes."1.c4": alternative "c4!" is the annotated move itself; it is left out',
      'notes."1.c4": alternative "Nf3" is listed twice; the second entry is left out',
      'notes."1.c4": mistake "Nf3" is listed twice; the second entry is left out',
      'notes."1.c4": mistake "Ke2" is not legal in that position; it is left out'
    ]);
  });

  it("drops a note whose path is not legal and reports it as an error", () => {
    const file = fixtureFile("white-english-e5");
    file.notes!["1.c4 e5 2.Nc4"] = { why: "No knight reaches c4." };
    file.notes!["1. ..."] = { why: "No moves at all." };
    const result = compileChapter(parsed(file), "builtin", 0);
    expect(result.notes.some((candidate) => candidate.why === "No knight reaches c4.")).toBe(false);
    expect(result.issues).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        path: 'notes."1.c4 e5 2.Nc4"',
        message: 'notes."1.c4 e5 2.Nc4": 2.Nc4 is not legal after 1.c4 e5; the note is left out'
      },
      { level: "error", fileId: "white-english-e5", path: 'notes."1. ..."', message: 'notes."1. ...": no moves found; the note is left out' }
    ]);
  });

  it("reads note keys in any movetext spelling and stores the canonical path key", () => {
    const file = fixtureFile("white-english-e5");
    file.notes = { "1. c4 e5 2. Nc3 Nc6 3. g3 g6 4. Bg2!": { why: "Spaced numbers and a glyph." } };
    const result = compileChapter(parsed(file), "builtin", 0);
    expect(result.issues).toEqual([]);
    expect(result.notes[0].key).toBe("c4 e5 Nc3 Nc6 g3 g6 Bg2");
    expect(result.notes[0].uci).toBe("f1g2");
  });
});

describe("compileCustomLines", () => {
  const at = Date.UTC(2026, 9, 1, 12);
  const record = (overrides: Partial<CustomLineRecord>): CustomLineRecord => ({
    id: "custom-line",
    side: "white",
    chapter: "My lines",
    family: "English Opening",
    name: "My line",
    eco: null,
    moves: "1.c4 e5 2.Nc3",
    description: "A line I added.",
    plans: ["Play g3 and Bg2."],
    createdAt: at,
    updatedAt: at,
    ...overrides
  });

  it("groups lines into one chapter per side and chapter title, under My lines", () => {
    const result = compileCustomLines(
      [
        record({ id: "my-c", side: "black", chapter: "Against 1.d4", moves: "1.d4 d5", createdAt: at + 2 }),
        record({ id: "my-b", chapter: "Sharp ideas", moves: "1.c4 c5 2.b4", createdAt: at + 1 }),
        record({ id: "my-a", moves: "1.c4 e6 2.Nc3", createdAt: at }),
        record({ id: "my-d", chapter: "sharp  IDEAS!", moves: "1.c4 c6 2.e4", createdAt: at + 3 })
      ],
      500
    );
    expect(result.issues).toEqual([]);
    expect(result.chapters.map((chapter) => chapter.id)).toEqual(["custom-white-my-lines", "custom-white-sharp-ideas", "custom-black-against-1-d4"]);
    expect(result.chapters.map((chapter) => chapter.lineIds)).toEqual([["my-a"], ["my-b", "my-d"], ["my-c"]]);
    expect(result.chapters[0]).toMatchObject({
      side: "white",
      group: CUSTOM_GROUP,
      family: "English Opening",
      chapter: "My lines",
      order: CUSTOM_CHAPTER_ORDER,
      origin: "custom",
      source: { kind: "user", references: [] },
      review: { status: "draft", confidence: "low", checkedWith: [] }
    });
    // Teaching order continues from orderBase, chapter by chapter.
    expect(result.lines.map((line) => [line.id, line.order])).toEqual([
      ["my-a", 500],
      ["my-b", 501],
      ["my-d", 502],
      ["my-c", 503]
    ]);
    expect(result.lines.find((line) => line.id === "my-c")).toMatchObject({ side: "black", userPlies: [2], origin: "custom", priority: "main", defaultEnabled: true });
  });

  it("orders lines in a chapter by when they were added, then id", () => {
    const result = compileCustomLines(
      [record({ id: "b", createdAt: at }), record({ id: "c", createdAt: at - 1 }), record({ id: "a", createdAt: at })],
      0
    );
    expect(result.chapters[0].lineIds).toEqual(["c", "a", "b"]);
  });

  it("reports a broken custom line and drops a chapter left without lines", () => {
    const result = compileCustomLines(
      [record({ id: "good", moves: "1.c4" }), record({ id: "bad", chapter: "Broken", moves: "1.c4 c4" })],
      0
    );
    expect(result.chapters.map((chapter) => chapter.id)).toEqual(["custom-white-my-lines"]);
    expect(result.lines.map((line) => line.id)).toEqual(["good"]);
    expect(result.issues).toEqual([
      { level: "error", fileId: "custom-white-broken", lineId: "bad", path: "moves", message: "moves: 1...c4 is not legal after 1.c4" }
    ]);
  });

  it("falls back to My lines for an empty chapter title and family", () => {
    const result = compileCustomLines([record({ chapter: "  ", family: "" })], 0);
    expect(result.chapters[0]).toMatchObject({ id: "custom-white-my-lines", chapter: "My lines", family: "My lines" });
    expect(result.lines[0].family).toBe("My lines");
  });

  it("returns nothing for no records", () => {
    expect(compileCustomLines([], 0)).toEqual({ chapters: [], lines: [], issues: [] });
  });
});

describe("slugify", () => {
  it("turns a title into lower-case words joined by hyphens", () => {
    expect(slugify("1...e5: the Reversed Sicilian")).toBe("1-e5-the-reversed-sicilian");
    expect(slugify("Grünfeld à la carte")).toBe("grunfeld-a-la-carte");
    expect(slugify("!!!")).toBe("lines");
  });
});
