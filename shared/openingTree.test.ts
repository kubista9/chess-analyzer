import { describe, expect, it } from "vitest";
import { deriveMonth, utcMonth } from "../server/services/gameDerive.js";
import { gameId, loadOwnerGames } from "../test/loadFixtures.js";
import { START_EPD } from "./epd.js";
import { buildBook, parseBookTsv } from "./openingBook.js";
import { buildTree, nodeByMoves, preGameRatings, treeGameFrom, type OpeningTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import { eloExpected, wilson } from "./stats.js";
import type { PlayerColor } from "./types.js";

const DAY = 86_400;
const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

let nextId = 1;
/** A synthetic game from SAN moves; `daysAgo` is measured from NOW. */
function game(
  line: string,
  color: PlayerColor,
  score: 0 | 0.5 | 1,
  { daysAgo = 1, me = 1200, opp = 1200, spentMs = 2000 }: { daysAgo?: number; me?: number; opp?: number; spentMs?: number | null } = {}
): TreeGame {
  const sans = line.split(" ");
  return {
    id: String(nextId++),
    endTime: NOW - daysAgo * DAY,
    color,
    score,
    myRating: me,
    oppRating: opp,
    baseMs: 180_000,
    plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs }))
  };
}

const ucis = (line: string) => replayOpening(line.split(" "), 99).map((ply) => ply.uci);
const at = (tree: OpeningTree, line: string) => nodeByMoves(tree, ucis(line));
const edge = (tree: OpeningTree, line: string, uciOrSan: string) =>
  at(tree, line)?.edges.find((candidate) => candidate.uci === uciOrSan || candidate.san === uciOrSan);
const unweighted = { now: NOW, halfLifeDays: null };

describe("buildTree on the owner's real transposition pair", () => {
  // 174004846670 and 174085063610 (both White, both losses) reach the same position at
  // ply 8 by different move orders.
  const byId = new Map(loadOwnerGames().map((raw) => [gameId(raw), raw]));
  const derived = ["174004846670", "174085063610"].map((id) => {
    const raw = byId.get(id)!;
    return deriveMonth("kubista9", utcMonth(raw.end_time), [raw]).games[0];
  });
  const games = derived.map(({ record, plies }) => treeGameFrom(record, plies));
  const tree = buildTree(games, { color: "white", ...unweighted });

  it("merges the two games on one node at ply 8 and keeps ply 7 apart", () => {
    const [a, b] = derived.map((entry) => entry.plies);
    expect(a[7].epdAfter).toBe(b[7].epdAfter);
    expect(a[6].epdAfter).not.toBe(b[6].epdAfter);

    const meeting = tree.nodes.get(a[7].epdAfter)!;
    expect(meeting.n).toBe(2);
    expect(meeting.ply).toBe(8);
    expect(tree.nodes.get(a[6].epdAfter)!.n).toBe(1);
    expect(tree.nodes.get(b[6].epdAfter)!.n).toBe(1);

    // Two different parent edges lead in, one game each, and they sum to the node's n.
    const incoming = [...tree.nodes.values()].flatMap((node) => node.edges.filter((e) => e.toEpd === meeting.epd));
    expect(incoming).toHaveLength(2);
    expect(incoming.map((e) => e.n)).toEqual([1, 1]);
    expect(incoming.every((e) => e.losses === 1)).toBe(true);
  });

  it("uses the stored clocks for the owner's think time", () => {
    const first = tree.nodes.get(START_EPD)!.edges[0];
    expect(first.owner).toBe(true);
    expect(first.n).toBe(2);
    expect(first.thinkTime).not.toBeNull();
    expect(first.thinkTime!.n).toBe(2);
    const reply = tree.nodes.get(first.toEpd)!.edges[0];
    expect(reply.owner).toBe(false);
    expect(reply.thinkTime).toBeNull();
  });
});

