import { Chess } from "chess.js";
import { classifyLoss, rootMoveLoss, toWhiteEval } from "../../shared/eval.js";
import { noteForCategory } from "../../shared/notes.js";
import type {
  AnnotatedMove,
  EngineLine,
  EngineTier,
  GameRecord,
  PlayerColor,
  PositionEval,
  ReviewGameHeader,
  ReviewLine
} from "../../shared/types.js";
import { lineFor, type PositionRequest } from "../engine/analysePosition.js";
import type { ParsedMove } from "./gameParser.js";

// Pure review maths: position evals in, White-view annotated moves out. No engine here.

export function sideToMove(fen: string): PlayerColor {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

/**
 * The engine requests for reviewing `ucis` (the first plies of a game): every position from
 * the start to after the last move. The owner's positions get the owner tier, the opponent's
 * the opponent tier, and each position's played move is scored at that root.
 */
export function reviewRequests(ucis: readonly string[], ownerColor: PlayerColor): PositionRequest[] {
  return Array.from({ length: ucis.length + 1 }, (_, index) => {
    const mover: PlayerColor = index % 2 === 0 ? "white" : "black";
    const tier: EngineTier = mover === ownerColor ? "owner" : "opponent";
    return { moves: ucis.slice(0, index), tier, played: index < ucis.length ? [ucis[index]] : [] };
  });
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
 * Annotates moves from per-position evals: `evals[i]` is the position before `moves[i]` and
 * `evals[i + 1]` the position after it (so evals.length = moves.length + 1). The loss of a
 * move is measured at its own root: the best line against the played move, both scored in
 * the position before the move at the same depth. The White-view evals shown before and
 * after a move are the two positions' own top lines, so the eval after ply N is the eval
 * before ply N + 1.
 */
export function annotateMoves(moves: ParsedMove[], evals: PositionEval[], ownerColor: PlayerColor): AnnotatedMove[] {
  if (evals.length !== moves.length + 1) {
    throw new Error(`Expected ${moves.length + 1} analysed positions, got ${evals.length}`);
  }

  return moves.map((move, index) => {
    const before = evals[index];
    const after = evals[index + 1];
    const best = before.lines[0];
    const played = lineFor(before, move.uci);
    if (!best || !played) {
      throw new Error(`The engine did not score ${move.san} at ply ${move.ply}`);
    }

    const lossWinPct = rootMoveLoss(best, played);
    const category = classifyLoss(lossWinPct);
    const isPlayerMove = move.color === ownerColor;
    const evalBefore = toWhiteEval(before.score, move.color);
    const evalAfter = toWhiteEval(after.score, opposite(move.color));

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
