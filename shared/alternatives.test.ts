import { describe, expect, it } from "vitest";
import {
  ALT_GATE_LOSS,
  alternativeCandidates,
  jaccard,
  onlyMovePositions,
  pawnSet,
  rankAlternatives,
  type AltInput
} from "./alternatives.js";
import { START_EPD } from "./epd.js";
import { scoreWinPercent } from "./eval.js";
import type { EvalLookup } from "./openingAnalysis.js";
import { buildBook, type OpeningBook } from "./openingBook.js";
import { buildTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import type { RepEntry } from "./repertoire.js";
import type { SeedFlag } from "./repertoireSeed.js";
import type { EngineLine, PlayerColor, PositionEval } from "./types.js";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

const BOOK: OpeningBook = buildBook(
  [
    ["D06", "Queen's Gambit", "1. d4 d5 2. c4"],
    ["D30", "Queen's Gambit Declined", "1. d4 d5 2. c4 e6"],
    ["D31", "Queen's Gambit Declined: Queen's Knight Variation", "1. d4 d5 2. c4 e6 3. Nc3"],
    ["D30", "Queen's Gambit Declined: Three Knights", "1. d4 d5 2. c4 e6 3. Nf3"],
    ["D10", "Slav Defense", "1. d4 d5 2. c4 c6"],
    ["D11", "Slav Defense: Modern Line", "1. d4 d5 2. c4 c6 3. Nf3"],
    ["D20", "Queen's Gambit Accepted", "1. d4 d5 2. c4 dxc4"],
    ["D08", "Queen's Gambit Declined: Albin Countergambit", "1. d4 d5 2. c4 e5"],
    ["D07", "Queen's Gambit Declined: Chigorin Defense", "1. d4 d5 2. c4 Nc6"],
    ["D06", "Queen's Gambit Declined: Baltic Defense", "1. d4 d5 2. c4 Bf5"],
    ["C40", "King's Knight Opening", "1. e4 e5 2. Nf3"],
    ["C44", "King's Knight Opening: Normal Variation", "1. e4 e5 2. Nf3 Nc6"],
    ["C50", "Italian Game", "1. e4 e5 2. Nf3 Nc6 3. Bc4"],
    ["C60", "Ruy Lopez", "1. e4 e5 2. Nf3 Nc6 3. Bb5"],
    ["C44", "Scotch Game", "1. e4 e5 2. Nf3 Nc6 3. d4"],
    ["C42", "Petrov's Defense", "1. e4 e5 2. Nf3 Nf6"],
    ["C41", "Philidor Defense", "1. e4 e5 2. Nf3 d6"],
    ["C40", "King's Pawn Game: Busch-Gass Gambit", "1. e4 e5 2. Nf3 Bc5"]
  ].map(([eco, name, pgn]) => ({ eco, name, pgn }))
);

let nextId = 1;
function game(line: string, color: PlayerColor, score: 0 | 0.5 | 1): TreeGame {
  const sans = line.split(" ");
  nextId += 1;
  return {
    id: String(nextId),
    endTime: NOW - 86_400 - nextId,
    color,
    score,
    myRating: 1200,
    oppRating: 1200,
    baseMs: 180_000,
    plyCount: 60,
    plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs: 1000 }))
  };
}

function results(line: string, color: PlayerColor, { wins = 0, losses = 0, draws = 0 }): TreeGame[] {
  return [
    ...Array.from({ length: wins }, () => game(line, color, 1)),
    ...Array.from({ length: losses }, () => game(line, color, 0)),
    ...Array.from({ length: draws }, () => game(line, color, 0.5))
  ];
}

const epdAfter = (line: string) => {
  if (!line) {
    return START_EPD;
  }
  const sans = line.split(" ");
  return replayOpening(sans, sans.length).at(-1)!.epdAfter;
};

const pathOf = (line: string) => {
  const sans = line ? line.split(" ") : [];
  return { moves: replayOpening(sans, sans.length).map((ply) => ply.uci), sans };
};

/** An engine line: the PV as space-separated UCI moves, the score from the side to move. */
const pv = (moves: string, cp: number, depth = 18): EngineLine => {
  const list = moves.split(" ");
  return { uci: list[0], cp, mate: null, winPct: scoreWinPercent({ cp, mate: null }), depth, pv: list };
};

