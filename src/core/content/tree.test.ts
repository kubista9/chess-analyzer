import { describe, expect, it } from "vitest";
import { fixtureFiles } from "../../test/content";
import { START_EPD, START_FEN, replayMoves } from "../chess/position";
import type { CustomLineRecord } from "../training/types";
import { buildCatalog } from "./catalog";
import { buildTree, comparePriority, linePositionKeys, nodeAt, opponentRepliesAt, positionItems, userMovesAt, walkTree } from "./tree";
import { posKey, type RepertoireTree, type TreeEdge } from "./types";

const catalog = buildCatalog(fixtureFiles());
const byDefault = (lineId: string) => catalog.lineById.get(lineId)?.defaultEnabled ?? false;
const white = buildTree(catalog, "white", byDefault);
const black = buildTree(catalog, "black", byDefault);

/** The EPD after SAN moves from the start. */
const epdAfter = (line: string) => (line ? replayMoves(line.split(" ")).at(-1)!.epdAfter : START_EPD);
const sans = (edges: readonly TreeEdge[]) => edges.map((edge) => edge.san);

const FOUR_KNIGHTS = "eng-e5-four-knights";
const VIA_NF6 = "eng-nf6-four-knights-bb4";

function customRecord(moves: string): CustomLineRecord {
  const at = Date.UTC(2026, 9, 1, 12);
  return {
    id: "knight-dance",
    side: "white",
    chapter: "Tests",
    family: "Test",
    name: "Out and back",
    eco: null,
    moves,
    description: "A line that comes back to the start.",
    plans: ["None."],
    createdAt: at,
    updatedAt: at
  };
}

