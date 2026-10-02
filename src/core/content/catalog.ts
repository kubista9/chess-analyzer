import { Chess } from "chess.js";
import { formatLine, moveLabel, parseMovetext } from "../chess/format";
import { IllegalMoveError, START_EPD, fenOf, replayMoves, toEpd, type Color } from "../chess/position";
import type { CustomLineRecord } from "../training/types";
import { compileChapter, compileCustomLines, parseContentFile } from "./compile";
import { SIDES, type ContentFile, type LineDef } from "./schema";
import { moveKey, type Catalog, type Chapter, type CompiledNote, type ContentIssue, type Line } from "./types";

// The whole repertoire, compiled once: built-in chapters (content/**/*.json) plus the user's
// own lines, with lookups by id and the move notes indexed by position. Also PGN and content
// JSON export, and PGN import for "Add a line".

/** Maximum length of a PGN movetext line, in characters (the PGN export format's limit). */
export const PGN_LINE_WIDTH = 80;

/** Optional extras for buildCatalog. */
export interface BuildCatalogOptions {
  /** fileNames[i] names files[i] in issues about a file that does not validate (e.g. "white/english.json"). */
  fileNames?: readonly string[];
}

const SIDE_RANK: Record<Color, number> = { white: 0, black: 1 };

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Everything a note says, for telling a harmless duplicate from a conflicting one. */
function noteText(note: CompiledNote): string {
  const { idea, hint, narrow, why, fits, avoids, alternatives, mistakes } = note;
  return JSON.stringify({ idea, hint, narrow, why, fits, avoids, alternatives, mistakes });
}

/**
 * Compiles every content file and the user's custom lines into one catalog. Files are taken
 * in order of side, `order`, then id. A duplicate chapter or line id is an error and the later
 * one is left out. Notes are indexed by moveKey(epdBefore, uci): a note written for the side
 * that plays the move beats one written from the other side (only it has the hints), otherwise
 * the first chapter in order wins; duplicates with different text are a warning.
 */
export function buildCatalog(
  files: readonly unknown[],
  customLines: readonly CustomLineRecord[] = [],
  options: BuildCatalogOptions = {}
): Catalog {
  const issues: ContentIssue[] = [];
  const parsed: { file: ContentFile; index: number }[] = [];
  files.forEach((json, index) => {
    const result = parseContentFile(json, options.fileNames?.[index]);
    issues.push(...result.issues);
    if (result.file) {
      parsed.push({ file: result.file, index });
    }
  });
  parsed.sort(
    (left, right) =>
      SIDE_RANK[left.file.side] - SIDE_RANK[right.file.side] ||
      left.file.order - right.file.order ||
      compareText(left.file.id, right.file.id) ||
      left.index - right.index
  );

  const chapters: Chapter[] = [];
  const lines: Line[] = [];
  const chapterById = new Map<string, Chapter>();
  const lineById = new Map<string, Line>();
  const notes = new Map<string, CompiledNote>();
  const noteSide = new Map<string, Color>();

  const addChapter = (chapter: Chapter, chapterLines: readonly Line[], fileName?: string): boolean => {
    if (chapterById.has(chapter.id)) {
      const where = fileName ? ` (${fileName})` : "";
      issues.push({ level: "error", fileId: chapter.id, message: `duplicate chapter id "${chapter.id}"${where}; this chapter is left out` });
      return false;
    }
    const kept: Line[] = [];
    for (const line of chapterLines) {
      const existing = lineById.get(line.id);
      if (existing) {
        issues.push({
          level: "error",
          fileId: chapter.id,
          lineId: line.id,
          message: `duplicate line id "${line.id}" (already used in chapter "${existing.chapterId}"); this line is left out`
        });
        continue;
      }
      lineById.set(line.id, line);
      kept.push(line);
    }
    const compiled = { ...chapter, lineIds: kept.map((line) => line.id) };
    chapterById.set(compiled.id, compiled);
    chapters.push(compiled);
    lines.push(...kept);
    return true;
  };

  const addNote = (note: CompiledNote, side: Color) => {
    const key = moveKey(note.epdBefore, note.uci);
    const existing = notes.get(key);
    if (!existing) {
      notes.set(key, note);
      noteSide.set(key, side);
      return;
    }
    const existingFromMover = noteSide.get(key) === existing.mover;
    const fromMover = side === note.mover;
    if (fromMover && !existingFromMover) {
      notes.set(key, note);
      noteSide.set(key, side);
    } else if (fromMover === existingFromMover && noteText(note) !== noteText(existing)) {
      const where = existing.chapterId === note.chapterId ? "elsewhere in this chapter" : `in chapter "${existing.chapterId}"`;
      issues.push({
        level: "warning",
        fileId: note.chapterId,
        path: `notes.${JSON.stringify(note.key)}`,
        message: `the note on ${moveLabel(note.key.split(" ").length, note.san)} after ${pathLabel(note)} is also written ${where} with different text; that one is used`
      });
    }
  };

  let orderBase = 0;
  for (const { file, index } of parsed) {
    const compiled = compileChapter(file, "builtin", orderBase);
    orderBase += file.lines.length;
    if (!addChapter(compiled.chapter, compiled.lines, options.fileNames?.[index])) {
      continue;
    }
    issues.push(...compiled.issues);
    for (const note of compiled.notes) {
      addNote(note, compiled.chapter.side);
    }
  }

  const custom = compileCustomLines(customLines, orderBase);
  issues.push(...custom.issues);
  for (const chapter of custom.chapters) {
    addChapter(
      chapter,
      custom.lines.filter((line) => line.chapterId === chapter.id)
    );
  }

  chapters.sort((left, right) => SIDE_RANK[left.side] - SIDE_RANK[right.side] || left.order - right.order || compareText(left.id, right.id));
  lines.sort((left, right) => left.order - right.order);
  return { chapters, lines, chapterById, lineById, notes, issues };
}