function evalAt(line: string, lines: EngineLine[], scored: EngineLine[] = [], tier: PositionEval["tier"] = "deep"): PositionEval {
  return { epd: epdAfter(line), tier, depth: lines[0].depth, nodes: 1_500_000, lines, scored, terminal: null, bestUci: lines[0].uci, score: lines[0] };
}

function lookupOf(evals: PositionEval[]): EvalLookup {
  const byEpd = new Map(evals.map((evaluation) => [evaluation.epd, evaluation]));
  return (epd) => byEpd.get(epd);
}

// The Albin position, 1.d4 d5 2.c4, with a deep row: e6 / g6 (not a book move) / c6 / dxc4 in the
// lines, the Albin and the Chigorin scored by searchmoves, the Baltic (a book move) not scored.
const ALBIN_LINE = "d4 d5 c4";
const ALBIN_DEEP = evalAt(
  ALBIN_LINE,
  [pv("e7e6 b1c3 g8f6 c1g5 f8e7 e2e3", -31), pv("g7g6 c4d5 d8d5 b1c3 d5a5 e2e4", -33), pv("c7c6 g1f3 g8f6 b1c3 d5c4 a2a4", -38), pv("d5c4 e2e4 e7e5 g1f3 e5d4 f1c4", -40)],
  [pv("e7e5 d4e5 d5d4 g1f3 b8c6 g2g3", -78), pv("b8c6 g1f3 c8g4 c4d5 g4f3 g2f3", -64)]
);
// After 2...c6 3.Nf3 the owner has one good move (Nf6); everything else loses at least 10 win%.
const SLAV_ONLY_MOVE = evalAt("d4 d5 c4 c6 Nf3", [pv("g8f6 b1c3", -30, 15), pv("c8g4 f3e5", -250, 15)], [], "owner");

const ALBIN_GAMES = [
  ...results("d4 d5 c4 e5 dxe5 d4", "black", { wins: 3, losses: 12 }),
  ...results("d4 d5 c4 e5 cxd5 Qxd5", "black", { wins: 3, losses: 2 }),
  ...results("d4 d5 c4 e6 Nc3 Nf6", "black", { wins: 2, losses: 1 })
];
const ALBIN_FLAG: SeedFlag = { tier: "watch", n: 20, score: 0.3, expected: 0.5, z: 1.79, line: "1.d4 d5 2.c4 e5" };

function input(games: TreeGame[], color: PlayerColor, line: string, fields: Partial<AltInput> = {}): AltInput {
  const tree = buildTree(games, { color, now: NOW, halfLifeDays: null, book: BOOK });
  return {
    tree,
    games,
    book: BOOK,
    epd: epdAfter(line),
    path: pathOf(line),
    root: undefined,
    lookup: null,
    flags: new Map(),
    entries: new Map(),
    ...fields
  };
}

const albin = (fields: Partial<AltInput> = {}) =>
  input(ALBIN_GAMES, "black", ALBIN_LINE, {
    root: ALBIN_DEEP,
    lookup: lookupOf([SLAV_ONLY_MOVE]),
    flags: new Map([[`${epdAfter(ALBIN_LINE)}|e7e5`, ALBIN_FLAG]]),
    ...fields
  });

