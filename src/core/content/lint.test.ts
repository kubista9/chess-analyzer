import { describe, expect, it } from "vitest";
import { fixtureFile, fixtureFiles } from "../../test/content";
import { loadBookFromTsv } from "../openingDb/book";
import type { CustomLineRecord } from "../training/types";
import { buildCatalog } from "./catalog";
import { giveaway, lintAgainstBook, lintCatalog } from "./lint";
import type { ContentFileInput } from "./schema";
import type { ContentIssue } from "./types";

type Files = ContentFileInput[];

/** The fixture with a change applied to its chapters (by id). */
function changed(change: (byId: Record<string, ContentFileInput>) => void): Files {
  const files = fixtureFiles();
  change(Object.fromEntries(files.map((file) => [file.id, file])));
  return files;
}

function lint(files: Files, custom: readonly CustomLineRecord[] = []): ContentIssue[] {
  const catalog = buildCatalog(files, custom);
  expect(catalog.issues).toEqual([]);
  return lintCatalog(catalog);
}

const errors = (issues: readonly ContentIssue[]) => issues.filter((issue) => issue.level === "error");
const warnings = (issues: readonly ContentIssue[]) => issues.filter((issue) => issue.level === "warning");
const lineOf = (files: Files, id: string) => files.flatMap((file) => file.lines).find((line) => line.id === id)!;

const FOUR_KNIGHTS_SPLIT = '4.g3 ("eng-e5-four-knights", "eng-nf6-four-knights-bb4")';

describe("lintCatalog on the fixture", () => {
  const issues = lint(fixtureFiles());

  it("finds no errors", () => {
    expect(errors(issues)).toEqual([]);
  });

  it("reports the two moves without a note and the disabled line that disagrees", () => {
    expect(issues).toEqual([
      {
        level: "warning",
        fileId: "white-english-e5",
        lineId: "eng-e5-four-knights-e3",
        path: "moves",
        message:
          `moves: after 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 this line plays 4.e3 and other lines play ${FOUR_KNIGHTS_SPLIT}; ` +
          "with it switched on, both moves count as your repertoire move there"
      },
      {
        level: "warning",
        fileId: "white-english-e5",
        lineId: "eng-e5-closed",
        path: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1",
        message: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1: your move 6.Rb1 has no note; the trainer falls back to a generic hint"
      },
      {
        level: "warning",
        fileId: "white-english-e5",
        lineId: "eng-e5-four-knights-e3",
        path: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.e3",
        message: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.e3: your move 4.e3 has no note; the trainer falls back to a generic hint"
      }
    ]);
  });

  it("is clean once the gaps are filled and the optional line agrees", () => {
    const files = changed((byId) => {
      const e5 = byId["white-english-e5"];
      e5.notes!["1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1"] = { idea: "flank", why: "Prepares b4." };
      e5.lines = e5.lines.filter((line) => line.id !== "eng-e5-four-knights-e3");
    });
    expect(lint(files)).toEqual([]);
  });

  it("returns nothing for an empty catalog", () => {
    expect(lintCatalog(buildCatalog([]))).toEqual([]);
  });
});

