import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_EPD } from "../../shared/epd.js";
import { buildTree, type TreeGame } from "../../shared/openingTree.js";
import { replayOpening } from "../../shared/pgn.js";
import { openDatabase } from "../db/connection.js";
import { colorView, editEntry, loadRepertoire, repertoirePgn } from "./repertoireService.js";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;
let nextId = 1;
function games(line: string, count: number): TreeGame[] {
  const sans = line.split(" ");
  return Array.from({ length: count }, () => {
    nextId += 1;
    return {
      id: `g${nextId}`,
      endTime: NOW - 86_400 - nextId,
      color: "black" as const,
      score: 1 as const,
      myRating: 1200,
      oppRating: 1200,
      baseMs: 180_000,
      plyCount: 60,
      plies: replayOpening(sans, sans.length).map((ply) => ({ ...ply, spentMs: 1000 }))
    };
  });
}
const epdAfter = (line: string) => {
  const sans = line.split(" ");
  return replayOpening(sans, sans.length).at(-1)!.epdAfter;
};

describe("repertoire service", () => {
  it("walks the lines from the start and exports them as PGN with variations", () => {
    const db = openDatabase(":memory:");
    const all = [...games("e4 d5 exd5 Qxd5 Nc3 Qa5", 4), ...games("e4 d5 e5 c5", 3), ...games("d4 d5 c4 e6", 3)];
    const tree = buildTree(all, { color: "black", now: NOW, halfLifeDays: null });
    for (const [line, san, ply] of [
      ["e4", "d5", 2],
      ["e4 d5 exd5", "Qxd5", 4],
      ["e4 d5 exd5 Qxd5 Nc3", "Qa5", 6],
      ["e4 d5 e5", "c5", 4],
      ["d4", "d5", 2]
    ] as const) {
      editEntry(db, "kubista9", { color: "black", epd: epdAfter(line), san, ply }, 1000);
    }
    const view = colorView(tree, all, loadRepertoire(db, "kubista9").black, null, { now: NOW, halfLifeDays: null });
    expect(view.nodes[0]).toMatchObject({ epd: START_EPD, ownerToMove: false, children: [{ san: "e4", n: 7 }, { san: "d4", n: 3 }] });
    const afterD4d5 = view.nodes.find((node) => node.epd === epdAfter("d4 d5"))!;
    expect(afterD4d5.children.map((child) => child.san)).toEqual(["c4"]);
    // 1.d4 d5 2.c4 has no entry yet: a leaf with the owner's options.
    const leaf = view.nodes.find((node) => node.epd === epdAfter("d4 d5 c4"))!;
    expect(leaf).toMatchObject({ entry: null, children: [], options: [{ san: "e6", n: 3 }] });
    expect(view.unprepared.map((row) => row.opp.san)).toEqual(["c4"]);

    const pgn = repertoirePgn(view, "kubista9", new Date(NOW * 1000));
    expect(pgn).toContain('[Black "kubista9"]');
    expect(pgn.split("\n\n")[1].trim().replaceAll("\n", " ")).toBe(
      "1. e4 (1. d4 d5 {edited} 2. c4) 1... d5 {edited} 2. exd5 (2. e5 c5 {edited}) 2... Qxd5 {edited} 3. Nc3 Qa5 {edited} *"
    );
    // chess.js reads it (the main line).
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"]);
  });

  it("keeps an entry's lock, status and note apart from its move", () => {
    const db = openDatabase(":memory:");
    const epd = epdAfter("e4");
    const first = editEntry(db, "kubista9", { color: "black", epd, san: "d5", ply: 2 }, 1000);
    expect(first).toMatchObject({ source: "edited", locked: true, replaced: null });
    const unlocked = editEntry(db, "kubista9", { color: "black", epd, locked: false, note: "  main line " }, 2000);
    expect(unlocked).toMatchObject({ san: "d5", locked: false, note: "main line", updatedAt: 2000 });
    const changed = editEntry(db, "kubista9", { color: "black", epd, uci: "e7e5" }, 3000);
    expect(changed).toMatchObject({ san: "e5", locked: true, note: "main line", replaced: { san: "d5" }, ply: 2 });
    expect(() => editEntry(db, "kubista9", { color: "black", epd: epdAfter("d4"), san: "d5" }, 4000)).toThrow(/needs its ply/);
  });
});
