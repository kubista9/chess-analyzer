import { CATEGORY_THRESHOLDS } from "../eval.js";
import { RETRY_CORRECT_LOSS, RETRY_PLAYABLE_LOSS } from "../review.js";
import type { Outcome } from "./scheduler.js";

// Answer judging for the two drill kinds. Losses are the mover's win% loss against the best
// move at the same root (deep tier for mistake cards, owner tier or deep for line cards).

/** Below this loss a move is engine-sound ("good" in the review's classes). */
export const SOUND_LOSS = CATEGORY_THRESHOLDS.good;

/** Mistake cards accept a move within this loss of the best (the review's Retry "good enough"). */
export const MISTAKE_TOLERANCE = RETRY_PLAYABLE_LOSS;

/**
 * Line cards: only the repertoire move is correct. Another engine-sound move is "sound-other"
 * (no lapse, no promotion: the owner plays his move next); anything else is wrong. A move the
 * engine has not scored (loss null) counts as wrong.
 */
export type LineVerdict = "correct" | "sound-other" | "wrong";

export function judgeLineMove(repertoireUci: string, uci: string, loss: number | null): LineVerdict {
  if (uci === repertoireUci) {
    return "correct";
  }
  return loss !== null && loss < SOUND_LOSS ? "sound-other" : "wrong";
}

/**
 * Mistake cards: the engine's best (loss < 1), any move within 3 win% of it, or the repertoire
 * move when it is sound (loss < 5).
 */
export type MistakeVerdict = "best" | "good-enough" | "repertoire" | "wrong";

export function judgeMistakeMove(input: { uci: string; loss: number; repertoireUci: string | null }): MistakeVerdict {
  if (input.loss < RETRY_CORRECT_LOSS) {
    return "best";
  }
  if (input.loss < MISTAKE_TOLERANCE) {
    return "good-enough";
  }
  if (input.repertoireUci === input.uci && input.loss < SOUND_LOSS) {
    return "repertoire";
  }
  return "wrong";
}

export type DrillVerdict = LineVerdict | MistakeVerdict;

/** The SRS outcome of a verdict; null for a neutral one (a sound move other than the repertoire's). */
export function outcomeOf(verdict: DrillVerdict): Outcome | null {
  if (verdict === "sound-other") {
    return null;
  }
  return verdict === "wrong" ? "wrong" : "correct";
}

/** Only the first graded attempt at a card in a presentation changes its schedule. */
export function gradesSchedule(verdict: DrillVerdict, attempts: number): boolean {
  return attempts === 1 && outcomeOf(verdict) !== null;
}

export interface ScoredMove {
  uci: string;
  san: string;
  loss: number;
}

export interface AcceptableMove extends ScoredMove {
  why: "best" | "within" | "repertoire";
}

/** The moves a mistake card accepts, from the scored moves at its root (best first). */
export function acceptableMoves(scored: readonly ScoredMove[], repertoire: { uci: string } | null): AcceptableMove[] {
  const out: AcceptableMove[] = [];
  for (const move of [...scored].sort((left, right) => left.loss - right.loss || left.uci.localeCompare(right.uci))) {
    if (move.loss < RETRY_CORRECT_LOSS) {
      out.push({ ...move, why: "best" });
    } else if (move.loss < MISTAKE_TOLERANCE) {
      out.push({ ...move, why: "within" });
    } else if (repertoire?.uci === move.uci && move.loss < SOUND_LOSS) {
      out.push({ ...move, why: "repertoire" });
    }
  }
  return out;
}
