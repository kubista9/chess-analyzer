import { CP_CLAMP } from "./constants.js";
import { clamp } from "./chess.js";
import type { MoveCategory, PlayerColor } from "./types.js";

// All win% maths and move classification live here (server and client share it).
//
// Two views are used:
// - EngineScore: a raw UCI score from the side to move. Exactly one of cp / mate is set.
// - WhiteEval: a display eval from White's side, cp clamped, mate kept in its own field.
//
// Move loss is measured in the mover's win% at ONE root search: the best line and the
// played move are both scored in the position before the move, at the same depth.

/** A raw engine score from the side to move. mate > 0: the side to move mates; mate <= 0: it is mated. */
export interface EngineScore {
  cp: number | null;
  mate: number | null;
}

/**
 * An engine evaluation from White's point of view.
 * - cp: centipawns, clamped to +/-CP_CLAMP. For a mate it is +/-CP_CLAMP on the mating side.
 * - mate: moves to mate, positive when White mates, negative when Black mates, null when
 *   there is no forced mate. 0 means the position is checkmate (the sign of cp says who won).
 */
export interface WhiteEval {
  cp: number;
  mate: number | null;
}

export function clampCp(cp: number): number {
  return clamp(cp, -CP_CLAMP, CP_CLAMP);
}

/**
 * The centipawn equivalent of a side-to-move score: a mate is +/-CP_CLAMP (mate 0 means the
 * side to move is already mated, so -CP_CLAMP); otherwise cp clamped to +/-CP_CLAMP.
 */
export function cpEquivalent(score: EngineScore): number {
  if (score.mate !== null) {
    return score.mate > 0 ? CP_CLAMP : -CP_CLAMP;
  }
  if (score.cp === null || !Number.isFinite(score.cp)) {
    throw new Error("An engine score needs a cp or a mate value");
  }
  return clampCp(score.cp);
}

/**
 * Lichess winning chances as a percentage (0-100), from a cp eval (clamped first).
 * wp(0) = 50, wp(100) = 59.1, wp(1000) = 97.54.
 */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampCp(cp))) - 1);
}

/** The side to move's win% for a raw engine score. */
export function scoreWinPercent(score: EngineScore): number {
  return winPercent(cpEquivalent(score));
}

/**
 * The mover's loss for playing `played` instead of `best`, both scored from the same root
 * (the position before the move, side to move = the mover). Never negative. Mates map to the
 * clamped eval, so a mate-to-mate transition (mate 3 instead of mate 5) costs 0.
 */
export function rootMoveLoss(best: EngineScore, played: EngineScore): number {
  return Math.max(0, scoreWinPercent(best) - scoreWinPercent(played));
}

/** Converts a side-to-move engine score into a clamped White-view eval. */
export function toWhiteEval(score: EngineScore, sideToMove: PlayerColor): WhiteEval {
  const sign = sideToMove === "white" ? 1 : -1;
  if (score.mate === 0) {
    return checkmateEval(sideToMove);
  }
  if (score.mate !== null) {
    const mate = sign * score.mate;
    return { cp: mate >= 0 ? CP_CLAMP : -CP_CLAMP, mate };
  }

  return { cp: sign * cpEquivalent(score), mate: null };
}

/** The eval of a checkmated position: the side to move has lost. */
export function checkmateEval(sideToMove: PlayerColor): WhiteEval {
  return { cp: sideToMove === "white" ? -CP_CLAMP : CP_CLAMP, mate: 0 };
}

/** White's win% for an eval. A mate counts as the clamped eval of the mating side. */
export function whiteWinPercent(evaluation: WhiteEval): number {
  return winPercent(evaluation.cp);
}

/** Win% for the given side. */
export function winPercentFor(evaluation: WhiteEval, color: PlayerColor): number {
  const white = whiteWinPercent(evaluation);
  return color === "white" ? white : 100 - white;
}

// Upper bounds (exclusive) of each class in the mover's win% loss. "best" is defined by
// loss alone (never by identity with the engine's rank-1 move or bestmove, which are unstable
// between near-equal moves). good/inaccuracy/mistake match lichess's 0.1/0.2/0.3
// winning-chance thresholds (5/10/15 win%).
export const CATEGORY_THRESHOLDS = {
  best: 1,
  good: 5,
  inaccuracy: 10,
  mistake: 15
} as const;

/** best < 1, good < 5, inaccuracy < 10, mistake < 15, blunder >= 15 (mover's win% loss). */
export function classifyLoss(lossWinPct: number): MoveCategory {
  if (!Number.isFinite(lossWinPct) || lossWinPct < 0) {
    throw new Error(`Invalid win% loss: ${lossWinPct}`);
  }
  if (lossWinPct < CATEGORY_THRESHOLDS.best) {
    return "best";
  }
  if (lossWinPct < CATEGORY_THRESHOLDS.good) {
    return "good";
  }
  if (lossWinPct < CATEGORY_THRESHOLDS.inaccuracy) {
    return "inaccuracy";
  }
  if (lossWinPct < CATEGORY_THRESHOLDS.mistake) {
    return "mistake";
  }
  return "blunder";
}

/** An "opening error" is a mistake or worse. */
export function isOpeningError(category: MoveCategory): boolean {
  return category === "mistake" || category === "blunder";
}

/** Lichess per-move accuracy (0-100) for a win% loss. */
export function moveAccuracy(lossWinPct: number): number {
  return clamp(103.1668 * Math.exp(-0.04354 * lossWinPct) - 3.1669, 0, 100);
}

/** White-view display: "+0.80", "-1.25", "M3" (White mates), "-M3" (Black mates), "1-0"/"0-1" at mate. */
export function formatEval(evaluation: WhiteEval): string {
  if (evaluation.mate !== null) {
    if (evaluation.mate === 0) {
      return evaluation.cp > 0 ? "1-0" : "0-1";
    }
    return evaluation.mate > 0 ? `M${evaluation.mate}` : `-M${-evaluation.mate}`;
  }

  const value = evaluation.cp / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

// Interim (P1b) review helpers, kept until the review moves to one-root scoring.

/** A raw engine score, from the side to move (UCI "score cp" / "score mate"). */
export type SideToMoveScore = EngineScore;

/** How much win% the mover gave away between two separately searched positions, never negative. */
export function winPercentLoss(before: WhiteEval, after: WhiteEval, mover: PlayerColor): number {
  return Math.max(0, winPercentFor(before, mover) - winPercentFor(after, mover));
}

/** The P1b classes: the engine's top move is always best, otherwise classifyLoss. */
export function categorizeMove(lossWinPct: number, isTopMove: boolean): MoveCategory {
  return isTopMove ? "best" : classifyLoss(lossWinPct);
}