describe("rankAlternatives at the Albin (1.d4 d5 2.c4)", () => {
  const result = rankAlternatives(albin());

  it("questions the most-played move, with its flag and engine gap", () => {
    expect(result.current).toMatchObject({ san: "e5", source: "most-played", flag: { n: 20 }, hole: false });
    expect(result.current!.eval!.gap).toBeGreaterThan(3);
    expect(result.current!.eval!.gap).toBeLessThan(ALT_GATE_LOSS);
    expect(result.current!.ownerStats).toMatchObject({ n: 20, score: 0.3 });
    expect(result.engine).toMatchObject({ tier: "deep", depth: 18, multipv: 4, bestSan: "e6" });
  });

  it("offers 2...e6, 2...c6 and 2...dxc4, each within the gate with a 6-ply SAN line and reasons", () => {
    expect(result.alternatives.map((alternative) => alternative.san)).toEqual(["e6", "c6", "dxc4"]);
    for (const alternative of result.alternatives) {
      expect(alternative.eval.gap).toBeLessThanOrEqual(ALT_GATE_LOSS);
      expect(alternative.sampleLine.sans).toHaveLength(6);
      expect(alternative.reasons.length).toBeGreaterThan(1);
      expect(alternative.name).toBeTruthy();
    }
    expect(result.alternatives[0].sampleLine.sans).toEqual(["e6", "Nc3", "Nf6", "Bg5", "Be7", "e3"]);
  });

  it("scores the features: owned, named, mainstream, only-moves, forcing, eval gap", () => {
    const [e6, c6, dxc4] = result.alternatives;
    const points = (alternative: typeof e6) => Object.fromEntries(alternative.reasons.map((reason) => [reason.feature, reason.points]));
    // 3 games at 67%: +4; named +3; 3 of the 9 book lines here: +2; the best move: 0.
    expect(points(e6)).toMatchObject({ owned: 4, named: 3, mainstream: 2, "eval-gap": 0 });
    expect(e6.kind).toBe("owned");
    expect(e6.reasons.find((reason) => reason.feature === "owned")!.text).toContain("You already play it: 3 games, 67%");
    // The Slav's 3...Nf6 is an only move (the second-best is 18 win% worse).
    expect(points(c6)).toMatchObject({ named: 3, mainstream: 1, "only-moves": -1 });
    expect(c6.onlyMoves).toEqual({ positions: 2, checked: 1, found: 1 });
    expect(c6.kind).toBe("book");
    // dxc4 e4 e5 Nf3 exd4 Bxc4: three captures.
    expect(points(dxc4)).toMatchObject({ named: 3, forcing: -1 });
    expect(points(dxc4)["eval-gap"]).toBeLessThan(0);
    for (const alternative of result.alternatives) {
      expect(alternative.score).toBeCloseTo(alternative.reasons.reduce((sum, reason) => sum + reason.points, 0), 5);
    }
  });

  it("gates on the engine only: the unscored book move is rejected, a non-book engine line is an engine idea listed last", () => {
    expect(result.rejected.map((move) => move.san)).toContain("Bf5");
    expect(result.rejected.find((move) => move.san === "Bf5")!.reason).toContain("Not scored");
    const all = [...result.alternatives, ...result.others];
    expect(all.at(-1)).toMatchObject({ san: "g6", kind: "engine-idea" });
    // g6 is 0.2 win% from the best, better than the Chigorin, and still ranked after it.
    expect(all.map((alternative) => alternative.san)).toEqual(["e6", "c6", "dxc4", "Nc6", "g6"]);
  });

  it("rejects a move more than 5 win% below the best", () => {
    const worse = { ...ALBIN_DEEP, scored: [...ALBIN_DEEP.scored.slice(0, 1), pv("b8c6 g1f3", -120)] };
    const ranked = rankAlternatives(albin({ root: worse }));
    expect(ranked.rejected.find((move) => move.san === "Nc6")!.gap).toBeGreaterThan(ALT_GATE_LOSS);
    expect([...ranked.alternatives, ...ranked.others].map((alternative) => alternative.san)).not.toContain("Nc6");
  });

  it("splits the questioned move's points by reply: the loss sits after 3.dxe5", () => {
    expect(result.pointsLost).toMatchObject({ san: "e5", n: 20, pointsLost: 4 });
    expect(result.pointsLost!.rows.map((row) => [row.san, row.n, row.pointsLost])).toEqual([
      ["dxe5", 15, 4.5],
      ["cxd5", 5, -0.5]
    ]);
    expect(result.pointsLost!.rows[0].answers).toEqual([{ uci: "d5d4", san: "d4", n: 15, score: 0.2, pointsLost: 4.5 }]);
  });

  it("marks the repertoire move and a questioned move passed by the caller", () => {
    const entry: RepEntry = {
      color: "black",
      epd: epdAfter(ALBIN_LINE),
      uci: "c7c6",
      san: "c6",
      source: "edited",
      status: "active",
      locked: true,
      replaced: null,
      reason: null,
      note: null,
      ply: 4,
      updatedAt: 1
    };
    const ranked = rankAlternatives(albin({ entries: new Map([[entry.epd, entry]]) }));
    expect(ranked.current).toMatchObject({ san: "c6", source: "repertoire", isRepertoire: true });
    expect(ranked.alternatives.map((alternative) => alternative.san)).not.toContain("c6");
    const asked = rankAlternatives(albin({ current: "e7e5", entries: new Map([[entry.epd, entry]]) }));
    expect(asked.current).toMatchObject({ san: "e5", source: "asked" });
    expect(asked.alternatives.find((alternative) => alternative.san === "c6")!.isRepertoire).toBe(true);
  });

  it("always carries the honesty block", () => {
    expect(result.honesty.join(" ")).toMatch(/no popularity data/);
    expect(result.honesty.join(" ")).toMatch(/8 games/);
    expect(rankAlternatives(input([], "black", ALBIN_LINE)).honesty).toEqual(result.honesty);
  });

  it("is deterministic: the same input, in any game order, gives the same result", () => {
    const again = rankAlternatives(albin());
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    const reversed = rankAlternatives({ ...albin(), tree: buildTree([...ALBIN_GAMES].reverse(), { color: "black", now: NOW, halfLifeDays: null, book: BOOK }) });
    expect(JSON.stringify({ ...reversed, pointsLost: null })).toBe(JSON.stringify({ ...result, pointsLost: null }));
  });
});

