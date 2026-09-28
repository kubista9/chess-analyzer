import { describe, expect, it } from "vitest";
import { buildTree, type TreeGame } from "./openingTree.js";
import { replayOpening } from "./pgn.js";
import { buildSnapshot } from "./repertoireSnapshot.js";
import type { PlayerColor } from "./types.js";

const DAY = 86_400;
const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;

let nextId = 1;
function games(line: string, color: PlayerColor, count: number, { daysAgo = 1, score = 0.5 as 0 | 0.5 | 1 } = {}): TreeGame[] {
  const sans = line.split(" ");
  return Array.from({ length: count }, () => ({
    id: String(nextId++),
    endTime: NOW - daysAgo * DAY,
    color,
    score,
    myRating: 1200,
    oppRating: 1200,
    baseMs: 180_000,
    plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs: null }))
  }));
}

describe("buildSnapshot", () => {
  it("as Black: the opponent's first moves and the owner's answers, with usage hints", () => {
    const tree = buildTree(
      [
        // 1.e4: 1...e5 was the habit (older), 1...d5 is what the owner plays now.
        ...games("e4 e5", "black", 30, { daysAgo: 150, score: 0 }),
        ...games("e4 e5", "black", 3, { daysAgo: 10 }),
        ...games("e4 d5", "black", 5, { daysAgo: 150 }),
        ...games("e4 d5", "black", 30, { daysAgo: 10, score: 1 }),
        ...games("e4 c6", "black", 1),
        ...games("d4 d5", "black", 9),
        // Under 8 games: no group.
        ...games("Nf3 d5", "black", 4)
      ],
      { color: "black", now: NOW, halfLifeDays: null }
    );
    const snapshot = buildSnapshot(tree);
    expect(snapshot.games).toBe(82);
    expect(snapshot.groups.map((group) => `${group.label} (${group.n})`)).toEqual(["vs 1.e4 (69)", "vs 1.d4 (9)"]);
    const [e4] = snapshot.groups;
    expect(e4.moves).toEqual(["e2e4"]);
    // 1...c6 has under 5% of the games.
    expect(e4.answers.map((move) => `${move.label} ${move.n} ${move.usage}`)).toEqual(["1...d5 35 rising", "1...e5 33 fading"]);
    expect(e4.answers[0]).toMatchObject({ moves: ["e2e4", "d7d5"], score: 32.5 / 35 });
    expect(e4.answers[1].score).toBeCloseTo(1.5 / 33, 12);
  });

  it("as White: the first moves, then the replies to the main one", () => {
    const tree = buildTree(
      [...games("c4 e5 Nc3", "white", 13), ...games("c4 c5 g3", "white", 8), ...games("c4 c5 Nc3", "white", 4), ...games("d4 d5", "white", 3)],
      { color: "white", now: NOW, halfLifeDays: null }
    );
    const snapshot = buildSnapshot(tree);
    expect(snapshot.groups.map((group) => group.label)).toEqual(["First move", "vs 1.c4 e5", "vs 1.c4 c5"]);
    expect(snapshot.groups[0].answers.map((move) => `${move.label} ${move.n}`)).toEqual(["1.c4 25", "1.d4 3"]);
    expect(snapshot.groups[2].answers.map((move) => `${move.label} ${Math.round(move.share * 100)}%`)).toEqual(["2.g3 67%", "2.Nc3 33%"]);
    expect(snapshot.groups[2].moves).toEqual(["c2c4", "c7c5"]);
  });

  it("is empty without games", () => {
    expect(buildSnapshot(buildTree([], { color: "white", now: NOW, halfLifeDays: null })).groups).toEqual([]);
  });
});
