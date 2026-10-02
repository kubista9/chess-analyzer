import { describe, expect, it } from "vitest";
import { fixtureFile, fixtureFiles } from "../../test/content";
import { START_EPD, START_FEN, replayMoves } from "../chess/position";
import type { CustomLineRecord } from "../training/types";
import {
  EXPORT_PLACEHOLDER_DESCRIPTION,
  EXPORT_PLACEHOLDER_PLAN,
  PGN_LINE_WIDTH,
  buildCatalog,
  chaptersForSide,
  lineToContentJson,
  lineToPgn,
  linesForSide,
  noteFor,
  parsePgnMainLine,
  summariseCatalog
} from "./catalog";
import { compileChapter, parseContentFile } from "./compile";
import { lineSchema, type ContentFileInput } from "./schema";
import { noteKey, type Catalog } from "./types";

const AT = Date.UTC(2026, 9, 1, 12);

function customRecord(overrides: Partial<CustomLineRecord> = {}): CustomLineRecord {
  return {
    id: "my-hedgehog",
    side: "white",
    chapter: "My lines",
    family: "English Opening",
    name: "My \"Hedgehog\" line",
    eco: "A30",
    moves: "1.c4 c5 2.Nf3 Nf6 3.g3 b6 4.Bg2 Bb7 5.O-O e6 6.Nc3",
    description: "Against the Hedgehog set-up.",
    plans: ["d4 and a big centre."],
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

/** A small Black chapter against 1.c4 that annotates moves the White chapters annotate too. */
function blackAgainstEnglish(): ContentFileInput {
  return {
    schemaVersion: 1,
    id: "black-vs-english",
    side: "black",
    group: "Against 1.c4",
    family: "English Opening",
    chapter: "1.c4 e5",
    order: 5,
    summary: "The Reversed Sicilian from Black's side.",
    ideas: ["Take the centre with ...e5."],
    source: { kind: "editorial", references: [] },
    review: { status: "draft", confidence: "low" },
    notes: {
      "1.c4": { why: "White takes d5 from the side; you answer in the centre." },
      "1.c4 e5": { idea: "centre", hint: "Claim your share of the centre at once.", why: "You take the centre directly." },
      "1.c4 e5 2.Nc3 Nf6": { idea: "development", why: "Develops and attacks e4." }
    },
    lines: [
      {
        id: "black-english-nf6",
        name: "2...Nf6",
        priority: "main",
        moves: "1.c4 e5 2.Nc3 Nf6",
        description: "Natural development.",
        plans: ["...d5 when White allows it."]
      }
    ]
  };
}

describe("buildCatalog", () => {
  const catalog = buildCatalog([...fixtureFiles()].reverse());

  it("compiles the fixture without issues and sorts chapters by side, order and id", () => {
    expect(catalog.issues).toEqual([]);
    expect(catalog.chapters.map((chapter) => chapter.id)).toEqual(["white-english-e5", "white-english-nf6", "black-scandinavian"]);
    expect(catalog.lines.map((line) => [line.id, line.order])).toEqual([
      ["eng-e5-bc5", 0],
      ["eng-e5-closed", 1],
      ["eng-e5-four-knights", 2],
      ["eng-e5-four-knights-e3", 3],
      ["eng-nf6-four-knights-bb4", 4],
      ["scandi-qa5", 5],
      ["scandi-nf3-bg4", 6]
    ]);
    expect(catalog.chapterById.get("white-english-nf6")?.lineIds).toEqual(["eng-nf6-four-knights-bb4"]);
    expect(catalog.lineById.get("scandi-qa5")?.chapterId).toBe("black-scandinavian");
    expect(catalog.lineById.size).toBe(7);
    expect(catalog.chapterById.size).toBe(3);
  });

  it("gives the same catalog whatever order the files come in", () => {
    const forwards = buildCatalog(fixtureFiles());
    expect(forwards.lines.map((line) => line.id)).toEqual(catalog.lines.map((line) => line.id));
    expect([...forwards.notes.keys()]).toEqual([...catalog.notes.keys()]);
  });

  it("indexes notes by position and move, so a transposition finds the note", () => {
    const viaNf6 = catalog.lineById.get("eng-nf6-four-knights-bb4")!;
    // 1.c4 Nf6 2.Nc3 e5 3.Nf3: chapter 1 wrote the note under 1.c4 e5 2.Nc3 Nf6 3.Nf3.
    const move = viaNf6.moves[4];
    expect(move.san).toBe("Nf3");
    const note = noteFor(catalog, move.epdBefore, move.uci, "white");
    expect(note).toMatchObject({ key: "c4 e5 Nc3 Nf6 Nf3", chapterId: "white-english-e5" });
    expect(catalog.notes.get(noteKey("white", START_EPD, "c2c4"))?.key).toBe("c4");
    expect(noteFor(catalog, START_EPD, "e2e4", "white")).toBeUndefined();
  });

  it("finds a chapter's or side's chapters and lines", () => {
    expect(chaptersForSide(catalog, "white").map((chapter) => chapter.id)).toEqual(["white-english-e5", "white-english-nf6"]);
    expect(chaptersForSide(catalog, "black").map((chapter) => chapter.id)).toEqual(["black-scandinavian"]);
    expect(linesForSide(catalog, "black").map((line) => line.id)).toEqual(["scandi-qa5", "scandi-nf3-bg4"]);
    expect(linesForSide(catalog, "white")).toHaveLength(5);
  });

  it("returns an empty catalog for no files", () => {
    const empty = buildCatalog([]);
    expect(empty).toMatchObject({ chapters: [], lines: [], issues: [] });
    expect(empty.notes.size).toBe(0);
  });

  it("reports a broken file and still compiles the others", () => {
    const broken = { ...fixtureFile("white-english-nf6"), lines: [] };
    const result = buildCatalog([fixtureFile("white-english-e5"), broken, { nonsense: true }], [], {
      fileNames: ["white/e5.json", "white/nf6.json", "black/nonsense.json"]
    });
    expect(result.chapters.map((chapter) => chapter.id)).toEqual(["white-english-e5"]);
    expect(result.issues.every((issue) => issue.level === "error")).toBe(true);
    expect(result.issues.find((issue) => issue.path === "lines")).toMatchObject({ fileId: "white-english-nf6" });
    expect(result.issues.filter((issue) => issue.fileId === "black/nonsense.json").length).toBeGreaterThan(0);
  });

  it("carries compile issues of a chapter into the catalog", () => {
    const file = fixtureFile("white-english-e5");
    file.lines[1].moves = "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1 Nf6 7.Rb2 Nf6";
    const result = buildCatalog([file]);
    expect(result.lineById.has("eng-e5-closed")).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", lineId: "eng-e5-closed", path: "moves" })]);
  });

  it("rejects a second chapter with the same id", () => {
    const copy = fixtureFile("white-english-e5");
    copy.lines = [{ ...copy.lines[1], id: "eng-e5-closed-copy" }];
    const result = buildCatalog([fixtureFile("white-english-e5"), copy], [], { fileNames: ["white/a.json", "white/b.json"] });
    expect(result.chapters).toHaveLength(1);
    expect(result.lineById.has("eng-e5-closed-copy")).toBe(false);
    expect(result.issues).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        message: 'duplicate chapter id "white-english-e5" (white/b.json); this chapter is left out'
      }
    ]);
  });

  it("rejects a line id that another chapter already uses", () => {
    const nf6 = fixtureFile("white-english-nf6");
    nf6.lines[0].id = "eng-e5-closed";
    const result = buildCatalog([fixtureFile("white-english-e5"), nf6]);
    expect(result.lineById.get("eng-e5-closed")?.chapterId).toBe("white-english-e5");
    expect(result.chapterById.get("white-english-nf6")?.lineIds).toEqual([]);
    expect(result.lines).toHaveLength(4);
    expect(result.issues).toEqual([
      {
        level: "error",
        fileId: "white-english-nf6",
        lineId: "eng-e5-closed",
        message: 'duplicate line id "eng-e5-closed" (already used in chapter "white-english-e5"); this line is left out'
      }
    ]);
  });

  it("keeps the first chapter's note on a duplicate and warns only when the text differs", () => {
    const nf6 = fixtureFile("white-english-nf6");
    nf6.notes = { ...nf6.notes, "1.c4": { why: "A different explanation." } };
    const conflicting = buildCatalog([nf6, fixtureFile("white-english-e5")]);
    expect(noteFor(conflicting, START_EPD, "c2c4", "white")?.chapterId).toBe("white-english-e5");
    expect(conflicting.issues).toEqual([
      {
        level: "warning",
        fileId: "white-english-nf6",
        path: 'notes."c4"',
        message: 'the note on 1.c4 after the start is also written in chapter "white-english-e5" with different text; that one is used'
      }
    ]);

    const same = fixtureFile("white-english-nf6");
    same.notes = { ...same.notes, "1.c4": structuredClone(fixtureFile("white-english-e5").notes!["1.c4"]) };
    expect(buildCatalog([fixtureFile("white-english-e5"), same]).issues).toEqual([]);
  });

  it("keeps each side's notes apart, so a White and a Black chapter can annotate the same moves", () => {
    const result = buildCatalog([...fixtureFiles(), blackAgainstEnglish()]);
    // Both sides explain 1.c4 and 1...e5 in their own words: nothing conflicts, nothing is dropped.
    expect(result.issues).toEqual([]);
    const afterC4 = result.lineById.get("eng-e5-closed")!.moves[1];
    expect(afterC4.san).toBe("e5");

    // Training White: White's own notes, on White's moves and on Black's replies.
    expect(noteFor(result, START_EPD, "c2c4", "white")).toMatchObject({ chapterId: "white-english-e5", idea: "centre" });
    expect(noteFor(result, afterC4.epdBefore, afterC4.uci, "white")).toMatchObject({
      chapterId: "white-english-e5",
      why: "Black takes the centre directly, a Sicilian with the colours reversed.",
      hint: null
    });
    // Training Black: Black's notes, which speak to the Black player.
    expect(noteFor(result, START_EPD, "c2c4", "black")).toMatchObject({
      chapterId: "black-vs-english",
      why: "White takes d5 from the side; you answer in the centre."
    });
    expect(noteFor(result, afterC4.epdBefore, afterC4.uci, "black")).toMatchObject({
      chapterId: "black-vs-english",
      hint: "Claim your share of the centre at once.",
      why: "You take the centre directly."
    });

    // A note only the other side wrote addresses the other player, so it is not used.
    const nf6 = result.lineById.get("black-english-nf6")!.moves[3];
    expect(nf6.san).toBe("Nf6");
    expect(noteFor(result, nf6.epdBefore, nf6.uci, "black")?.chapterId).toBe("black-vs-english");
    expect(noteFor(result, nf6.epdBefore, nf6.uci, "white")).toBeUndefined();
    const exd5 = result.lineById.get("scandi-qa5")!.moves[2];
    expect(noteFor(result, exd5.epdBefore, exd5.uci, "black")?.chapterId).toBe("black-scandinavian");
    expect(noteFor(result, exd5.epdBefore, exd5.uci, "white")).toBeUndefined();

    // The same in any file order.
    const reversed = buildCatalog([blackAgainstEnglish(), ...fixtureFiles()].reverse());
    expect([...reversed.notes.keys()].sort()).toEqual([...result.notes.keys()].sort());
    expect(noteFor(reversed, START_EPD, "c2c4", "black")?.chapterId).toBe("black-vs-english");
  });

  it("warns about a duplicate within one side only, never across sides", () => {
    const second = blackAgainstEnglish();
    second.id = "black-vs-english-two";
    second.order = 6;
    second.lines[0].id = "black-english-nf6-two";
    second.notes = { "1.c4 e5": { why: "A different explanation of your move." }, "1.c4": { why: "White takes d5 from the side; you answer in the centre." } };
    const result = buildCatalog([...fixtureFiles(), second, blackAgainstEnglish()]);
    expect(result.issues).toEqual([
      {
        level: "warning",
        fileId: "black-vs-english-two",
        path: 'notes."c4 e5"',
        message: 'the note on 1...e5 after 1.c4 is also written in chapter "black-vs-english" with different text; that one is used'
      }
    ]);
    const afterC4 = result.lineById.get("eng-e5-closed")!.moves[1];
    expect(noteFor(result, afterC4.epdBefore, afterC4.uci, "black")?.why).toBe("You take the centre directly.");
  });

  it("adds the user's own lines after the built-in ones", () => {
    const result = buildCatalog(fixtureFiles(), [customRecord(), customRecord({ id: "my-scandi", side: "black", moves: "1.e4 d5 2.e5 Bf5" })]);
    expect(result.issues).toEqual([]);
    expect(result.chapters.map((chapter) => chapter.id)).toEqual([
      "white-english-e5",
      "white-english-nf6",
      "custom-white-my-lines",
      "black-scandinavian",
      "custom-black-my-lines"
    ]);
    expect(result.lineById.get("my-hedgehog")).toMatchObject({ origin: "custom", order: 7, group: "My lines" });
    expect(result.lineById.get("my-scandi")).toMatchObject({ origin: "custom", order: 8, side: "black" });
    expect(linesForSide(result, "black").map((line) => line.id)).toEqual(["scandi-qa5", "scandi-nf3-bg4", "my-scandi"]);
  });

  it("drops a custom line whose id a built-in line already uses", () => {
    const result = buildCatalog(fixtureFiles(), [customRecord({ id: "eng-e5-closed" })]);
    expect(result.lineById.get("eng-e5-closed")?.origin).toBe("builtin");
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", lineId: "eng-e5-closed", fileId: "custom-white-my-lines" })]);
  });
});