describe("rankAlternatives after 1.e4 e5 2.Nf3 (2...Bc5)", () => {
  const LINE = "e4 e5 Nf3";
  const games = [...results("e4 e5 Nf3 Bc5 Nxe5", "black", { wins: 4, losses: 6 }), ...results("e4 e5 Nf3 Nc6 Bc4", "black", { wins: 2, losses: 2 })];
  const root = evalAt(
    LINE,
    [pv("b8c6 f1c4 f8c5 c2c3 g8f6 d2d4", -45), pv("g8f6 f3e5 d7d6 e5f3 f6e4 d2d4", -48), pv("d7d6 d2d4 g8f6 b1c3 b8d7 f1c4", -55), pv("d7d5 e4d5 d8d5 b1c3 d5a5 d2d4", -106)],
    [pv("f8c5 f3e5 c5f2 e1f2 d8h4 g2g3", -171)]
  );
  const result = rankAlternatives(input(games, "black", LINE, { root }));

  it("ranks 2...Nc6 first, marked as a move he already plays", () => {
    expect(result.current).toMatchObject({ san: "Bc5", hole: true });
    expect(result.alternatives[0]).toMatchObject({ san: "Nc6", kind: "owned", isRepertoire: false });
    expect(result.alternatives[0].reasons[0].text).toMatch(/^You already play it/);
    expect(result.alternatives.map((alternative) => alternative.san)).toEqual(["Nc6", "Nf6", "d6"]);
    // 1...d5 is 12 win% worse: rejected.
    expect(result.rejected.map((move) => move.san)).toContain("d5");
  });

  it("lists typical replies from the owner's games and the book", () => {
    const replies = result.alternatives[0].replies;
    expect(replies[0]).toMatchObject({ san: "Bc4", source: "games", n: 4 });
    expect(replies.map((reply) => reply.san)).toEqual(expect.arrayContaining(["Bc4", "Bb5", "d4"]));
  });

  it("has no 'change earlier' when no earlier move has a better-scoring sibling", () => {
    expect(result.ancestors).toEqual([]);
  });

  it("suggests changing 1...e5 when 1...d5 scores clearly better (z >= 1.64)", () => {
    const more = [...games, ...results("e4 e5 Nf3 Nc6 Bc4", "black", { wins: 4, losses: 11 }), ...results("e4 d5 exd5 Qxd5", "black", { wins: 18, losses: 7 })];
    const ranked = rankAlternatives(input(more, "black", LINE, { root }));
    expect(ranked.ancestors).toHaveLength(1);
    expect(ranked.ancestors[0]).toMatchObject({ kind: "results", ply: 2, moves: ["e2e4"], instead: { san: "e5", n: 29 }, play: [{ san: "d5", n: 25 }] });
    expect(ranked.ancestors[0].reason).toMatch(/you score 72% with 1\.\.\.d5/);
  });
});

