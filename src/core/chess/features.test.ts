import { describe, expect, it } from "vitest";
import { IDEAS } from "../content/schema";
import { describeMove, guessIdea, pieceName, squareRegion, type MoveFeatures } from "./features";
import { applyMove, replayMoves } from "./position";

/** Features of the last move of a SAN line from the start, with the earlier moves as history. */
function lastMove(line: string): MoveFeatures {
  const moves = replayMoves(line.split(" "));
  return describeMove(moves[moves.length - 1], moves.slice(0, -1));
}

describe("names and regions", () => {
  it("names every piece", () => {
    expect((["p", "n", "b", "r", "q", "k"] as const).map(pieceName)).toEqual(["pawn", "knight", "bishop", "rook", "queen", "king"]);
  });

  it("splits the board into queenside a-c, centre d-e and kingside f-h", () => {
    expect(["a1", "b5", "c4", "d4", "e5", "f3", "g7", "h8"].map(squareRegion)).toEqual([
      "queenside",
      "queenside",
      "queenside",
      "centre",
      "centre",
      "kingside",
      "kingside",
      "kingside"
    ]);
  });
});

describe("describeMove", () => {
  it("describes 1.c4 as a central pawn move (a c-pawn on ranks 3-6 counts as centre)", () => {
    expect(lastMove("c4")).toEqual({
      piece: "p",
      pieceName: "pawn",
      from: "c2",
      to: "c4",
      region: "centre",
      isCapture: false,
      isCheck: false,
      castle: null,
      isPawnMove: true,
      isCentralPawnMove: true,
      isDevelopingMove: false,
      isFianchetto: false,
      isQueenMove: false,
      isKingMove: false,
      isRecapture: false,
      isRepeatMove: false,
      attacks: []
    });
  });

  it("uses the target square's region for pieces, so a knight on c3 is queenside", () => {
    expect(lastMove("c4 e5 Nc3")).toMatchObject({ region: "queenside", isDevelopingMove: true, isCentralPawnMove: false });
    expect(lastMove("Nf3")).toMatchObject({ region: "kingside", isDevelopingMove: true });
    expect(lastMove("c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6 d3 Be7 Nf3 O-O O-O Nc6 Rb1 Re8 Bd2")).toMatchObject({ region: "centre" });
  });

  it("counts f- and c-pawn moves on ranks 3-6 as central, but not a- or h-pawn moves", () => {
    expect(lastMove("f4")).toMatchObject({ isCentralPawnMove: true, region: "centre" });
    expect(lastMove("e4 c6")).toMatchObject({ isCentralPawnMove: true, region: "centre", from: "c7", to: "c6" });
    expect(lastMove("h4")).toMatchObject({ isCentralPawnMove: false, region: "kingside" });
    expect(lastMove("a3")).toMatchObject({ isCentralPawnMove: false, region: "queenside" });
  });

  it("recognises fianchettos by pawn and by bishop", () => {
    expect(lastMove("g3").isFianchetto).toBe(true);
    expect(lastMove("e4 b6").isFianchetto).toBe(true);
    expect(lastMove("g4").isFianchetto).toBe(false);
    const bishop = lastMove("g3 d5 Bg2");
    expect(bishop).toMatchObject({ isFianchetto: true, isDevelopingMove: true, piece: "b", region: "kingside" });
  });

  it("describes castling on both sides", () => {
    expect(lastMove("Nf3 d5 g3 Nf6 Bg2 e6 O-O")).toMatchObject({ castle: "short", region: "kingside", isKingMove: true, attacks: [] });
    expect(lastMove("d4 d5 Nc3 Nc6 Bf4 Bf5 Qd2 Qd7 O-O-O")).toMatchObject({ castle: "long", region: "queenside" });
    expect(lastMove("e4 e5 Nf3 Nf6 Be2 Be7 O-O O-O")).toMatchObject({ castle: "short", from: "e8", to: "g8" });
  });

  it("flags queen and king moves, captures and checks", () => {
    expect(lastMove("e4 e5 Qh5")).toMatchObject({ isQueenMove: true, piece: "q" });
    expect(lastMove("e4 e5 Ke2")).toMatchObject({ isKingMove: true, castle: null });
    expect(lastMove("e4 e5 Bc4 Nc6 Bxf7+")).toMatchObject({ isCapture: true, isCheck: true, attacks: ["king on e8", "knight on g8"] });
  });

  it("calls a capture on the square the previous move captured on a recapture", () => {
    expect(lastMove("c4 d5 cxd5 Qxd5").isRecapture).toBe(true);
    expect(lastMove("e4 d5 exd5 Nf6 c4 c6 dxc6 Nxc6").isRecapture).toBe(true);
    // The previous move was not a capture: Nxd5 just wins the pawn back later.
    expect(lastMove("c4 d5 cxd5 Nf6 Nc3 Nxd5").isRecapture).toBe(false);
    // A capture elsewhere is not a recapture.
    expect(lastMove("e4 d5 exd5 e5 dxe6").isRecapture).toBe(false);
  });

  it("tracks a piece through the history to spot repeat moves", () => {
    expect(lastMove("e4 e5 Nf3 Nc6 Ng5")).toMatchObject({ isRepeatMove: true, isDevelopingMove: false });
    expect(lastMove("e4 e5 Nf3 Nc6 Nc3").isRepeatMove).toBe(false);
    // Only the mover's own history counts.
    expect(lastMove("e4 d5 exd5 Qxd5").isRepeatMove).toBe(false);
  });

  it("does not count a knight that went home and comes out again as developing", () => {
    const again = lastMove("Nf3 Nf6 Ng1 Ng8 Nf3");
    expect(again).toMatchObject({ isDevelopingMove: false, isRepeatMove: true, from: "g1" });
    expect(lastMove("Nf3").isDevelopingMove).toBe(true);
  });

  it("lists the opponent pieces (not pawns) the moved piece attacks, sorted", () => {
    // 4.h3 hits the bishop on g4.
    expect(lastMove("e4 e5 Nf3 d6 d4 Bg4 h3").attacks).toEqual(["bishop on g4"]);
    // 2.e5 hits the knight on f6.
    expect(lastMove("e4 Nf6 e5").attacks).toEqual(["knight on f6"]);
    // A fork: the knight on c7 attacks the king's rook on a8 and the king on e8.
    const fork = lastMove("e4 e5 Nc3 Nf6 Nb5 Nxe4 Nxc7+");
    expect(fork.attacks).toEqual(["king on e8", "rook on a8"]);
    // Pawns are left out.
    expect(lastMove("e4 e5 Nf3").attacks).toEqual([]);
  });

  it("describes a promotion as a pawn move with the new piece's attacks", () => {
    const move = applyMove("8/4P3/5k2/8/8/8/8/4K3 w - - 0 1", "e8=N+")!;
    expect(describeMove(move, [])).toMatchObject({ piece: "p", isPawnMove: true, isCheck: true, attacks: ["king on f6"] });
  });
});

