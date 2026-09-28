import { describe, expect, it } from "vitest";
import {
  EARLY_LOSS_PLY,
  ENGINE_HOLE_MIN_LOSS,
  FIX_FDR_Q,
  bhAdjusted,
  buildFixList,
  collectCandidates,
  collectEngineHoles,
  type FixEngine,
  selectLeaks,
  type CandidateGame,
  type FixCandidate
} from "./fixList.js";
import { benjaminiHochberg } from "./moveSignals.js";
import { buildTree, formatLine, principalPaths, type OpeningTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import { analyzeGameOpening } from "./openingAnalysis.js";
import type { PlayerColor, PositionEval } from "./types.js";

const DAY = 86_400;
const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

let nextId = 1;
/** A synthetic game from SAN moves (Elo expectation 0.5 unless the ratings differ). */
function game(
  line: string,
  color: PlayerColor,
  score: 0 | 0.5 | 1,
  { daysAgo = 1, me = 1200, opp = 1200, plyCount }: { daysAgo?: number; me?: number; opp?: number; plyCount?: number } = {}
): TreeGame {
  const sans = line.split(" ");
  return {
    id: String(nextId++),
    endTime: NOW - daysAgo * DAY - nextId,
    color,
    score,
    myRating: me,
    oppRating: opp,
    baseMs: 180_000,
    plyCount: plyCount ?? 60,
    plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs: 1000 }))
  };
}

/** `losses` losses, `wins` wins and `draws` draws of one line. */
function results(line: string, color: PlayerColor, { losses = 0, wins = 0, draws = 0 }, options: Parameters<typeof game>[3] = {}): TreeGame[] {
  return [
    ...Array.from({ length: losses }, () => game(line, color, 0, options)),
    ...Array.from({ length: wins }, () => game(line, color, 1, options)),
    ...Array.from({ length: draws }, () => game(line, color, 0.5, options))
  ];
}

function fixList(games: TreeGame[], halfLifeDays: number | null = null) {
  const parts = (["white", "black"] as const).map((color) => ({
    tree: buildTree(games, { color, now: NOW, halfLifeDays }),
    games
  }));
  return buildFixList(parts);
}

const lineOf = (item: { sans: string[] }) => item.sans.join(" ");

/** `count` White first moves at exactly the Elo expectation (z = 0): null candidates. */
function crowd(count: number): TreeGame[] {
  const moves = ["a3", "a4", "b3", "b4", "c3", "c4", "d3", "d4", "e3", "e4", "f3", "f4", "g3", "g4", "h3", "h4", "Na3", "Nc3", "Nf3", "Nh3"];
  return moves.slice(0, count).flatMap((move) => results(move, "white", { losses: 4, wins: 4 }));
}

describe("bhAdjusted", () => {
  it("gives the step-up adjusted p-values, consistent with benjaminiHochberg", () => {
    const p = [0.01, 0.04, 0.03, 0.2];
    const q = bhAdjusted(p);
    expect(q.map((value) => Number(value.toFixed(4)))).toEqual([0.04, 0.0533, 0.0533, 0.2]);
    for (const level of [0.03, 0.05, 0.1, 0.2]) {
      expect(q.map((value) => value <= level)).toEqual(benjaminiHochberg(p, level));
    }
  });
});