/** "the start" or "1.c4 e5" for the position a note's move is played from. */
function pathLabel(note: CompiledNote): string {
  const sans = note.key.split(" ").slice(0, -1);
  return sans.length === 0 ? "the start" : formatLine(sans);
}

/** The note on the move `uci` played from `epdBefore`, if the content has one. */
export function noteFor(catalog: Catalog, epdBefore: string, uci: string): CompiledNote | undefined {
  return catalog.notes.get(moveKey(epdBefore, uci));
}

/** The chapters of one side, in order. */
export function chaptersForSide(catalog: Catalog, side: Color): Chapter[] {
  return catalog.chapters.filter((chapter) => chapter.side === side);
}

/** The lines of one side, in teaching order. */
export function linesForSide(catalog: Catalog, side: Color): Line[] {
  return catalog.lines.filter((line) => line.side === side);
}

/** Content counts of one side. */
export interface SideSummary {
  side: Color;
  chapters: number;
  lines: number;
  /** Lines on until the user changes it. */
  defaultEnabledLines: number;
  /** Plies over all lines. */
  plies: number;
  /** Distinct user moves (position and move) over all lines. */
  userMoves: number;
  /** Of those, the ones with a note. */
  notedUserMoves: number;
  /** notedUserMoves / userMoves (0..1), or null without user moves. */
  coverage: number | null;
}

/** Counts per side for `content:check`'s summary table. */
export function summariseCatalog(catalog: Catalog): SideSummary[] {
  return SIDES.map((side) => {
    const sideLines = linesForSide(catalog, side);
    const userMoves = new Set<string>();
    for (const line of sideLines) {
      for (const ply of line.userPlies) {
        const move = line.moves[ply - 1];
        userMoves.add(moveKey(move.epdBefore, move.uci));
      }
    }
    const notedUserMoves = [...userMoves].filter((key) => catalog.notes.has(key)).length;
    return {
      side,
      chapters: chaptersForSide(catalog, side).length,
      lines: sideLines.length,
      defaultEnabledLines: sideLines.filter((line) => line.defaultEnabled).length,
      plies: sideLines.reduce((sum, line) => sum + line.moves.length, 0),
      userMoves: userMoves.size,
      notedUserMoves,
      coverage: userMoves.size === 0 ? null : notedUserMoves / userMoves.size
    };
  });
}

function pgnValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Joins tokens with spaces into lines of at most `width` characters (a longer token gets a line of its own). */
function wrapTokens(tokens: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (!current) {
      current = token;
    } else if (current.length + 1 + token.length <= width) {
      current += ` ${token}`;
    } else {
      lines.push(current);
      current = token;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * A line as a PGN game: the seven standard tags (Event "Repertoire line", players "?"), Opening
 * and ECO, then the movetext in export format wrapped at PGN_LINE_WIDTH. With `notes` (and
 * `comments` not false) each move with a note gets its "why" as a {comment}.
 */
export function lineToPgn(line: Line, options: { comments?: boolean; notes?: Catalog } = {}): string {
  const headers: [string, string][] = [
    ["Event", "Repertoire line"],
    ["Site", "?"],
    ["Date", "????.??.??"],
    ["Round", "?"],
    ["White", "?"],
    ["Black", "?"],
    ["Result", "*"],
    ["Opening", line.name]
  ];
  if (line.eco) {
    headers.push(["ECO", line.eco]);
  }
  const catalog = options.comments === false ? undefined : options.notes;
  const tokens: string[] = [];
  let afterComment = false;
  line.moves.forEach((move, index) => {
    const ply = index + 1;
    const number = Math.ceil(ply / 2);
    if (move.color === "white") {
      tokens.push(`${number}. ${move.san}`);
    } else if (index === 0 || afterComment) {
      tokens.push(`${number}... ${move.san}`);
    } else {
      tokens.push(move.san);
    }
    afterComment = false;
    const why = catalog ? noteFor(catalog, move.epdBefore, move.uci)?.why : undefined;
    if (why) {
      const words = why.replace(/[{}]/g, "").split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        words[0] = `{${words[0]}`;
        words[words.length - 1] = `${words[words.length - 1]}}`;
        tokens.push(...words);
        afterComment = true;
      }
    }
  });
  tokens.push("*");
  const headerText = headers.map(([key, value]) => `[${key} "${pgnValue(value)}"]`).join("\n");
  return `${headerText}\n\n${wrapTokens(tokens, PGN_LINE_WIDTH).join("\n")}\n`;
}

const HEADER_PATTERN = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/;

/**
 * Reads the first game of a PGN: its tags and the main line (variations, comments, NAGs and the
 * result dropped), replayed with chess.js into canonical SAN. Throws an Error with a message for
 * the user when a move is illegal or the game starts from a set-up position.
 */
export function parsePgnMainLine(pgn: string): { sans: string[]; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const movetext: string[] = [];
  for (const raw of pgn.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const text = raw.trim();
    if (text.startsWith("%")) {
      continue;
    }
    const header = HEADER_PATTERN.exec(text);
    if (header) {
      if (movetext.some((part) => part.trim() !== "")) {
        // The tags of the next game: only the first game is read.
        break;
      }
      headers[header[1]] = header[2].replace(/\\(["\\])/g, "$1");
      continue;
    }
    movetext.push(raw);
  }

  if (headers.FEN !== undefined) {
    let startEpd: string | null;
    try {
      startEpd = toEpd(new Chess(fenOf(headers.FEN)).fen());
    } catch {
      startEpd = null;
    }
    if (startEpd !== START_EPD) {
      throw new Error("This PGN starts from a set-up position. A repertoire line has to start from the initial position.");
    }
  }

  const tokens = parseMovetext(movetext.join("\n"));
  try {
    return { sans: replayMoves(tokens).map((move) => move.san), headers };
  } catch (error) {
    if (error instanceof IllegalMoveError) {
      const where = error.index === 0 ? "in the starting position" : `after ${formatLine(tokens.slice(0, error.index))}`;
      throw new Error(`Move ${moveLabel(error.index + 1, error.move)} is not legal ${where}.`);
    }
    throw error;
  }
}

/**
 * A compiled line in the content file format, ready to paste into a chapter's `lines`. Source
 * and review are written when they differ from the chapter's, and always for a custom line
 * (it will land in a chapter with other metadata).
 */
export function lineToContentJson(line: Line, catalog: Catalog): LineDef {
  const chapter = catalog.chapterById.get(line.chapterId);
  const writeMeta = line.origin === "custom" || !chapter;
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  return {
    id: line.id,
    name: line.name,
    ...(line.eco ? { eco: line.eco } : {}),
    priority: line.priority,
    defaultEnabled: line.defaultEnabled,
    moves: formatLine(line.sans),
    description: line.description,
    plans: [...line.plans],
    ideas: [...line.ideas],
    traps: line.traps.map((trap) => ({ name: trap.name, moves: formatLine(trap.sans), side: trap.side, description: trap.description })),
    checkpoints: line.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    ...(line.recallPly !== line.moves.length ? { recall: { ply: line.recallPly } } : {}),
    ...(writeMeta || differs(line.source, chapter?.source) ? { source: structuredClone(line.source) } : {}),
    ...(writeMeta || differs(line.review, chapter?.review) ? { review: structuredClone(line.review) } : {})
  };
}
