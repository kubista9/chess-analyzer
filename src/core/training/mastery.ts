import type { Color } from "../chess/position";
import { linePositionKeys } from "../content/tree";
import { posKey, type Line } from "../content/types";
import { hintsShown, outcomeOf, resultOf, resultScore } from "./hints";
import { BOX_DAYS, grade, newSrs } from "./scheduler";
import type { LadderState, LineProgress, LineState, LineStatus, Outcome, PositionProgress, Result, WeakMove } from "./types";

// Progress records: what one answered exercise, one Play the Line run or one recall answer does to
// the stored progress, and how mastery and a line's status are computed from it. Pure: the clock
// is passed in.

/** Results kept per position for mastery (results). */
export const RECENT_RESULTS = 8;

/** Wrong moves kept per position (moves). */
export const WEAK_MOVES_KEPT = 5;

/** A line is mastered from this mean mastery on, once every position has been seen (0..1). */
export const MASTERED_AT = 0.85;

/** A line is being reviewed from this mean mastery on (0..1). */
export const REVIEWING_AT = 0.4;

/** Smoothing of the recent results: weight of the newest result in the moving average (0..1). */
export const MASTERY_EMA_ALPHA = 0.5;

/** Share of mastery that comes from recent results; the rest comes from the Leitner box (0..1). */
export const MASTERY_RESULT_WEIGHT = 0.6;

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Worst first: the order used to pick a run's result and outcome. */
const RESULT_SEVERITY: Record<Result, number> = { clean: 0, hinted: 1, retried: 2, revealed: 3 };
const OUTCOME_SEVERITY: Record<Outcome, number> = { good: 0, hard: 1, again: 2 };

/** A position the user has not practised yet. */
export function newPositionProgress(side: Color, epd: string): PositionProgress {
  return {
    key: posKey(side, epd),
    side,
    epd,
    attempts: 0,
    clean: 0,
    incorrect: 0,
    wrongTries: 0,
    hintsUsed: 0,
    reveals: 0,
    firstSeenAt: null,
    lastPracticedAt: null,
    lastResult: null,
    recent: [],
    mastery: 0,
    srs: newSrs(),
    weakMoves: []
  };
}

/** Adds the wrong moves of one exercise: count desc, then most recent, then SAN; at most WEAK_MOVES_KEPT. */
function mergeWeakMoves(current: readonly WeakMove[], wrongSans: readonly string[], now: number): WeakMove[] {
  const bySan = new Map(current.map((entry) => [entry.san, { ...entry }]));
  for (const san of wrongSans) {
    if (!san) {
      continue;
    }
    const entry = bySan.get(san);
    if (entry) {
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, now);
    } else {
      bySan.set(san, { san, count: 1, lastAt: now });
    }
  }
  return [...bySan.values()]
    .sort((left, right) => right.count - left.count || right.lastAt - left.lastAt || byText(left.san, right.san))
    .slice(0, WEAK_MOVES_KEPT);
}

/** One answered position exercise: counters, recent results, weak moves, the schedule and mastery. */
export function applyPositionResult(
  progress: PositionProgress,
  input: { ladder: LadderState; wrongSans: readonly string[]; now: number }
): PositionProgress {
  const { ladder, now } = input;
  const result = resultOf(ladder);
  const next: PositionProgress = {
    ...progress,
    attempts: progress.attempts + 1,
    clean: progress.clean + (result === "clean" ? 1 : 0),
    incorrect: progress.incorrect + (result === "clean" ? 0 : 1),
    wrongTries: progress.wrongTries + ladder.wrongTries,
    hintsUsed: progress.hintsUsed + hintsShown(ladder),
    reveals: progress.reveals + (ladder.revealed ? 1 : 0),
    firstSeenAt: progress.firstSeenAt ?? now,
    lastPracticedAt: now,
    lastResult: result,
    recent: [...progress.recent, result].slice(-RECENT_RESULTS),
    srs: grade(progress.key, progress.srs, outcomeOf(ladder), now),
    weakMoves: mergeWeakMoves(progress.weakMoves, input.wrongSans, now)
  };
  return { ...next, mastery: positionMastery(next) };
}

/**
 * 0 if never attempted; else MASTERY_RESULT_WEIGHT × the moving average of the recent result
 * scores (oldest first, α MASTERY_EMA_ALPHA) plus the rest × box / BOX_DAYS.length.
 */
