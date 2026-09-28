import { describe, expect, it } from "vitest";
import { scoreWinPercent } from "../../shared/eval.js";
import type { EvalLookup } from "../../shared/openingAnalysis.js";
import { replayOpening } from "../../shared/pgn.js";
import { bookExitCopy, cleanOpeningCopy, judgeRetry, moveLabel, openingPly, retryVerdict } from "../../shared/review.js";
import type { EngineLine, OpeningPly, PlayerColor, PositionEval } from "../../shared/types.js";
import { getOpeningBook } from "./openingBook.js";
import { buildOpeningReview, toReviewLine } from "./review.js";

const line = (uci: string, cp: number | null, pv: string[] = [uci], mate: number | null = null): EngineLine => ({
  uci,
  cp,
  mate,
  winPct: scoreWinPercent({ cp, mate }),
  depth: 15,
  pv
});

function plies(sans: string): OpeningPly[] {
  const moves = sans.split(" ");
  return replayOpening(moves, moves.length).map((ply, index) => ({ ...ply, ply: index + 1, clockMs: null, spentMs: null }));
}

/** A lookup keyed by the SAN path to each position: [path, lines, scored]. */
function lookupFrom(entries: [string, EngineLine[], EngineLine[]?][]): EvalLookup {
  const byEpd = new Map<string, PositionEval>();
  for (const [path, lines, scored = []] of entries) {
    const sans = path ? path.split(" ") : [];
    const epd = sans.length ? plies(path).at(-1)!.epdAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
    byEpd.set(epd, { epd, tier: "owner", depth: 15, nodes: 1, lines, scored, terminal: null, bestUci: lines[0].uci, score: lines[0] });
  }
  return (epd) => byEpd.get(epd);
}

function review(sans: string, color: PlayerColor, lookup: EvalLookup) {
  const game = { id: "g1", color, endTime: 1_780_000_000, score: 0 as const, myRating: 1500, oppRating: 1500, tc: null, plyCount: 60 };
  return buildOpeningReview({ game, plies: plies(sans), lookup, book: getOpeningBook(), configId: 1 });
}

// Black (the owner): 1.e4 e5 2.Nf3 Bc5 is a mistake (-165 against Nc6 -45), scores from the side to move.
const BC5 = lookupFrom([
  ["", [line("e2e4", 30, ["e2e4", "e7e5", "g1f3"])]],
  ["e4", [line("e7e5", -30)]],
  ["e4 e5", [line("g1f3", 40)]],
  ["e4 e5 Nf3", [line("b8c6", -45, ["b8c6", "f1b5", "a7a6"]), line("g8f6", -52)], [line("f8c5", -165, ["f8c5", "f3e5"])]],
  ["e4 e5 Nf3 Bc5", [line("f3e5", 160)]],
  ["e4 e5 Nf3 Bc5 Nxe5", [line("d8e7", -150)]]
]);

