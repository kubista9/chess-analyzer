import { describe, expect, it } from "vitest";
import { acceptableMoves, gradesSchedule, judgeLineMove, judgeMistakeMove, outcomeOf } from "./judge.js";

describe("line drill judging", () => {
  it("only the repertoire move is correct; a sound other move is neutral", () => {
    expect(judgeLineMove("b8c6", "b8c6", null)).toBe("correct");
    expect(judgeLineMove("b8c6", "g8f6", 0.3)).toBe("sound-other");
    expect(judgeLineMove("b8c6", "f8c5", 10.8)).toBe("wrong");
    expect(judgeLineMove("b8c6", "d7d6", null)).toBe("wrong");
    expect(outcomeOf("sound-other")).toBeNull();
    expect(gradesSchedule("sound-other", 1)).toBe(false);
    expect(gradesSchedule("correct", 1)).toBe(true);
    expect(gradesSchedule("wrong", 2)).toBe(false);
  });
});

describe("mistake drill judging", () => {
  // After 1.e4 e5 2.Nf3: the deep tier's losses (P7b's golden numbers).
  const scored = [
    { uci: "b8c6", san: "Nc6", loss: 0 },
    { uci: "g8f6", san: "Nf6", loss: 0.3 },
    { uci: "d7d6", san: "d6", loss: 0.9 },
    { uci: "d7d5", san: "d5", loss: 5.5 },
    { uci: "f8c5", san: "Bc5", loss: 10.8 }
  ];

  it("accepts the best move and moves within 3 win%, not Bc5", () => {
    const accepted = acceptableMoves(scored, null).map((move) => move.san);
    expect(accepted).toContain("Nc6");
    expect(accepted).not.toContain("Bc5");
    expect(accepted).toEqual(["Nc6", "Nf6", "d6"]);
    expect(judgeMistakeMove({ uci: "b8c6", loss: 0, repertoireUci: null })).toBe("best");
    expect(judgeMistakeMove({ uci: "g8f6", loss: 2.5, repertoireUci: null })).toBe("good-enough");
    expect(judgeMistakeMove({ uci: "f8c5", loss: 10.8, repertoireUci: null })).toBe("wrong");
    expect(outcomeOf("good-enough")).toBe("correct");
  });

  it("also accepts a sound repertoire move, never an unsound one", () => {
    const withRep = [...scored, { uci: "a7a6", san: "a6", loss: 4 }];
    expect(acceptableMoves(withRep, { uci: "a7a6" }).find((move) => move.san === "a6")?.why).toBe("repertoire");
    expect(judgeMistakeMove({ uci: "a7a6", loss: 4, repertoireUci: "a7a6" })).toBe("repertoire");
    expect(judgeMistakeMove({ uci: "d7d5", loss: 5.5, repertoireUci: "d7d5" })).toBe("wrong");
    expect(acceptableMoves(scored, { uci: "f8c5" }).some((move) => move.san === "Bc5")).toBe(false);
  });
});
