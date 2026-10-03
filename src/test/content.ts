import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentFileInput } from "../core/content/schema";
import type { ContentIssue } from "../core/content/types";

// Content for tests and scripts: the real chapter files read with fs (the app uses
// import.meta.glob in core/content/builtin.ts instead), the opening-book TSVs, and a small
// hand-written repertoire used as a fixture by the content tests.

/** The repository root (this file lives in src/test/). */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CONTENT_DIR = join(REPO_ROOT, "content");
export const BOOK_DIR = join(REPO_ROOT, "data", "chess-openings");

export interface ContentEntry {
  /** Path relative to the content folder with forward slashes, e.g. "white/english-e5.json". */
  path: string;
  /** The parsed JSON, or undefined when the file is not valid JSON (see `error`). */
  json: unknown;
  error: string | null;
}

/** Every *.json file under `dir` (recursively), as sorted forward-slash paths relative to it. */
export function contentJsonPaths(dir: string = CONTENT_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && statSync(join(dir, name)).isFile())
    .map((name) => name.split(sep).join("/"))
    .sort();
}

/** Reads and parses every content file; a file that is not valid JSON gets an error instead. */
export function readContentEntries(dir: string = CONTENT_DIR): ContentEntry[] {
  return contentJsonPaths(dir).map((path) => {
    const text = readFileSync(join(dir, path), "utf8");
    try {
      return { path, json: JSON.parse(text) as unknown, error: null };
    } catch (error) {
      return { path, json: undefined, error: `not valid JSON: ${(error as Error).message}` };
    }
  });
}

/** The parsed content files (content/**\/*.json) in path order. Throws when a file is not valid JSON. */
export function loadContentFiles(dir: string = CONTENT_DIR): unknown[] {
  return readContentEntries(dir).map((entry) => {
    if (entry.error !== null) {
      throw new Error(`${relative(REPO_ROOT, join(dir, entry.path))}: ${entry.error}`);
    }
    return entry.json;
  });
}

