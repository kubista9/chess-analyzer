import { describe, expect, it } from "vitest";
import { OPENING_PLY_LIMIT, OWNER_USERNAME } from "../../shared/constants.js";
import { formatEval } from "../../shared/eval.js";
import type { LegacyEngineLine } from "../../shared/types.js";
import { loadOwnerGames } from "../../test/loadFixtures.js";
import { deriveGame, rawGameSchema, utcMonth } from "./gameDerive.js";
import { parseGame, type ParsedMove } from "./gameParser.js";
import {
  analysisFromLines,
  annotateMoves,
  reviewHeader,
  sideToMove,
  terminalAnalysis,
  toReviewLine,
  type PositionAnalysis
} from "./reviewMoves.js";

const scandinavianRaw = rawGameSchema.parse(loadOwnerGames().find((raw) => raw.url.endsWith("/184405952510"))!);
const scandinavian = deriveGame(OWNER_USERNAME, utcMonth(scandinavianRaw.end_time), scandinavianRaw);

/**
 * A fake engine: for each position, the top line is `topMove` (default: the move the game
 * played next) and the score is `whiteCp` converted to the side to move, the way UCI reports it.
 */
function fakeAnalyses(moves: ParsedMove[], whiteCp: (index: number) => number): PositionAnalysis[] {
  const fens = [moves[0].fenBefore, ...moves.map((move) => move.fenAfter)];
  return fens.map((fen, index) => {
    const next = moves[index];
    const sign = sideToMove(fen) === "white" ? 1 : -1;
    const line: LegacyEngineLine = {
      move: next?.uci ?? "a2a3",
      scoreCp: sign * whiteCp(index),
      mate: null,
      pv: next ? moves.slice(index, index + 3).map((move) => move.uci) : []
    };
    return next ? analysisFromLines(fen, [line]) : { eval: { cp: whiteCp(index), mate: null }, lines: [] };
  });
}

describe("annotateMoves", () => {
  const moves = parseGame(scandinavian.pgn).moves.slice(0, OPENING_PLY_LIMIT);

  it("reviews at most OPENING_PLY_LIMIT plies", () => {
    expect(OPENING_PLY_LIMIT).toBe(20);
    expect(moves).toHaveLength(20);
  });

  it("keeps a constant White advantage positive on both colours' moves", () => {
    const annotated = annotateMoves(moves, fakeAnalyses(moves, () => 50), "black");
    expect(annotated).toHaveLength(20);
    for (const move of annotated) {
      expect(move.whiteCpBefore, `ply ${move.ply}`).toBe(50);
      expect(move.whiteCpAfter, `ply ${move.ply}`).toBe(50);
      expect(move.lossWinPct).toBe(0);
      expect(move.category).toBe("best");
      expect(formatEval({ cp: move.whiteCpAfter, mate: move.mateAfter })).toBe("+0.50");
    }
  });

  it("charges the mover, from the mover's side", () => {
    // White is +0.50 until Black's 3...Qa5 (ply 6), then +4.00.
    const annotated = annotateMoves(moves, fakeAnalyses(moves, (index) => (index >= 6 ? 400 : 50)), "black");
    const qa5 = annotated[5];
    expect(qa5).toMatchObject({ san: "Qa5", color: "black", whiteCpBefore: 50, whiteCpAfter: 400, isPlayerMove: true });
    expect(qa5.lossWinPct).toBeCloseTo(26.8, 1);
    expect(annotated[6].lossWinPct).toBe(0);
  });

  it("uses second-person copy only on the owner's moves", () => {
    const annotated = annotateMoves(moves, fakeAnalyses(moves, () => 0), "black");
    expect(annotated[1].note).toContain("Engine agrees with your move");
    expect(annotated[0].note).toBe("Engine agrees with this move.");
    expect(annotated.filter((move) => move.isPlayerMove).every((move) => move.color === "black")).toBe(true);
  });

  it("puts the engine line in SAN", () => {
    const annotated = annotateMoves(moves, fakeAnalyses(moves, () => 0), "black");
    expect(annotated[0].bestLine).toMatchObject({ uci: "e2e4", san: "e4", pvSan: ["e4", "d5", "exd5"] });
  });

  it("rejects a mismatched number of analyses", () => {
    expect(() => annotateMoves(moves, fakeAnalyses(moves, () => 0).slice(1), "black")).toThrow();
  });
});

describe("mates", () => {
  // Fool's mate: 1. f3 e5 2. g4 Qh4#
  const moves = parseGame("1. f3 e5 2. g4 Qh4# 0-1").moves;

  it("evaluates the checkmated position without the engine", () => {
    expect(terminalAnalysis(moves[3].fenAfter)).toEqual({ eval: { cp: -1000, mate: 0 }, lines: [] });
    expect(terminalAnalysis(moves[0].fenBefore)).toBeNull();
  });

  it("keeps mate scores separate and clamps cp", () => {
    // Before 2...Qh4# Black to move, mate in 1 (UCI: score mate 1, parsed cp 99000).
    const before = analysisFromLines(moves[3].fenBefore, [
      { move: "d8h4", scoreCp: 99000, mate: 1, pv: ["d8h4"] }
    ]);
    expect(before.eval).toEqual({ cp: -1000, mate: -1 });
    expect(formatEval(before.eval)).toBe("-M1");

    const beforeG4 = analysisFromLines(moves[2].fenBefore, [{ move: "e2e4", scoreCp: 0, mate: null, pv: ["e2e4"] }]);
    const analyses = [
      ...fakeAnalyses(moves.slice(0, 2), () => 0).slice(0, 2),
      beforeG4,
      before,
      terminalAnalysis(moves[3].fenAfter)!
    ];
    const annotated = annotateMoves(moves, analyses, "white");
    const mate = annotated[3];
    expect(mate).toMatchObject({ san: "Qh4#", mateBefore: -1, mateAfter: 0, whiteCpAfter: -1000, lossWinPct: 0, category: "best" });
    // 2. g4 walks into mate: from 0.00 to -M1, the biggest possible loss.
    expect(annotated[2].category).toBe("blunder");
    expect(annotated[2].lossWinPct).toBeCloseTo(47.5, 1);
    expect(Math.max(...annotated.map((move) => Math.abs(move.whiteCpBefore)))).toBeLessThanOrEqual(1000);
  });

  it("converts a mating line to SAN", () => {
    const line = toReviewLine(moves[3].fenBefore, { move: "d8h4", scoreCp: 99000, mate: 1, pv: ["d8h4"] });
    expect(line).toEqual({ uci: "d8h4", san: "Qh4#", pvSan: ["Qh4#"], whiteCp: -1000, mate: -1 });
  });
});

describe("reviewHeader", () => {
  it("derives the header from the stored GameRecord only", () => {
    const record = scandinavian.record;
    expect(reviewHeader(record, OWNER_USERNAME)).toEqual({
      url: record.url,
      endTime: record.endTime,
      timeClass: "blitz",
      openingName: record.openingName,
      result: "loss",
      white: { username: "fernando787", rating: record.oppRating },
      black: { username: OWNER_USERNAME, rating: record.myRating }
    });
    expect(record.color).toBe("black");
    expect(OWNER_USERNAME).toBe("kubista9");
  });
});
