import { Chess } from "chess.js";
import { normalizeResult } from "../../shared/chess.js";
import { categorizeMove, checkmateEval, toWhiteEval, winPercentLoss, type WhiteEval } from "../../shared/eval.js";
import { noteForCategory } from "../../shared/notes.js";
import type {
  AnnotatedMove,
  ArchiveGame,
  EngineLine,
  PlayerColor,
  ReviewGameHeader,
  ReviewLine
} from "../../shared/types.js";
import type { ParsedMove } from "./gameParser.js";

// Pure review maths: engine output in, White-view annotated moves out. No engine here.

/** One analysed position: its White-view eval and the raw engine lines (side-to-move view). */
export interface PositionAnalysis {
  eval: WhiteEval;
  lines: EngineLine[];
}

export function sideToMove(fen: string): PlayerColor {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

/**
 * The eval of a position the engine returns no line for: checkmate or stalemate.
 * Returns null for any other position, which needs an engine search.
 */
export function terminalAnalysis(fen: string): PositionAnalysis | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) {
    return { eval: checkmateEval(sideToMove(fen)), lines: [] };
  }
  if (chess.isStalemate()) {
    return { eval: { cp: 0, mate: null }, lines: [] };
  }
  return null;
}

/** Turns raw engine lines for `fen` into a PositionAnalysis (eval from the top line). */
export function analysisFromLines(fen: string, lines: EngineLine[]): PositionAnalysis {
  const top = lines[0];
  if (!top) {
    throw new Error(`The engine returned no line for ${fen}`);
  }

  return { eval: toWhiteEval({ cp: top.scoreCp, mate: top.mate }, sideToMove(fen)), lines };
}

/** Converts a UCI engine line into SAN, stopping at the first move that does not apply. */
export function toReviewLine(fen: string, line: EngineLine): ReviewLine {
  const chess = new Chess(fen);
  const pvSan: string[] = [];
  for (const uci of line.pv) {
    try {
      pvSan.push(
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
      );
    } catch {
      break;
    }
  }

  const evaluation = toWhiteEval({ cp: line.scoreCp, mate: line.mate }, sideToMove(fen));
  return {
    uci: line.move,
    san: pvSan[0] ?? line.move,
    pvSan,
    whiteCp: evaluation.cp,
    mate: evaluation.mate
  };
}

/**
 * Annotates moves from per-position analyses: `analyses[i]` is the position before
 * `moves[i]`, and `analyses[i + 1]` the position after it (so analyses.length = moves.length + 1).
 */
export function annotateMoves(
  moves: ParsedMove[],
  analyses: PositionAnalysis[],
  ownerColor: PlayerColor
): AnnotatedMove[] {
  if (analyses.length !== moves.length + 1) {
    throw new Error(`Expected ${moves.length + 1} analysed positions, got ${analyses.length}`);
  }

  return moves.map((move, index) => {
    const before = analyses[index];
    const after = analyses[index + 1];
    const top = before.lines[0];
    if (!top) {
      throw new Error(`No engine line before ply ${move.ply}`);
    }

    const lossWinPct = winPercentLoss(before.eval, after.eval, move.color);
    const category = categorizeMove(lossWinPct, top.move === move.uci);
    const isPlayerMove = move.color === ownerColor;

    return {
      ply: move.ply,
      moveNumber: move.moveNumber,
      san: move.san,
      uci: move.uci,
      color: move.color,
      category,
      whiteCpBefore: before.eval.cp,
      whiteCpAfter: after.eval.cp,
      mateBefore: before.eval.mate,
      mateAfter: after.eval.mate,
      lossWinPct,
      bestLine: toReviewLine(move.fenBefore, top),
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      note: noteForCategory(category, lossWinPct, isPlayerMove),
      isPlayerMove
    };
  });
}

export function reviewHeader(game: ArchiveGame, ownerColor: PlayerColor): ReviewGameHeader {
  return {
    url: game.url,
    endTime: game.endTime,
    timeClass: game.timeClass,
    openingName: game.openingName,
    result: normalizeResult(ownerColor, game.white.result, game.black.result),
    white: { username: game.white.username, rating: game.white.rating },
    black: { username: game.black.username, rating: game.black.rating }
  };
}