describe("summariseCatalog", () => {
  it("counts chapters, lines, plies and noted user moves per side", () => {
    const [white, black] = summariseCatalog(buildCatalog(fixtureFiles()));
    // 17 distinct White moves; 6.Rb1 and the 4.e3 of the disabled line have no note.
    expect(white).toEqual({
      side: "white",
      chapters: 2,
      lines: 5,
      defaultEnabledLines: 4,
      plies: 7 + 11 + 13 + 7 + 11,
      userMoves: 17,
      notedUserMoves: 15,
      coverage: 15 / 17
    });
    expect(black).toEqual({ side: "black", chapters: 1, lines: 2, defaultEnabledLines: 2, plies: 14, userMoves: 5, notedUserMoves: 5, coverage: 1 });
  });

  it("counts a user move as noted only when a chapter of the same side explains it", () => {
    const files = fixtureFiles();
    const [white, scandinavian] = [files[0], files[2]];
    // Move Black's note on 2...Qxd5 into a White chapter: Black's coverage drops.
    white.notes!["1.e4 d5 2.exd5 Qxd5"] = scandinavian.notes!["1.e4 d5 2.exd5 Qxd5"];
    delete scandinavian.notes!["1.e4 d5 2.exd5 Qxd5"];
    const [whiteSummary, blackSummary] = summariseCatalog(buildCatalog(files));
    expect(whiteSummary).toMatchObject({ userMoves: 17, notedUserMoves: 15 });
    expect(blackSummary).toMatchObject({ userMoves: 5, notedUserMoves: 4, coverage: 4 / 5 });
  });

  it("has no coverage without lines", () => {
    expect(summariseCatalog(buildCatalog([]))[0]).toMatchObject({ lines: 0, userMoves: 0, coverage: null });
  });
});

