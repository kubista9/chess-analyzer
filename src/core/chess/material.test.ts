import { describe, expect, it } from "vitest";
import { PIECE_VALUES, materialState } from "./material";
import { START_FEN, START_EPD, fenAfter } from "./position";

describe("materialState", () => {
  it("is level at the start", () => {
    expect(materialState(START_FEN)).toEqual({ capturedByWhite: [], capturedByBlack: [], balance: 0 });
    expect(materialState(START_EPD)).toEqual({ capturedByWhite: [], capturedByBlack: [], balance: 0 });
  });

  it("counts a captured pawn and the recapture", () => {
    expect(materialState(fenAfter("e4 d5 exd5".split(" ")))).toEqual({ capturedByWhite: ["p"], capturedByBlack: [], balance: 1 });
    expect(materialState(fenAfter("e4 d5 exd5 Qxd5".split(" ")))).toEqual({ capturedByWhite: ["p"], capturedByBlack: ["p"], balance: 0 });
  });

  it("lists captured pieces most valuable first (bishop before knight on a tie)", () => {
    // Black is missing the queen, a knight, a bishop and a pawn; White is missing a rook.
    const fen = "r3kb1r/ppp1pppp/2n5/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1";
    expect(materialState(fen)).toEqual({
      capturedByWhite: ["q", "b", "n", "p"],
      capturedByBlack: ["r"],
      // White 9 + 5 + 6 + 6 + 8 = 34; Black 10 + 3 + 3 + 7 = 23.
      balance: 11
    });
  });

  it("counts a promotion from the board, so the promoted pawn is not called captured", () => {
    // White has two queens and seven pawns: one pawn promoted.
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNQ w Qkq - 0 1";
    const state = materialState(fen);
    expect(state.capturedByBlack).toEqual(["r"]);
    expect(state.capturedByWhite).toEqual([]);
    // White: 2q + r + 2b + 2n + 7p = 18 + 5 + 6 + 6 + 7 = 42; Black: 39.
    expect(state.balance).toBe(3);
  });

  it("handles an underpromotion the same way", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNN w Qkq - 0 1";
    // White: q + r + 2b + 3n + 7p = 9 + 5 + 6 + 9 + 7 = 36; Black: 39.
    expect(materialState(fen)).toEqual({ capturedByWhite: [], capturedByBlack: ["r"], balance: -3 });
  });

  it("cannot tell a promotion from a capture once the extra piece is gone", () => {
    // White lost its queen and promoted a pawn to a new one: the board shows one queen and a missing pawn.
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(materialState(fen)).toEqual({ capturedByWhite: [], capturedByBlack: ["p"], balance: -1 });
  });

  it("works on a bare-kings ending and returns a level state for a broken FEN", () => {
    expect(materialState("8/8/8/4k3/8/8/8/4K3 w - - 0 1")).toEqual({
      capturedByWhite: ["q", "r", "r", "b", "b", "n", "n", "p", "p", "p", "p", "p", "p", "p", "p"],
      capturedByBlack: ["q", "r", "r", "b", "b", "n", "n", "p", "p", "p", "p", "p", "p", "p", "p"],
      balance: 0
    });
    expect(materialState("broken")).toEqual({ capturedByWhite: [], capturedByBlack: [], balance: 0 });
  });

  it("uses the usual piece values in pawns", () => {
    expect(PIECE_VALUES).toEqual({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 });
  });
});
