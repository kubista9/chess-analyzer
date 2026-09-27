import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { toEpd } from "../../shared/epd.js";
import { bookChildren } from "../../shared/openingBook.js";
import { loadOpeningBook } from "./openingBook.js";

// The vendored lichess-org/chess-openings TSVs at c67912be58 (data/chess-openings/SOURCE.md).
const book = loadOpeningBook();

function epdAt(line: string): string {
  const chess = new Chess();
  for (const san of line.split(" ")) {
    chess.move(san);
  }
  return toEpd(chess.fen());
}

const nameOf = (line: string) => {
  const hit = book.named.get(epdAt(line));
  return hit && `${hit.eco} ${hit.name}`;
};

describe("the vendored opening book", () => {
  it("has the pinned dataset's size", () => {
    expect(book.rows).toBe(3815);
    expect(book.positions.size).toBe(7864);
    expect(book.named.size).toBe(3815);
  });

  it("names the owner's main lines", () => {
    expect(nameOf("e4 d5 exd5 Qxd5 Nc3 Qa5")).toBe("B01 Scandinavian Defense: Main Line");
    expect(nameOf("d4 d5 c4 e5")).toBe("D08 Queen's Gambit Declined: Albin Countergambit");
    expect(nameOf("e4 e5 Nf3 Bc5")).toBe("C40 King's Pawn Game: Busch-Gass Gambit");
    expect(nameOf("d4 d5 Bf4")).toBe("D00 Queen's Pawn Game: Accelerated London System");
    expect(nameOf("c4 c5")).toBe("A30 English Opening: Symmetrical Variation");
  });

  it("finds a name by position, whatever the move order", () => {
    // The Albin position reached by 1.c4 e5 2.d4 d5 is still the Albin.
    expect(nameOf("c4 e5 d4 d5")).toBe("D08 Queen's Gambit Declined: Albin Countergambit");
  });

  it("names unsound lines too (book membership is not soundness)", () => {
    expect(nameOf("e4 e5 Nf3 f5")).toMatch(/Latvian Gambit/);
    expect(nameOf("e4 e5 Nf3 f6")).toMatch(/Damiano Defense/);
  });

  it("lists the book replies to 1.e4", () => {
    const replies = bookChildren(book, epdAt("e4")).map((move) => move.san);
    expect(replies).toEqual(expect.arrayContaining(["e5", "c5", "e6", "c6", "d5", "Nf6", "d6", "g6"]));
  });
});
