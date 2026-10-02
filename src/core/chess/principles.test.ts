import { describe, expect, it } from "vitest";
import { START_FEN, fenAfter, replayMoves } from "./position";
import { OPENING_PLIES, developmentState, principleNotes, type PrincipleId } from "./principles";

/** Principle ids for the last move of a SAN line from the start. */
function idsFor(line: string): PrincipleId[] {
  const moves = replayMoves(line.split(" "));
  return principleNotes(moves[moves.length - 1], moves.slice(0, -1)).map((note) => note.id);
}

describe("developmentState", () => {
  it("starts with nothing developed", () => {
    expect(developmentState(START_FEN, "white")).toEqual({ minorsDeveloped: 0, castled: false, kingMoved: false });
    expect(developmentState(START_FEN, "black")).toEqual({ minorsDeveloped: 0, castled: false, kingMoved: false });
  });

  it("counts developed knights and bishops and a castled king", () => {
    const fen = fenAfter("Nf3 Nf6 g3 g6 Bg2 Bg7 O-O".split(" "));
    expect(developmentState(fen, "white")).toEqual({ minorsDeveloped: 2, castled: true, kingMoved: false });
    expect(developmentState(fen, "black")).toEqual({ minorsDeveloped: 2, castled: false, kingMoved: false });
  });

  it("sees a long castle, and a king that walked instead of castling", () => {
    const long = fenAfter("d4 d5 Nc3 Nc6 Bf4 Bf5 Qd2 Qd7 O-O-O".split(" "));
    expect(developmentState(long, "white")).toMatchObject({ minorsDeveloped: 2, castled: true, kingMoved: false });
    const walked = fenAfter("e4 e5 Ke2".split(" "));
    expect(developmentState(walked, "white")).toEqual({ minorsDeveloped: 0, castled: false, kingMoved: true });
  });

  it("does not count a minor piece that went home again", () => {
    expect(developmentState(fenAfter("Nf3 Nf6 Ng1".split(" ")), "white").minorsDeveloped).toBe(0);
  });

  it("returns an empty state for a broken FEN", () => {
    expect(developmentState("broken", "white")).toEqual({ minorsDeveloped: 0, castled: false, kingMoved: false });
  });
});

describe("principleNotes", () => {
  it("has nothing to say about sound opening moves", () => {
    for (const line of ["c4", "c4 e5 Nc3", "c4 e5 Nc3 Nf6 g3", "e4 e5 Nf3 Nc6 Bb5", "Nf3 d5 g3 Nf6 Bg2 e6 O-O", "e4 d5 exd5 Qxd5"]) {
      expect(idsFor(line), line).toEqual([]);
    }
  });

  it("warns about an early queen without a reason", () => {
    expect(idsFor("e4 e5 Qh5")).toEqual(["early-queen"]);
    expect(idsFor("e4 e5 Qh5 Nc6 Qf3")).toEqual(["early-queen"]);
    // A capture is a concrete reason (the Scandinavian recapture).
    expect(idsFor("e4 d5 exd5 Qxd5")).toEqual([]);
    // So is a check.
    expect(idsFor("e4 e5 Qh5 Nc6 Qxf7+")).toEqual([]);
  });

  it("warns about moving the same minor piece twice, unless forced", () => {
    expect(idsFor("e4 e5 Nf3 Nc6 Ng5")).toEqual(["same-piece-twice"]);
    // Moving an attacked piece away is a reason: 3...a6 hits the bishop on b5.
    expect(idsFor("e4 e5 Nf3 Nc6 Bb5 a6 Ba4")).toEqual([]);
    // Taking something is a reason too.
    expect(idsFor("e4 e5 Nf3 Nc6 Bb5 Nf6 Bxc6")).toEqual([]);
  });

  it("warns when the king walks instead of castling", () => {
    expect(idsFor("e4 e5 Ke2")).toEqual(["king-moved"]);
    expect(idsFor("e4 e5 Nf3 Nc6 Bc4 Nf6 Kf1")).toEqual(["king-moved"]);
  });

  it("warns when a rook move gives up castling on that side", () => {
    expect(idsFor("h4 e5 Rh3")).toEqual(["castling-rights-lost"]);
    // After castling, a rook move is fine.
    expect(idsFor("Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 Re1")).toEqual([]);
  });

  it("warns about an edge pawn move before development", () => {
    expect(idsFor("a4")).toEqual(["flank-pawn"]);
    expect(idsFor("e4 h5")).toEqual(["flank-pawn"]);
    expect(idsFor("h4")).toEqual(["flank-pawn"]);
    // With two minor pieces out, an edge pawn move can be a plan.
    expect(idsFor("Nf3 Nf6 g3 g6 Bg2 Bg7 a4")).toEqual([]);
  });

  it("warns about neglecting development after several moves", () => {
    expect(idsFor("a3 e5 h3 d5 a4 Nf6 h4 Nc6 b4")).toEqual(["neglects-development"]);
    // Early in the game it says nothing yet.
    expect(idsFor("a3 e5 b4")).toEqual([]);
  });

  it("warns when a pawn move loosens the castled king's shelter", () => {
    expect(idsFor("Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 h3")).toEqual(["king-shelter"]);
    expect(idsFor("Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 g4")).toEqual(["king-shelter"]);
    // A queenside pawn move does not touch the shelter.
    expect(idsFor("Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 c4")).toEqual([]);
  });

  it("warns when a minor piece blocks an unmoved centre pawn", () => {
    expect(idsFor("e4 e5 Bd3")).toEqual(["blocks-own-piece"]);
    expect(idsFor("e4 e6 d4 Bd6")).toEqual(["blocks-own-piece"]);
    // Once the d-pawn has moved, d3/d6 blocks nothing.
    expect(idsFor("d4 d5 c4 e6 Nc3 Bd6")).toEqual([]);
    expect(idsFor("d4 d5 e3 e6 Bd3")).toEqual([]);
  });

  it("gives several notes in a fixed order", () => {
    expect(idsFor("a3 e5 h3 d5 a4 Nf6 h4 Nc6 e3 Be7 Ke2")).toEqual(["king-moved", "neglects-development"]);
  });

  it("writes short second-person sentences", () => {
    const moves = replayMoves("e4 e5 Qh5".split(" "));
    const [note] = principleNotes(moves[2], moves.slice(0, 2));
    expect(note.text).toMatch(/^[A-Z].*\.$/);
    expect(note.text).not.toMatch(/!/);
  });

  it("stays quiet once the opening is over", () => {
    const moves = replayMoves("e4 e5 Ke2".split(" "));
    // Only the history's length matters here (the king move is judged on its own position).
    const longHistory = Array.from({ length: OPENING_PLIES }, () => moves[1]);
    expect(principleNotes(moves[2], longHistory)).toEqual([]);
    expect(principleNotes(moves[2], longHistory.slice(1)).map((note) => note.id)).toEqual(["king-moved"]);
  });
});