describe("buildTree on synthetic games", () => {
  it("merges the English transposition from the plan onto one node with summed n", () => {
    const a = "c4 e5 Nc3 Nc6 g3 Nf6 Bg2 d6";
    const b = "c4 d6 Nc3 Nf6 g3 Nc6 Bg2 e5";
    const tree = buildTree([game(a, "white", 1), game(b, "white", 0), game(a, "white", 0.5)], { color: "white", ...unweighted });
    const nodeA = at(tree, a)!;
    expect(nodeA).toBe(at(tree, b));
    expect(nodeA).toMatchObject({ n: 3, ended: 3, ply: 8 });
    expect(edge(tree, "c4 e5 Nc3 Nc6 g3 Nf6 Bg2", "d6")).toMatchObject({ n: 2, wins: 1, draws: 1, losses: 0 });
    expect(edge(tree, "c4 d6 Nc3 Nf6 g3 Nc6 Bg2", "e5")).toMatchObject({ n: 1, wins: 0, draws: 0, losses: 1 });
  });

  it("counts games, W/D/L and scores, and keeps the colours apart", () => {
    const tree = buildTree(
      [
        game("e4 e5 Nf3", "black", 0),
        game("e4 e5 Nf3", "black", 0.5),
        game("e4 d5", "black", 1),
        game("e4 e5", "white", 1) // other colour: ignored
      ],
      { color: "black", ...unweighted }
    );
    expect(tree.games).toBe(3);
    const root = tree.nodes.get(START_EPD)!;
    expect(root).toMatchObject({ n: 3, ended: 0, ownerToMove: false, ply: 0 });
    expect(root.edges.map((e) => [e.san, e.n, e.owner])).toEqual([["e4", 3, false]]);

    const replies = at(tree, "e4")!;
    expect(replies.ownerToMove).toBe(true);
    expect(replies.edges.map((e) => [e.san, e.n, e.wins, e.draws, e.losses])).toEqual([
      ["e5", 2, 0, 1, 1],
      ["d5", 1, 1, 0, 0]
    ]);
    const e5 = replies.edges[0];
    expect(e5.raw.score).toBe(0.25);
    expect(e5.raw.expected).toBe(0.5);
    expect(e5.raw.deltaPts).toBe(-0.5);
    expect(e5.raw.ci).toEqual(wilson(0.25, 2));
    expect(e5.lowSample).toBe(true);
    // Unweighted: the weighted summary is the raw one.
    expect(e5.weighted).toEqual(e5.raw);
    expect(at(tree, "e4 e5 Nf3")!.ended).toBe(2);
  });

  it("keeps counts consistent along every path", () => {
    const lines = ["d4 d5 c4 e5", "d4 d5 c4 e6", "d4 d5 Bf4", "d4 Nf6 c4 e6", "Nf3 d5 d4", "d4 d5 Nf3"];
    const tree = buildTree(
      lines.map((line, index) => game(line, "black", (index % 3) / 2 as 0 | 0.5 | 1)),
      { color: "black", ...unweighted }
    );
    const incoming = new Map<string, number>();
    for (const node of tree.nodes.values()) {
      expect(node.edges.reduce((sum, e) => sum + e.n, 0) + node.ended).toBe(node.n);
      for (const e of node.edges) {
        expect(e.wins + e.draws + e.losses).toBe(e.n);
        expect(new Set(e.gameIds).size).toBe(e.n);
        incoming.set(e.toEpd, (incoming.get(e.toEpd) ?? 0) + e.n);
      }
    }
    for (const node of tree.nodes.values()) {
      expect(node.epd === START_EPD ? tree.games : incoming.get(node.epd)).toBe(node.n);
    }
    // 1.Nf3 d5 2.d4 and 1.d4 d5 2.Nf3 are one position.
    expect(at(tree, "Nf3 d5 d4")).toBe(at(tree, "d4 d5 Nf3"));
    expect(at(tree, "d4 d5 Nf3")!.n).toBe(2);
  });

  it("counts a repeated position once per game, stopping at the repeating move", () => {
    const shuffle = game("Nf3 Nf6 Ng1 Ng8 e4 e5", "white", 1);
    const tree = buildTree([shuffle, game("e4 e5", "white", 0)], { color: "white", ...unweighted });
    expect(tree.repetitionStops).toBe(1);
    const root = tree.nodes.get(START_EPD)!;
    expect(root.n).toBe(2);
    // Ties sort by SAN (ASCII, so pieces before pawns).
    expect(root.edges.map((e) => [e.san, e.n])).toEqual([
      ["Nf3", 1],
      ["e4", 1]
    ]);
    // Ng8 would return to the start; it is not counted, and the walk ends before it.
    expect(edge(tree, "Nf3 Nf6", "Ng1")!.n).toBe(1);
    expect(at(tree, "Nf3 Nf6 Ng1")!.edges).toEqual([]);
    expect(at(tree, "Nf3 Nf6 Ng1")!.ended).toBe(1);
    expect(at(tree, "e4 e5")!.n).toBe(1);
  });

  it("stops at maxPly", () => {
    const tree = buildTree([game("e4 e5 Nf3 Nc6 Bb5", "white", 1)], { color: "white", ...unweighted, maxPly: 3 });
    expect(at(tree, "e4 e5 Nf3")!.ended).toBe(1);
    expect(at(tree, "e4 e5 Nf3")!.edges).toEqual([]);
    expect(tree.maxPly).toBe(3);
  });

  it("weights by recency from a fixed now and splits the 90-day trend", () => {
    const tree = buildTree(
      [
        game("e4 e5", "black", 0, { daysAgo: 0 }),
        game("e4 e5", "black", 1, { daysAgo: 60 }),
        game("e4 e5", "black", 1, { daysAgo: 120 })
      ],
      { color: "black", now: NOW, halfLifeDays: 60 }
    );
    const e5 = edge(tree, "e4", "e5")!;
    expect(e5.n).toBe(3);
    expect(e5.weighted.wN).toBeCloseTo(1.75, 12);
    expect(e5.weighted.score).toBeCloseTo(0.75 / 1.75, 12);
    expect(e5.weighted.ess).toBeCloseTo(1.75 ** 2 / (1 + 0.25 + 0.0625), 12);
    expect(e5.weighted.ci).toEqual(wilson(e5.weighted.score, e5.weighted.ess));
    expect(e5.raw.score).toBeCloseTo(2 / 3, 12);
    expect(e5.trend).toEqual({ days: 90, recentN: 2, recentScore: 0.5, olderN: 1, olderScore: 1 });
    expect(tree.nodes.get(START_EPD)!.wN).toBeCloseTo(1.75, 12);
  });

  it("compares with the Elo expectation of each game", () => {
    const tree = buildTree(
      [game("d4 d5", "black", 0, { me: 1200, opp: 1400 }), game("d4 d5", "black", 1, { me: 1200, opp: 1000 })],
      { color: "black", ...unweighted }
    );
    const d5 = edge(tree, "d4", "d5")!;
    const expected = eloExpected(1200, 1400) + eloExpected(1200, 1000);
    expect(d5.raw.expected).toBeCloseTo(expected / 2, 12);
    expect(d5.raw.deltaPts).toBeCloseTo(1 - expected, 12);
  });

  it("lists game ids newest first and averages the owner's think time", () => {
    const older = game("c4 c5", "white", 1, { daysAgo: 30, spentMs: 1000 });
    const newer = game("c4 c5", "white", 0, { daysAgo: 2, spentMs: 5000 });
    const noClock = game("c4 c5", "white", 0, { daysAgo: 10, spentMs: null });
    const tree = buildTree([older, newer, noClock], { color: "white", ...unweighted });
    const c4 = tree.nodes.get(START_EPD)!.edges[0];
    expect(c4.gameIds).toEqual([newer.id, noClock.id, older.id]);
    expect(c4.thinkTime).toEqual({ n: 2, avgMs: 3000, avgShareOfBase: 3000 / 180_000 });
    expect(edge(tree, "c4", "c5")!.thinkTime).toBeNull();
  });

  it("names nodes exactly or by the deepest name on the way, and marks book positions", () => {
    const book = buildBook(
      parseBookTsv(
        [
          "eco\tname\tpgn",
          "B01\tScandinavian Defense\t1. e4 d5",
          "B01\tScandinavian Defense: Main Line\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5"
        ].join("\n")
      )
    );
    const tree = buildTree(
      [game("e4 d5 exd5 Qxd5 Nc3 Qa5 d4", "black", 1), game("e4 d5 exd5 Qxd5 Nc3 Qd8", "black", 0)],
      { color: "black", ...unweighted, book }
    );
    expect(at(tree, "e4 d5")).toMatchObject({ name: "Scandinavian Defense", eco: "B01", nameExact: true, inBook: true });
    expect(at(tree, "e4 d5 exd5")).toMatchObject({ name: "Scandinavian Defense", nameExact: false, inBook: true });
    expect(edge(tree, "e4 d5 exd5 Qxd5 Nc3", "Qa5")).toMatchObject({ name: "Scandinavian Defense: Main Line", nameExact: true, inBook: true });
    expect(edge(tree, "e4 d5 exd5 Qxd5 Nc3", "Qd8")).toMatchObject({ name: "Scandinavian Defense", nameExact: false, inBook: false });
    expect(at(tree, "e4 d5 exd5 Qxd5 Nc3 Qa5 d4")).toMatchObject({ name: "Scandinavian Defense: Main Line", inBook: false });
    expect(tree.nodes.get(START_EPD)).toMatchObject({ name: null, inBook: true });
  });
});

describe("preGameRatings", () => {
  it("takes the previous post-game rating in the same time class", () => {
    const ratings = preGameRatings([
      { id: "b2", timeClass: "blitz", endTime: 20, myRating: 1010 },
      { id: "b1", timeClass: "blitz", endTime: 10, myRating: 1000 },
      { id: "r1", timeClass: "rapid", endTime: 15, myRating: 1300 },
      { id: "b3", timeClass: "blitz", endTime: 30, myRating: 995 },
      { id: "r2", timeClass: "rapid", endTime: 40, myRating: 1290 }
    ]);
    expect(Object.fromEntries(ratings)).toEqual({ b1: 1000, b2: 1000, b3: 1010, r1: 1300, r2: 1300 });
  });
});