/** The opening-book TSV texts (data/chess-openings/*.tsv) in file-name order. */
export function loadBookTexts(dir: string = BOOK_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsv"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

/**
 * Files must sit in the folder of their side: content/white/ for White chapters, content/black/
 * for Black ones (an error otherwise; a file outside both folders is a warning).
 */
export function folderSideIssues(entries: readonly ContentEntry[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const entry of entries) {
    if (entry.error !== null || entry.json === null || typeof entry.json !== "object") {
      continue;
    }
    const { id, side } = entry.json as { id?: unknown; side?: unknown };
    const folder = entry.path.split("/")[0];
    const fileId = typeof id === "string" ? id : entry.path;
    if (folder !== "white" && folder !== "black") {
      issues.push({ level: "warning", fileId, message: `${entry.path}: chapter files belong in content/white/ or content/black/` });
    } else if (side !== folder) {
      issues.push({ level: "error", fileId, path: "side", message: `side: "${String(side)}" does not match the folder content/${folder}/ (${entry.path})` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Fixture repertoire: a small English Opening (two chapters) and a Scandinavian for Black.
//
// - shared prefixes: every White line starts 1.c4, most continue 1...e5 2.Nc3
// - a transposition: 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3 reaches the Four Knights of 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3
// - edge order by priority: "eng-e5-bc5" (secondary) comes first in its file, yet 2...Bc5 sorts after 2...Nc6 and 2...Nf6
// - a disabled-by-default line ("eng-e5-four-knights-e3") that plays 4.e3 where the Four Knights plays 4.g3
// - notes with alternatives and mistakes, a note on an opponent move, a trap and checkpoints
// - two deliberate gaps: 6.Rb1 and 4.e3 have no note
// ---------------------------------------------------------------------------------------------

const FIXTURE_SOURCE: ContentFileInput["source"] = {
  kind: "editorial",
  references: ["Opening principles: Chess Opening Fundamentals (I. Smirnov), ideas only, no text reproduced"]
};

const FIXTURE_REVIEW: ContentFileInput["review"] = { status: "draft", confidence: "medium", checkedWith: ["chess.js legality"] };

/** FENs of the fixture's checkpoints (as chess.js writes them). */
export const FIXTURE_FENS = {
  closedAfterBg7: "r1bqk1nr/pppp1pbp/2n3p1/4p3/2P5/2N3P1/PP1PPPBP/R1BQK1NR w KQkq - 2 5",
  fourKnightsAfterG3: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2P5/2N2NP1/PP1PPP1P/R1BQKB1R b KQkq - 0 4",
  scandinavianAfterQa5: "rnb1kbnr/ppp1pppp/8/q7/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 4"
} as const;

const ENGLISH_E5: ContentFileInput = {
  schemaVersion: 1,
  id: "white-english-e5",
  side: "white",
  group: "English Opening",
  family: "English Opening",
  chapter: "1...e5: the Reversed Sicilian",
  order: 10,
  summary: "White meets 1...e5 with Nc3 and a kingside fianchetto: a Sicilian with the colours reversed and an extra tempo.",
  ideas: ["Control d5 with the c-pawn, the c3-knight and the g2-bishop.", "Expand on the queenside with Rb1 and b4."],
  source: FIXTURE_SOURCE,
  review: FIXTURE_REVIEW,
  notes: {
    "1.c4": {
      idea: "centre",
      hint: "Start by taking a share of the centre without committing your central pawns.",
      narrow: "A flank pawn on the queenside can control d5.",
      why: "Controls d5 from the side and keeps the d- and e-pawns flexible.",
      fits: "The English builds pressure on the light squares before deciding the centre.",
      avoids: "Rushing a fixed pawn centre that gives Black an early target.",
      alternatives: [{ san: "Nf3", note: "Just as flexible; it often transposes after a later c4.", transposes: true }],
      mistakes: [{ san: "g4", note: "Weakens your kingside and does nothing for the centre.", severity: "mistake" }]
    },
    "1.c4 e5": { why: "Black takes the centre directly, a Sicilian with the colours reversed." },
    "1.c4 e5 2.Nc3": {
      idea: "development",
      hint: "Bring out a piece that adds pressure on the light central squares.",
      narrow: "Look at your queenside knight.",
      why: "Develops and adds a second guard of d5.",
      alternatives: [{ san: "g3", note: "The fianchetto first keeps the knight's square open; it usually transposes.", transposes: true }]
    },
    "1.c4 e5 2.Nc3 Nc6 3.g3": { idea: "development", why: "Prepares Bg2, so the bishop bears down on d5 and the long diagonal." },
    "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2": {
      idea: "development",
      why: "The bishop controls d5 and eyes the queenside along the long diagonal.",
      mistakes: [{ san: "Bh3", note: "The bishop does nothing on h3 and can be exchanged.", severity: "inaccuracy" }]
    },
    "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3": { idea: "structure", why: "Supports a later e4 or c5 and opens the c1-bishop." },
    "1.c4 e5 2.Nc3 Nf6 3.Nf3": { idea: "development", why: "Develops and puts the question to the e5-pawn." },
    "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3": { idea: "development", why: "The fianchetto aims the bishop at d5 before the centre opens." },
    "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 d5 5.cxd5": {
      idea: "structure",
      hint: "Change the pawn structure before Black can support the advanced pawn.",
      why: "Exchanges the flank pawn for a centre pawn, a Sicilian structure with an extra tempo.",
      alternatives: [{ san: "d4", note: "Opens the centre at once; sharper, but sound." }]
    },
    "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 d5 5.cxd5 Nxd5 6.Bg2": { idea: "development", why: "Hits the d5-knight along the long diagonal." },
    "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 d5 5.cxd5 Nxd5 6.Bg2 Nb6 7.O-O": {
      idea: "king-safety",
      hint: "Your king is still in the middle: make it safe before the centre opens.",
      why: "Gets the king safe and connects the rooks; d4 or a4 can follow."
    },
    "1.c4 e5 2.Nc3 Bc5 3.g3": { idea: "development", why: "Keeps to the fianchetto plan." },
    "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6": { why: "Black lines up the queen and bishop against f2 and threatens mate." },
    "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.e3": {
      idea: "prevention",
      hint: "Black is threatening something serious against your king: stop it first.",
      narrow: "A central pawn can block the bishop's diagonal.",
      why: "Blocks the c5-bishop's diagonal, so f2 is safe.",
      alternatives: [{ san: "Nf3", note: "Also stops the mate by blocking the f-file." }],
      mistakes: [{ san: "Bg2", note: "Allows ...Qxf2 mate.", severity: "mistake" }]
    }
  },
  lines: [
    {
      id: "eng-e5-bc5",
      name: "2...Bc5 with the early queen",
      eco: "A21",
      priority: "secondary",
      moves: "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.e3",
      description: "Black aims straight at f2; you block the bishop and develop normally.",
      plans: ["Nge2 and d4 to gain time against the bishop and queen."],
      traps: [
        {
          name: "Mate on f2",
          moves: "1.c4 e5 2.Nc3 Bc5 3.g3 Qf6 4.Bg2 Qxf2#",
          side: "against",
          description: "Developing the bishop at once walks into mate."
        }
      ]
    },
    {
      id: "eng-e5-closed",
      name: "Closed system with g3, Bg2 and d3",
      eco: "A26",
      priority: "main",
      moves: "1.c4 e5 2.Nc3 Nc6 3.g3 g6 4.Bg2 Bg7 5.d3 d6 6.Rb1",
      description: "Both sides fianchetto; you prepare b4 on the queenside.",
      plans: ["b4-b5 to push away the c6-knight.", "Nf3 or e3 and Nge2, then O-O."],
      checkpoints: [{ ply: 8, fen: FIXTURE_FENS.closedAfterBg7, label: "Both bishops fianchettoed" }]
    },
    {
      id: "eng-e5-four-knights",
      name: "Four Knights with g3",
      eco: "A29",
      priority: "main",
      moves: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.g3 d5 5.cxd5 Nxd5 6.Bg2 Nb6 7.O-O",
      description: "A reversed Dragon: your bishop on g2 presses against Black's centre.",
      plans: ["a3 and b4 on the queenside.", "d3 and Be3, keeping the pressure on the long diagonal."],
      checkpoints: [{ ply: 7, fen: FIXTURE_FENS.fourKnightsAfterG3 }],
      recall: { ply: 9 }
    },
    {
      id: "eng-e5-four-knights-e3",
      name: "Four Knights with e3",
      eco: "A28",
      priority: "sideline",
      defaultEnabled: false,
      moves: "1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 4.e3",
      description: "A quieter set-up that keeps d4 in reserve.",
      plans: ["d4 next, or Qc2 and a3."],
      source: { kind: "editorial", references: [], note: "Optional line." }
    }
  ]
};

const ENGLISH_NF6: ContentFileInput = {
  schemaVersion: 1,
  id: "white-english-nf6",
  side: "white",
  group: "English Opening",
  family: "English Opening",
  chapter: "1...Nf6: the Anglo-Indian",
  order: 20,
  summary: "Against 1...Nf6 you play Nc3 and Nf3, which often transposes to the Four Knights.",
  ideas: ["Keep the Four Knights set-up whatever Black's move order."],
  source: FIXTURE_SOURCE,
  review: { status: "reviewed", confidence: "high", checkedWith: ["chess.js legality"] },
  notes: {
    "1.c4 Nf6 2.Nc3": { idea: "development", why: "Develops and controls d5 and e4." },
    "1.c4 Nf6 2.Nc3 e5": { why: "Black transposes to a King's English." },
    "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3 Bb4 5.Bg2": { idea: "development", why: "Completes the fianchetto; the pin on c3 does not worry you." },
    "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3 Bb4 5.Bg2 O-O 6.O-O": { idea: "king-safety", why: "Castles before deciding the centre." }
  },
  lines: [
    {
      id: "eng-nf6-four-knights-bb4",
      name: "Four Knights by transposition, 4...Bb4",
      eco: "A29",
      priority: "secondary",
      moves: "1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 4.g3 Bb4 5.Bg2 O-O 6.O-O",
      description: "Black pins the c3-knight; you castle and keep the bishop pair in mind.",
      plans: ["Nd5 to question the b4-bishop."]
    }
  ]
};

const SCANDINAVIAN: ContentFileInput = {
  schemaVersion: 1,
  id: "black-scandinavian",
  side: "black",
  group: "Against 1.e4",
  family: "Scandinavian Defence",
  chapter: "1.e4 d5: the Scandinavian",
  order: 10,
  summary: "You hit e4 at once and take back with the queen.",
  ideas: ["Develop quickly while White chases the queen."],
  source: FIXTURE_SOURCE,
  review: FIXTURE_REVIEW,
  notes: {
    "1.e4 d5": {
      idea: "centre",
      hint: "Challenge White's centre pawn straight away.",
      why: "Attacks e4 at once and opens lines for your pieces.",
      alternatives: [{ san: "e5", note: "Sound and classical, but a different opening." }]
    },
    "1.e4 d5 2.exd5": { why: "White takes the pawn and will gain time against your queen." },
    "1.e4 d5 2.exd5 Qxd5": { idea: "recapture", why: "Wins the pawn back at once." },
    "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5": { idea: "activity", why: "The queen is safe on a5, out of reach of the minor pieces, and eyes the c3-knight." },
    "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 4.d4 Nf6": { idea: "development", why: "Develops and covers the kingside." },
    "1.e4 d5 2.exd5 Qxd5 3.Nf3 Bg4": { idea: "development", why: "Pins the knight before White can play Nc3 with tempo." }
  },
  lines: [
    {
      id: "scandi-qa5",
      name: "Main line with 3...Qa5",
      eco: "B01",
      priority: "main",
      moves: "1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 4.d4 Nf6",
      description: "The classical Scandinavian: queen on a5, then Bf5 and c6.",
      plans: ["...Bf5, ...c6 and ...e6 with a solid Caro-Kann-like structure."],
      checkpoints: [{ ply: 6, fen: FIXTURE_FENS.scandinavianAfterQa5 }]
    },
    {
      id: "scandi-nf3-bg4",
      name: "3.Nf3 Bg4",
      eco: "B01",
      priority: "secondary",
      moves: "1.e4 d5 2.exd5 Qxd5 3.Nf3 Bg4",
      description: "Against the early knight you pin it at once.",
      plans: ["...Nc6 and ...O-O-O with quick development."]
    }
  ]
};

/** The fixture chapters as JSON (fresh copies, safe to modify): two White chapters and one Black. */
export function fixtureFiles(): ContentFileInput[] {
  return [structuredClone(ENGLISH_E5), structuredClone(ENGLISH_NF6), structuredClone(SCANDINAVIAN)];
}

/** One fixture chapter by id (a fresh copy). */
export function fixtureFile(id: "white-english-e5" | "white-english-nf6" | "black-scandinavian"): ContentFileInput {
  const file = fixtureFiles().find((candidate) => candidate.id === id);
  if (!file) {
    throw new Error(`No fixture chapter "${id}"`);
  }
  return file;
}