describe("guessIdea", () => {
  it("maps the features to one idea", () => {
    expect(guessIdea(lastMove("Nf3 d5 g3 Nf6 Bg2 e6 O-O"))).toBe("king-safety");
    expect(guessIdea(lastMove("c4 d5 cxd5 Qxd5"))).toBe("recapture");
    expect(guessIdea(lastMove("Nf3"))).toBe("development");
    expect(guessIdea(lastMove("g3"))).toBe("development");
    expect(guessIdea(lastMove("c4"))).toBe("centre");
    expect(guessIdea(lastMove("e4 e5 Nf3 d6 d4 Bg4 h3"))).toBe("tempo");
    expect(guessIdea(lastMove("a4"))).toBe("flank");
    expect(guessIdea(lastMove("e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 Re1"))).toBe("activity");
  });

  it("prefers recapture over centre and development for a move that takes back", () => {
    // exd5 is a central pawn move too; winning the material back is the clearer idea.
    const pawn = lastMove("d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5");
    expect(pawn).toMatchObject({ isCentralPawnMove: true, isRecapture: true });
    expect(guessIdea(pawn)).toBe("recapture");
    // 4...Nxc6 also develops the knight for the first time.
    const knight = lastMove("e4 d5 exd5 Nf6 c4 c6 dxc6 Nxc6");
    expect(knight).toMatchObject({ isDevelopingMove: true, isRecapture: true });
    expect(guessIdea(knight)).toBe("recapture");
  });

  it("does not call a capture that attacks a piece a tempo move", () => {
    // 4.Nxc6 hits the queen on d8, but taking material is the point of a capture.
    const capture = lastMove("e4 e5 Nf3 Nf6 Nxe5 Nc6 Nxc6");
    expect(capture.attacks.length).toBeGreaterThan(0);
    expect(guessIdea(capture)).not.toBe("tempo");
  });

  it("always returns a known idea", () => {
    const lines = ["e4", "e4 e5 Qh5", "e4 e5 Ke2", "e4 e5 Bc4 Nc6 Bxf7+", "h4 e5 Rh3"];
    for (const line of lines) {
      expect(IDEAS).toContain(guessIdea(lastMove(line)));
    }
  });
});
