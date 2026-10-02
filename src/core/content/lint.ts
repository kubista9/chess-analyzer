import { bareSan, formatLine, moveLabel } from "../chess/format";
import type { Color } from "../chess/position";
import { nameAt, type OpeningBook } from "../openingDb/book";
import { SIDES } from "./schema";
import { moveKey, type Catalog, type CompiledNote, type ContentIssue, type Line } from "./types";

// Authoring checks that need the whole catalog (compile.ts already checked each file on its own):
// enabled lines that disagree, hints that give the move away, missing or stray notes, recall
// positions that do not identify their line, and ECO codes that disagree with the opening book.

/** "the start" or "1.c4 e5 2.Nc3" for the position after the first `plies` moves of `sans`. */
function afterText(sans: readonly string[], plies: number): string {
  return plies === 0 ? "the start" : formatLine(sans.slice(0, plies));
}

const quoteIds = (lines: readonly Line[]) => lines.map((line) => `"${line.id}"`).join(", ");

/** One repertoire move of a line: the user's move at a position. */
interface UserMove {
  line: Line;
  /** 1-based ply of the move in its line. */
  ply: number;
  epd: string;
  uci: string;
  san: string;
}

/** The user's moves of every line of `side`, grouped by position, then by move (both in teaching order). */
function userMovesByPosition(catalog: Catalog, side: Color): Map<string, Map<string, UserMove[]>> {
  const byEpd = new Map<string, Map<string, UserMove[]>>();
  for (const line of catalog.lines) {
    if (line.side !== side) {
      continue;
    }
    const seen = new Set<string>();
    for (const ply of line.userPlies) {
      const move = line.moves[ply - 1];
      // A line that repeats a position (a knight out and back) counts once per position and move.
      const key = moveKey(move.epdBefore, move.uci);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const byUci = byEpd.get(move.epdBefore) ?? new Map<string, UserMove[]>();
      const list = byUci.get(move.uci) ?? [];
      list.push({ line, ply, epd: move.epdBefore, uci: move.uci, san: move.san });
      byUci.set(move.uci, list);
      byEpd.set(move.epdBefore, byUci);
    }
  }
  return byEpd;
}

/** "4.g3 (lines "a", "b")" for the lines that play one move at a position. */
function playedBy(moves: readonly UserMove[]): string {
  return `${moveLabel(moves[0].ply, moves[0].san)} (${quoteIds(moves.map((move) => move.line))})`;
}

/**
 * Two default-enabled lines that want different user moves in one position are an error: the
 * trainer would accept either, so neither is learnt as "the" move. A default-disabled line that
 * disagrees with any other line is a warning (switching it on adds a second answer there).
 */
function disagreements(catalog: Catalog, side: Color, issues: ContentIssue[]): void {
  for (const byUci of userMovesByPosition(catalog, side).values()) {
    if (byUci.size < 2) {
      continue;
    }
    const groups = [...byUci.values()];
    const first = groups[0][0];
    const where = afterText(first.line.sans, first.ply - 1);

    const enabled = groups
      .map((moves) => moves.filter((move) => move.line.defaultEnabled))
      .filter((moves) => moves.length > 0);
    if (enabled.length > 1) {
      const blamed = enabled[1][0].line;
      issues.push({
        level: "error",
        fileId: blamed.chapterId,
        lineId: blamed.id,
        path: "moves",
        message:
          `moves: lines enabled by default disagree after ${where}: ${enabled.map(playedBy).join(" · ")}; ` +
          `set "defaultEnabled": false on all but one, or make them agree`
      });
    }

    for (const moves of groups) {
      for (const move of moves) {
        if (move.line.defaultEnabled) {
          continue;
        }
        const others = groups.filter((other) => other !== moves);
        issues.push({
          level: "warning",
          fileId: move.line.chapterId,
          lineId: move.line.id,
          path: "moves",
          message:
            `moves: after ${where} this line plays ${moveLabel(move.ply, move.san)} and other lines play ${others.map(playedBy).join(" · ")}; ` +
            `with it switched on, both moves count as your repertoire move there`
        });
      }
    }
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mentions of castling: the word ("castle", "castling") or O-O / 0-0 written out. */
const CASTLING_MENTION = /castl|\b[O0]-[O0]\b/i;

/**
 * Why a hint text gives `note`'s move away, or null: it names the move's SAN (without check
 * marks), the target square of a non-castling move as a word (also inside a SAN such as "Nxd5"),
 * or castling for a castling move.
 */
export function giveaway(text: string, note: Pick<CompiledNote, "san" | "uci">): string | null {
  const san = bareSan(note.san);
  if (new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(san)}(?![A-Za-z0-9])`).test(text)) {
    return `it names the move ${san}`;
  }
  const castling = san.startsWith("O-O");
  if (castling) {
    return CASTLING_MENTION.test(text) ? "it mentions castling" : null;
  }
  const target = note.uci.slice(2, 4);
  // The square alone, or as the end of a SAN-like token: "Nxd5", "Rad1", "exd5".
  if (new RegExp(`(?<![A-Za-z0-9])(?:[KQRBN][a-h1-8]?x?|[a-h]x)?${target}(?![A-Za-z0-9])`).test(text)) {
    return `it names the target square ${target}`;
  }
  return null;
}

function giveaways(catalog: Catalog, issues: ContentIssue[]): void {
  for (const note of catalog.notes.values()) {
    const ply = note.key.split(" ").length;
    for (const field of ["hint", "narrow"] as const) {
      const text = note[field];
      const reason = text === null ? null : giveaway(text, note);
      if (reason) {
        const path = `notes.${JSON.stringify(note.key)}.${field}`;
        issues.push({
          level: "error",
          fileId: note.chapterId,
          path,
          message: `${path}: the ${field} for ${moveLabel(ply, note.san)} gives the move away: ${reason}`
        });
      }
    }
  }
}

/** User moves (position and move) that no note explains: the trainer then writes a generic hint. */
function missingNotes(catalog: Catalog, issues: ContentIssue[]): void {
  const reported = new Set<string>();
  for (const line of catalog.lines) {
    for (const ply of line.userPlies) {
      const move = line.moves[ply - 1];
      const key = moveKey(move.epdBefore, move.uci);
      if (catalog.notes.has(key) || reported.has(key)) {
        continue;
      }
      reported.add(key);
      const path = formatLine(line.sans.slice(0, ply));
      issues.push({
        level: "warning",
        fileId: line.chapterId,
        lineId: line.id,
        path,
        message: `${path}: your move ${moveLabel(ply, move.san)} has no note; the trainer falls back to a generic hint`
      });
    }
  }
}

/** Notes whose move no line or trap plays. */
function strayNotes(catalog: Catalog, issues: ContentIssue[]): void {
  const played = new Set<string>();
  for (const line of catalog.lines) {
    for (const move of line.moves) {
      played.add(moveKey(move.epdBefore, move.uci));
    }
    for (const trap of line.traps) {
      for (const move of trap.played) {
        played.add(moveKey(move.epdBefore, move.uci));
      }
    }
  }
  for (const [key, note] of catalog.notes) {
    if (!played.has(key)) {
      const path = `notes.${JSON.stringify(note.key)}`;
      issues.push({
        level: "warning",
        fileId: note.chapterId,
        path,
        message: `${path}: no line or trap plays ${moveLabel(note.key.split(" ").length, note.san)} in this position; check the note's move path`
      });
    }
  }
}