describe("collectCandidates", () => {
  it("takes the owner's moves with n >= 8 in both colours, never the opponent's", () => {
    const games = [
      ...results("e4 e5 Nf3", "white", { losses: 5, wins: 5 }),
      ...results("e4 c5 Nf3", "white", { losses: 4, wins: 4 }),
      ...results("d4 d5", "black", { losses: 8 })
    ];
    const lists = (["white", "black"] as const).map((color) => {
      const tree = buildTree(games, { color, now: NOW, halfLifeDays: null });
      return collectCandidates(tree, games).map((candidate) => `${color} ${lineOf(candidate)} ${candidate.games.length}`);
    });
    // 1.e4 (18), 2.Nf3 after 1...e5 (10); 2.Nf3 after 1...c5 has 8. 1...e5 / 1...c5 are the opponent's.
    expect(lists[0].sort()).toEqual(["white e4 18", "white e4 c5 Nf3 8", "white e4 e5 Nf3 10"]);
    expect(lists[1]).toEqual(["black d4 d5 8"]);
  });

  it("needs an effective n of 8 as well as 8 raw games", () => {
    const games = [...results("e4 e5", "black", { losses: 2 }), ...results("e4 e5", "black", { losses: 8 }, { daysAgo: 400 })];
    const tree = buildTree(games, { color: "black", now: NOW, halfLifeDays: 30 });
    expect(collectCandidates(tree, games)).toEqual([]);
    const unweighted = buildTree(games, { color: "black", now: NOW, halfLifeDays: null });
    expect(collectCandidates(unweighted, games).map(lineOf)).toEqual(["e4 e5"]);
  });

  it("records per game the weight, the Elo expectation and the ply of the move", () => {
    const games = results("d4 d5 c4 e5", "black", { losses: 8 }, { me: 1400, opp: 1200 });
    const tree = buildTree(games, { color: "black", now: NOW, halfLifeDays: null });
    const [first, second] = collectCandidates(tree, games).sort((a, b) => a.moves.length - b.moves.length);
    expect(lineOf(first)).toBe("d4 d5");
    expect(lineOf(second)).toBe("d4 d5 c4 e5");
    expect(second.moves).toEqual(["d2d4", "d7d5", "c2c4", "e7e5"]);
    expect(second.games.every((entry) => entry.ply === 4 && entry.w === 1 && entry.s === 0)).toBe(true);
    expect(second.games[0].e).toBeCloseTo(1 / (1 + 10 ** (-200 / 400)), 12);
  });
});

describe("principalPaths and formatLine", () => {
  it("labels a transposed position with its shortest, most-played move order", () => {
    const games = [
      ...results("Nf3 d5 d4", "white", { wins: 3 }),
      ...results("d4 d5 Nf3", "white", { wins: 5 })
    ];
    const tree: OpeningTree = buildTree(games, { color: "white", now: NOW, halfLifeDays: null });
    const merged = games[0].plies[2].epdAfter;
    expect(games[3].plies[2].epdAfter).toBe(merged);
    expect(principalPaths(tree).get(merged)!.sans).toEqual(["d4", "d5", "Nf3"]);
  });

  it("numbers moves from the right ply", () => {
    expect(formatLine(["e4", "e5", "Nf3", "Nc6"])).toBe("1.e4 e5 2.Nf3 Nc6");
    expect(formatLine(["e5", "Nf3"], 2)).toBe("1...e5 2.Nf3");
    expect(formatLine([])).toBe("");
  });
});

describe("the gate", () => {
  it("lists a clear leak and leaves noise and strengths alone", () => {
    const items = fixList([
      ...results("e4 e5", "black", { losses: 11, wins: 1 }),
      ...results("e4 d5", "black", { losses: 5, wins: 5 }),
      ...results("d4 Nf6", "black", { wins: 10, losses: 2 })
    ]);
    expect(items.items.map(lineOf)).toEqual(["e4 e5"]);
    expect(items.tested).toBe(3);
    const [leak] = items.items;
    expect(leak).toMatchObject({ kind: "results-leak", tier: "leak", color: "black", n: 12, wins: 1, losses: 11, line: "1.e4 e5" });
    expect(leak.deltaPts).toBeCloseTo(-5, 12);
    expect(leak.pointsLost).toBeCloseTo(5, 12);
    expect(leak.z).toBeCloseTo(5 / Math.sqrt(12 * 0.25), 12);
    expect(leak.confidence).toBe("high");
  });

  it("needs z >= 1.64 even when Benjamini-Hochberg alone would pass", () => {
    // z = 2.5 / sqrt(35 * 0.25) = 0.85; alone in its family, p = 0.2 would just pass BH at q = 0.2.
    const selection = fixList(results("e4 e5", "black", { losses: 20, wins: 15 }));
    expect(selection.tested).toBe(1);
    expect(selection.items).toEqual([]);
    expect(selection.watch).toEqual([]);
  });

  it("applies Benjamini-Hochberg across the whole candidate set, both colours", () => {
    // One Black line at z = 2.0 (p = 0.023): a discovery alone, but not among 19 White null lines.
    const leak = results("e4 e5", "black", { losses: 12, wins: 4 });
    const alone = fixList(leak);
    expect(alone.items.map(lineOf)).toEqual(["e4 e5"]);

    const crowded = fixList([...leak, ...crowd(19)]);
    expect(crowded.tested).toBe(20);
    expect(crowded.items).toEqual([]);
    expect(crowded.watch.map(lineOf)).toEqual(["e4 e5"]);
    expect(crowded.watch[0].q).toBeGreaterThan(FIX_FDR_Q);
  });
});

