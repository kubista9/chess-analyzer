import { describe, expect, it } from "vitest";
import { OPENING_PLY_LIMIT, OWNER_USERNAME } from "../../shared/constants.js";
import { toEpd } from "../../shared/epd.js";
import { formatEval, scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine, PositionEval } from "../../shared/types.js";
import { loadOwnerGames } from "../../test/loadFixtures.js";
import { deriveGame, rawGameSchema, utcMonth } from "./gameDerive.js";
import { parseGame, type ParsedMove } from "./gameParser.js";
import { annotateMoves, reviewHeader, sideToMove, toReviewLine } from "./reviewMoves.js";

const scandinavianRaw = rawGameSchema.parse(loadOwnerGames().find((raw) => raw.url.endsWith("/184405952510"))!);
const scandinavian = deriveGame(OWNER_USERNAME, utcMonth(scandinavianRaw.end_time), scandinavianRaw);

function line(uci: string, cp: number | null, mate: number | null = null, pv: string[] = [uci]): EngineLine {
  return { uci, cp, mate, winPct: scoreWinPercent({ cp, mate }), depth: 15, pv };
}

/**
 * Fake engine output: position i has a best line `a2a3`-style dummy move worth whiteCp(i), and
 * the move the game played from it is scored (searchmoves) at whiteCp(i + 1), both converted
 * to the side to move the way UCI reports them. So a move loses exactly the swing it causes.
 */
function fakeEvals(moves: ParsedMove[], whiteCp: (index: number) => number, bestIsPlayed = false): PositionEval[] {
  // One position per move: the position before it (the opening pass's positions).
  const fens = moves.map((move) => move.fenBefore);
  return fens.map((fen, index) => {
    const sign = sideToMove(fen) === "white" ? 1 : -1;
    const next = moves[index];
    const best = bestIsPlayed && next
      ? line(next.uci, sign * whiteCp(index), null, moves.slice(index, index + 3).map((move) => move.uci))
      : line("zzzz", sign * whiteCp(index));
    const scored = next && !bestIsPlayed ? [line(next.uci, sign * whiteCp(index + 1))] : [];
    return {
      epd: toEpd(fen),
      tier: "owner",
      depth: 15,
      nodes: 1,
      lines: [best],
      scored,
      terminal: null,
      bestUci: best.uci,
      score: { cp: best.cp, mate: null }
    };
  });
}

describe("annotateMoves", () => {
  const moves = parseGame(scandinavian.pgn).moves.slice(0, OPENING_PLY_LIMIT);

  it("reviews at most OPENING_PLY_LIMIT plies", () => {
    expect(OPENING_PLY_LIMIT).toBe(20);
    expect(moves).toHaveLength(20);
  });

  it("keeps a constant White advantage positive on both colours' moves, and calls equal moves best", () => {
    const annotated = annotateMoves(moves, fakeEvals(moves, () => 50), "black");
    expect(annotated).toHaveLength(20);
    for (const move of annotated) {
      expect(move.whiteCpBefore, `ply ${move.ply}`).toBe(50);
      expect(move.whiteCpAfter, `ply ${move.ply}`).toBe(50);
      expect(move.lossWinPct).toBe(0);
      // "best" by loss, although the engine's rank-1 move was another one.
      expect(move.category).toBe("best");
      expect(move.bestLine.uci).toBe("zzzz");
      expect(formatEval({ cp: move.whiteCpAfter, mate: move.mateAfter })).toBe("+0.50");
    }
  });

  it("charges the mover, from the mover's side, at the move's own root", () => {
    // White is +0.50 until Black's 3...Qa5 (ply 6), then +4.00.
    const annotated = annotateMoves(moves, fakeEvals(moves, (index) => (index >= 6 ? 400 : 50)), "black");
    const qa5 = annotated[5];
    expect(qa5).toMatchObject({ san: "Qa5", color: "black", whiteCpBefore: 50, whiteCpAfter: 400, isPlayerMove: true });
    expect(qa5.lossWinPct).toBeCloseTo(26.8, 1);
    expect(qa5.category).toBe("blunder");
    expect(annotated[6].lossWinPct).toBe(0);
  });

  it("uses second-person copy only on the owner's moves", () => {
    const annotated = annotateMoves(moves, fakeEvals(moves, () => 0), "black");
    expect(annotated[1].note).toContain("Engine agrees with your move");
    expect(annotated[0].note).toBe("Engine agrees with this move.");
    expect(annotated.filter((move) => move.isPlayerMove).every((move) => move.color === "black")).toBe(true);
  });

  it("puts the engine line in SAN", () => {
    const annotated = annotateMoves(moves, fakeEvals(moves, () => 0, true), "black");
    expect(annotated[0].bestLine).toMatchObject({ uci: "e2e4", san: "e4", pvSan: ["e4", "d5", "exd5"] });
  });

  it("takes the eval after the last move from the played move's score at its root", () => {
    const annotated = annotateMoves(moves, fakeEvals(moves, (index) => (index >= 20 ? 120 : 50)), "black");
    expect(annotated[19]).toMatchObject({ whiteCpBefore: 50, whiteCpAfter: 120 });
  });

  it("rejects a mismatched number of evals, and a move the engine did not score", () => {
    expect(() => annotateMoves(moves, fakeEvals(moves, () => 0).slice(1), "black")).toThrow();
    const evals = fakeEvals(moves, () => 0);
    evals[3] = { ...evals[3], scored: [] };
    expect(() => annotateMoves(moves, evals, "black")).toThrow(/did not score/);
  });
});

describe("mates", () => {
  // Fool's mate: 1. f3 e5 2. g4 Qh4# 0-1
  const moves = parseGame("1. f3 e5 2. g4 Qh4# 0-1").moves;

  it("keeps mate scores separate, clamps cp, and charges walking into mate the maximum", () => {
    const evals = fakeEvals(moves, () => 0);
    // Before 2.g4: White's best is 0.00, 2.g4 allows mate in 1 (score mate -1 for White).
    evals[2] = { ...evals[2], scored: [line("g2g4", null, -1)] };
    // Before 2...Qh4#: Black to move mates in 1.
    evals[3] = { ...evals[3], lines: [line("d8h4", null, 1)], scored: [], bestUci: "d8h4", score: { cp: null, mate: 1 } };
    // After it the game is over: checkmate, which the review shows without an analysed position.
    expect(evals).toHaveLength(4);

    const annotated = annotateMoves(moves, evals, "white");
    const mate = annotated[3];
    expect(mate).toMatchObject({ san: "Qh4#", mateBefore: -1, mateAfter: 0, whiteCpAfter: -1000, lossWinPct: 0, category: "best" });
    expect(formatEval({ cp: mate.whiteCpBefore, mate: mate.mateBefore })).toBe("-M1");
    expect(annotated[2].category).toBe("blunder");
    expect(annotated[2].lossWinPct).toBeCloseTo(47.5, 1);
    expect(Math.max(...annotated.map((move) => Math.abs(move.whiteCpBefore)))).toBeLessThanOrEqual(1000);
  });

  it("converts a mating line to SAN", () => {
    const converted = toReviewLine(moves[3].fenBefore, line("d8h4", null, 1));
    expect(converted).toEqual({ uci: "d8h4", san: "Qh4#", pvSan: ["Qh4#"], whiteCp: -1000, mate: -1 });
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