describe("lineToPgn", () => {
  const catalog = buildCatalog(fixtureFiles());
  const closed = catalog.lineById.get("eng-e5-closed")!;

  it("writes the seven standard tags, the opening and the moves", () => {
    expect(lineToPgn(closed)).toBe(
      [
        '[Event "Repertoire line"]',
        '[Site "?"]',
        '[Date "????.??.??"]',
        '[Round "?"]',
        '[White "?"]',
        '[Black "?"]',
        '[Result "*"]',
        '[Opening "Closed system with g3, Bg2 and d3"]',
        '[ECO "A26"]',
        "",
        "1. c4 e5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7 5. d3 d6 6. Rb1 *",
        ""
      ].join("\n")
    );
  });

  it("adds each note's why as a comment and repeats the move number after a comment", () => {
    const pgn = lineToPgn(closed, { notes: catalog });
    const movetext = pgn.split("\n\n")[1];
    const flat = movetext.replace(/\s+/g, " ");
    expect(flat).toContain("1. c4 {Controls d5 from the side and keeps the d- and e-pawns flexible.} 1... e5 {Black");
    expect(flat).toContain("4. Bg2 {The bishop controls d5");
    expect(flat).toContain("} 5... d6 6. Rb1 *");
    expect(movetext.split("\n").length).toBeGreaterThan(1);
    for (const row of movetext.trimEnd().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(PGN_LINE_WIDTH);
    }
    expect(lineToPgn(closed, { notes: catalog, comments: false })).toBe(lineToPgn(closed));
  });

  it("leaves out the ECO tag when the line has none and escapes quotes in the name", () => {
    const result = buildCatalog([], [customRecord({ eco: null })]);
    const pgn = lineToPgn(result.lineById.get("my-hedgehog")!);
    expect(pgn).not.toContain("[ECO");
    expect(pgn).toContain('[Opening "My \\"Hedgehog\\" line"]');
  });

  it("reads back with parsePgnMainLine, comments included", () => {
    for (const line of catalog.lines) {
      const { sans, headers } = parsePgnMainLine(lineToPgn(line, { notes: catalog }));
      expect(sans).toEqual(line.sans);
      expect(headers.Opening).toBe(line.name);
    }
    const custom = buildCatalog([], [customRecord()]).lineById.get("my-hedgehog")!;
    expect(parsePgnMainLine(lineToPgn(custom)).headers.Opening).toBe('My "Hedgehog" line');
  });

  it("starts with the move number for a Black line too", () => {
    const scandi = catalog.lineById.get("scandi-nf3-bg4")!;
    expect(lineToPgn(scandi).split("\n\n")[1]).toBe("1. e4 d5 2. exd5 Qxd5 3. Nf3 Bg4 *\n");
  });
});

