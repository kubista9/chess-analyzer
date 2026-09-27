import { describe, expect, it } from "vitest";
import { CP_CLAMP, MOVE_CATEGORIES } from "./constants.js";
import {
  categorizeMove,
  checkmateEval,
  clampCp,
  formatEval,
  toWhiteEval,
  whiteWinPercent,
  winPercent,
  winPercentFor,
  winPercentLoss
} from "./eval.js";

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
    expect(winPercent(100)).toBeCloseTo(59.1, 1);
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
    expect(toWhiteEval({ cp: 97000, mate: 3 }, "black")).toEqual({ cp: -1000, mate: -3 });
    // White to move and getting mated in 2.
    expect(toWhiteEval({ cp: -98000, mate: -2 }, "white")).toEqual({ cp: -1000, mate: -2 });
    expect(toWhiteEval({ cp: 99000, mate: 1 }, "white")).toEqual({ cp: 1000, mate: 1 });
  });

  it("treats mate 0 as checkmate of the side to move", () => {
    expect(toWhiteEval({ cp: -100000, mate: 0 }, "white")).toEqual(checkmateEval("white"));
    expect(checkmateEval("white")).toEqual({ cp: -1000, mate: 0 });
    expect(checkmateEval("black")).toEqual({ cp: 1000, mate: 0 });
  });
});

describe("winPercentLoss", () => {
  it("measures the loss from the mover's side", () => {
    const even = { cp: 0, mate: null };
    const whitePlus = { cp: 100, mate: null };
    expect(winPercentLoss(whitePlus, even, "white")).toBeCloseTo(9.1, 1);
    expect(winPercentLoss(even, whitePlus, "black")).toBeCloseTo(9.1, 1);
  });

  it("is never negative", () => {
    expect(winPercentLoss({ cp: 0, mate: null }, { cp: 300, mate: null }, "white")).toBe(0);
  });

  it("costs nothing for a mate-to-mate transition", () => {
    expect(winPercentLoss({ cp: 1000, mate: 3 }, { cp: 1000, mate: 2 }, "white")).toBe(0);
    expect(winPercentLoss({ cp: -1000, mate: -1 }, checkmateEval("white"), "black")).toBe(0);
  });

  it("caps a mate blunder at the clamped maximum instead of 100000 cp", () => {
    const loss = winPercentLoss({ cp: 1000, mate: 2 }, { cp: -1000, mate: -1 }, "white");
    expect(loss).toBeCloseTo(95.1, 1);
  });

  it("uses White's share for the bar", () => {
    expect(whiteWinPercent({ cp: 0, mate: null })).toBe(50);
    expect(winPercentFor({ cp: 100, mate: null }, "black")).toBeCloseTo(40.9, 1);
  });
});

describe("categorizeMove", () => {
  it("has exactly the five categories", () => {
    expect([...MOVE_CATEGORIES]).toEqual(["best", "good", "inaccuracy", "mistake", "blunder"]);
  });

  it("uses the 1/5/10/15 win% thresholds", () => {
    expect(categorizeMove(0, false)).toBe("best");
    expect(categorizeMove(0.99, false)).toBe("best");
    expect(categorizeMove(1, false)).toBe("good");
    expect(categorizeMove(4.99, false)).toBe("good");
    expect(categorizeMove(5, false)).toBe("inaccuracy");
    expect(categorizeMove(9.99, false)).toBe("inaccuracy");
    expect(categorizeMove(10, false)).toBe("mistake");
    expect(categorizeMove(14.99, false)).toBe("mistake");
    expect(categorizeMove(15, false)).toBe("blunder");
    expect(categorizeMove(95, false)).toBe("blunder");
  });

  it("calls the engine's top move best", () => {
    expect(categorizeMove(3, true)).toBe("best");
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
