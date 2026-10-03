import { describe, expect, it } from "vitest";
import { CP_CLAMP, MOVE_CATEGORIES } from "./score";
import {
  CATEGORY_THRESHOLDS,
  checkmateEval,
  clampCp,
  classifyLoss,
  cpEquivalent,
  formatEval,
  isOpeningError,
  moveAccuracy,
  rootMoveLoss,
  scoreWinPercent,
  toWhiteEval,
  whiteWinPercent,
  winPercent,
  winPercentFor
} from "./score";

describe("clampCp", () => {
  it("clamps to +/-1000 and keeps values inside the range", () => {
    expect(clampCp(100000)).toBe(CP_CLAMP);
    expect(clampCp(-99995)).toBe(-CP_CLAMP);
    expect(clampCp(250)).toBe(250);
    expect(clampCp(-1000)).toBe(-1000);
  });
});

describe("winPercent (lichess)", () => {
  it("matches the reference values", () => {
    expect(winPercent(0)).toBe(50);
    expect(Math.abs(winPercent(100) - 59.1)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(winPercent(1000) - 97.55)).toBeLessThanOrEqual(0.05);
    expect(winPercent(1000)).toBeCloseTo(97.54, 2);
  });

  it("is symmetric and clamped", () => {
    expect(winPercent(-300)).toBeCloseTo(100 - winPercent(300), 10);
    expect(winPercent(100000)).toBe(winPercent(1000));
    expect(winPercent(1000) - winPercent(-1000)).toBeCloseTo(95.1, 1);
  });
});

describe("toWhiteEval", () => {
  it("keeps White-to-move scores and negates Black-to-move scores", () => {
    expect(toWhiteEval({ cp: 80, mate: null }, "white")).toEqual({ cp: 80, mate: null });
    expect(toWhiteEval({ cp: 80, mate: null }, "black")).toEqual({ cp: -80, mate: null });
  });

  it("clamps centipawns", () => {
    expect(toWhiteEval({ cp: 4000, mate: null }, "black")).toEqual({ cp: -1000, mate: null });
  });

  it("keeps mate separately, signed for the mating side", () => {
    // Black to move and mating in 3: Black mates, so negative from White's side.
    expect(toWhiteEval({ cp: null, mate: 3 }, "black")).toEqual({ cp: -1000, mate: -3 });
    // White to move and getting mated in 2.
    expect(toWhiteEval({ cp: null, mate: -2 }, "white")).toEqual({ cp: -1000, mate: -2 });
    expect(toWhiteEval({ cp: null, mate: 1 }, "white")).toEqual({ cp: 1000, mate: 1 });
  });

  it("treats mate 0 as checkmate of the side to move", () => {
    expect(toWhiteEval({ cp: null, mate: 0 }, "white")).toEqual(checkmateEval("white"));
    expect(checkmateEval("white")).toEqual({ cp: -1000, mate: 0 });
    expect(checkmateEval("black")).toEqual({ cp: 1000, mate: 0 });
  });
});

describe("cpEquivalent", () => {
  it("maps mates to +/-1000 from the side to move and clamps cp", () => {
    expect(cpEquivalent({ cp: null, mate: 3 })).toBe(1000);
    expect(cpEquivalent({ cp: null, mate: -2 })).toBe(-1000);
    // mate 0: the side to move is already mated.
    expect(cpEquivalent({ cp: null, mate: 0 })).toBe(-1000);
    expect(cpEquivalent({ cp: 4000, mate: null })).toBe(1000);
    expect(cpEquivalent({ cp: -35, mate: null })).toBe(-35);
  });

  it("rejects a score with neither cp nor mate", () => {
    expect(() => cpEquivalent({ cp: null, mate: null })).toThrow();
  });
});

