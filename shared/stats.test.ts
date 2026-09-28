import { describe, expect, it } from "vitest";
import {
  addGame,
  ageDays,
  effectiveN,
  eloExpected,
  emptyAccumulator,
  isLowSample,
  leakZ,
  recencyWeight,
  summarize,
  wilson
} from "./stats.js";

describe("wilson", () => {
  it("matches the textbook interval", () => {
    // p = 0.5, n = 100, z = 1.96: [0.4038, 0.5962].
    const [lo, hi] = wilson(0.5, 100);
    expect(lo).toBeCloseTo(0.4038, 4);
    expect(hi).toBeCloseTo(0.5962, 4);
  });

  it("gives the golden 1.e4 e5 interval (40% over 216 games -> [34%, 46%])", () => {
    const [lo, hi] = wilson(86 / 216, 216);
    expect(Math.round(lo * 100)).toBe(34);
    expect(Math.round(hi * 100)).toBe(46);
  });

  it("stays inside [0, 1] at the edges and is [0, 1] with no games", () => {
    expect(wilson(0, 5)[0]).toBe(0);
    expect(wilson(0, 5)[1]).toBeGreaterThan(0.3);
    expect(wilson(1, 5)[1]).toBe(1);
    expect(wilson(0.5, 0)).toEqual([0, 1]);
  });

  it("widens as n shrinks and with a larger z", () => {
    const width = ([lo, hi]: [number, number]) => hi - lo;
    expect(width(wilson(0.4, 20))).toBeGreaterThan(width(wilson(0.4, 200)));
    expect(width(wilson(0.4, 50, 2.58))).toBeGreaterThan(width(wilson(0.4, 50)));
  });

  it("accepts a fractional effective n", () => {
    const [lo, hi] = wilson(0.4, 10.5);
    expect(lo).toBeGreaterThan(wilson(0.4, 10)[0]);
    expect(hi).toBeLessThan(wilson(0.4, 10)[1]);
  });
});

describe("eloExpected", () => {
  it("is 0.5 for equal ratings and symmetric", () => {
    expect(eloExpected(1200, 1200)).toBe(0.5);
    expect(eloExpected(1300, 1200) + eloExpected(1200, 1300)).toBeCloseTo(1, 12);
  });

  it("gives 1 / (1 + 10^(diff / 400))", () => {
    expect(eloExpected(1200, 1600)).toBeCloseTo(1 / 11, 12);
    expect(eloExpected(1000, 1100)).toBeCloseTo(0.3599, 4);
  });
});

describe("recency weights", () => {
  it("halves every half-life (60 days by default)", () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(60)).toBeCloseTo(0.5, 12);
    expect(recencyWeight(120)).toBeCloseTo(0.25, 12);
    expect(recencyWeight(90, 90)).toBeCloseTo(0.5, 12);
  });

  it("is 1 when unweighted, clamps future games to age 0, and rejects a bad half-life", () => {
    expect(recencyWeight(500, null)).toBe(1);
    expect(recencyWeight(-3)).toBe(1);
    expect(() => recencyWeight(10, 0)).toThrow(/positive/);
  });

  it("measures age in UTC days", () => {
    expect(ageDays(0, 86_400 * 1.5)).toBe(1.5);
  });

  it("computes Kish's effective n", () => {
    expect(effectiveN(10, 10)).toBe(10); // ten weights of 1
    expect(effectiveN(1 + 0.5, 1 + 0.25)).toBeCloseTo(1.8, 12);
    expect(effectiveN(0, 0)).toBe(0);
  });
});

describe("weighted summaries and the leak z", () => {
  it("summarises unweighted games like plain counts", () => {
    const acc = emptyAccumulator();
    // 2 wins, 1 draw, 1 loss against equal opponents.
    for (const s of [1, 1, 0.5, 0]) {
      addGame(acc, 1, s, 0.5);
    }
    const summary = summarize(acc);
    expect(summary.wN).toBe(4);
    expect(summary.ess).toBe(4);
    expect(summary.score).toBe(0.625);
    expect(summary.expected).toBe(0.5);
    expect(summary.delta).toBe(0.125);
    expect(summary.deltaPts).toBe(0.5);
    expect(summary.ci).toEqual(wilson(0.625, 4));
    // z = Σ(E - s) / sqrt(Σ E(1 - E)) = -0.5 / sqrt(4 * 0.25) = -0.5.
    expect(summary.z).toBeCloseTo(-0.5, 12);
  });

  it("weights score, expectation and deltas by recency", () => {
    const acc = emptyAccumulator();
    addGame(acc, 1, 0, 0.6); // recent loss
    addGame(acc, 0.25, 1, 0.4); // old win
    const summary = summarize(acc);
    expect(summary.wN).toBe(1.25);
    expect(summary.score).toBeCloseTo(0.25 / 1.25, 12);
    expect(summary.expected).toBeCloseTo((0.6 + 0.1) / 1.25, 12);
    expect(summary.deltaPts).toBeCloseTo(0.25 - 0.7, 12);
    expect(summary.ess).toBeCloseTo(1.5625 / 1.0625, 12);
    expect(summary.ci).toEqual(wilson(summary.score, summary.ess));
  });

  it("uses per-game variances in the z denominator", () => {
    const acc = emptyAccumulator();
    addGame(acc, 1, 0, 0.9);
    addGame(acc, 0.5, 0, 0.5);
    const expectedZ = (0.9 + 0.25) / Math.sqrt(0.9 * 0.1 + 0.25 * 0.25);
    expect(leakZ(acc)).toBeCloseTo(expectedZ, 12);
    expect(leakZ(emptyAccumulator())).toBeNull();
  });

  it("flags samples under 8 games", () => {
    expect(isLowSample(7)).toBe(true);
    expect(isLowSample(8)).toBe(false);
  });
});
