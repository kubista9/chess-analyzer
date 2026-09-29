import { describe, expect, it } from "vitest";
import { START_EPD } from "./epd.js";
import { buildFixList } from "./fixList.js";
import { buildTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import { legalMove, repTag, repertoireStats, walkRepertoire, type RepEntry } from "./repertoire.js";
import type { PlayerColor } from "./types.js";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

let nextId = 1;
function game(line: string, color: PlayerColor, score: 0 | 0.5 | 1 = 0): TreeGame {
  const sans = line.split(" ");
  nextId += 1;
  return {
    id: `g${nextId}`,
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

const epdAfter = (line: string) => {
  if (!line) {
    return START_EPD;
  }
  const sans = line.split(" ");
  return replayOpening(sans, sans.length).at(-1)!.epdAfter;
};

/** Entries from [line to the position, SAN of the owner's move]. */
function repertoire(color: PlayerColor, moves: [string, string][]): Map<string, RepEntry> {
  const entries = new Map<string, RepEntry>();
  for (const [line, san] of moves) {
    const epd = epdAfter(line);
    const move = legalMove(epd, { san })!;
    entries.set(epd, {
      color,
      epd,
      uci: move.uci,
      san: move.san,
      source: "from-games",
      status: "active",
      locked: false,
      replaced: null,
      reason: null,
      note: null,
      ply: line ? line.split(" ").length + 1 : 1,
      updatedAt: 1
    });
  }
  return entries;
}

// Black: 1.e4 d5 2.exd5 Qxd5 3.Nc3 Qa5, and 1.d4 d5 2.c4 e6.
const BLACK = repertoire("black", [
  ["e4", "d5"],
  ["e4 d5 exd5", "Qxd5"],
  ["e4 d5 exd5 Qxd5 Nc3", "Qa5"],
  ["d4", "d5"],
  ["d4 d5 c4", "e6"]
]);

describe("walkRepertoire", () => {
  it("finds the first owner move that leaves the repertoire", () => {
    const walk = walkRepertoire(game("d4 d5 c4 e5 dxe5", "black"), BLACK);
    expect(walk.deviation).toEqual({
      ply: 4,
      epd: epdAfter("d4 d5 c4"),
      played: { uci: "e7e5", san: "e5" },
      expected: { uci: "e7e6", san: "e6" }
    });
    expect(walk.unprepared).toBeNull();
    expect(walk.inRepThrough).toBe(3);
  });

  it("finds the first opponent move the repertoire has no answer to", () => {
    const walk = walkRepertoire(game("e4 d5 exd5 Qxd5 Nf3 Qa5", "black"), BLACK);
    expect(walk.deviation).toBeNull();
    expect(walk.unprepared).toEqual({ ply: 5, parentEpd: epdAfter("e4 d5 exd5 Qxd5"), opp: { uci: "g1f3", san: "Nf3" }, epd: epdAfter("e4 d5 exd5 Qxd5 Nf3") });
    expect(walk.inRepThrough).toBe(4);
  });

  it("counts a game that follows the repertoire to its end as staying in it", () => {
    const walk = walkRepertoire(game("e4 d5 exd5 Qxd5 Nc3 Qa5 d4", "black"), BLACK);
    expect(walk).toMatchObject({ deviation: null, unprepared: null, started: true, inRepThrough: 16 });
    // Only the first 16 plies are walked; nothing is unprepared past the repertoire's depth.
    expect(walkRepertoire(game("e4 d5 exd5 Qxd5 Nc3 Qa5", "black"), BLACK, 5).inRepThrough).toBe(5);
  });

  it("follows entries across transpositions (entries are keyed by position)", () => {
    const white = repertoire("white", [
      ["", "d4"],
      ["d4 Nf6", "c4"],
      ["d4 Nf6 c4 e6", "Nc3"],
      ["d4 e6", "c4"]
    ]);
    // 1.d4 e6 2.c4 Nf6 reaches the 1.d4 Nf6 2.c4 e6 position: the entry 3.Nc3 applies.
    expect(walkRepertoire(game("d4 e6 c4 Nf6 Nc3", "white"), white)).toMatchObject({ deviation: null, unprepared: null });
    const walk = walkRepertoire(game("d4 e6 c4 Nf6 Nf3", "white"), white);
    expect(walk.deviation).toMatchObject({ ply: 5, played: { san: "Nf3" }, expected: { san: "Nc3" } });
  });

  it("does not measure White's games without a root entry", () => {
    const walk = walkRepertoire(game("e4 e5", "white"), new Map());
    expect(walk).toMatchObject({ started: false, deviation: null, unprepared: null, inRepThrough: 0 });
  });
});

describe("repertoireStats", () => {
  const games = [
    game("e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3 Nf6 d4 c6 Bc4 Bf5", "black", 1),
    game("e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3 Nf6 d4 c6 Bc4 Bf5", "black", 0.5),
    game("e4 e5 Nf3 Nc6", "black", 0),
    game("e4 e5 Nf3 Nc6", "black", 0),
    game("d4 d5 Bf4 Bf5", "black", 0),
    game("d4 d5 Bf4 c5", "black", 1),
    game("d4 d5 Bf4 e6", "black", 0)
  ];

  it("reports coverage through plies 8 and 12, and the deviation and unprepared tables", () => {
    const stats = repertoireStats("black", games, BLACK, { now: NOW, halfLifeDays: null });
    // The two Scandinavian games reach 3...Qa5 and then 4.Nf3 is unprepared (ply 7): in through ply 6.
    expect(stats.coverage).toEqual([
      { ply: 8, stayed: 0, games: 7, rate: 0 },
      { ply: 12, stayed: 0, games: 7, rate: 0 }
    ]);
    expect(stats.deviations).toMatchObject([{ ply: 2, played: { san: "e5" }, expected: { san: "d5" }, n: 2, score: 0, pointsLost: 1 }]);
    expect(stats.deviations[0].examples.map((example) => example.ply)).toEqual([2, 2]);
    expect(stats.unprepared.map((row) => [row.opp.san, row.ply, row.n])).toEqual([
      ["Bf4", 3, 3],
      ["Nf3", 7, 2]
    ]);
    expect(stats.unprepared[0]).toMatchObject({ score: 1 / 3, pointsLost: 0.5 });
    expect(stats.byGame.get(games[0].id)).toEqual({ deviationPly: null, unpreparedPly: 7, inRepThrough: 6 });
  });

  it("recomputes at once when an entry is added", () => {
    const more = new Map(BLACK);
    for (const [key, entry] of repertoire("black", [
      ["e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3", "Nf6"],
      ["e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3 Nf6 d4", "c6"],
      ["e4 d5 exd5 Qxd5 Nc3 Qa5 Nf3 Nf6 d4 c6 Bc4", "Bf5"]
    ])) {
      more.set(key, entry);
    }
    const stats = repertoireStats("black", games, more, { now: NOW, halfLifeDays: null });
    expect(stats.coverage.map((coverage) => coverage.stayed)).toEqual([2, 2]);
  });

  it("feeds unprepared replies with 3+ games that lose points into the fix list", () => {
    const tree = buildTree(games, { color: "black", now: NOW, halfLifeDays: null });
    const stats = repertoireStats("black", games, BLACK, { now: NOW, halfLifeDays: null });
    const fix = buildFixList([{ tree, games }], undefined, { black: stats.unprepared });
    expect(fix.unprepared).toMatchObject([
      { kind: "unprepared", id: `unprepared:black:d2d4,d7d5,c1f4`, line: "1.d4 d5 2.Bf4", before: "1.d4 d5", n: 3, impact: 0.5 }
    ]);
    expect(fix.ranked.some((item) => item.kind === "unprepared")).toBe(true);
    // Without a repertoire there is nothing unprepared.
    expect(buildFixList([{ tree, games }]).unprepared).toEqual([]);
  });
});

describe("repTag", () => {
  it("labels an entry from the games, as a suggestion, or as edited", () => {
    expect(repTag({ source: "from-games", replaced: null })).toEqual({ kind: "from-games" });
    expect(repTag({ source: "seed-engine", replaced: { uci: "f8c5", san: "Bc5", loss: 11.9, reason: "" } })).toEqual({ kind: "suggested", replaces: "Bc5" });
    expect(repTag({ source: "edited", replaced: { uci: "f8c5", san: "Bc5", loss: null, reason: "" } })).toEqual({ kind: "edited" });
  });
});
