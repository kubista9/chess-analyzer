import { describe, expect, it } from "vitest";
import {
  IllegalMoveError,
  START_EPD,
  START_FEN,
  applyMove,
  checkedKingSquare,
  cleanSan,
  colorCode,
  fenAfter,
  fenOf,
  gameState,
  isPromotion,
  isValidFen,
  legalMoves,
  legalTargets,
  opposite,
  replayMoves,
  sanToUci,
  sideToMove,
  toEpd,
  uciToSan
} from "./position";

/** Both sides can castle either way; nothing else is on the board except the pawns. */
const CASTLING_FEN = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
/** A white pawn on e7 about to promote; the black king on f6 is a knight's jump from e8. */
const PROMOTION_FEN = "8/4P3/5k2/8/8/8/8/4K3 w - - 0 1";
/** As PROMOTION_FEN with a black rook on d8 to capture while promoting. */
const CAPTURE_PROMOTION_FEN = "3r4/4P3/5k2/8/8/8/8/4K3 w - - 0 1";

/** The last position of a SAN line from the start. */
const fenOfLine = (line: string) => fenAfter(line.split(" "));

describe("position keys", () => {
  it("drops the move clocks so transpositions share one EPD", () => {
    expect(START_EPD).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    expect(toEpd(START_FEN)).toBe(START_EPD);
    // 1.c4 e5 2.Nc3 Nf6 3.Nf3 Nc6 and 1.c4 Nf6 2.Nc3 e5 3.Nf3 Nc6 differ only in the halfmove clock.
    const viaE5 = fenOfLine("c4 e5 Nc3 Nf6 Nf3 Nc6");
    const viaNf6 = fenOfLine("c4 Nf6 Nc3 e5 Nf3 Nc6");
    expect(viaE5).not.toBe(viaNf6);
    expect(toEpd(viaE5)).toBe(toEpd(viaNf6));
  });

  it("rejects text that is not a FEN", () => {
    expect(() => toEpd("rnbqkbnr w")).toThrow(/Not a FEN/);
  });

  it("turns an EPD back into a full FEN and leaves a FEN alone", () => {
    expect(fenOf(START_EPD)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(fenOf(`  ${START_FEN}  `)).toBe(START_FEN);
  });

  it("reads the side to move from a FEN or an EPD", () => {
    expect(sideToMove(START_FEN)).toBe("white");
    expect(sideToMove(toEpd(fenOfLine("c4")))).toBe("black");
    expect(opposite("white")).toBe("black");
    expect(opposite("black")).toBe("white");
    expect(colorCode("white")).toBe("w");
    expect(colorCode("black")).toBe("b");
  });
});

describe("cleanSan", () => {
  it("strips annotation glyphs and move numbers", () => {
    expect(cleanSan("Nf3!?")).toBe("Nf3");
    expect(cleanSan("Bg2??")).toBe("Bg2");
    expect(cleanSan(" e4! ")).toBe("e4");
    expect(cleanSan("1.e4")).toBe("e4");
    expect(cleanSan("12.Nf3")).toBe("Nf3");
    expect(cleanSan("2...Nc6")).toBe("Nc6");
    expect(cleanSan("2..Nc6")).toBe("Nc6");
    expect(cleanSan("2…Nc6")).toBe("Nc6");
    expect(cleanSan("3. Nc3!")).toBe("Nc3");
  });

  it("keeps check marks, promotion pieces and castling with zeros", () => {
    expect(cleanSan("Qh4#")).toBe("Qh4#");
    expect(cleanSan("e8=Q+!")).toBe("e8=Q+");
    expect(cleanSan("0-0-0")).toBe("0-0-0");
  });
});

describe("applyMove", () => {
  it("plays SAN, UCI and {from, to} and returns everything about the move", () => {
    const expected = {
      from: "e2",
      to: "e4",
      uci: "e2e4",
      san: "e4",
      color: "white",
      piece: "p",
      captured: null,
      promotion: null,
      castle: null,
      check: false,
      checkmate: false,
      fenBefore: START_FEN,
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      epdBefore: START_EPD,
      epdAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
    };
    expect(applyMove(START_FEN, "e4")).toEqual(expected);
    expect(applyMove(START_FEN, "e2e4")).toEqual(expected);
    expect(applyMove(START_FEN, { from: "e2", to: "e4" })).toEqual(expected);
  });

  it("accepts an EPD as the position", () => {
    expect(applyMove(START_EPD, "Nf3")?.uci).toBe("g1f3");
  });

  it("reads SAN with annotation glyphs, move numbers and long-algebraic spellings", () => {
    expect(applyMove(START_FEN, "Nf3!?")?.san).toBe("Nf3");
    expect(applyMove(START_FEN, "1.c4!")?.san).toBe("c4");
    expect(applyMove(START_FEN, "Ng1f3")?.san).toBe("Nf3");
    const afterE4 = fenOfLine("e4");
    expect(applyMove(afterE4, "1...e5?!")?.san).toBe("e5");
    expect(applyMove(afterE4, "1…c5")?.san).toBe("c5");
  });

  it("returns null for an illegal or unparsable move", () => {
    expect(applyMove(START_FEN, "e5")).toBeNull();
    expect(applyMove(START_FEN, "Ke2")).toBeNull();
    expect(applyMove(START_FEN, "e2e5")).toBeNull();
    expect(applyMove(START_FEN, "O-O")).toBeNull();
    expect(applyMove(START_FEN, "hello")).toBeNull();
    expect(applyMove(START_FEN, "")).toBeNull();
    expect(applyMove(START_FEN, { from: "d1", to: "d3" })).toBeNull();
    expect(applyMove(START_FEN, { from: "z9", to: "e4" })).toBeNull();
  });

  it("returns null for a broken position", () => {
    expect(applyMove("not a fen", "e4")).toBeNull();
    expect(applyMove("8/8/8/8/8/8/8/8 w - - 0 1", "e4")).toBeNull();
  });

  it("flags captures with the captured piece", () => {
    const move = applyMove(fenOfLine("e4 d5"), "exd5");
    expect(move).toMatchObject({ san: "exd5", uci: "e4d5", piece: "p", captured: "p" });
  });
});

describe("castling", () => {
  it("castles short and long for White by SAN, UCI and {from, to}", () => {
    const short = applyMove(CASTLING_FEN, "O-O");
    expect(short).toMatchObject({ san: "O-O", uci: "e1g1", from: "e1", to: "g1", piece: "k", castle: "short" });
    expect(short?.fenAfter.split(" ")[0]).toBe("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1");
    expect(short?.epdAfter.split(" ")[2]).toBe("kq");

    const long = applyMove(CASTLING_FEN, "O-O-O");
    expect(long).toMatchObject({ san: "O-O-O", uci: "e1c1", castle: "long" });
    expect(long?.fenAfter.split(" ")[0]).toBe("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/2KR3R");

    expect(applyMove(CASTLING_FEN, "e1g1")?.castle).toBe("short");
    expect(applyMove(CASTLING_FEN, "e1c1")?.castle).toBe("long");
    expect(applyMove(CASTLING_FEN, { from: "e1", to: "g1" })?.san).toBe("O-O");
    expect(applyMove(CASTLING_FEN, "0-0")?.san).toBe("O-O");
    expect(applyMove(CASTLING_FEN, "0-0-0")?.san).toBe("O-O-O");
  });

  it("castles short and long for Black", () => {
    const blackToMove = CASTLING_FEN.replace(" w ", " b ");
    const short = applyMove(blackToMove, "O-O");
    expect(short).toMatchObject({ san: "O-O", uci: "e8g8", color: "black", castle: "short" });
    expect(short?.fenAfter.split(" ")[0]).toBe("r4rk1/pppppppp/8/8/8/8/PPPPPPPP/R3K2R");
    expect(short?.epdAfter.split(" ")[2]).toBe("KQ");
    const long = applyMove(blackToMove, "e8c8");
    expect(long).toMatchObject({ san: "O-O-O", castle: "long" });
    expect(long?.fenAfter.split(" ")[0]).toBe("2kr3r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R");
  });

  it("castles in a real opening and records the lost rights", () => {
    const moves = replayMoves("e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6".split(" "));
    expect(moves[6]).toMatchObject({ san: "O-O", castle: "short", color: "white" });
    expect(moves[6].epdAfter.split(" ")[2]).toBe("kq");
  });

  it("refuses to castle without the right, out of check or through an attacked square", () => {
    // The king has moved and come back: no rights left.
    expect(applyMove("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w kq - 0 1", "O-O")).toBeNull();
    // In check from the rook on e8 (the e-file is open).
    expect(applyMove("4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1", "O-O")).toBeNull();
    // f1 is attacked by the rook on f8, so the king cannot pass it; the long side is free.
    const throughCheck = "5rk1/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    expect(applyMove(throughCheck, "O-O")).toBeNull();
    expect(applyMove(throughCheck, "O-O-O")?.san).toBe("O-O-O");
    // A piece in the way.
    expect(applyMove(START_FEN, "e1g1")).toBeNull();
  });
});

describe("en passant", () => {
  it("keeps the en-passant square in the EPD only when the capture is legal", () => {
    // 1.e4: nothing can take on e3.
    expect(toEpd(fenOfLine("e4"))).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -");
    // 1.e4 a6 2.e5 d5: the e5 pawn can take on d6.
    const moves = replayMoves("e4 a6 e5 d5".split(" "));
    expect(moves[3].epdAfter).toBe("rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6");
    // A double step next to no enemy pawn leaves "-".
    expect(moves[1].epdAfter.endsWith(" w KQkq -")).toBe(true);
  });

  it("leaves the en-passant square out when the capture would expose the king", () => {
    // White king a5, pawn b5, black rook h5: bxc6 e.p. would open the fifth rank.
    const move = applyMove("4k3/2p5/8/KP5r/8/8/8/8 b - - 0 1", "c5");
    expect(move?.epdAfter).toBe("4k3/8/8/KPp4r/8/8/8/8 w - -");
    expect(applyMove(move!.fenAfter, "bxc6")).toBeNull();
  });

  it("captures en passant by SAN and UCI and removes the passed pawn", () => {
    const fen = fenOfLine("e4 a6 e5 d5");
    for (const input of ["exd6", "e5d6"]) {
      const move = applyMove(fen, input);
      expect(move).toMatchObject({ san: "exd6", uci: "e5d6", captured: "p", piece: "p" });
      expect(move?.fenAfter.split(" ")[0]).toBe("rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR");
    }
  });

  it("allows en passant only on the very next move", () => {
    const fen = fenOfLine("e4 a6 e5 d5 Nf3 h6");
    expect(toEpd(fen).endsWith(" -")).toBe(true);
    expect(applyMove(fen, "exd6")).toBeNull();
  });
});

describe("promotion", () => {
  it("promotes by SAN, UCI and {from, to, promotion}", () => {
    expect(applyMove(PROMOTION_FEN, "e8=Q")).toMatchObject({ san: "e8=Q", uci: "e7e8q", piece: "p", promotion: "q", check: false });
    expect(applyMove(PROMOTION_FEN, "e7e8q")?.san).toBe("e8=Q");
    expect(applyMove(PROMOTION_FEN, { from: "e7", to: "e8", promotion: "q" })?.uci).toBe("e7e8q");
  });

  it("underpromotes, with the check the new piece gives", () => {
    const knight = applyMove(PROMOTION_FEN, "e7e8n");
    expect(knight).toMatchObject({ san: "e8=N+", uci: "e7e8n", promotion: "n", check: true, checkmate: false });
    expect(knight?.fenAfter.split(" ")[0]).toBe("4N3/8/5k2/8/8/8/8/4K3");
    expect(applyMove(PROMOTION_FEN, { from: "e7", to: "e8", promotion: "r" })).toMatchObject({ san: "e8=R", promotion: "r" });
    expect(applyMove(PROMOTION_FEN, "e8=B")).toMatchObject({ uci: "e7e8b", promotion: "b" });
    expect(applyMove(PROMOTION_FEN, "e8=N+")?.uci).toBe("e7e8n");
  });

  it("promotes with a capture", () => {
    expect(applyMove(CAPTURE_PROMOTION_FEN, "exd8=Q+")).toMatchObject({ uci: "e7d8q", captured: "r", promotion: "q", check: true });
    expect(applyMove(CAPTURE_PROMOTION_FEN, "e7d8n")).toMatchObject({ san: "exd8=N", captured: "r" });
  });

  it("needs the piece: a promotion without one is not a move", () => {
    expect(applyMove(PROMOTION_FEN, "e7e8")).toBeNull();
    expect(applyMove(PROMOTION_FEN, { from: "e7", to: "e8" })).toBeNull();
    expect(applyMove(PROMOTION_FEN, "e8")).toBeNull();
    // chess.js alone would read these as a knight promotion.
    expect(applyMove(PROMOTION_FEN, "e7-e8")).toBeNull();
    expect(applyMove(PROMOTION_FEN, "e7e8k")).toBeNull();
    expect(applyMove(PROMOTION_FEN, "Pe7e8")).toBeNull();
    expect(applyMove(PROMOTION_FEN, { from: "e7", to: "e8", promotion: "k" })).toBeNull();
    expect(applyMove(PROMOTION_FEN, "e8=K")).toBeNull();
    // Long algebraic that names the piece is fine.
    expect(applyMove(PROMOTION_FEN, "e7e8=N")?.uci).toBe("e7e8n");
    expect(applyMove(PROMOTION_FEN, "e7-e8Q")?.uci).toBe("e7e8q");
  });

  it("ignores a promotion piece on a move that does not promote, as boards often send one", () => {
    expect(applyMove(START_FEN, { from: "e2", to: "e4", promotion: "q" })?.uci).toBe("e2e4");
  });

  it("tells the board when a move would promote", () => {
    expect(isPromotion(PROMOTION_FEN, "e7", "e8")).toBe(true);
    expect(isPromotion(CAPTURE_PROMOTION_FEN, "e7", "d8")).toBe(true);
    expect(isPromotion(PROMOTION_FEN, "e1", "e2")).toBe(false);
    expect(isPromotion(START_FEN, "e2", "e4")).toBe(false);
    expect(isPromotion("garbage", "e7", "e8")).toBe(false);
  });
});

describe("check and mate", () => {
  it("flags a check that is not mate", () => {
    const move = replayMoves("e4 e5 Bc4 Nc6 Bxf7+".split(" "))[4];
    expect(move).toMatchObject({ san: "Bxf7+", check: true, checkmate: false, captured: "p" });
    expect(checkedKingSquare(move.fenAfter)).toBe("e8");
  });

  it("flags mate", () => {
    const moves = replayMoves("f3 e5 g4 Qh4#".split(" "));
    expect(moves[3]).toMatchObject({ san: "Qh4#", check: true, checkmate: true, color: "black" });
    expect(checkedKingSquare(moves[3].fenAfter)).toBe("e1");
    expect(gameState(moves[3].fenAfter)).toBe("checkmate");
  });

  it("does not trust a check mark the move does not deserve", () => {
    // chess.js reads "Nf3+" as Nf3; the canonical SAN has no check mark.
    expect(applyMove(START_FEN, "Nf3+")).toMatchObject({ san: "Nf3", check: false });
  });

  it("reports no checked king when nobody is in check or the FEN is broken", () => {
    expect(checkedKingSquare(START_FEN)).toBeNull();
    expect(checkedKingSquare("nonsense")).toBeNull();
  });
});

describe("replayMoves", () => {
  it("replays SAN and UCI from the start or a given position", () => {
    const moves = replayMoves(["c4", "e7e5", "Nc3", "Nf6!"]);
    expect(moves.map((move) => move.san)).toEqual(["c4", "e5", "Nc3", "Nf6"]);
    expect(moves.map((move) => move.color)).toEqual(["white", "black", "white", "black"]);
    // Each move starts where the previous one ended.
    for (let index = 1; index < moves.length; index += 1) {
      expect(moves[index].fenBefore).toBe(moves[index - 1].fenAfter);
    }
    expect(replayMoves(["O-O"], CASTLING_FEN)[0].castle).toBe("short");
    expect(replayMoves([])).toEqual([]);
  });

  it("throws IllegalMoveError with the 0-based index of the first illegal move", () => {
    let error: unknown;
    try {
      replayMoves(["c4", "e5", "Nc3", "Nf9", "Nf6"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IllegalMoveError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "IllegalMoveError", index: 3, move: "Nf9" });
    expect((error as Error).message).toContain('Move 4 ("Nf9") is not legal');
  });

  it("rejects a move after mate and a move for the wrong side", () => {
    expect(() => replayMoves(["f3", "e5", "g4", "Qh4#", "a3"])).toThrow(IllegalMoveError);
    expect(() => replayMoves(["e4", "d4"])).toThrow(expect.objectContaining({ index: 1 }));
    expect(() => replayMoves(["e5"])).toThrow(expect.objectContaining({ index: 0, move: "e5" }));
  });
});

describe("move lists and conversions", () => {
  it("lists every legal move with mate flags", () => {
    expect(legalMoves(START_FEN)).toHaveLength(20);
    expect(legalMoves("broken")).toEqual([]);
    const mates = legalMoves(fenOfLine("f3 e5 g4")).filter((move) => move.checkmate);
    expect(mates.map((move) => move.san)).toEqual(["Qh4#"]);
  });

  it("lists legal target squares for one piece", () => {
    expect(legalTargets(START_FEN, "g1").sort()).toEqual(["f3", "h3"]);
    expect(legalTargets(START_FEN, "e4")).toEqual([]);
    expect(legalTargets(START_FEN, "e8")).toEqual([]);
    expect(legalTargets(CASTLING_FEN, "e1").sort()).toEqual(["c1", "d1", "f1", "g1"]);
    expect(legalTargets("broken", "e2")).toEqual([]);
  });

  it("converts between UCI and SAN in a position", () => {
    expect(uciToSan(START_FEN, "g1f3")).toBe("Nf3");
    expect(uciToSan(START_FEN, "g1g3")).toBeNull();
    expect(sanToUci(START_FEN, "Nf3")).toBe("g1f3");
    expect(sanToUci(START_FEN, "Nf6")).toBeNull();
    expect(sanToUci(PROMOTION_FEN, "e8=N+")).toBe("e7e8n");
  });

  it("gives the position after a list of moves", () => {
    expect(fenAfter([])).toBe(START_FEN);
    expect(fenAfter([], START_EPD)).toBe(START_FEN);
    expect(fenAfter(["e4", "e5"])).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    expect(() => fenAfter(["e4", "e4"])).toThrow(IllegalMoveError);
  });
});

describe("validity and game state", () => {
  it("validates FENs with chess.js", () => {
    expect(isValidFen(START_FEN)).toBe(true);
    expect(isValidFen(START_EPD)).toBe(true);
    expect(isValidFen("garbage")).toBe(false);
    expect(isValidFen("4k3/8/8/8/8/8/8/K3K3 w - - 0 1")).toBe(false);
    expect(isValidFen("4k3/8/8/8/8/8/8/P3K3 w - - 0 1")).toBe(false);
  });

  it("knows checkmate, stalemate and draws", () => {
    expect(gameState(START_FEN)).toBeNull();
    expect(gameState("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).toBe("stalemate");
    expect(gameState("8/8/8/4k3/8/8/8/4K3 w - - 0 1")).toBe("draw");
    expect(gameState("broken")).toBeNull();
  });
});