describe("parsePgnMainLine", () => {
  it("reads tags and the main line, dropping variations, comments, NAGs and the result", () => {
    const pgn = [
      "﻿[Event \"Club game\"]",
      '[White "Someone \\"Quoted\\""]',
      "[Black \"?\"]",
      "",
      "1. c4 {English} e5 (1... c5 2. Nf3 (2. g3)) 2. Nc3 $1 Nf6!? ; rest of line",
      "3. Nf3 Nc6 4. g3 d5 5. cxd5 Nxd5 1-0",
      ""
    ].join("\r\n");
    expect(parsePgnMainLine(pgn)).toEqual({
      sans: ["c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6", "g3", "d5", "cxd5", "Nxd5"],
      headers: { Event: "Club game", White: 'Someone "Quoted"', Black: "?" }
    });
  });

  it("stores canonical SAN for loosely written moves", () => {
    expect(parsePgnMainLine("1.e4 e5 2.Ng1f3 Nc6 3.Bb5 a6 4.Bxc6 dxc6 5.0-0").sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6", "dxc6", "O-O"]);
    expect(parsePgnMainLine("1.f3 e5 2.g4 Qh4").sans).toEqual(["f3", "e5", "g4", "Qh4#"]);
  });

  it("reads only the first game", () => {
    const pgn = '[Event "One"]\n\n1. d4 d5 *\n\n[Event "Two"]\n\n1. e4 e5 *\n';
    expect(parsePgnMainLine(pgn)).toEqual({ sans: ["d4", "d5"], headers: { Event: "One" } });
  });

  it("returns no moves for a PGN without movetext", () => {
    expect(parsePgnMainLine("")).toEqual({ sans: [], headers: {} });
    expect(parsePgnMainLine('[Event "Empty"]\n\n*')).toEqual({ sans: [], headers: { Event: "Empty" } });
  });

  it("throws a readable error for an illegal move", () => {
    expect(() => parsePgnMainLine("1. e4 e5 2. Nf3 Nc3")).toThrow("Move 2...Nc3 is not legal after 1.e4 e5 2.Nf3.");
    expect(() => parsePgnMainLine("1. Ke2")).toThrow("Move 1.Ke2 is not legal in the starting position.");
  });

  it("accepts a FEN tag only for the initial position", () => {
    expect(parsePgnMainLine(`[FEN "${START_FEN}"]\n\n1. c4`).sans).toEqual(["c4"]);
    expect(() => parsePgnMainLine('[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Kb1')).toThrow(/set-up position/);
    expect(() => parsePgnMainLine('[FEN "nonsense"]\n\n1. c4')).toThrow(/set-up position/);
  });
});

describe("lineToContentJson", () => {
  const catalog: Catalog = buildCatalog(fixtureFiles(), [customRecord()]);

  it("writes a built-in line in the content format, leaving out what the chapter already says", () => {
    const json = lineToContentJson(catalog.lineById.get("eng-e5-closed")!, catalog);
    expect(json).toEqual({
      id: "eng-e5-closed",
      name: "Closed system with g3, Bg2 and d3",
      eco: "A26",
      priority: "main",
      defaultEnabled: true,
      moves: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1",
      description: "Both sides fianchetto; you prepare b4 on the queenside.",
      plans: ["b4-b5 to push away the c6-knight.", "Nf3 or e3 and Nge2, then O-O."],
      ideas: [],
      traps: [],
      checkpoints: [expect.objectContaining({ ply: 8 })]
    });
    expect(lineSchema.parse(json)).toEqual(json);
  });

  it("keeps a recall ply, traps and a source of its own", () => {
    expect(lineToContentJson(catalog.lineById.get("eng-e5-four-knights")!, catalog).recall).toEqual({ ply: 9 });
    expect(lineToContentJson(catalog.lineById.get("eng-e5-bc5")!, catalog).traps).toEqual([
      { name: "Mate on f2", moves: "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf2#", side: "against", description: "Developing the bishop at once walks into mate." }
    ]);
    const e3 = lineToContentJson(catalog.lineById.get("eng-e5-four-knights-e3")!, catalog);
    expect(e3.source).toEqual({ kind: "editorial", references: [], note: "Optional line." });
    expect(e3.review).toBeUndefined();
    expect(e3.defaultEnabled).toBe(false);
  });

  it("writes a custom line with its source and review, ready for a chapter file", () => {
    const json = lineToContentJson(catalog.lineById.get("my-hedgehog")!, catalog);
    expect(json).toMatchObject({
      id: "my-hedgehog",
      moves: "1.c4 c5 2.Nf3 Nf6 3.g3 b6 4.Bg2 Bb7 5.O-O e6 6.Nc3",
      source: { kind: "user", references: [] },
      review: { status: "draft", confidence: "low", checkedWith: [] }
    });
    expect(json.recall).toBeUndefined();
    expect(json.review?.notes).toBeUndefined();
    expect(lineSchema.parse(json)).toEqual(json);
  });

  it("fills in what a custom line leaves empty, so the export always validates, and says so in the review notes", () => {
    const sloppy = buildCatalog(
      [],
      [customRecord({ id: "My_Line 1", name: "  ", eco: "Reversed Sicilian", description: " ", plans: ["", "  "], moves: "1.c4 e5 2.Nc3" })]
    );
    expect(sloppy.issues).toEqual([]);
    const json = lineToContentJson(sloppy.lines[0], sloppy);
    expect(lineSchema.safeParse(json).error?.issues ?? []).toEqual([]);
    expect(json).toMatchObject({
      id: "my-line-1",
      name: "1.c4 e5 2.Nc3",
      description: EXPORT_PLACEHOLDER_DESCRIPTION,
      plans: [EXPORT_PLACEHOLDER_PLAN],
      review: {
        status: "draft",
        confidence: "low",
        notes:
          "Exported from the app with placeholder text for the description and the plans; replace it before review. " +
          'The ECO code "Reversed Sicilian" was left out: it is not a code such as A20. ' +
          'The id "My_Line 1" became "my-line-1": content ids are lower-case words joined by hyphens.'
      }
    });
    expect(json).not.toHaveProperty("eco");

    // Pasted into a chapter, it compiles without issues.
    const file = fixtureFile("white-english-e5");
    file.lines = [json];
    expect(parseContentFile(file).issues).toEqual([]);
  });

  it("trims a custom line's texts, upper-cases its ECO code and notes only what was filled in", () => {
    const record = customRecord({ name: " Mine ", eco: "a30", description: "Hedgehog. ", plans: [" d4 later. ", ""] });
    const catalogWithRecord = buildCatalog([], [record]);
    const json = lineToContentJson(catalogWithRecord.lines[0], catalogWithRecord);
    expect(json).toMatchObject({ id: "my-hedgehog", name: "Mine", eco: "A30", description: "Hedgehog.", plans: ["d4 later."] });
    expect(json.review?.notes).toBeUndefined();

    const noPlans = buildCatalog([], [customRecord({ plans: [] })]);
    const withPlaceholder = lineToContentJson(noPlans.lines[0], noPlans);
    expect(withPlaceholder.plans).toEqual([EXPORT_PLACEHOLDER_PLAN]);
    expect(withPlaceholder.review?.notes).toBe("Exported from the app with placeholder text for the plans; replace it before review.");
    expect(lineSchema.safeParse(withPlaceholder).success).toBe(true);
  });

  it("round-trips: the exported line compiles to the same moves", () => {
    for (const line of catalog.lines) {
      const file = fixtureFile(line.side === "white" ? "white-english-e5" : "black-scandinavian");
      file.lines = [lineToContentJson(line, catalog)];
      const parsedFile = parseContentFile(file).file!;
      const compiled = compileChapter(parsedFile, "builtin", 0);
      expect(compiled.issues).toEqual([]);
      expect(compiled.lines[0].sans).toEqual(line.sans);
      expect(compiled.lines[0].recallPly).toBe(line.recallPly);
      expect(compiled.lines[0].traps.map((trap) => trap.sans)).toEqual(line.traps.map((trap) => trap.sans));
    }
  });

  it("matches the replayed moves of the line", () => {
    const json = lineToContentJson(catalog.lineById.get("scandi-qa5")!, catalog);
    expect(replayMoves(json.moves.replace(/\d+\./g, "").trim().split(/\s+/)).map((move) => move.san)).toEqual(
      catalog.lineById.get("scandi-qa5")!.sans
    );
  });
});