describe("rootMoveLoss (same root, mover's view)", () => {
  it("measures the drop from the best line to the played move", () => {
    expect(rootMoveLoss({ cp: 100, mate: null }, { cp: 0, mate: null })).toBeCloseTo(9.1, 1);
    expect(rootMoveLoss({ cp: -42, mate: null }, { cp: -166, mate: null })).toBeCloseTo(10.96, 2);
  });

  it("is never negative (a played move scored above the best line costs 0)", () => {
    expect(rootMoveLoss({ cp: 20, mate: null }, { cp: 35, mate: null })).toBe(0);
  });

  it("costs nothing for a mate-to-mate transition", () => {
    expect(rootMoveLoss({ cp: null, mate: 3 }, { cp: null, mate: 5 })).toBe(0);
    expect(rootMoveLoss({ cp: null, mate: 1 }, { cp: 1000, mate: null })).toBe(0);
  });

  it("caps a mate blunder at the clamped maximum (95.1) instead of 100000 cp", () => {
    const loss = rootMoveLoss({ cp: null, mate: 2 }, { cp: null, mate: -1 });
    expect(loss).toBeCloseTo(95.1, 1);
    expect(loss).toBeLessThanOrEqual(95.1);
    expect(scoreWinPercent({ cp: null, mate: 0 })).toBeCloseTo(100 - 97.54, 2);
  });

  it("uses White's share for the bar", () => {
    expect(whiteWinPercent({ cp: 0, mate: null })).toBe(50);
    expect(winPercentFor({ cp: 100, mate: null }, "black")).toBeCloseTo(40.9, 1);
  });
});

describe("classifyLoss", () => {
  it("has exactly the five categories", () => {
    expect([...MOVE_CATEGORIES]).toEqual(["best", "good", "inaccuracy", "mistake", "blunder"]);
  });

  it("uses the 1/5/10/15 win% thresholds", () => {
    expect(CATEGORY_THRESHOLDS).toEqual({ best: 1, good: 5, inaccuracy: 10, mistake: 15 });
    expect(classifyLoss(0)).toBe("best");
    expect(classifyLoss(0.99)).toBe("best");
    expect(classifyLoss(1)).toBe("good");
    expect(classifyLoss(4.99)).toBe("good");
    expect(classifyLoss(5)).toBe("inaccuracy");
    expect(classifyLoss(9.99)).toBe("inaccuracy");
    expect(classifyLoss(10)).toBe("mistake");
    expect(classifyLoss(14.99)).toBe("mistake");
    expect(classifyLoss(15)).toBe("blunder");
    expect(classifyLoss(95.1)).toBe("blunder");
  });

  it("defines best by loss alone: a near-equal second line is best, a rank-1 move is not special", () => {
    // Scandinavian 3...Qa5 vs 3...Qd8 about 5 cp apart at -0.70: well under 1 win%.
    expect(classifyLoss(rootMoveLoss({ cp: -67, mate: null }, { cp: -72, mate: null }))).toBe("best");
    // 2...Bc5 after 1.e4 e5 2.Nf3 (-42 vs -166 at depth 16): a mistake.
    expect(classifyLoss(rootMoveLoss({ cp: -42, mate: null }, { cp: -166, mate: null }))).toBe("mistake");
  });

  it("rejects NaN and negative losses", () => {
    expect(() => classifyLoss(Number.NaN)).toThrow();
    expect(() => classifyLoss(-1)).toThrow();
  });

  it("counts mistakes and blunders as opening errors", () => {
    expect(MOVE_CATEGORIES.filter(isOpeningError)).toEqual(["mistake", "blunder"]);
  });
});

describe("moveAccuracy", () => {
  it("is 100 at no loss and falls towards 0", () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(10)).toBeCloseTo(63.5, 0);
    expect(moveAccuracy(95.1)).toBeGreaterThanOrEqual(0);
    expect(moveAccuracy(95.1)).toBeLessThan(2);
  });
});

describe("formatEval", () => {
  it("shows centipawns from White's side with a sign", () => {
    expect(formatEval({ cp: 80, mate: null })).toBe("+0.80");
    expect(formatEval({ cp: -125, mate: null })).toBe("-1.25");
    expect(formatEval({ cp: 0, mate: null })).toBe("+0.00");
    expect(formatEval({ cp: 1000, mate: null })).toBe("+10.00");
  });

  it("shows mates as M#", () => {
    expect(formatEval({ cp: 1000, mate: 3 })).toBe("M3");
    expect(formatEval({ cp: -1000, mate: -3 })).toBe("-M3");
    expect(formatEval(checkmateEval("black"))).toBe("1-0");
    expect(formatEval(checkmateEval("white"))).toBe("0-1");
  });
});
