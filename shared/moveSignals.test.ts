import { describe, expect, it } from "vitest";
import { benjaminiHochberg, moveSignals, normalSf, trendDirection } from "./moveSignals.js";

const row = (n: number, z: number | null, ess = n) => ({ n, weighted: { ess, z } });

describe("normalSf", () => {
  it("matches the standard normal tail", () => {
    expect(normalSf(0)).toBeCloseTo(0.5, 6);
    expect(normalSf(1.64)).toBeCloseTo(0.0505, 4);
    expect(normalSf(1.96)).toBeCloseTo(0.025, 4);
    expect(normalSf(-1.96)).toBeCloseTo(0.975, 4);
    expect(normalSf(3)).toBeCloseTo(0.00135, 5);
  });
});

describe("benjaminiHochberg", () => {
  it("keeps every p up to the largest rank under its threshold", () => {
    // Thresholds at q = 0.2 over 4: 0.05, 0.1, 0.15, 0.2. Rank 3 (0.12) passes, so ranks 1-3 do.
    expect(benjaminiHochberg([0.12, 0.01, 0.9, 0.08])).toEqual([true, true, false, true]);
    expect(benjaminiHochberg([0.3, 0.5])).toEqual([false, false]);
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe("moveSignals", () => {
  it("colours a clear leak and a clear strength, and leaves noise neutral", () => {
    // 1.e4 e5 as Black: z 2.95 on 216 games.
    expect(moveSignals([row(216, 2.95), row(222, -2.4), row(40, 0.9)])).toEqual(["leak", "strength", "neutral"]);
  });

  it("marks rows under 8 games low sample, even with a large z", () => {
    expect(moveSignals([row(7, 3.5), row(3, null)])).toEqual(["low-sample", "low-sample"]);
  });

  it("needs an effective n of 8 as well as 8 raw games", () => {
    expect(moveSignals([row(10, 3, 3.2)])).toEqual(["neutral"]);
    expect(moveSignals([row(10, 3, 8)])).toEqual(["leak"]);
  });

  it("needs |z| >= 1.64 even when the row is the only candidate", () => {
    // p = 0.12 passes BH alone at q = 0.2, but z 1.55 is under the gate.
    expect(moveSignals([row(30, 1.55)])).toEqual(["neutral"]);
    expect(moveSignals([row(30, 1.7)])).toEqual(["leak"]);
  });

  it("controls the false discovery rate across a table", () => {
    // Alone, z 1.8 (p 0.072) is a discovery; among 8 noisy rows it no longer is.
    const noisy = [row(20, 1.8), ...Array.from({ length: 7 }, () => row(20, 0.3))];
    expect(moveSignals(noisy)[0]).toBe("neutral");
    expect(moveSignals([row(20, 1.8)])[0]).toBe("leak");
  });

  it("leaves a row with no variance neutral", () => {
    expect(moveSignals([row(12, null)])).toEqual(["neutral"]);
  });
});

describe("trendDirection", () => {
  const trend = (recentN: number, recentScore: number | null, olderN: number, olderScore: number | null) => ({
    recentN,
    recentScore,
    olderN,
    olderScore
  });

  it("points up, down or flat once both sides have 8 games", () => {
    expect(trendDirection(trend(32, 0.5, 184, 0.4))).toBe("up");
    expect(trendDirection(trend(32, 0.3, 184, 0.4))).toBe("down");
    expect(trendDirection(trend(32, 0.42, 184, 0.4))).toBe("flat");
  });

  it("has no direction with too few games on either side", () => {
    expect(trendDirection(trend(7, 1, 184, 0.4))).toBe("none");
    expect(trendDirection(trend(200, 0.55, 0, null))).toBe("none");
  });
});