describe("blame attribution", () => {
  it("emits only the child when it explains about 70% of the parent's lost points", () => {
    const selection = fixList([
      // 2...Nc6: 10 games, 4.0 points lost (z 2.53).
      ...results("e4 e5 Nf3 Nc6", "black", { losses: 9, wins: 1 }),
      // The rest of 1...e5: 12 games, 1.5 points lost (z 0.87): not enough on its own.
      ...results("e4 e5 Bc4 Nf6", "black", { losses: 6, wins: 3, draws: 3 })
    ]);
    // 1...e5 as a whole: 5.5 points over 22 games (z 2.35) is significant, but its residual is not.
    expect(selection.significant).toBe(2);
    expect(selection.items.map(lineOf)).toEqual(["e4 e5 Nf3 Nc6"]);
    expect(selection.items[0].pointsLost).toBeCloseTo(4, 12);
  });

  it("also emits the parent's residual when two children explain 40% each", () => {
    const residualGames = [
      // 12 more 1...e5 games over two replies with under 8 games each: 2.0 points lost (residual z 1.15).
      ...results("e4 e5 d4 exd4", "black", { losses: 4, wins: 2 }),
      ...results("e4 e5 Nc3 Nf6", "black", { losses: 3, wins: 1, draws: 2 })
    ];
    const selection = fixList([
      ...results("e4 e5 Nf3 Nc6", "black", { losses: 9, wins: 1 }),
      ...results("e4 e5 Bc4 Nf6", "black", { losses: 9, wins: 1 }),
      ...residualGames
    ]);
    const lines = selection.items.map(lineOf);
    expect(lines).toEqual(["e4 e5 Bc4 Nf6", "e4 e5 Nf3 Nc6", "e4 e5"]);
    const parent = selection.items[2];
    expect(parent.n).toBe(32);
    expect(parent.deltaPts).toBeCloseTo(-10, 12);
    expect(parent.pointsLost).toBeCloseTo(2, 12);
    expect(parent.residualN).toBe(12);
    expect(parent.explainedBy.sort()).toEqual(["black:e2e4,e7e5,f1c4,g8f6", "black:e2e4,e7e5,g1f3,b8c6"]);
    // Its example games are ones it is blamed for, not the children's.
    const residualIds = new Set(residualGames.map((entry) => entry.id));
    expect(parent.examples.map((example) => residualIds.has(example.id))).toEqual([true, true, true]);
    // The lost points are shared out, never counted twice: 4 + 4 + 2 = the parent's 10.
    expect(selection.items.reduce((sum, item) => sum + item.pointsLost, 0)).toBeCloseTo(10, 12);
  });

  it("ranks by the residual points lost, not by the whole line", () => {
    const selection = fixList([
      ...results("e4 e5 Nf3 Nc6", "black", { losses: 9, wins: 1 }),
      ...results("e4 e5 Bc4 Nf6", "black", { losses: 9, wins: 1 }),
      ...results("e4 e5 d4 exd4", "black", { losses: 4, wins: 2 }),
      ...results("e4 e5 Nc3 Nf6", "black", { losses: 3, wins: 1, draws: 2 }),
      // A White leak worth 6 points: first, ahead of the 1...e5 parent with 10 in total.
      ...results("c4 c5 Nc3", "white", { losses: 14, wins: 2 })
    ]);
    expect(selection.items.map((item) => `${item.color} ${item.line}`)).toEqual([
      "white 1.c4 c5 2.Nc3",
      "black 1.e4 e5 2.Bc4 Nf6",
      "black 1.e4 e5 2.Nf3 Nc6",
      "black 1.e4 e5"
    ]);
    // 1.c4 itself (16 games, 6 points) is fully explained by 2.Nc3, so it is not listed.
    expect(selection.items.some((item) => item.line === "1.c4")).toBe(false);
  });

  it("does not let a watch-level child shrink a leak", () => {
    const selection = fixList([
      // 2...Nc6: z 1.73 on its own (p 0.042), not a discovery among 17 candidates.
      ...results("e4 e5 Nf3 Nc6", "black", { losses: 9, wins: 3 }),
      // The rest of 1...e5, spread over replies with under 8 games each: 12 points lost.
      ...["d4 exd4", "Nc3 Nf6", "Bc4 Nf6", "f4 exf4"].flatMap((reply) => results(`e4 e5 ${reply}`, "black", { losses: 6 })),
      ...crowd(15)
    ]);
    expect(selection.tested).toBe(17);
    expect(selection.items.map(lineOf)).toEqual(["e4 e5"]);
    expect(selection.watch.map(lineOf)).toEqual(["e4 e5 Nf3 Nc6"]);
    const [leak] = selection.items;
    expect(leak.pointsLost).toBeCloseTo(15, 12);
    expect(leak.residualN).toBe(36);
    expect(leak.explainedBy).toEqual([]);
  });
});

