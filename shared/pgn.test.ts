import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { gameId, loadOwnerGames } from "../test/loadFixtures.js";
import { START_EPD, START_FEN, toEpd } from "./epd.js";
import { parseClock, parsePgnHeaders, parsePgnMoves, parseTimeControl, replayOpening, spentSeconds } from "./pgn.js";

const owner = new Map(loadOwnerGames().map((raw) => [gameId(raw), raw]));

describe("toEpd", () => {
  it("keeps the first four FEN fields", () => {
    expect(toEpd(START_FEN)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    expect(START_EPD).toBe(toEpd(START_FEN));
    expect(() => toEpd("8/8/8 w")).toThrow();
  });
});

describe("parsePgnHeaders", () => {
  it("reads the Chess.com headers", () => {
    const headers = parsePgnHeaders(owner.get("184405952510")!.pgn);
    expect(headers).toMatchObject({ White: "fernando787", Black: "kubista9", TimeControl: "180" });
    expect(headers.ECO).toMatch(/^B0\d$/);
    expect(headers.Termination).toContain("won");
  });

  it("unescapes quotes and stops at the movetext", () => {
    expect(parsePgnHeaders('[Event "A \\"quoted\\" event"]\n\n1. e4 [not a header] *')).toEqual({ Event: 'A "quoted" event' });
  });
});

describe("parseTimeControl", () => {
  it("parses base and increment", () => {
    expect(parseTimeControl("180")).toEqual({ base: 180, inc: 0 });
    expect(parseTimeControl("180+2")).toEqual({ base: 180, inc: 2 });
    expect(parseTimeControl("600")).toEqual({ base: 600, inc: 0 });
  });

  it("gives null for daily and unknown controls", () => {
    expect(parseTimeControl("1/86400")).toBeNull();
    expect(parseTimeControl("-")).toBeNull();
    expect(parseTimeControl(undefined)).toBeNull();
  });
});

describe("parseClock", () => {
  it("reads h:mm:ss with tenths", () => {
    expect(parseClock("0:02:58.9")).toBeCloseTo(178.9);
    expect(parseClock("1:00:00")).toBe(3600);
    expect(parseClock("nope")).toBeNull();
  });
});

describe("parsePgnMoves", () => {
  it("matches chess.js on every real game, SAN for SAN", () => {
    for (const raw of owner.values()) {
      const chess = new Chess();
      chess.loadPgn(raw.pgn);
      expect(parsePgnMoves(raw.pgn).map((move) => move.san)).toEqual(chess.history());
    }
  });

  it("attaches each %clk to the move before it", () => {
    const moves = parsePgnMoves(owner.get("184405952510")!.pgn);
    expect(moves.every((move) => move.clockSec !== null)).toBe(true);
    expect(moves[0].clockSec).toBeLessThanOrEqual(180);
  });

  it("skips comments, variations, NAGs, move numbers and the result", () => {
    const pgn = '[Event "x"]\n\n1. e4 {[%clk 0:02:59.5]} 1... e5 $1 (1... c5 {sicilian} 2. Nf3) 2. Nf3! ; rest\n2... Nc6 1-0';
    expect(parsePgnMoves(pgn)).toEqual([
      { san: "e4", clockSec: 179.5 },
      { san: "e5", clockSec: null },
      { san: "Nf3", clockSec: null },
      { san: "Nc6", clockSec: null }
    ]);
  });
});

describe("spentSeconds", () => {
  it("starts each side from the base time", () => {
    expect(spentSeconds([178.9, 178.6, 177.7, 175], { base: 180, inc: 0 })).toEqual([1.1, 1.4, 1.2, 3.6]);
  });

  it("adds the increment back", () => {
    // 180+2: White thinks 3 s (180 - 3 + 2 = 179), then 5 s (179 - 5 + 2 = 176).
    expect(spentSeconds([179, 181, 176, 170], { base: 180, inc: 2 })).toEqual([3, 1, 5, 13]);
  });

  it("floors at 0 and propagates missing clocks as null", () => {
    expect(spentSeconds([180.5, null, 179, 175], { base: 180, inc: 0 })).toEqual([0, null, 1.5, null]);
    expect(spentSeconds([170, 170], null)).toEqual([null, null]);
  });
});

describe("replayOpening", () => {
  it("starts at the standard position and chains EPDs", () => {
    const sans = parsePgnMoves(owner.get("184405952510")!.pgn).map((move) => move.san);
    const plies = replayOpening(sans, 30);
    expect(plies).toHaveLength(30);
    expect(plies[0].epdBefore).toBe(START_EPD);
    expect(plies.slice(0, 6).map((ply) => ply.uci)).toEqual(["e2e4", "d7d5", "e4d5", "d8d5", "b1c3", "d5a5"]);
    for (let index = 1; index < plies.length; index += 1) {
      expect(plies[index].epdBefore).toBe(plies[index - 1].epdAfter);
    }
  });

  it("stops at the game's end when it is shorter than the limit", () => {
    expect(replayOpening(["f3", "e5", "g4", "Qh4#"], 30).map((ply) => ply.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
  });

  it("writes the en-passant square only when the capture is legal", () => {
    // 1.e4 (no black pawn can take on e3) vs 1.e4 d5 2.e5 f5 (exf6 is legal).
    expect(replayOpening(["e4"], 1)[0].epdAfter.endsWith(" -")).toBe(true);
    expect(replayOpening(["e4", "d5", "e5", "f5"], 4)[3].epdAfter.endsWith(" f6")).toBe(true);
  });

  it("throws on an illegal move", () => {
    expect(() => replayOpening(["e4", "e4"], 30)).toThrow();
  });
});