describe("buildOpeningReview", () => {
  it("lands on the owner's first mistake, with its callout facts from White's side", () => {
    const result = review("e4 e5 Nf3 Bc5 Nxe5 Qe7", "black", BC5);
    expect(result.status).toBe("complete");
    expect(result.firstOwnerError).toBe(4);
    expect(result.landing).toEqual({ ply: 4, reason: "first-mistake" });
    const bc5 = result.plies[3];
    expect(bc5).toMatchObject({ ply: 4, moveNumber: 2, color: "black", owner: true, san: "Bc5", cls: "mistake", approx: false });
    expect(bc5.loss).toBeGreaterThanOrEqual(10);
    expect(bc5.lines.map((entry) => entry.san)).toEqual(["Nc6", "Nf6"]);
    expect(moveLabel(bc5.ply, bc5.lines[0].san)).toBe("2...Nc6");
    // ?ply= overrides the landing, clamped to the window.
    expect(openingPly(result, null)).toBe(4);
    expect(openingPly(result, 2)).toBe(2);
    expect(openingPly(result, 99)).toBe(6);
  });

  it("converts Black's scores to White's side: evals after the move and the lines", () => {
    const result = review("e4 e5 Nf3 Bc5 Nxe5 Qe7", "black", BC5);
    const bc5 = result.plies[3];
    // Black's -165 (side to move) is +1.65 for White, after 2...Bc5 and in its own line.
    expect(bc5.evalAfter).toMatchObject({ cp: 165, mate: null });
    expect(bc5.played).toMatchObject({ san: "Bc5", whiteCp: 165 });
    expect(bc5.lines[0]).toMatchObject({ san: "Nc6", whiteCp: 45 });
    expect(bc5.evalAfter !== "pending" && bc5.evalAfter.whiteWinPct).toBeGreaterThan(50);
    // White's own move keeps its sign; the start position's lines are White's.
    expect(result.plies[4].evalAfter).toMatchObject({ cp: 160 });
    expect(result.start.lines[0]).toMatchObject({ san: "e4", whiteCp: 30 });
  });

  it("gives every engine line in SAN, stopping at the first move that does not apply", () => {
    const result = review("e4 e5 Nf3 Bc5 Nxe5 Qe7", "black", BC5);
    expect(result.start.lines[0].pvSan).toEqual(["e4", "e5", "Nf3"]);
    expect(result.plies[3].lines[0].pvSan).toEqual(["Nc6", "Bb5", "a6"]);
    expect(result.plies[3].played?.pvSan).toEqual(["Bc5", "Nxe5"]);
    const broken = toReviewLine(result.plies[0].fenBefore, line("e2e4", 30, ["e2e4", "e2e4", "g1f3"]), "white");
    expect(broken.pvSan).toEqual(["e4"]);
    const mate = toReviewLine(result.plies[0].fenBefore, line("e2e4", null, ["e2e4"], -3), "white");
    expect(mate).toMatchObject({ mate: -3 });
  });

  it("places the book divider after the last book move and names who left first", () => {
    // 1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5 is the Scandinavian main line; 4.h4 leaves the book.
    const result = review("e4 d5 exd5 Qxd5 Nc3 Qa5 h4", "black", () => undefined);
    expect(result.bookExit).toMatchObject({ lastBookPly: 6, exitBy: "opponent", name: "Scandinavian Defense: Main Line" });
    expect(result.plies.map((ply) => ply.inBook)).toEqual([true, true, true, true, true, true, false]);
    expect(bookExitCopy(result.bookExit!, result.plies)).toBe(
      "Out of book after 3...Qa5 (Scandinavian Defense: Main Line), your opponent left first"
    );
    const mine = review("e4 d5 exd5 Qxd5 Nc3 Qa5 h4", "white", () => undefined);
    expect(bookExitCopy(mine.bookExit!, mine.plies)).toMatch(/, you left first$/);
  });

  it("marks unscored plies pending and opens a clean or unknown opening at the book exit", () => {
    const pending = review("e4 d5 exd5 Qxd5 Nc3 Qa5 h4", "black", () => undefined);
    expect(pending.status).toBe("partial");
    expect(pending.coverage).toEqual({ plies: 7, pliesScored: 0 });
    expect(pending.firstOwnerError).toBe("pending");
    expect(pending.plies[0]).toMatchObject({ evalAfter: "pending", loss: null, cls: null, lines: [], played: null });
    expect(pending.landing).toEqual({ ply: 7, reason: "book-exit" });

    const clean = review("e4 e5 Nf3", "black", BC5);
    expect(clean.firstOwnerError).toBeNull();
    expect(clean.landing.reason).toBe("book-exit");
    expect(cleanOpeningCopy(20)).toBe("Clean opening: no mistakes in the first 10 moves");
  });
});

describe("retry judging", () => {
  it("is correct within 1 win% of the best, playable within 3, and try again beyond", () => {
    expect(retryVerdict(0)).toBe("correct");
    expect(retryVerdict(0.99)).toBe("correct");
    expect(retryVerdict(1)).toBe("playable");
    expect(retryVerdict(2.99)).toBe("playable");
    expect(retryVerdict(3)).toBe("try-again");
    // Nc6 (-45) against itself; Nf6 (-52) is close; Bc5 (-165) is far.
    expect(judgeRetry(line("b8c6", -45), line("b8c6", -45))).toEqual({ loss: 0, verdict: "correct" });
    expect(judgeRetry(line("b8c6", -45), line("g8f6", -52)).verdict).toBe("correct");
    expect(judgeRetry(line("b8c6", -45), line("d7d6", -95)).verdict).toBe("try-again");
    const bc5 = judgeRetry(line("b8c6", -45), line("f8c5", -165));
    expect(bc5.verdict).toBe("try-again");
    expect(bc5.loss).toBeGreaterThan(10);
  });
});
