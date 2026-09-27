import { CP_CLAMP } from "./constants.js";
import { clamp } from "./chess.js";
import type { MoveCategory, PlayerColor } from "./types.js";

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

/** A raw engine score, from the side to move (UCI "score cp" / "score mate"). */
export interface SideToMoveScore {
  cp: number;
  mate: number | null;
}

export function clampCp(cp: number): number {
  return clamp(cp, -CP_CLAMP, CP_CLAMP);
}

/** Converts a side-to-move engine score into a clamped White-view eval. */
export function toWhiteEval(score: SideToMoveScore, sideToMove: PlayerColor): WhiteEval {
  const sign = sideToMove === "white" ? 1 : -1;
  if (score.mate === 0) {
    return checkmateEval(sideToMove);
  }
  if (score.mate !== null) {
    const mate = sign * score.mate;
    return { cp: mate >= 0 ? CP_CLAMP : -CP_CLAMP, mate };
  }

  return { cp: clampCp(sign * score.cp), mate: null };
}

/** The eval of a checkmated position: the side to move has lost. */
export function checkmateEval(sideToMove: PlayerColor): WhiteEval {
  return { cp: sideToMove === "white" ? -CP_CLAMP : CP_CLAMP, mate: 0 };
}

/**
 * Lichess winning chances as a percentage (0-100) for White, from a clamped cp eval.
 * wp(0) = 50, wp(100) = 59.1, wp(1000) = 97.54.
 */
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampCp(cp))) - 1);
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

/**
 * How much win% the mover gave away with a move, never negative. Because mates map to the
 * clamped eval, a mate-to-mate transition (e.g. M3 -> M2) costs 0.
 */
export function winPercentLoss(before: WhiteEval, after: WhiteEval, mover: PlayerColor): number {
  return Math.max(0, winPercentFor(before, mover) - winPercentFor(after, mover));
}

// Upper bounds (exclusive) of each class in lichess win% loss, matching lichess's
// 0.1/0.2/0.3 winning-chance thresholds for inaccuracy/mistake/blunder.
export const CATEGORY_THRESHOLDS = {
  best: 1,
  good: 5,
  inaccuracy: 10,
  mistake: 15
} as const;

/** best (engine's top move or loss < 1), good < 5, inaccuracy < 10, mistake < 15, blunder >= 15. */
export function categorizeMove(lossWinPct: number, isTopMove: boolean): MoveCategory {
  if (isTopMove || lossWinPct < CATEGORY_THRESHOLDS.best) {
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