describe("lines that disagree", () => {
  it("is an error when two default-enabled lines want different moves in one position", () => {
    const files = changed((byId) => {
      byId["white-english-e5"].lines.find((line) => line.id === "eng-e5-four-knights-e3")!.defaultEnabled = true;
    });
    const issues = lint(files);
    expect(errors(issues)).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        lineId: "eng-e5-four-knights-e3",
        path: "moves",
        message:
          `moves: lines enabled by default disagree after 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6: ${FOUR_KNIGHTS_SPLIT} · 4.e3 ("eng-e5-four-knights-e3"); ` +
          'set "defaultEnabled": false on all but one, or make them agree'
      }
    ]);
    // Enabled now, so no "disabled line disagrees" warning any more.
    expect(warnings(issues).some((issue) => issue.message.includes("switched on"))).toBe(false);
  });

  it("finds a disagreement reached through a transposition", () => {
    const files = changed((byId) => {
      byId["white-english-nf6"].lines[0].moves = "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.d4";
      byId["white-english-nf6"].notes = { "1.c4 Nf6 2.Nc3": { why: "Develops." }, "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.d4": { why: "Opens the centre." } };
    });
    const [error] = errors(lint(files));
    expect(error).toMatchObject({ fileId: "white-english-nf6", lineId: "eng-nf6-four-knights-bb4" });
    expect(error.message).toContain('after 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6: 4.g3 ("eng-e5-four-knights") · 4.d4 ("eng-nf6-four-knights-bb4")');
  });

  it("checks Black's lines too", () => {
    const files = changed((byId) => {
      const scandi = byId["black-scandinavian"];
      scandi.lines[1].moves = "1.e4 d5 2.exd5 Nf6";
      scandi.notes!["1.e4 d5 2.exd5 Nf6"] = { why: "The Portuguese way: the pawn comes back later." };
    });
    const [error] = errors(lint(files));
    expect(error.lineId).toBe("scandi-nf3-bg4");
    expect(error.message).toContain('after 1.e4 d5 2.exd5: 2...Qxd5 ("scandi-qa5") · 2...Nf6 ("scandi-nf3-bg4")');
  });

  it("does not compare White's and Black's lines", () => {
    const blackVsEnglish = fixtureFile("black-scandinavian");
    blackVsEnglish.id = "black-vs-english";
    blackVsEnglish.notes = { "1.c4 c5": { why: "Symmetrical." } };
    blackVsEnglish.lines = [{ ...blackVsEnglish.lines[0], id: "black-symmetrical", moves: "1.c4 c5", checkpoints: [] }];
    expect(errors(lint([...fixtureFiles(), blackVsEnglish]))).toEqual([]);
  });

  it("warns once per position for a disabled line, naming every other move there", () => {
    const files = changed((byId) => {
      byId["white-english-nf6"].lines.push({
        id: "eng-nf6-four-knights-d4",
        name: "Four Knights with d4",
        priority: "sideline",
        defaultEnabled: false,
        moves: "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.d4",
        description: "Opens the centre at once.",
        plans: ["Nxd4 and a Scotch with colours reversed."]
      });
    });
    const switchedOn = warnings(lint(files)).filter((issue) => issue.message.includes("switched on"));
    expect(switchedOn.map((issue) => issue.lineId)).toEqual(["eng-e5-four-knights-e3", "eng-nf6-four-knights-d4"]);
    expect(switchedOn[1].message).toContain(`other lines play ${FOUR_KNIGHTS_SPLIT} · 4.e3 ("eng-e5-four-knights-e3");`);
  });
});

describe("giveaway", () => {
  const nf3 = { san: "Nf3", uci: "g1f3" };
  const cxd5 = { san: "cxd5", uci: "c4d5" };
  const castle = { san: "O-O", uci: "e1g1" };

  it("catches the move's SAN, without check marks", () => {
    expect(giveaway("Play Nf3 now.", nf3)).toBe("it names the move Nf3");
    expect(giveaway("Bb5 pins the knight.", { san: "Bb5+", uci: "f1b5" })).toBe("it names the move Bb5");
    expect(giveaway("Promote with e8=Q.", { san: "e8=Q", uci: "e7e8q" })).toBe("it names the move e8=Q");
  });

  it("catches the target square as a word or at the end of a move", () => {
    expect(giveaway("The f3 square needs a defender.", nf3)).toBe("it names the target square f3");
    expect(giveaway("Something must go to f3!", nf3)).toBe("it names the target square f3");
    expect(giveaway("Think of Ng1-f3.", nf3)).toBe("it names the target square f3");
    expect(giveaway("Recapture with exd5 or cxd5? Think about the structure.", cxd5)).toBe("it names the move cxd5");
    expect(giveaway("Your pawn could take on d5.", cxd5)).toBe("it names the target square d5");
    expect(giveaway("A knight on d5 would be strong.", cxd5)).toBe("it names the target square d5");
    expect(giveaway("Compare it with Nxd5.", cxd5)).toBe("it names the target square d5");
    expect(giveaway("Rad5 is the rook's idea.", cxd5)).toBe("it names the target square d5");
    expect(giveaway("The c4-pawn can advance.", { san: "c4", uci: "c2c4" })).toBe("it names the move c4");
  });

  it("leaves other squares and words alone", () => {
    expect(giveaway("Develop a kingside piece towards the centre.", nf3)).toBeNull();
    expect(giveaway("Control e5 and d4.", nf3)).toBeNull();
    expect(giveaway("The f-file and the f2-f4 idea come later.", nf3)).toBeNull();
    expect(giveaway("Nf33 and af3 are not squares.", nf3)).toBeNull();
    expect(giveaway("Use the c-pawn to change the structure.", cxd5)).toBeNull();
    expect(giveaway("Castle soon after this.", nf3)).toBeNull();
  });

  it("catches castling for a castling move, but not its target square", () => {
    expect(giveaway("Castle now.", castle)).toBe("it mentions castling");
    expect(giveaway("Castling connects the rooks.", castle)).toBe("it mentions castling");
    expect(giveaway("Think of 0-0.", castle)).toBe("it mentions castling");
    expect(giveaway("O-O-O is too slow; play the other way.", castle)).toBe("it names the move O-O");
    expect(giveaway("Make your king safe; g1 is a good home.", castle)).toBeNull();
    expect(giveaway("Long castling.", { san: "O-O-O", uci: "e1c1" })).toBe("it mentions castling");
  });
});

