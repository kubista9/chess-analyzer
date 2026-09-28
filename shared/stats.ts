// Statistics primitives for results over games: Wilson intervals, Elo expectation, recency
// weights with an effective sample size, and the leak z-score. Pure, no I/O.
//
// A "score" is the owner's points per game (win 1, draw 0.5, loss 0), so a draw is half a
// point and Wilson is applied to the score fraction, as lichess and the plan do.

/** Half-life of the recency weight, in days (GLOBAL: "half-life 60 days"). */
export const DEFAULT_HALF_LIFE_DAYS = 60;

/** Below this many raw games a line is "low sample": shown greyed, never ranked. */
export const LOW_SAMPLE_N = 8;

/** z for a two-sided 95% interval. */
export const Z_95 = 1.96;

const DAY_SECONDS = 86_400;

/**
 * Wilson score interval for a proportion `p` observed over `n` trials. With recency weights,
 * pass the effective n (ESS) and the weighted score. Returns [0, 1] when n is 0.
 */
export function wilson(p: number, n: number, z: number = Z_95): [number, number] {
  if (!(n > 0)) {
    return [0, 1];
  }
  const q = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = q + z2 / (2 * n);
  const margin = z * Math.sqrt((q * (1 - q)) / n + z2 / (4 * n * n));
  return [Math.max(0, (centre - margin) / denominator), Math.min(1, (centre + margin) / denominator)];
}

/** The Elo expected score of a player rated `me` against `opp`: 1 / (1 + 10^((opp - me) / 400)). */
export function eloExpected(me: number, opp: number): number {
  return 1 / (1 + 10 ** ((opp - me) / 400));
}

/**
 * Recency weight 0.5^(age / halfLife). `halfLifeDays` null means unweighted (always 1).
 * A negative age (a game after `now`) counts as age 0.
 */
export function recencyWeight(ageDays: number, halfLifeDays: number | null = DEFAULT_HALF_LIFE_DAYS): number {
  if (halfLifeDays === null) {
    return 1;
  }
  if (!(halfLifeDays > 0)) {
    throw new Error(`Half-life must be positive, got ${halfLifeDays}`);
  }
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

/** Age in days of a game that ended at `endTime`, seen at `now` (both Unix seconds). */
export function ageDays(endTime: number, now: number): number {
  return (now - endTime) / DAY_SECONDS;
}

/** Kish's effective sample size (Σw)² / Σw². */
export function effectiveN(sumW: number, sumW2: number): number {
  return sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
}

/** Running weighted sums over games: Σw, Σw², Σws, ΣwE and Σw²E(1-E). */
export interface ScoreAccumulator {
  n: number;
  sumW: number;
  sumW2: number;
  sumWS: number;
  sumWE: number;
  /** Σ w² E(1 - E): the variance of Σw(E - s) under the Elo model, per game. */
  sumW2Var: number;
}

export function emptyAccumulator(): ScoreAccumulator {
  return { n: 0, sumW: 0, sumW2: 0, sumWS: 0, sumWE: 0, sumW2Var: 0 };
}

/** Adds one game with weight `w`, score `s` and Elo expectation `e`. */
export function addGame(acc: ScoreAccumulator, w: number, s: number, e: number): void {
  acc.n += 1;
  acc.sumW += w;
  acc.sumW2 += w * w;
  acc.sumWS += w * s;
  acc.sumWE += w * e;
  acc.sumW2Var += w * w * e * (1 - e);
}

/**
 * Leak z-score Σw(E - s) / sqrt(Σw² E(1 - E)), with per-game variances. Positive means the
 * owner scored below his Elo expectation. Null when there is no variance (no games).
 */
export function leakZ(acc: ScoreAccumulator): number | null {
  return acc.sumW2Var > 0 ? (acc.sumWE - acc.sumWS) / Math.sqrt(acc.sumW2Var) : null;
}

export interface ScoreSummary {
  /** Σw; the raw game count when unweighted. */
  wN: number;
  /** Effective n (Σw)² / Σw²; equals the raw count when unweighted. */
  ess: number;
  /** Σws / Σw, 0..1. */
  score: number;
  /** ΣwE / Σw, 0..1. */
  expected: number;
  /** score - expected, as a fraction. */
  delta: number;
  /** Σw(s - E): points above (+) or below (-) the Elo expectation. */
  deltaPts: number;
  /** 95% Wilson interval of the score on the effective n. */
  ci: [number, number];
  /** Leak z (positive = below expectation), or null with no games. */
  z: number | null;
}

export function summarize(acc: ScoreAccumulator): ScoreSummary {
  const ess = effectiveN(acc.sumW, acc.sumW2);
  const score = acc.sumW > 0 ? acc.sumWS / acc.sumW : 0;
  const expected = acc.sumW > 0 ? acc.sumWE / acc.sumW : 0;
  return {
    wN: acc.sumW,
    ess,
    score,
    expected,
    delta: score - expected,
    deltaPts: acc.sumWS - acc.sumWE,
    ci: wilson(score, ess),
    z: leakZ(acc)
  };
}

export function isLowSample(n: number): boolean {
  return n < LOW_SAMPLE_N;
}
