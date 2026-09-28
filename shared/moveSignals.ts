import { LOW_SAMPLE_N, type ScoreSummary } from "./stats.js";

// When the Explorer may colour a move row as a leak or a strength. The P3 critic measured
// that "n >= 8 and z >= 1" is indistinguishable from noise on this data (a null simulation
// flags as many lines as the real games do), so a row is coloured only when:
//   - it has at least 8 raw games AND an effective n of at least 8 (8 old games can have ESS ~3),
//   - |z| >= 1.64 (one-sided 95%), and
//   - it survives Benjamini-Hochberg at q = 0.2 across the table's eligible rows.
// Everything else stays neutral; rows under 8 games are "low sample".

export const SIGNAL_MIN_N = LOW_SAMPLE_N;
export const SIGNAL_MIN_ESS = 8;
export const SIGNAL_MIN_Z = 1.64;
export const SIGNAL_FDR_Q = 0.2;

/** leak = below the Elo expectation, strength = above it. */
export type MoveSignal = "leak" | "strength" | "neutral" | "low-sample";

export interface SignalRow {
  n: number;
  /** The summary the view shows (recency-weighted, or raw when unweighted). */
  weighted: Pick<ScoreSummary, "ess" | "z">;
}

/** Upper tail of the standard normal, 1 - Φ(z) (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
export function normalSf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/** Benjamini-Hochberg: which of `pValues` are discoveries at false discovery rate `q`. */
export function benjaminiHochberg(pValues: readonly number[], q: number = SIGNAL_FDR_Q): boolean[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (const [rank, { p }] of order.entries()) {
    if (p <= ((rank + 1) / order.length) * q) {
      cutoff = rank;
    }
  }
  const result = pValues.map(() => false);
  for (const { index } of order.slice(0, cutoff + 1)) {
    result[index] = true;
  }
  return result;
}

/** The signal of each row of one table (the moves from one position), in order. */
export function moveSignals(rows: readonly SignalRow[]): MoveSignal[] {
  const eligible = rows.flatMap((row, index) =>
    row.n >= SIGNAL_MIN_N && row.weighted.ess >= SIGNAL_MIN_ESS && row.weighted.z !== null
      ? [{ index, z: row.weighted.z }]
      : []
  );
  const discovered = benjaminiHochberg(eligible.map(({ z }) => 2 * normalSf(Math.abs(z))));
  const signals: MoveSignal[] = rows.map((row) => (row.n < SIGNAL_MIN_N ? "low-sample" : "neutral"));
  for (const [position, { index, z }] of eligible.entries()) {
    if (discovered[position] && Math.abs(z) >= SIGNAL_MIN_Z) {
      signals[index] = z > 0 ? "leak" : "strength";
    }
  }
  return signals;
}

/** A trend arrow needs this many games on each side of the 90-day split... */
export const TREND_MIN_N = LOW_SAMPLE_N;
/** ...and a score change of at least this much. */
export const TREND_MIN_CHANGE = 0.05;

export type TrendDirection = "up" | "down" | "flat" | "none";

/** Recent (last 90 days) vs older score; "none" when either side has too few games. */
export function trendDirection(trend: {
  recentN: number;
  recentScore: number | null;
  olderN: number;
  olderScore: number | null;
}): TrendDirection {
  if (trend.recentN < TREND_MIN_N || trend.olderN < TREND_MIN_N || trend.recentScore === null || trend.olderScore === null) {
    return "none";
  }
  const change = trend.recentScore - trend.olderScore;
  return change >= TREND_MIN_CHANGE ? "up" : change <= -TREND_MIN_CHANGE ? "down" : "flat";
}
