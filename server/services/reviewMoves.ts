import { Chess } from "chess.js";
import { checkmateEval, classifyLoss, rootMoveLoss, toWhiteEval, type WhiteEval } from "../../shared/eval.js";
import { noteForCategory } from "../../shared/notes.js";
import type {
  AnnotatedMove,
  EngineLine,
  GameRecord,
  PlayerColor,
  PositionEval,
  ReviewGameHeader,
  ReviewLine
} from "../../shared/types.js";
import { lineFor } from "../engine/analysePosition.js";
import type { ParsedMove } from "./gameParser.js";

// Pure review maths: position evals in, White-view annotated moves out. No engine here.

export function sideToMove(fen: string): PlayerColor {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
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

  const evaluation = toWhiteEval(line, sideToMove(fen));
  return {
    uci: line.uci,
    san: pvSan[0] ?? line.uci,
    pvSan,
    whiteCp: evaluation.cp,
    mate: evaluation.mate
  };
}

/**
 * The White-view eval after the last reviewed move, which has no analysed position of its own:
 * checkmate or stalemate when the game ended there, otherwise the played move's score at its
 * root (the same search as the best move).
 */
function evalAfterLast(move: ParsedMove, played: EngineLine): WhiteEval {
  const after = new Chess(move.fenAfter);
  if (after.isCheckmate()) {
    return checkmateEval(opposite(move.color));
  }
  if (after.isStalemate()) {
    return { cp: 0, mate: null };
  }
  return toWhiteEval(played, move.color);
}

/**
 * Annotates moves from per-position evals: `evals[i]` is the position before `moves[i]` (the
 * opening pass's positions, so evals.length = moves.length). The loss of a move is measured
 * at its own root: the best line against the played move, both scored in the position before
 * the move at the same depth. The White-view eval after a move is the next position's own top
 * line, so the eval after ply N is the eval before ply N + 1; after the last move it is the
 * played move's score at its root.
 */
export function annotateMoves(moves: ParsedMove[], evals: PositionEval[], ownerColor: PlayerColor): AnnotatedMove[] {
  if (evals.length !== moves.length) {
    throw new Error(`Expected ${moves.length} analysed positions, got ${evals.length}`);
  }

  return moves.map((move, index) => {
    const before = evals[index];
    const best = before.lines[0];
    const played = lineFor(before, move.uci);
    if (!best || !played) {
      throw new Error(`The engine did not score ${move.san} at ply ${move.ply}`);
    }

    const lossWinPct = rootMoveLoss(best, played);
    const category = classifyLoss(lossWinPct);
    const isPlayerMove = move.color === ownerColor;
    const evalBefore = toWhiteEval(before.score, move.color);
    const next = evals[index + 1];
    const evalAfter = next ? toWhiteEval(next.score, opposite(move.color)) : evalAfterLast(move, played);

    return {
      ply: move.ply,
      moveNumber: move.moveNumber,
      san: move.san,
      uci: move.uci,
      color: move.color,
      category,
      whiteCpBefore: evalBefore.cp,
      whiteCpAfter: evalAfter.cp,
      mateBefore: evalBefore.mate,
      mateAfter: evalAfter.mate,
      lossWinPct,
      bestLine: toReviewLine(move.fenBefore, best),
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      note: noteForCategory(category, lossWinPct, isPlayerMove),
      isPlayerMove
    };
  });
}

/** The review header, from the stored game only. `owner` is the owner's display name. */
export function reviewHeader(game: GameRecord, owner: string): ReviewGameHeader {
  const me = { username: owner, rating: game.myRating };
  const opponent = { username: game.oppName, rating: game.oppRating };
  return {
    url: game.url,
    endTime: game.endTime,
    timeClass: game.timeClass,
    openingName: game.openingName,
    result: game.result,
    white: game.color === "white" ? me : opponent,
    black: game.color === "white" ? opponent : me
  };
}
