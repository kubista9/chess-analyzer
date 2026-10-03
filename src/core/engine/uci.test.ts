import { describe, expect, it } from "vitest";
import { START_FEN } from "../chess/position";
import {
  MultiPvCollector,
  PV_MAX_MOVES,
  goCommand,
  parseBestMove,
  parseIdName,
  parseInfoLine,
  parseNodes,
  positionCommand,
  setOptionCommand,
  toEngineLine
} from "./uci";

// Engine output recorded from Stockfish (the 1.c4 lines and the stopped search from the vendored
// Stockfish 19 Lite WASM build run under Node; the others from the previous native-engine fixtures).

/** 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6, White to move, MultiPV 3, depth 12 (Stockfish 19 Lite WASM). */
const C4_QF6_MPV3 = `info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))
info depth 1 seldepth 6 multipv 1 score cp 97 nodes 131 nps 4225 hashfull 0 time 31 pv c3e4
info depth 1 seldepth 2 multipv 2 score cp 49 nodes 131 nps 4093 hashfull 0 time 32 pv g1f3
info depth 1 seldepth 2 multipv 3 score cp 33 nodes 131 nps 4093 hashfull 0 time 32 pv e2e3
info depth 11 seldepth 14 multipv 1 score cp 83 nodes 57899 nps 95700 hashfull 17 time 605 pv g1f3 g8e7 f1g2 d7d6 b2b4 c5b6
info depth 11 seldepth 17 multipv 2 score cp 82 nodes 57899 nps 95700 hashfull 17 time 605 pv e2e3 d7d6 f1g2 b8c6 g1e2
info depth 11 seldepth 21 multipv 3 score cp 52 nodes 57899 nps 95700 hashfull 17 time 605 pv f2f4 d7d6 g1f3 b8c6 f1g2 f6g6 c3d5 c5b6 f4e5 d6e5 d2d4
info depth 12 seldepth 18 multipv 1 score cp 91 nodes 95255 nps 90203 hashfull 36 time 1056 pv e2e3 g8e7 f1g2 e8g8 g1e2 d7d6 d2d4 c5b4 e1g1 c7c6 a2a3 b4c3 e2c3
info depth 12 seldepth 15 multipv 2 score cp 87 nodes 95255 nps 90118 hashfull 36 time 1057 pv g1f3 g8e7 f1g2 d7d6 b2b4 c5b6 e1g1 e8g8 a2a4 a7a5 b4b5 c7c6
info depth 12 seldepth 18 multipv 3 score cp 60 nodes 95255 nps 90033 hashfull 36 time 1058 pv f2f4 d7d6 g1f3 b8c6 f1g2 g8h6 a2a3 a7a5 c3d5 f6d8 f4e5 d6e5 d2d4
bestmove e2e3 ponder g8e7`;

/** The same position, "go depth 12 searchmoves f1g2": 4.Bg2 allows mate in one. */
const C4_BG2_SEARCHMOVES = `info depth 1 seldepth 8 multipv 1 score mate -1 nodes 11 nps 3666 hashfull 0 time 3 pv f1g2 f6f2
info depth 12 seldepth 3 multipv 1 score mate -1 nodes 33 nps 8250 hashfull 0 time 4 pv f1g2 f6f2
bestmove f1g2 ponder f6f2`;

/** Start position, MultiPV 2, stopped inside depth 15: rank 2 is only an upperbound line. */
const STOPPED_MPV2 = `info depth 14 seldepth 21 multipv 1 score cp 34 nodes 62285 nps 514752 hashfull 26 time 121 pv d2d4 d7d5 c2c4 e7e6 g1f3 f8e7
info depth 14 seldepth 21 multipv 2 score cp 32 nodes 62285 nps 514752 hashfull 26 time 121 pv e2e4 c7c5 b1c3 b8c6 g1f3 e7e5
info depth 15 seldepth 25 multipv 1 score cp 29 nodes 160996 nps 506276 hashfull 66 time 318 pv d2d4 d7d5 g1f3 e7e6 c2c4 g8f6
info depth 15 seldepth 25 multipv 2 score cp 28 upperbound nodes 160996 nps 506276 hashfull 66 time 318 pv e2e4 e7e5
bestmove d2d4 ponder d7d5`;