describe("item details", () => {
  it("counts early losses and picks the most recent losses as examples", () => {
    const games = [
      ...results("e4 e5", "black", { losses: 6 }, { plyCount: EARLY_LOSS_PLY, daysAgo: 10 }),
      ...results("e4 e5", "black", { losses: 4 }, { plyCount: 80, daysAgo: 2 }),
      ...results("e4 e5", "black", { wins: 2 }, { daysAgo: 1 })
    ];
    const [item] = fixList(games).items;
    expect(item.earlyLoss).toEqual({ ply: EARLY_LOSS_PLY, n: 6, rate: 0.5 });
    // Newest losses first (the wins are newer but not losses).
    expect(item.examples.map((example) => example.score)).toEqual([0, 0, 0]);
    const lossIds = games.filter((entry) => entry.score === 0).sort((a, b) => b.endTime - a.endTime).slice(0, 3).map((entry) => entry.id);
    expect(item.examples.map((example) => example.id)).toEqual(lossIds);
    expect(item.examples.every((example) => example.ply === 2)).toBe(true);
    expect(item.trend).toMatchObject({ recentN: 12, olderN: 0, direction: "none" });
  });

  it("uses the weighted view for score, CI and z, and keeps the raw values beside them", () => {
    const games = [
      ...results("e4 e5", "black", { losses: 10 }, { daysAgo: 5 }),
      ...results("e4 e5", "black", { wins: 6 }, { daysAgo: 150 })
    ];
    const [item] = fixList(games, 60).items;
    expect(item.raw.score).toBeCloseTo(6 / 16, 12);
    expect(item.score).toBeLessThan(item.raw.score);
    expect(item.ess).toBeLessThan(16);
    expect(item.ci[0]).toBeLessThan(item.score);
    expect(item.ci[1]).toBeGreaterThan(item.score);
  });

  it("recomputes everything from replaced scores (the null simulation's hook)", () => {
    const games = results("e4 e5", "black", { losses: 12 });
    const tree = buildTree(games, { color: "black", now: NOW, halfLifeDays: null });
    const candidates: FixCandidate[] = collectCandidates(tree, games);
    expect(selectLeaks(candidates).items).toHaveLength(1);
    const fair = selectLeaks(candidates, (entry: CandidateGame) => (Number(entry.id) % 2 ? 1 : 0));
    expect(fair.items).toEqual([]);
  });
});

