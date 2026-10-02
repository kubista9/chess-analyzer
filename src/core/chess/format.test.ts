import { describe, expect, it } from "vitest";
import { bareSan, formatLine, moveLabel, moveNumber, parseMovetext, pathKey } from "./format";
import { replayMoves } from "./position";

describe("move labels", () => {
  it("numbers White's moves with one dot and Black's with three", () => {
    expect(moveLabel(1, "c4")).toBe("1.c4");
    expect(moveLabel(2, "e5")).toBe("1...e5");
    expect(moveLabel(5, "Nc3")).toBe("3.Nc3");
    expect(moveLabel(6, "Qa5")).toBe("3...Qa5");
  });

  it("maps plies to move numbers", () => {
    expect([1, 2, 3, 4, 19, 20].map(moveNumber)).toEqual([1, 1, 2, 2, 10, 10]);
  });
});

describe("formatLine", () => {
  it("writes a line from the start with move numbers", () => {
    expect(formatLine(["c4", "e5", "Nc3", "Nf6", "g3"])).toBe("1.c4 e5 2.Nc3 Nf6 3.g3");
    expect(formatLine([])).toBe("");
  });

  it("starts a line on Black's move with three dots", () => {
    expect(formatLine(["Nc6", "g3", "g6"], 4)).toBe("2...Nc6 3.g3 g6");
    expect(formatLine(["Nc3"], 3)).toBe("2.Nc3");
  });

  it("round-trips through parseMovetext", () => {
    const sans = ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"];
    expect(parseMovetext(formatLine(sans))).toEqual(sans);
  });
});

describe("parseMovetext", () => {
  it("reads compact and spaced move numbers", () => {
    expect(parseMovetext("1.c4 e5 2.Nc3 Nf6")).toEqual(["c4", "e5", "Nc3", "Nf6"]);
    expect(parseMovetext("1. c4 e5 2. Nc3 Nf6")).toEqual(["c4", "e5", "Nc3", "Nf6"]);
    expect(parseMovetext("1.c4\ne5\n\t2.Nc3")).toEqual(["c4", "e5", "Nc3"]);
  });

  it("reads lines that start on Black's move", () => {
    expect(parseMovetext("1...e5 2.Nf3")).toEqual(["e5", "Nf3"]);
    expect(parseMovetext("2... Nc6 3. g3")).toEqual(["Nc6", "g3"]);
    expect(parseMovetext("1…e5 2.Nf3")).toEqual(["e5", "Nf3"]);
  });

  it("drops comments, NAGs, glyphs and the result", () => {
    expect(parseMovetext("1.c4 {the English} e5 ; a rest-of-line comment\n2.Nc3! Nf6?! 3.g3 $1 d5 1-0")).toEqual([
      "c4",
      "e5",
      "Nc3",
      "Nf6",
      "g3",
      "d5"
    ]);
    expect(parseMovetext("1.e4 e5 *")).toEqual(["e4", "e5"]);
    expect(parseMovetext("1.e4 e5 0-1")).toEqual(["e4", "e5"]);
    expect(parseMovetext("1.e4 e5 1/2-1/2")).toEqual(["e4", "e5"]);
    expect(parseMovetext("1.e4 !? e5")).toEqual(["e4", "e5"]);
  });

  it("skips variations, nested ones included", () => {
    expect(parseMovetext("1.c4 e5 (1...c5 2.Nf3 (2.g3 g6) Nc6) 2.Nc3 (2.g3) Nf6")).toEqual(["c4", "e5", "Nc3", "Nf6"]);
    // A stray closing bracket does not swallow the rest.
    expect(parseMovetext("1.c4 ) e5")).toEqual(["c4", "e5"]);
  });

  it("keeps check marks, castling and promotion, and drops an e.p. suffix", () => {
    expect(parseMovetext("1.e4 e5 2.Bc4 Nc6 3.Bxf7+ Kxf7")).toEqual(["e4", "e5", "Bc4", "Nc6", "Bxf7+", "Kxf7"]);
    expect(parseMovetext("12.O-O O-O-O 13.exd6 e.p. b1=Q+")).toEqual(["O-O", "O-O-O", "exd6", "b1=Q+"]);
  });

  it("returns nothing for empty or number-only text", () => {
    expect(parseMovetext("")).toEqual([]);
    expect(parseMovetext("  1.  2.  ")).toEqual([]);
    expect(parseMovetext("{only a comment}")).toEqual([]);
  });

  it("does not check legality: replayMoves does", () => {
    const tokens = parseMovetext("1.c4 e5 2.Ke3");
    expect(tokens).toEqual(["c4", "e5", "Ke3"]);
    expect(() => replayMoves(tokens)).toThrow(/Move 3/);
  });
});

describe("pathKey and bareSan", () => {
  it("joins the SAN of a path without numbers", () => {
    expect(pathKey("1.c4 e5 2.Nc3")).toBe("c4 e5 Nc3");
    expect(pathKey("1. c4 e5 2. Nc3!")).toBe("c4 e5 Nc3");
    expect(pathKey(["c4", "e5"])).toBe("c4 e5");
    expect(pathKey("")).toBe("");
  });

  it("strips check marks and glyphs for comparing typed moves", () => {
    expect(bareSan("Nf3+")).toBe("Nf3");
    expect(bareSan("Qh4#")).toBe("Qh4");
    expect(bareSan("e8=Q+!")).toBe("e8=Q");
    expect(bareSan("O-O+")).toBe("O-O");
    expect(bareSan("2...Nc6")).toBe("Nc6");
    expect(bareSan("Nc3")).toBe("Nc3");
  });
});