describe("buildTree", () => {
  it("has one node per position over the enabled lines of the side", () => {
    const enabled = catalog.lines.filter((line) => line.side === "white" && line.defaultEnabled);
    expect([...white.lineIds]).toEqual(["eng-e5-bc5", "eng-e5-closed", FOUR_KNIGHTS, VIA_NF6]);
    expect(white.side).toBe("white");
    expect(white.nodes.size).toBe(new Set(enabled.flatMap((line) => line.epds)).size);
    expect(nodeAt(white, epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6 e3"))).toBeUndefined();
  });

  it("merges a transposition into one node with the lines of both move orders", () => {
    const merged = nodeAt(white, epdAfter("c4 e5 Nc3 Nf6"))!;
    expect(nodeAt(white, epdAfter("c4 Nf6 Nc3 e5"))).toBe(merged);
    expect(merged.lineIds).toEqual([FOUR_KNIGHTS, VIA_NF6]);
    expect(merged.edges).toHaveLength(1);
    expect(merged.edges[0]).toEqual({ uci: "g1f3", san: "Nf3", from: "g1", to: "f3", mover: "user", lineIds: [FOUR_KNIGHTS, VIA_NF6], priority: "main" });
    // After 4.g3 the two lines split again: 4...d5 (main) and 4...Bb4 (secondary).
    const split = nodeAt(white, epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6 g3"))!;
    expect(sans(split.edges)).toEqual(["d5", "Bb4"]);
    expect(split.edges.map((edge) => edge.lineIds)).toEqual([[FOUR_KNIGHTS], [VIA_NF6]]);
  });

  it("dedupes edges by move and lists their lines in teaching order", () => {
    const start = nodeAt(white, START_EPD)!;
    expect(start.edges).toHaveLength(1);
    expect(start.edges[0].lineIds).toEqual(["eng-e5-bc5", "eng-e5-closed", FOUR_KNIGHTS, VIA_NF6]);
    expect(start.lineIds).toEqual(["eng-e5-bc5", "eng-e5-closed", FOUR_KNIGHTS, VIA_NF6]);
  });

  it("gives an edge the best priority of its lines", () => {
    // 1.c4 is played by secondary and main lines: it is a main-line move.
    expect(nodeAt(white, START_EPD)!.edges[0].priority).toBe("main");
    expect(nodeAt(white, epdAfter("c4 Nf6"))!.edges[0]).toMatchObject({ san: "Nc3", priority: "secondary", lineIds: [VIA_NF6] });
  });

  it("orders edges by priority, then the first line's teaching order, then UCI", () => {
    // 2...Bc5 belongs to the first line in teaching order, but that line is secondary.
    expect(sans(nodeAt(white, epdAfter("c4 e5 Nc3"))!.edges)).toEqual(["Nc6", "Nf6", "Bc5"]);
    expect(sans(nodeAt(white, epdAfter("c4"))!.edges)).toEqual(["e5", "Nf6"]);
  });

  it("marks who moves: user edges at the user's nodes, opponent edges at the others", () => {
    for (const node of white.nodes.values()) {
      expect(node.userToMove).toBe(node.toMove === "white");
      for (const edge of node.edges) {
        expect(edge.mover).toBe(node.userToMove ? "user" : "opponent");
      }
    }
    const afterC4 = nodeAt(white, epdAfter("c4"))!;
    expect(afterC4).toMatchObject({ toMove: "black", userToMove: false });
  });

  it("takes minPly, pathSans and the FEN from the shortest route, ties to the first line", () => {
    const start = nodeAt(white, START_EPD)!;
    expect(start).toMatchObject({ minPly: 0, pathSans: [], fen: START_FEN });
    const merged = nodeAt(white, epdAfter("c4 e5 Nc3 Nf6"))!;
    expect(merged.minPly).toBe(4);
    expect(merged.pathSans).toEqual(["c4", "e5", "Nc3", "Nf6"]);
    expect(merged.fen).toBe(catalog.lineById.get(FOUR_KNIGHTS)!.moves[3].fenAfter);
    const end = nodeAt(white, epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O"))!;
    expect(end).toMatchObject({ minPly: 13, edges: [], lineIds: [FOUR_KNIGHTS] });
  });

  it("finds the shortest route when a line comes back to a position", () => {
    const dance = buildCatalog([], [customRecord("1.Nf3 Nf6 2.Ng1 Ng8 3.e4")]);
    const tree = buildTree(dance, "white", () => true);
    const start = nodeAt(tree, START_EPD)!;
    expect(start.minPly).toBe(0);
    expect(start.lineIds).toEqual(["knight-dance"]);
    // Same line, same priority and order: UCI decides (e2e4 before g1f3).
    expect(sans(start.edges)).toEqual(["e4", "Nf3"]);
    expect(tree.nodes.size).toBe(5);
    expect(positionItems(tree, dance).map((item) => item.expected.map((edge) => edge.san))).toEqual([["e4", "Nf3"], ["Ng1"]]);
    expect(linePositionKeys(dance.lineById.get("knight-dance")!)).toEqual([posKey("white", START_EPD), posKey("white", epdAfter("Nf3 Nf6"))]);
  });

  it("includes a line only when isEnabled says so", () => {
    const all = buildTree(catalog, "white", () => true);
    const node = nodeAt(all, epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6"))!;
    expect(sans(node.edges)).toEqual(["g3", "e3"]);
    expect(node.edges.map((edge) => edge.priority)).toEqual(["main", "sideline"]);
    expect(node.lineIds).toEqual([FOUR_KNIGHTS, "eng-e5-four-knights-e3", VIA_NF6]);

    const onlyClosed = buildTree(catalog, "white", (lineId) => lineId === "eng-e5-closed");
    expect([...onlyClosed.lineIds]).toEqual(["eng-e5-closed"]);
    expect(onlyClosed.nodes.size).toBe(12);
    expect(buildTree(catalog, "white", () => false).nodes.size).toBe(0);
  });

  it("builds each side from its own lines only", () => {
    expect([...black.lineIds]).toEqual(["scandi-qa5", "scandi-nf3-bg4"]);
    expect(nodeAt(black, START_EPD)).toMatchObject({ userToMove: false, edges: [expect.objectContaining({ san: "e4", mover: "opponent" })] });
    expect(sans(nodeAt(black, epdAfter("e4 d5 exd5 Qxd5"))!.edges)).toEqual(["Nc3", "Nf3"]);
    expect(nodeAt(black, epdAfter("c4"))).toBeUndefined();
  });
});

describe("move lookups", () => {
  it("returns the user's moves only where the user is to move", () => {
    expect(sans(userMovesAt(white, epdAfter("c4 e5")))).toEqual(["Nc3"]);
    expect(userMovesAt(white, epdAfter("c4"))).toEqual([]);
    expect(userMovesAt(white, epdAfter("d4"))).toEqual([]);
    expect(sans(userMovesAt(black, epdAfter("e4")))).toEqual(["d5"]);
  });

  it("returns the opponent replies the repertoire prepares for", () => {
    expect(sans(opponentRepliesAt(white, epdAfter("c4 e5 Nc3")))).toEqual(["Nc6", "Nf6", "Bc5"]);
    expect(opponentRepliesAt(white, epdAfter("c4 e5"))).toEqual([]);
    expect(opponentRepliesAt(white, epdAfter("e4"))).toEqual([]);
    expect(sans(opponentRepliesAt(black, START_EPD))).toEqual(["e4"]);
  });
});

describe("positionItems", () => {
  const items = positionItems(white, catalog);

  it("lists every position where the user has a repertoire move, main lines first", () => {
    expect(items.map((item) => item.pathSans.join(" "))).toEqual([
      "",
      "c4 e5",
      "c4 e5 Nc3 Nc6",
      "c4 e5 Nc3 Nc6 g3 g6",
      "c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7",
      "c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6",
      "c4 e5 Nc3 Nf6",
      "c4 e5 Nc3 Nf6 Nf3 Nc6",
      "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5",
      "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5",
      "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6",
      "c4 e5 Nc3 Bc5",
      "c4 e5 Nc3 Bc5 g3 Qf6",
      "c4 Nf6",
      "c4 Nf6 Nc3 e5 Nf3 Nc6 g3 Bb4",
      "c4 Nf6 Nc3 e5 Nf3 Nc6 g3 Bb4 Bg2 O-O"
    ]);
    expect(items.map((item) => item.priority)).toEqual([...Array(11).fill("main"), ...Array(5).fill("secondary")]);
  });

  it("fills each item from its node", () => {
    const start = items[0];
    expect(start).toMatchObject({ key: posKey("white", START_EPD), side: "white", epd: START_EPD, fen: START_FEN, minPly: 0, order: 0 });
    expect(sans(start.expected)).toEqual(["c4"]);
    const merged = items[7];
    expect(merged.epd).toBe(epdAfter("c4 Nf6 Nc3 e5 Nf3 Nc6"));
    expect(merged.lineIds).toEqual([FOUR_KNIGHTS, VIA_NF6]);
    expect(merged.order).toBe(catalog.lineById.get(FOUR_KNIGHTS)!.order);
    expect(merged.minPly).toBe(6);
    for (const item of items) {
      expect(item.expected.every((edge) => edge.mover === "user")).toBe(true);
      expect(item.key).toBe(posKey("white", item.epd));
    }
  });

  it("lists every user move of a position when enabled lines differ there", () => {
    const all = positionItems(buildTree(catalog, "white", () => true), catalog);
    const split = all.find((item) => item.epd === epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6"))!;
    expect(sans(split.expected)).toEqual(["g3", "e3"]);
    expect(split.lineIds).toEqual([FOUR_KNIGHTS, "eng-e5-four-knights-e3", VIA_NF6]);
    expect(split.priority).toBe("main");
    expect(all).toHaveLength(items.length);
  });

  it("works for Black: the positions after White's moves", () => {
    const blackItems = positionItems(black, catalog);
    expect(blackItems.map((item) => item.pathSans.join(" "))).toEqual(["e4", "e4 d5 exd5", "e4 d5 exd5 Qxd5 Nc3", "e4 d5 exd5 Qxd5 Nc3 Qa5 d4", "e4 d5 exd5 Qxd5 Nf3"]);
    expect(blackItems.every((item) => item.side === "black" && item.key.startsWith("black|"))).toBe(true);
  });

  it("is empty for an empty tree", () => {
    expect(positionItems(buildTree(catalog, "white", () => false), catalog)).toEqual([]);
  });
});

describe("linePositionKeys", () => {
  it("keys the position before each user move, in order", () => {
    const fourKnights = catalog.lineById.get(FOUR_KNIGHTS)!;
    const keys = linePositionKeys(fourKnights);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe(posKey("white", START_EPD));
    expect(keys).toEqual(fourKnights.userPlies.map((ply) => posKey("white", fourKnights.epds[ply - 1])));
  });

  it("shares keys across a transposition", () => {
    const viaNf6 = new Set(linePositionKeys(catalog.lineById.get(VIA_NF6)!));
    const shared = linePositionKeys(catalog.lineById.get(FOUR_KNIGHTS)!).filter((key) => viaNf6.has(key));
    expect(shared).toEqual([START_EPD, epdAfter("c4 e5 Nc3 Nf6"), epdAfter("c4 e5 Nc3 Nf6 Nf3 Nc6")].map((epd) => posKey("white", epd)));
  });

  it("uses Black's positions for a Black line", () => {
    expect(linePositionKeys(catalog.lineById.get("scandi-nf3-bg4")!)).toEqual(
      ["e4", "e4 d5 exd5", "e4 d5 exd5 Qxd5 Nf3"].map((line) => posKey("black", epdAfter(line)))
    );
  });
});

describe("walkTree", () => {
  const walk = (tree: RepertoireTree, line: string) => walkTree(tree, line ? replayMoves(line.split(" ")) : []);

  it("follows a whole line without a deviation", () => {
    expect(walkTree(white, catalog.lineById.get("eng-e5-closed")!.moves)).toEqual({ inRepertoireThrough: 11, deviation: null });
  });

  it("follows a game across lines after a transposition", () => {
    expect(walk(white, "c4 Nf6 Nc3 e5 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O")).toEqual({ inRepertoireThrough: 13, deviation: null });
  });

  it("reports an opponent move the repertoire does not cover", () => {
    const result = walk(white, "c4 c5 Nc3");
    expect(result.inRepertoireThrough).toBe(1);
    expect(result.deviation).toMatchObject({ ply: 2, by: "opponent" });
    expect(result.deviation!.played.san).toBe("c5");
    expect(sans(result.deviation!.expected)).toEqual(["e5", "Nf6"]);
  });

  it("reports a user move that is not the repertoire move", () => {
    const result = walk(white, "c4 e5 Nf3 Nc6");
    expect(result.inRepertoireThrough).toBe(2);
    expect(result.deviation).toMatchObject({ ply: 3, by: "user" });
    expect(result.deviation!.played.uci).toBe("g1f3");
    expect(sans(result.deviation!.expected)).toEqual(["Nc3"]);
  });

  it("reports the first move after the end of the repertoire with nothing expected", () => {
    const result = walk(white, "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7");
    expect(result.inRepertoireThrough).toBe(13);
    expect(result.deviation).toMatchObject({ ply: 14, by: "opponent", expected: [] });
  });

  it("does not follow a disabled line", () => {
    expect(walk(white, "c4 e5 Nc3 Nf6 Nf3 Nc6 e3").deviation).toMatchObject({ ply: 7, by: "user" });
    expect(walk(buildTree(catalog, "white", () => true), "c4 e5 Nc3 Nf6 Nf3 Nc6 e3")).toEqual({ inRepertoireThrough: 7, deviation: null });
  });

  it("handles no moves and an empty tree", () => {
    expect(walk(white, "")).toEqual({ inRepertoireThrough: 0, deviation: null });
    const empty = buildTree(catalog, "white", () => false);
    expect(walk(empty, "c4")).toMatchObject({ inRepertoireThrough: 0, deviation: { ply: 1, by: "user", expected: [] } });
  });

  it("walks Black's tree from White's first move", () => {
    expect(walk(black, "d4").deviation).toMatchObject({ ply: 1, by: "opponent" });
    expect(sans(walk(black, "d4").deviation!.expected)).toEqual(["e4"]);
    const userLeft = walk(black, "e4 e5");
    expect(userLeft.deviation).toMatchObject({ ply: 2, by: "user" });
    expect(sans(userLeft.deviation!.expected)).toEqual(["d5"]);
    expect(walk(black, "e4 d5 exd5 Qxd5 Nf3 Bg4").deviation).toBeNull();
  });
});

describe("comparePriority", () => {
  it("sorts main before secondary before sideline", () => {
    const priorities = ["sideline", "main", "secondary", "main"] as const;
    expect([...priorities].sort(comparePriority)).toEqual(["main", "main", "secondary", "sideline"]);
  });
});