describe("engine holes", () => {
  const engineLine = (uci: string, cp: number) => ({ uci, cp, mate: null, winPct: 0, depth: 15, pv: [uci] });
  const epdAfter = (line: string) => {
    const sans = line.split(" ");
    return replayOpening(sans, sans.length)[sans.length - 1].epdAfter;
  };
  // Owner-to-move roots and the positions after, as the backfill stores them.
  const evals = new Map<string, PositionEval>();
  const put = (line: string, lines: [string, number][], scored: [string, number][] = []) => {
    const epd = epdAfter(line);
    const all = lines.map(([uci, cp]) => engineLine(uci, cp));
    evals.set(epd, {
      epd,
      tier: "owner",
      depth: 15,
      nodes: 1,
      lines: all,
      scored: scored.map(([uci, cp]) => engineLine(uci, cp)),
      terminal: null,
      bestUci: all[0].uci,
      score: all[0]
    });
  };
  put("e4 e5 Nf3", [["b8c6", -45], ["g8f6", -52]], [["f8c5", -160], ["d7d6", -60], ["f7f6", -105]]);
  put("e4", [["e7e5", -30]]);
  put("e4 e5 Nf3 Bc5", [["f3e5", 155]]);
  put("e4 e5 Nf3 f6", [["f3e5", 120]]);
  const engine: FixEngine = {
    lookup: (epd) => evals.get(epd),
    analysisOf: (entry) => analyzeGameOpening(entry, (epd) => evals.get(epd))
  };

  it("lists a refuted owner move even when its results are fine, with impact = wN x loss / 100", () => {
    const games = [
      ...results("e4 e5 Nf3 Bc5", "black", { wins: 8, losses: 8 }),
      ...results("e4 e5 Nf3 d6", "black", { wins: 3, losses: 3 }),
      ...results("e4 e5 Nf3 f6", "black", { wins: 2, losses: 2 }),
      ...results("e4 e5 Nf3 Nc6", "black", { wins: 1, losses: 1 })
    ];
    const tree = buildTree(games, { color: "black", now: NOW, halfLifeDays: null });
    const holes = collectEngineHoles(tree, games, engine);
    // Bc5 (loss ~11, the loss gate); f6 (loss ~5.4 with 3.Nxe5 at +1.20 for White: the reply gate);
    // d6 (loss ~1.6) and Nc6 (1 game) are not holes.
    expect(holes.map((hole) => hole.sans.join(" "))).toEqual(["e4 e5 Nf3 Bc5", "e4 e5 Nf3 f6"]);
    const [bc5, f6] = holes;
    expect(bc5).toMatchObject({
      kind: "engine-hole",
      id: "hole:black:e2e4,e7e5,g1f3,f8c5",
      line: "1.e4 e5 2.Nf3 Bc5",
      before: "1.e4 e5 2.Nf3",
      n: 16,
      score: 0.5,
      bestSan: "Nc6",
      reply: { san: "Nxe5", cpForThem: 155 },
      ownerEval: { best: { cp: -45 }, played: { cp: -160 } },
      whiteEval: { best: { cp: 45 }, played: { cp: 160 } },
      gates: { loss: true, reply: true }
    });
    expect(bc5.loss).toBeGreaterThanOrEqual(ENGINE_HOLE_MIN_LOSS);
    expect(bc5.impact).toBeCloseTo((16 * bc5.loss) / 100, 2);
    expect(f6.gates).toEqual({ loss: false, reply: true });
    expect(bc5.examples).toHaveLength(3);
  });

  it("merges holes with the leaks by impact and adds engine stats to the leaks", () => {
    const games = [
      ...results("e4 e5 Nf3 Bc5", "black", { wins: 1, losses: 15 }),
      ...crowd(20).map((entry) => ({ ...entry, color: "white" as const }))
    ];
    const list = fixList(games);
    expect(list.holes).toEqual([]);
    const withEngine = buildFixList(
      (["white", "black"] as const).map((color) => ({ tree: buildTree(games, { color, now: NOW, halfLifeDays: null }), games })),
      engine
    );
    expect(withEngine.holes.map((hole) => hole.line)).toEqual(["1.e4 e5 2.Nf3 Bc5"]);
    expect(withEngine.ranked.map((item) => item.kind)).toContain("engine-hole");
    const impacts = withEngine.ranked.map((item) => item.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    const leak = withEngine.items.find((item) => item.line === "1.e4 e5 2.Nf3 Bc5");
    // The 4-ply games are fully scored: the first mistake (2...Bc5) is known in all 16.
    expect(leak?.engine).toMatchObject({
      games: 16,
      complete: 0,
      firstError: { known: 16, errors: 16, rate: 1, shown: true },
      topFirstMistake: { san: "Bc5", bestSan: "Nc6", count: 16 }
    });
  });
});
