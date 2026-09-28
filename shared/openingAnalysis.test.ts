import { describe, expect, it } from "vitest";
import { scoreWinPercent } from "./eval.js";
import {
  analyzeGameOpening,
  coverageOk,
  firstErrorShares,
  meanEvalAt,
  sanOf,
  topFirstMistakes,
  type EvalLookup,
  type OwnerMoveScored
} from "./openingAnalysis.js";
import type { TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import { edgeEngine, gamesThrough, nodeEngine } from "./treeEngine.js";
import type { EngineLine, PlayerColor, PositionEval } from "./types.js";

const line = (uci: string, cp: number | null, mate: number | null = null): EngineLine => ({
  uci,
  cp,
  mate,
  winPct: scoreWinPercent({ cp, mate }),
  depth: 15,
  pv: [uci]
});

function evaluation(epd: string, lines: EngineLine[], scored: EngineLine[] = []): PositionEval {
  return { epd, tier: "owner", depth: 15, nodes: 1, lines, scored, terminal: null, bestUci: lines[0].uci, score: lines[0] };
}

let nextId = 1;
function game(sans: string, color: PlayerColor): TreeGame {
  const moves = sans.split(" ");
  return {
    id: String(nextId++),
    endTime: 1_700_000_000 + nextId,
    color,
    score: 0,
    myRating: 1500,
    oppRating: 1500,
    baseMs: 180_000,
    plyCount: 40,
    plies: replayOpening(moves, moves.length).map((ply) => ({ ...ply, spentMs: 2000 }))
  };
}

/** Evals keyed by the SAN path to the position: [path, lines, scored]. */
function lookupFrom(entries: [string, EngineLine[], EngineLine[]?][]): EvalLookup {
  const byEpd = new Map<string, PositionEval>();
  for (const [path, lines, scored] of entries) {
    const sans = path ? path.split(" ") : [];
    const plies = replayOpening(sans, sans.length);
    const epd = sans.length ? plies[plies.length - 1].epdAfter : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
    byEpd.set(epd, evaluation(epd, lines, scored));
  }
  return (epd) => byEpd.get(epd);
}

// Black (the owner): 1.e4 e5 2.Nf3 Bc5 (a mistake: -165 against Nc6 -45), 3.Qe2 (an opponent
// error in the stub), 3...h6 (misses 3...Bxf2+).
const LOOKUP = lookupFrom([
  ["", [line("e2e4", 30)]],
  ["e4", [line("e7e5", -30)]],
  ["e4 e5", [line("g1f3", 40)]],
  ["e4 e5 Nf3", [line("b8c6", -45), line("g8f6", -52)], [line("f8c5", -165)]],
  ["e4 e5 Nf3 Bc5", [line("f3e5", 160)], [line("d1e2", -150)]],
  ["e4 e5 Nf3 Bc5 Qe2", [line("c5f2", 150)], [line("h7h6", 0)]],
  ["e4 e5 Nf3 Nc6", [line("f1b5", 40)]]
]);

describe("analyzeGameOpening", () => {
  it("classifies from known evals and finds the first error, opponent errors and missed punishments", () => {
    const analysis = analyzeGameOpening(game("e4 e5 Nf3 Bc5 Qe2 h6", "black"), LOOKUP);
    expect(analysis.status).toBe("complete");
    expect(analysis.coverage).toEqual({ ownerMoves: 3, scored: 3, plies: 6, pliesScored: 6 });
    const [e5, bc5, h6] = analysis.ownerMoves as OwnerMoveScored[];
    expect(e5).toMatchObject({ ply: 2, cls: "best", loss: 0, bestSan: "e5" });
    expect(bc5).toMatchObject({ ply: 4, san: "Bc5", cls: "mistake", bestSan: "Nc6", bestUci: "b8c6" });
    expect(bc5.loss).toBeGreaterThanOrEqual(10);
    expect(bc5.winBest).toBeCloseTo(scoreWinPercent({ cp: -45, mate: null }), 1);
    expect(h6.cls).toBe("mistake");
    expect(analysis.firstOwnerError).toMatchObject({ ply: 4, san: "Bc5" });
    expect(analysis.firstInaccuracyPly).toBe(4);
    expect(analysis.opponentErrors).toEqual([expect.objectContaining({ ply: 5, san: "Qe2", approx: true })]);
    expect(analysis.missedPunish).toEqual([expect.objectContaining({ ply: 6, san: "h6", bestSan: "Bxf2+", errorPly: 5 })]);
    // After 2...Bc5 White is +1.65 (the played move's score at the ply-4 root, White's view).
    expect(analysis.evalWhite[3]).toMatchObject({ cp: 165, mate: null });
    expect(analysis.spentSec).toBe(6);
    expect(analysis.evalAt).toEqual([]);
  });

  it("returns pending, never numbers, for positions the cache cannot answer", () => {
    const missingBc5: EvalLookup = (epd, tier) =>
      epd === replayOpening(["e4", "e5", "Nf3"], 3)[2].epdAfter ? undefined : LOOKUP(epd, tier);
    const analysis = analyzeGameOpening(game("e4 e5 Nf3 Bc5 Qe2 h6", "black"), missingBc5);
    expect(analysis.status).toBe("partial");
    expect(analysis.ownerMoves[1]).toMatchObject({ status: "pending", san: "Bc5" });
    expect(analysis.evalWhite[3]).toBe("pending");
    expect(analysis.firstOwnerError).toBe("pending");
    expect(analysis.firstInaccuracyPly).toBe("pending");
    expect(analysis.coverage).toMatchObject({ ownerMoves: 3, scored: 2 });
  });

  it("reports a clean opening as null and records the owner's eval at the eval plies", () => {
    const moves = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7";
    const sans = moves.split(" ");
    const plies = replayOpening(sans, sans.length);
    const lookup: EvalLookup = (epd) => {
      const index = plies.findIndex((ply) => ply.epdBefore === epd);
      return index >= 0 ? evaluation(epd, [line(plies[index].uci, index % 2 ? -40 : 40)]) : undefined;
    };
    const analysis = analyzeGameOpening(game(moves, "white"), lookup);
    expect(analysis.firstOwnerError).toBeNull();
    expect(analysis.firstInaccuracyPly).toBeNull();
    expect(analysis.evalAt).toEqual([{ ply: 10, eval: { ply: 10, cp: 40, mate: null, winPct: expect.any(Number) } }]);
    expect(firstErrorShares([analysis], [10])).toEqual([{ ply: 10, games: 1, known: 1, errors: 0, rate: 0 }]);
    expect(meanEvalAt([analysis], 10)).toMatchObject({ known: 1, cp: 40 });
  });

  it("shows mates as mate scores from White's side", () => {
    const sans = ["f3", "e5", "g4"];
    const plies = replayOpening([...sans, "Qh4#"], 4);
    const lookup: EvalLookup = (epd) =>
      epd === plies[3].epdBefore ? evaluation(epd, [line("d8h4", null, 1)]) : evaluation(epd, [line(plies.find((p) => p.epdBefore === epd)!.uci, 0)]);
    const analysis = analyzeGameOpening(game("f3 e5 g4 Qh4#", "black"), lookup);
    expect(analysis.evalWhite[3]).toMatchObject({ cp: -1000, mate: -1 });
  });
});

describe("aggregates", () => {
  it("counts first errors only where the span is fully scored, and groups the first mistakes", () => {
    const bad = [1, 2, 3].map(() => analyzeGameOpening(game("e4 e5 Nf3 Bc5 Qe2 h6", "black"), LOOKUP));
    const unknown = analyzeGameOpening(game("e4 e5 Nf3 d6", "black"), LOOKUP);
    const shares = firstErrorShares([...bad, unknown], [4]);
    expect(shares[0]).toMatchObject({ games: 4, known: 3, errors: 3, rate: 1 });
    const top = topFirstMistakes(bad.map((analysis) => analysis.firstOwnerError as OwnerMoveScored));
    expect(top).toEqual([expect.objectContaining({ san: "Bc5", bestSan: "Nc6", count: 3, ply: 4 })]);
    expect(coverageOk(3, 4)).toBe(false);
    expect(coverageOk(5, 9)).toBe(true);
    expect(coverageOk(5, 11)).toBe(false);
  });
});

describe("tree engine fields", () => {
  const afterNf3 = replayOpening(["e4", "e5", "Nf3"], 3)[2].epdAfter;
  const node = { epd: afterNf3, ownerToMove: true, ply: 3 };

  it("gives a move row its eval, loss, class and the engine-best star", () => {
    expect(edgeEngine(node, { uci: "b8c6" }, LOOKUP)).toMatchObject({ status: "scored", cls: "best", isEngineBest: true, eval: { cp: 45 } });
    expect(edgeEngine(node, { uci: "f8c5" }, LOOKUP)).toMatchObject({ status: "scored", cls: "mistake", isEngineBest: false, approx: false });
    expect(edgeEngine(node, { uci: "d7d6" }, LOOKUP)).toEqual({ status: "pending" });
  });

  it("finds the first-error hotspot and hides it below the minimum coverage", () => {
    const games = [
      ...[1, 2, 3].map(() => game("e4 e5 Nf3 Bc5 Qe2 h6", "black")),
      game("e4 e5 Nf3 Nc6", "black"),
      game("e4 e5 Nf3 d6", "black")
    ];
    expect(gamesThrough(games, afterNf3, 20)).toHaveLength(5);
    const analysisOf = (entry: TreeGame) => analyzeGameOpening(entry, LOOKUP);
    const thin = nodeEngine(node, games, analysisOf, LOOKUP, 20);
    expect(thin).toMatchObject({ bestSan: "Nc6", games: 5, eval: { cp: 45 } });
    expect(thin.hotspot).toMatchObject({ known: 4, errors: 3, rate: 0.75, shown: false });
    expect(thin.hotspot.top[0]).toMatchObject({ san: "Bc5", bestSan: "Nc6", count: 3 });

    const more = nodeEngine(node, [...games, game("e4 e5 Nf3 Nc6", "black")], analysisOf, LOOKUP, 20);
    expect(more.hotspot).toMatchObject({ known: 5, errors: 3, rate: 0.6, shown: true });
  });

  it("marks a position the cache has not seen as pending", () => {
    const unseen = nodeEngine({ epd: replayOpening(["d4"], 1)[0].epdAfter, ownerToMove: false, ply: 1 }, [], () => {
      throw new Error("no games");
    }, LOOKUP, 20);
    expect(unseen).toMatchObject({ eval: "pending", bestSan: null, games: 0, evalAt20: null });
  });

  it("converts UCI to SAN in a position", () => {
    expect(sanOf(afterNf3, "b8c6")).toBe("Nc6");
    expect(sanOf(afterNf3, "a1a8")).toBe("a1a8");
  });
});