export function positionMastery(progress: PositionProgress): number {
  if (progress.attempts <= 0) {
    return 0;
  }
  let average: number | null = null;
  for (const result of progress.recent) {
    const score = resultScore(result);
    average = average === null ? score : MASTERY_EMA_ALPHA * score + (1 - MASTERY_EMA_ALPHA) * average;
  }
  const box = Math.min(Math.max(progress.srs.box, 0), BOX_DAYS.length);
  const mastery = MASTERY_RESULT_WEIGHT * (average ?? 0) + (1 - MASTERY_RESULT_WEIGHT) * (box / BOX_DAYS.length);
  return Math.min(Math.max(mastery, 0), 1);
}

/** A line the user has not practised yet. */
export function newLineProgress(lineId: string): LineProgress {
  return {
    lineId,
    runs: 0,
    cleanRuns: 0,
    movesPlayed: 0,
    movesClean: 0,
    wrongTries: 0,
    hintsUsed: 0,
    reveals: 0,
    recallAttempts: 0,
    recallCorrect: 0,
    lastPracticedAt: null,
    lastResult: null,
    srs: newSrs()
  };
}

/**
 * One finished Play the Line run (one ladder per user move). The run's result and the schedule
 * follow its worst move. A run without user moves changes nothing.
 */
export function applyLineRun(progress: LineProgress, input: { ladders: readonly LadderState[]; now: number }): LineProgress {
  const { ladders, now } = input;
  if (ladders.length === 0) {
    return progress;
  }
  const results = ladders.map(resultOf);
  const worstResult = results.reduce((worst, result) => (RESULT_SEVERITY[result] > RESULT_SEVERITY[worst] ? result : worst));
  const worstOutcome = ladders.map(outcomeOf).reduce((worst, outcome) => (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[worst] ? outcome : worst));
  const cleanMoves = results.filter((result) => result === "clean").length;
  return {
    ...progress,
    runs: progress.runs + 1,
    cleanRuns: progress.cleanRuns + (cleanMoves === ladders.length ? 1 : 0),
    movesPlayed: progress.movesPlayed + ladders.length,
    movesClean: progress.movesClean + cleanMoves,
    wrongTries: progress.wrongTries + ladders.reduce((sum, ladder) => sum + ladder.wrongTries, 0),
    hintsUsed: progress.hintsUsed + ladders.reduce((sum, ladder) => sum + hintsShown(ladder), 0),
    reveals: progress.reveals + ladders.filter((ladder) => ladder.revealed).length,
    lastPracticedAt: now,
    lastResult: worstResult,
    srs: grade(progress.lineId, progress.srs, worstOutcome, now)
  };
}

/**
 * One Position Recall answer. It counts towards the line's recall record only: the line's
 * schedule belongs to Play the Line runs, so recall does not move it.
 */
export function applyRecallAnswer(progress: LineProgress, input: { correct: boolean; now: number }): LineProgress {
  return {
    ...progress,
    recallAttempts: progress.recallAttempts + 1,
    recallCorrect: progress.recallCorrect + (input.correct ? 1 : 0),
    lastPracticedAt: input.now
  };
}

/** The mean mastery over the line's user positions (unseen positions count 0). */
export function lineMastery(line: Line, positions: ReadonlyMap<string, PositionProgress>): { mastery: number; seen: number; total: number } {
  const keys = linePositionKeys(line);
  let sum = 0;
  let seen = 0;
  for (const key of keys) {
    const progress = positions.get(key);
    if (progress && progress.attempts > 0) {
      seen += 1;
      sum += progress.mastery;
    }
  }
  return { mastery: keys.length === 0 ? 0 : sum / keys.length, seen, total: keys.length };
}

/** mastered from MASTERED_AT with every position seen; reviewing from REVIEWING_AT; else learning. */
export function suggestedStatus(mastery: number, seen: number, total: number): LineStatus {
  if (total > 0 && seen >= total && mastery >= MASTERED_AT) {
    return "mastered";
  }
  if (mastery >= REVIEWING_AT) {
    return "reviewing";
  }
  return "learning";
}

/** The status the user set by hand wins over the computed one. */
export function effectiveStatus(state: LineState | undefined, suggested: LineStatus): LineStatus {
  return state !== undefined && state.statusSetAt !== null ? state.status : suggested;
}