describe("'change earlier' from deep in the Albin", () => {
  it("suggests the gated alternatives at 2.c4 instead of the flagged 2...e5", () => {
    const line = "d4 d5 c4 e5 dxe5";
    const owner = evalAt(ALBIN_LINE, [pv("e7e6 b1c3", -31, 15), pv("c7c6 g1f3", -39, 15), pv("d5c4 e2e4", -38, 15)], [pv("e7e5 d4e5", -78, 15)], "owner");
    const ranked = rankAlternatives(input(ALBIN_GAMES, "black", line, { lookup: lookupOf([owner]), flags: new Map([[`${epdAfter(ALBIN_LINE)}|e7e5`, ALBIN_FLAG]]) }));
    expect(ranked.ancestors).toHaveLength(1);
    const suggestion = ranked.ancestors[0];
    expect(suggestion).toMatchObject({ kind: "leak", ply: 4, sans: ["d4", "d5", "c4"], instead: { san: "e5", n: 20 } });
    expect(suggestion.play.map((move) => move.san)).toEqual(["e6", "dxc4", "c6"]);
    expect(suggestion.reason).toContain("you score 30% over 20 games");
  });

  it("does not suggest replacing a flagged move that is the engine's best there (the points are lost later)", () => {
    const line = "d4 d5 c4 e5 dxe5";
    const owner = evalAt(ALBIN_LINE, [pv("e7e5 d4e5", -31, 15), pv("e7e6 b1c3", -32, 15)], [], "owner");
    const ranked = rankAlternatives(input(ALBIN_GAMES, "black", line, { lookup: lookupOf([owner]), flags: new Map([[`${epdAfter(ALBIN_LINE)}|e7e5`, ALBIN_FLAG]]) }));
    expect(ranked.ancestors).toEqual([]);
  });
});

describe("familiar and transposes", () => {
  // The owner reaches the QGD by 1.d4 d5 2.Nf3 e6 3.c4 Nf6 4.Nc3 (and plays the Albin after 2.c4).
  const games = [...results("d4 d5 Nf3 e6 c4 Nf6 Nc3 Be7", "black", { wins: 2, losses: 2 }), ...results("d4 d5 c4 e5", "black", { wins: 1, losses: 3 })];

  it("a move he has not played that reaches one of his positions transposes (+2)", () => {
    const root = evalAt(ALBIN_LINE, [pv("e7e6 g1f3 g8f6 b1c3 f8e7 c1g5", -31)], [pv("e7e5 d4e5", -78)]);
    const e6 = rankAlternatives(input(games, "black", ALBIN_LINE, { root })).alternatives[0];
    expect(e6.kind).toBe("book");
    expect(e6.reasons.find((reason) => reason.feature === "transposes")).toMatchObject({ points: 2 });
    expect(e6.reasons.find((reason) => reason.feature === "transposes")!.text).toContain("(4 games) after 2...e6 3.Nf3.");
  });

  it("the same pawn skeleton as a position he reaches is familiar (+2)", () => {
    const root = evalAt(ALBIN_LINE, [pv("e7e6 b1c3 g8f6 c1g5 f8e7 e2e3", -31)], [pv("e7e5 d4e5", -78)]);
    const e6 = rankAlternatives(input(games, "black", ALBIN_LINE, { root })).alternatives[0];
    expect(e6.reasons.find((reason) => reason.feature === "familiar")).toMatchObject({ points: 2 });
    expect(e6.reasons.find((reason) => reason.feature === "familiar")!.text).toContain("1.d4 d5 2.Nf3 e6 3.c4");
    expect(e6.reasons.some((reason) => reason.feature === "transposes")).toBe(false);
  });

  it("pawn sets and Jaccard", () => {
    const start = pawnSet(START_EPD);
    expect(start.size).toBe(16);
    expect(start.has("Pe2") && start.has("pd7")).toBe(true);
    const after = pawnSet(epdAfter("e4 e5"));
    expect(jaccard(start, after)).toBeCloseTo(14 / 18, 5);
    expect(jaccard(after, after)).toBe(1);
  });
});

describe("candidates", () => {
  it("are the engine lines, the most-travelled book children, the owner's moves with 3+ games and the questioned move", () => {
    const tree = buildTree(ALBIN_GAMES, { color: "black", now: NOW, halfLifeDays: null, book: BOOK });
    const epd = epdAfter(ALBIN_LINE);
    const ucis = alternativeCandidates(tree.nodes.get(epd), epd, BOOK, ALBIN_DEEP, null);
    expect(ucis).toEqual([...ucis].sort());
    expect(ucis).toEqual(expect.arrayContaining(["e7e6", "g7g6", "c7c6", "d5c4", "e7e5", "b8c6", "c8f5"]));
    // The only-move positions of a candidate: after its 2nd and 4th plies, with the moves from the start.
    const positions = onlyMovePositions(ALBIN_DEEP, epd, pathOf(ALBIN_LINE).moves, "c7c6");
    expect(positions.map((position) => position.epd)).toEqual([epdAfter("d4 d5 c4 c6 Nf3"), epdAfter("d4 d5 c4 c6 Nf3 Nf6 Nc3")]);
    expect(positions[0].moves).toEqual(["d2d4", "d7d5", "c2c4", "c7c6", "g1f3"]);
  });
});