/** 1.d4 d5 2.c4 e5, MultiPV 3: depth 13 has fail-high and fail-low lines that repeat moves across ranks. */
const BOUNDS_MPV3 = `info depth 12 seldepth 16 multipv 1 score cp 70 nodes 120000 pv d4e5 d5d4 g1f3
info depth 12 seldepth 15 multipv 2 score cp 41 nodes 120000 pv c4d5 e5d4 g1f3
info depth 12 seldepth 16 multipv 3 score cp 35 nodes 120000 pv b1c3 e5d4 d1d4
info depth 13 seldepth 17 multipv 1 score cp 95 lowerbound nodes 150000 pv d4e5
info depth 13 seldepth 17 multipv 2 score cp 90 lowerbound nodes 160000 pv d4e5
info depth 13 seldepth 17 multipv 3 score cp 10 upperbound nodes 170000 pv c4d5
info depth 13 seldepth 18 multipv 1 score cp 81 nodes 190000 pv d4e5 d5d4 g1f3 b8c6 a2a3
info depth 13 seldepth 17 multipv 2 score cp 44 nodes 190000 pv b1c3 e5d4 d1d4 g8f6
info depth 13 seldepth 18 multipv 3 score cp 38 nodes 190000 pv c4d5 e5d4 g1f3 c7c5
bestmove d4e5 ponder d5d4`;

/** 1.d4 d5 2.Bf4, MultiPV 3: depth 15 repeats e7e6 on ranks 2 and 3, so depth 14 is the last clean iteration. */
const DUPLICATE_RANKS = `info depth 14 multipv 1 score cp 21 nodes 260000 pv c7c5 e2e3 b8c6
info depth 14 multipv 2 score cp 14 nodes 260000 pv e7e6 e2e3 c7c5
info depth 14 multipv 3 score cp 12 nodes 260000 pv c8f5 e2e3 e7e6
info depth 15 multipv 1 score cp 19 nodes 330000 pv c7c5 e2e3 b8c6 c2c3
info depth 15 multipv 2 score cp 16 nodes 330000 pv e7e6 e2e3 c7c5
info depth 15 multipv 3 score cp 16 nodes 330000 pv e7e6 e2e3 c7c5
bestmove e7e6 ponder e2e3`;

/**
 * Scandinavian, MultiPV 3: depth 16 completes, the search is stopped inside depth 17 after rank 1,
 * and the ranks not re-searched are printed again with the previous depth's label.
 */
const STOP_PRINT_LEFTOVERS = `info depth 15 multipv 1 score cp -80 nodes 301000 pv d5d6 d2d4 g8f6
info depth 15 multipv 2 score cp -82 nodes 301000 pv d5a5 d2d4 g8f6
info depth 15 multipv 3 score cp -84 nodes 301000 pv d5d8 d2d4 c7c6
info depth 16 multipv 1 score cp -70 upperbound nodes 355000 pv d5d6 d2d4
info depth 16 multipv 1 score cp -70 nodes 402000 pv d5d6 d2d4 g8f6 g1f3
info depth 16 multipv 2 score cp -74 nodes 402000 pv d5d8 d2d4 c7c6 g1f3
info depth 16 multipv 3 score cp -81 nodes 402000 pv d5a5 d2d4 g8f6 g1f3
info depth 17 multipv 1 score cp -72 nodes 500000 pv d5d8 d2d4 c7c6 g1f3
info depth 16 multipv 2 score cp -70 nodes 500000 pv d5d6 d2d4 g8f6 g1f3
info depth 16 multipv 3 score cp -81 nodes 500000 pv d5a5 d2d4 g8f6 g1f3
bestmove d5d8 ponder d2d4`;

/** 1.f3 e5 2.g4, Black to move: mate in one (Qh4#). Stockfish labels the last iteration depth 245. */
const MATE_IN_ONE = `info depth 1 seldepth 2 multipv 1 score mate 1 nodes 30 pv d8h4
info depth 245 seldepth 2 multipv 1 score mate 1 nodes 900 pv d8h4
bestmove d8h4`;

/** A checkmated position (Stockfish 19 Lite WASM): no pv at all. */
const CHECKMATED = `info depth 0 score mate 0
bestmove (none)`;