describe("hints that give the move away", () => {
  it("is an error on a note's hint or narrow", () => {
    const files = changed((byId) => {
      const notes = byId["white-english-e5"].notes!;
      notes["1.c4 e5 2.Nc3"].hint = "Develop with Nc3 to guard d5.";
      notes["1.c4 e5 2.Nc3"].narrow = "The knight goes to c3.";
      notes["1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 d5 5.cxd5 Nxd5 6.Bg2 Nb6 7.O-O"].narrow = "Castle on the kingside.";
    });
    expect(errors(lint(files))).toEqual([
      {
        level: "error",
        fileId: "white-english-e5",
        path: 'notes."c4 e5 Nc3".hint',
        message: 'notes."c4 e5 Nc3".hint: the hint for 2.Nc3 gives the move away: it names the move Nc3'
      },
      {
        level: "error",
        fileId: "white-english-e5",
        path: 'notes."c4 e5 Nc3".narrow',
        message: 'notes."c4 e5 Nc3".narrow: the narrow for 2.Nc3 gives the move away: it names the target square c3'
      },
      {
        level: "error",
        fileId: "white-english-e5",
        path: 'notes."c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O".narrow',
        message:
          'notes."c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O".narrow: the narrow for 7.O-O gives the move away: it mentions castling'
      }
    ]);
  });

  it("checks Black's notes too", () => {
    const files = changed((byId) => {
      byId["black-scandinavian"].notes!["1.e4 d5"].hint = "Strike at e4 with your d-pawn: d5!";
    });
    expect(errors(lint(files)).map((issue) => issue.path)).toEqual(['notes."e4 d5".hint']);
  });
});

describe("notes no line plays", () => {
  it("warns about a note on a move that no line or trap plays", () => {
    const files = changed((byId) => {
      byId["white-english-e5"].notes!["1.c4 e5 2.Nc3 Nc6 3.Nf3"] = { why: "Not part of any line." };
    });
    const stray = warnings(lint(files)).filter((issue) => issue.path === 'notes."c4 e5 Nc3 Nc6 Nf3"');
    expect(stray).toEqual([
      {
        level: "warning",
        fileId: "white-english-e5",
        path: 'notes."c4 e5 Nc3 Nc6 Nf3"',
        message: `notes."c4 e5 Nc3 Nc6 Nf3": no White line or trap plays 3.Nf3 in this position; check the note's move path`
      }
    ]);
  });

  it("counts only the lines of the note's own side: a White note is never shown to Black", () => {
    const files = changed((byId) => {
      // Only the Black Scandinavian plays 1.e4 d5 2.exd5 Qxd5.
      byId["white-english-e5"].notes!["1.e4 d5 2.exd5 Qxd5"] = { why: "Black takes back with the queen." };
      delete byId["black-scandinavian"].notes!["1.e4 d5 2.exd5 Qxd5"];
    });
    const issues = warnings(lint(files));
    expect(issues.find((issue) => issue.path === 'notes."e4 d5 exd5 Qxd5"')).toEqual({
      level: "warning",
      fileId: "white-english-e5",
      path: 'notes."e4 d5 exd5 Qxd5"',
      message: `notes."e4 d5 exd5 Qxd5": no White line or trap plays 2...Qxd5 in this position; check the note's move path`
    });
    // Black's 2...Qxd5 still counts as a move without a note: the White note does not speak to Black.
    expect(issues.filter((issue) => issue.path === "1.e4 d5 2.exd5 Qxd5")).toEqual([
      expect.objectContaining({ fileId: "black-scandinavian", lineId: "scandi-qa5", message: expect.stringContaining("your move 2...Qxd5 has no note") })
    ]);
  });

  it("accepts a note on a trap move", () => {
    const files = changed((byId) => {
      byId["white-english-e5"].notes!["1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf2#"] = { why: "Mate." };
    });
    expect(lint(files).some((issue) => issue.path?.includes("Qxf2#"))).toBe(false);
  });
});