/**
 * Position Recall shows a line's recall position and asks which line it is. Another line with the
 * same recall position makes the question unanswerable; another line passing through it makes it
 * ambiguous.
 */
function recallClashes(catalog: Catalog, side: Color, issues: ContentIssue[]): void {
  const lines = catalog.lines.filter((line) => line.side === side);
  const recallEpd = (line: Line) => line.epds[line.recallPly];
  lines.forEach((line, index) => {
    const epd = recallEpd(line);
    const where = afterText(line.sans, line.recallPly);
    const same = lines.filter((other) => other !== line && recallEpd(other) === epd);
    const earlierSame = lines.slice(0, index).filter((other) => recallEpd(other) === epd);
    if (earlierSame.length > 0) {
      issues.push({
        level: "warning",
        fileId: line.chapterId,
        lineId: line.id,
        path: "recall",
        message: `recall: the recall position (after ${where}) is also the recall position of ${quoteIds(earlierSame)}; give one of them a different recall.ply`
      });
    }
    const passing = lines.filter((other) => other !== line && !same.includes(other) && other.epds.includes(epd));
    if (passing.length > 0) {
      issues.push({
        level: "warning",
        fileId: line.chapterId,
        lineId: line.id,
        path: "recall",
        message: `recall: ambiguous recall position (after ${where}): ${quoteIds(passing)} also pass${passing.length === 1 ? "es" : ""} through it; choose a recall.ply only this line reaches`
      });
    }
  });
}

/**
 * Catalog-wide content checks. Errors: default-enabled lines that disagree in a position, hints
 * that give the move away. Warnings: user moves without a note, notes no line or trap plays,
 * default-disabled lines that disagree with another line, recall positions shared with another line.
 */
export function lintCatalog(catalog: Catalog): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const side of SIDES) {
    disagreements(catalog, side, issues);
  }
  giveaways(catalog, issues);
  missingNotes(catalog, issues);
  strayNotes(catalog, issues);
  for (const side of SIDES) {
    recallClashes(catalog, side, issues);
  }
  return issues;
}

/**
 * A warning for every line whose `eco` differs from the ECO of the deepest position on the line
 * that the opening book names. Lines without an ECO or without a named position are not checked.
 */
export function lintAgainstBook(catalog: Catalog, book: OpeningBook): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (const line of catalog.lines) {
    if (!line.eco) {
      continue;
    }
    const named = nameAt(book, line.epds);
    if (named && named.eco !== line.eco) {
      issues.push({
        level: "warning",
        fileId: line.chapterId,
        lineId: line.id,
        path: "eco",
        message: `eco: the line says ${line.eco}, but the deepest position on it that the opening book names (after ${afterText(line.sans, named.index)}) is ${named.eco} "${named.name}"`
      });
    }
  }
  return issues;
}