function collect(transcript: string, expectedRanks: number) {
  const collector = new MultiPvCollector(expectedRanks);
  for (const line of transcript.split("\n")) {
    collector.push(line);
  }
  return collector.result();
}

describe("parseInfoLine", () => {
  it("reads depth, rank, score, bound, nodes and pv", () => {
    expect(parseInfoLine("info depth 16 seldepth 22 multipv 2 score cp -74 nodes 402000 nps 581000 time 692 pv d5d8 d2d4")).toEqual({
      depth: 16,
      multipv: 2,
      cp: -74,
      mate: null,
      bound: null,
      nodes: 402000,
      pv: ["d5d8", "d2d4"]
    });
  });

  it("marks lowerbound and upperbound lines", () => {
    expect(parseInfoLine("info depth 13 multipv 1 score cp 95 lowerbound nodes 1 pv d4e5")?.bound).toBe("lower");
    expect(parseInfoLine("info depth 13 multipv 3 score cp 10 upperbound nodes 1 pv c4d5")?.bound).toBe("upper");
    expect(parseInfoLine("info depth 15 seldepth 25 multipv 2 score cp 28 upperbound nodes 160996 pv e2e4 e7e5")?.bound).toBe("upper");
  });

  it("keeps mate scores apart from centipawns, with their sign", () => {
    expect(parseInfoLine("info depth 3 score mate -2 pv e1e2")).toMatchObject({ multipv: 1, cp: null, mate: -2 });
    expect(parseInfoLine("info depth 12 seldepth 3 multipv 1 score mate -1 nodes 33 pv f1g2 f6f2")).toMatchObject({
      cp: null,
      mate: -1,
      pv: ["f1g2", "f6f2"]
    });
    expect(parseInfoLine("info depth 245 seldepth 2 multipv 1 score mate 1 nodes 900 pv d8h4")).toMatchObject({ depth: 245, mate: 1 });
  });

  it("ignores lines without a pv or a score, and other output", () => {
    expect(parseInfoLine("info depth 0 score mate 0")).toBeNull();
    expect(parseInfoLine("info string NNUE evaluation using nn-61e7af4bb97d.nnue")).toBeNull();
    expect(parseInfoLine("info depth 12 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("info depth 5 score cp 20 pv")).toBeNull();
    expect(parseInfoLine("info depth x score cp 20 pv e2e4")).toBeNull();
    expect(parseInfoLine("info depth 5 score wdl 20 pv e2e4")).toBeNull();
    expect(parseInfoLine("bestmove e2e4")).toBeNull();
    expect(parseInfoLine("")).toBeNull();
  });

  it("defaults a missing or invalid multipv to rank 1", () => {
    expect(parseInfoLine("info depth 5 score cp 20 pv e2e4")?.multipv).toBe(1);
    expect(parseInfoLine("info depth 5 multipv 0 score cp 20 pv e2e4")?.multipv).toBe(1);
  });
});

describe("parseNodes", () => {
  it("reads nodes from any info line, bound lines included", () => {
    expect(parseNodes("info depth 13 multipv 1 score cp 95 lowerbound nodes 150000 pv d4e5")).toBe(150000);
    expect(parseNodes("info depth 0 score mate 0")).toBeNull();
    expect(parseNodes("bestmove e2e4")).toBeNull();
  });
});

describe("toEngineLine", () => {
  it("adds the side to move's win% and cuts the pv", () => {
    const line = toEngineLine({ depth: 20, multipv: 1, cp: 0, mate: null, bound: null, nodes: 1, pv: Array.from({ length: 14 }, () => "e2e4") });
    expect(line.winPct).toBe(50);
    expect(line.pv).toHaveLength(PV_MAX_MOVES);
  });
});

describe("MultiPvCollector", () => {
  it("returns the deepest iteration of a real Stockfish 19 search", () => {
    const result = collect(C4_QF6_MPV3, 3);
    expect(result).toMatchObject({ depth: 12, complete: true, nodes: 95255 });
    expect(result.lines.map((line) => [line.uci, line.cp, line.depth])).toEqual([
      ["e2e3", 91, 12],
      ["g1f3", 87, 12],
      ["f2f4", 60, 12]
    ]);
  });

  it("scores a searchmoves follow-up that allows mate as a mate against the side to move", () => {
    const result = collect(C4_BG2_SEARCHMOVES, 1);
    expect(result.lines).toEqual([{ uci: "f1g2", cp: null, mate: -1, winPct: expect.any(Number), depth: 12, pv: ["f1g2", "f6f2"] }]);
    expect(result.lines[0].winPct).toBeCloseTo(2.46, 2);
  });

  it("skips lowerbound and upperbound lines", () => {
    const result = collect(BOUNDS_MPV3, 3);
    expect(result).toMatchObject({ depth: 13, complete: true });
    expect(result.lines.map((line) => [line.uci, line.cp])).toEqual([
      ["d4e5", 81],
      ["b1c3", 44],
      ["c4d5", 38]
    ]);
  });

  it("falls back to the last complete iteration when a stop leaves only a bound line on a rank", () => {
    const result = collect(STOPPED_MPV2, 2);
    expect(result).toMatchObject({ depth: 14, complete: true });
    expect(result.lines.map((line) => line.uci)).toEqual(["d2d4", "e2e4"]);
  });

  it("ignores the stop-print leftovers of an unfinished iteration", () => {
    const result = collect(STOP_PRINT_LEFTOVERS, 3);
    expect(result).toMatchObject({ depth: 16, complete: true, nodes: 500000 });
    expect(result.lines.map((line) => [line.uci, line.cp])).toEqual([
      ["d5d6", -70],
      ["d5d8", -74],
      ["d5a5", -81]
    ]);
  });

  it("never reports one move on two ranks", () => {
    const result = collect(DUPLICATE_RANKS, 3);
    expect(result).toMatchObject({ depth: 14, complete: true });
    expect(result.lines.map((line) => line.uci)).toEqual(["c7c5", "e7e6", "c8f5"]);
  });

  it("keeps a mate for the side to move", () => {
    const result = collect(MATE_IN_ONE, 1);
    expect(result.lines).toEqual([{ uci: "d8h4", cp: null, mate: 1, winPct: expect.any(Number), depth: 245, pv: ["d8h4"] }]);
    expect(result.lines[0].winPct).toBeCloseTo(97.54, 2);
  });

  it("completes with fewer ranks than MultiPV when the position has fewer moves", () => {
    const collector = new MultiPvCollector(2);
    collector.push("info depth 10 multipv 1 score cp -25 nodes 14000 pv e8f8 d1d8");
    collector.push("info depth 10 multipv 2 score cp -380 nodes 14000 pv e8e7 d1d8");
    expect(collector.result()).toMatchObject({ depth: 10, complete: true, lines: [{ uci: "e8f8" }, { uci: "e8e7" }] });
  });

  it("ignores ranks above the expected count", () => {
    const collector = new MultiPvCollector(1);
    collector.push("info depth 8 multipv 1 score cp 10 nodes 10 pv e2e4");
    collector.push("info depth 8 multipv 2 score cp 5 nodes 10 pv d2d4");
    expect(collector.result().lines.map((line) => line.uci)).toEqual(["e2e4"]);
  });

  it("falls back to the deepest partial iteration, deduped, when none completed", () => {
    const collector = new MultiPvCollector(3);
    collector.push("info depth 5 multipv 1 score cp 10 nodes 100 pv e2e4 e7e5");
    collector.push("info depth 5 multipv 2 score cp 10 nodes 100 pv e2e4 c7c5");
    expect(collector.result()).toMatchObject({ depth: 5, complete: false, lines: [{ uci: "e2e4" }] });
  });

  it("returns no lines for a checkmated position", () => {
    expect(collect(CHECKMATED, 1)).toEqual({ lines: [], depth: 0, complete: false, nodes: 0 });
  });

  it("rejects a rank count that is not a positive integer", () => {
    expect(() => new MultiPvCollector(0)).toThrow(/positive integer/);
    expect(() => new MultiPvCollector(1.5)).toThrow(/positive integer/);
  });
});

describe("positionCommand", () => {
  it("uses startpos for the start position and the full FEN otherwise", () => {
    expect(positionCommand(START_FEN)).toBe("position startpos");
    expect(positionCommand("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -")).toBe("position startpos");
    expect(positionCommand("rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq e6 0 2")).toBe(
      "position fen rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq e6 0 2"
    );
  });

  it("completes an EPD with clocks and normalises whitespace", () => {
    expect(positionCommand("  rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR   w KQkq - ")).toBe(
      "position fen rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq - 0 1"
    );
  });

  it("keeps the start placement with other clocks as a FEN", () => {
    expect(positionCommand("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3")).toBe(
      "position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3"
    );
  });

  it("refuses text that could carry a second command", () => {
    expect(() => positionCommand("8/8/8/8/8/8/8/8 w - - 0 1\ngo infinite")).toThrow(/Not a FEN/);
    expect(() => positionCommand("not a fen")).toThrow(/Not a FEN/);
    expect(() => positionCommand("")).toThrow(/Not a FEN/);
  });
});

describe("goCommand", () => {
  it("writes depth, movetime and searchmoves in that order", () => {
    expect(goCommand({ depth: 14, movetimeMs: 800, searchMoves: ["e2e4", "d2d4"] })).toBe("go depth 14 movetime 800 searchmoves e2e4 d2d4");
    expect(goCommand({ depth: 18 })).toBe("go depth 18");
    expect(goCommand({ movetimeMs: 800 })).toBe("go movetime 800");
    expect(goCommand({ depth: 12, searchMoves: ["e7e8q"] })).toBe("go depth 12 searchmoves e7e8q");
  });

  it("leaves out an empty searchmoves list and rounds the movetime", () => {
    expect(goCommand({ depth: 10, searchMoves: [] })).toBe("go depth 10");
    expect(goCommand({ movetimeMs: 0.4 })).toBe("go movetime 1");
    expect(goCommand({ movetimeMs: 799.6 })).toBe("go movetime 800");
  });

  it("refuses a search without a limit or with malformed values", () => {
    expect(() => goCommand({})).toThrow(/depth or a movetime/);
    expect(() => goCommand({ depth: 0 })).toThrow(/positive integer/);
    expect(() => goCommand({ depth: 2.5 })).toThrow(/positive integer/);
    expect(() => goCommand({ movetimeMs: -1 })).toThrow(/positive number/);
    expect(() => goCommand({ movetimeMs: Number.NaN })).toThrow(/positive number/);
    expect(() => goCommand({ depth: 10, searchMoves: ["Nf3"] })).toThrow(/Not a UCI move/);
    expect(() => goCommand({ depth: 10, searchMoves: ["e2e4\nquit"] })).toThrow(/Not a UCI move/);
  });
});

describe("setOptionCommand", () => {
  it("writes an option and refuses line breaks", () => {
    expect(setOptionCommand("MultiPV", 3)).toBe("setoption name MultiPV value 3");
    expect(setOptionCommand("Hash", "16")).toBe("setoption name Hash value 16");
    expect(() => setOptionCommand("Hash", "16\nquit")).toThrow(/line break/);
  });
});

describe("parseBestMove", () => {
  it("reads the best move and the ponder move", () => {
    expect(parseBestMove("bestmove e2e3 ponder g8e7")).toEqual({ best: "e2e3", ponder: "g8e7" });
    expect(parseBestMove("bestmove d8h4")).toEqual({ best: "d8h4", ponder: null });
    expect(parseBestMove("bestmove e7e8q ponder a2a1n\r")).toEqual({ best: "e7e8q", ponder: "a2a1n" });
  });

  it("gives best null when there is no legal move", () => {
    expect(parseBestMove("bestmove (none)")).toEqual({ best: null, ponder: null });
    expect(parseBestMove("bestmove 0000")).toEqual({ best: null, ponder: null });
    expect(parseBestMove("bestmove")).toEqual({ best: null, ponder: null });
  });

  it("returns null for any other line", () => {
    expect(parseBestMove("info depth 1 score cp 10 pv e2e4")).toBeNull();
    expect(parseBestMove("bestmoves e2e4")).toBeNull();
    expect(parseBestMove("readyok")).toBeNull();
  });
});

describe("parseIdName", () => {
  it("reads the engine name", () => {
    expect(parseIdName("id name Stockfish 19 Lite WASM")).toBe("Stockfish 19 Lite WASM");
    expect(parseIdName("id author the Stockfish developers")).toBeNull();
    expect(parseIdName("uciok")).toBeNull();
  });
});