describe("recall positions", () => {
  /** A line that stops where the Four Knights and the 4...Bb4 line both pass. */
  const fianchetto = {
    id: "eng-nf6-fianchetto",
    name: "Four Knights fianchetto, by transposition",
    priority: "secondary" as const,
    moves: "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3",
    description: "The set-up itself.",
    plans: ["Bg2 and O-O."]
  };

  it("warns when other lines pass through a line's recall position", () => {
    const files = changed((byId) => byId["white-english-nf6"].lines.push(fianchetto));
    const recall = warnings(lint(files)).filter((issue) => issue.path === "recall");
    expect(recall).toEqual([
      {
        level: "warning",
        fileId: "white-english-nf6",
        lineId: "eng-nf6-fianchetto",
        path: "recall",
        message:
          'recall: ambiguous recall position (after 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3): "eng-e5-four-knights", "eng-nf6-four-knights-bb4" also pass through it; ' +
          "choose a recall.ply only this line reaches"
      }
    ]);
  });

  it("warns when two lines share the same recall position", () => {
    const files = changed((byId) => {
      byId["white-english-nf6"].lines.push(fianchetto);
      lineOf([byId["white-english-e5"]], "eng-e5-four-knights").recall = { ply: 7 };
    });
    const recall = warnings(lint(files)).filter((issue) => issue.path === "recall");
    expect(recall.map((issue) => [issue.lineId, issue.message])).toEqual([
      [
        "eng-e5-four-knights",
        'recall: ambiguous recall position (after 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3): "eng-nf6-four-knights-bb4" also passes through it; choose a recall.ply only this line reaches'
      ],
      [
        "eng-nf6-fianchetto",
        'recall: the recall position (after 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3) is also the recall position of "eng-e5-four-knights"; give one of them a different recall.ply'
      ],
      [
        "eng-nf6-fianchetto",
        'recall: ambiguous recall position (after 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3): "eng-nf6-four-knights-bb4" also passes through it; choose a recall.ply only this line reaches'
      ]
    ]);
  });

  it("compares recall positions within one side only", () => {
    const files = changed((byId) => {
      // Recall Black's 3...Qa5 line after 1.e4: a position White's lines never reach anyway.
      lineOf([byId["black-scandinavian"]], "scandi-qa5").recall = { ply: 1 };
    });
    const recall = warnings(lint(files)).filter((issue) => issue.path === "recall");
    expect(recall.map((issue) => issue.lineId)).toEqual(["scandi-qa5"]);
    expect(recall[0].message).toContain('"scandi-nf3-bg4" also passes through it');
  });
});

describe("lintAgainstBook", () => {
  const book = loadBookFromTsv([
    [
      "eco\tname\tpgn",
      "A10\tEnglish Opening\t1. c4",
      "A20\tEnglish Opening: King's English Variation\t1. c4 e5",
      "A25\tEnglish Opening: King's English Variation, Taimanov Variation\t1. c4 e5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7",
      "A28\tEnglish Opening: King's English Variation, Four Knights Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6"
    ].join("\n"),
    ["eco\tname\tpgn", "B01\tScandinavian Defense\t1. e4 d5"].join("\n")
  ]);
  const catalog = buildCatalog(fixtureFiles(), [
    {
      id: "my-english",
      side: "white",
      chapter: "My lines",
      family: "English Opening",
      name: "No ECO given",
      eco: null,
      moves: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.e3",
      description: "A custom line.",
      plans: ["Nge2."],
      createdAt: 0,
      updatedAt: 0
    }
  ]);
  const issues = lintAgainstBook(catalog, book);

  it("warns when the ECO differs from the deepest named position on the line", () => {
    expect(issues.map((issue) => issue.lineId)).toEqual(["eng-e5-bc5", "eng-e5-closed", "eng-e5-four-knights", "eng-nf6-four-knights-bb4"]);
    expect(issues[1]).toEqual({
      level: "warning",
      fileId: "white-english-e5",
      lineId: "eng-e5-closed",
      path: "eco",
      message:
        'eco: the line says A26, but the deepest position on it that the opening book names (after 1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7) is A25 "English Opening: King\'s English Variation, Taimanov Variation"'
    });
    // The 4...Bb4 line reaches the named Four Knights position by transposition.
    expect(issues[3].message).toContain('(after 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6) is A28 "English Opening: King\'s English Variation, Four Knights Variation"');
  });

  it("is quiet when the ECO matches, when there is none, or when the book names nothing on the line", () => {
    expect(issues.some((issue) => ["eng-e5-four-knights-e3", "scandi-qa5", "scandi-nf3-bg4", "my-english"].includes(issue.lineId!))).toBe(false);
    const empty = loadBookFromTsv(["eco\tname\tpgn\nA40\tQueen's Pawn Game\t1. d4"]);
    expect(lintAgainstBook(catalog, empty)).toEqual([]);
  });
});
