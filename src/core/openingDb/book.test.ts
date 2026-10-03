import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_EPD, toEpd } from "../chess/position";
import { bookChildren, bookExit, bookNameAt, bookSans, buildBook, loadBookFromTsv, mainstreamChildren, nameAt, openingFamily, parseBookTsv } from "./book";
import { createBookLoader, getOpeningBook } from "./loadBook";

const MINI_TSV = [
  "eco\tname\tpgn",
  "B01\tScandinavian Defense\t1. e4 d5",
  "B01\tScandinavian Defense: Main Line\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5",
  "C00\tFrench Defense\t1. e4 e6",
  "B00\tTest Line: En Passant\t1. e4 a6 2. e5 d5",
  // A longer line that ends on the same position as the shorter row after it.
  "A04\tTest Line: The Long Way\t1. Nf3 Nf6 2. Ng1 Ng8 3. e4 e5",
  "C20\tKing's Pawn Game\t1. e4 e5",
  ""
].join("\n");

/** The EPD after each SAN move from the start. */
function epdsAfter(line: string): string[] {
  const chess = new Chess();
  return line.split(" ").map((san) => {
    chess.move(san);
    return toEpd(chess.fen());
  });
}
const epdAt = (line: string) => epdsAfter(line).at(-1)!;

describe("parsing the TSVs", () => {
  it("reads eco/name/pgn rows and rejects a wrong header or a broken row", () => {
    const rows = parseBookTsv(MINI_TSV);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({ eco: "B01", name: "Scandinavian Defense: Main Line", pgn: "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5" });
    expect(() => parseBookTsv("eco\tpgn\n")).toThrow(/header/);
    expect(() => parseBookTsv("eco\tname\tpgn\nB01\tno pgn")).toThrow(/row 2/);
  });

  it("strips move numbers from a book pgn", () => {
    expect(bookSans("1. e4 d5 2. exd5 Qxd5")).toEqual(["e4", "d5", "exd5", "Qxd5"]);
  });
});

describe("buildBook on a mini TSV", () => {
  const book = buildBook(parseBookTsv(MINI_TSV));

  it("indexes every position on every line, the start included", () => {
    expect(book.rows).toBe(6);
    expect(book.positions.has(START_EPD)).toBe(true);
    for (const epd of epdsAfter("e4 d5 exd5 Qxd5 Nc3 Qa5")) {
      expect(book.positions.has(epd)).toBe(true);
    }
    expect(book.positions.has(epdAt("d4"))).toBe(false);
  });

  it("names the position a line ends on, by EPD", () => {
    expect(book.named.get(epdAt("e4 d5 exd5 Qxd5 Nc3 Qa5"))).toEqual({
      eco: "B01",
      name: "Scandinavian Defense: Main Line",
      plies: 6
    });
    expect(book.named.has(epdAt("e4 d5 exd5"))).toBe(false);
  });

  it("keeps the shortest line when two lines end on one position", () => {
    expect(book.named.get(epdAt("e4 e5"))).toEqual({ eco: "C20", name: "King's Pawn Game", plies: 2 });
  });

  it("keys en passant only when the capture is legal", () => {
    const epd = epdAt("e4 a6 e5 d5");
    expect(epd.endsWith(" w KQkq d6")).toBe(true);
    expect(book.named.get(epd)?.name).toBe("Test Line: En Passant");
    // After 1.e4 the e3 square is not capturable, so the EPD has "-".
    expect(epdAt("e4").endsWith(" b KQkq -")).toBe(true);
    expect(book.positions.has(epdAt("e4"))).toBe(true);
  });

  it("lists book children with SAN, UCI and target EPD, once per move", () => {
    const afterE4 = bookChildren(book, epdAt("e4"));
    expect(afterE4.map((move) => move.san)).toEqual(["d5", "e6", "a6", "e5"]);
    expect(afterE4[0]).toEqual({ san: "d5", uci: "d7d5", toEpd: epdAt("e4 d5") });
    expect(bookChildren(book, START_EPD).map((move) => move.uci)).toEqual(["e2e4", "g1f3"]);
    expect(bookChildren(book, epdAt("e4 d5 exd5 Qxd5 Nc3 Qa5"))).toEqual([]);
  });

  it("counts the lines through each position", () => {
    expect(book.lineCount.get(START_EPD)).toBe(6);
    expect(book.lineCount.get(epdAt("e4"))).toBe(6);
    expect(book.lineCount.get(epdAt("e4 d5"))).toBe(2);
    expect(book.lineCount.get(epdAt("e4 e5"))).toBe(2);
  });

  it("throws on an illegal book move", () => {
    expect(() => buildBook([{ eco: "X00", name: "Broken", pgn: "1. e4 e4" }])).toThrow(/Illegal move "e4"/);
  });
});

describe("names and book exit along a game", () => {
  const book = buildBook(parseBookTsv(MINI_TSV));
  const game = epdsAfter("e4 d5 exd5 Qxd5 Nc3 Qa5 h4 c6");

  it("finds the deepest named position", () => {
    expect(nameAt(book, game)).toMatchObject({ name: "Scandinavian Defense: Main Line", eco: "B01", index: 5 });
    expect(nameAt(book, game.slice(0, 4))).toMatchObject({ name: "Scandinavian Defense", index: 1 });
    expect(nameAt(book, epdsAfter("d4 d5"))).toBeNull();
  });

  it("takes the family before the colon", () => {
    expect(openingFamily("Scandinavian Defense: Main Line")).toBe("Scandinavian Defense");
    expect(openingFamily("French Defense")).toBe("French Defense");
  });

  it("reports the last book ply and who left the book", () => {
    // 7.h4 (White) is the first non-book ply.
    expect(bookExit(book, game, "black")).toEqual({ lastBookPly: 6, exitBy: "opponent" });
    expect(bookExit(book, game, "white")).toEqual({ lastBookPly: 6, exitBy: "owner" });
    expect(bookExit(book, epdsAfter("d4"), "white")).toEqual({ lastBookPly: 0, exitBy: "owner" });
    expect(bookExit(book, epdsAfter("e4 e6"), "black")).toEqual({ lastBookPly: 2, exitBy: null });
  });
});

describe("mainstream moves and exact names", () => {
  const book = buildBook(parseBookTsv(MINI_TSV));

  it("sorts book children by the lines through them, then by UCI", () => {
    expect(mainstreamChildren(book, epdAt("e4")).map((move) => [move.san, move.lines])).toEqual([
      ["d5", 2],
      ["e5", 2],
      ["a6", 1],
      ["e6", 1]
    ]);
    expect(mainstreamChildren(book, START_EPD)).toEqual([
      { san: "e4", uci: "e2e4", toEpd: epdAt("e4"), lines: 6 },
      { san: "Nf3", uci: "g1f3", toEpd: epdAt("Nf3"), lines: 1 }
    ]);
    expect(mainstreamChildren(book, epdAt("d4"))).toEqual([]);
  });

  it("names only a position a book line ends on", () => {
    expect(bookNameAt(book, epdAt("e4 e5"))).toEqual({ eco: "C20", name: "King's Pawn Game", plies: 2 });
    expect(bookNameAt(book, epdAt("e4 d5 exd5"))).toBeNull();
    expect(bookNameAt(book, START_EPD)).toBeNull();
  });
});

describe("loadBookFromTsv", () => {
  it("builds one book from several TSV texts", () => {
    const book = loadBookFromTsv([MINI_TSV, "eco\tname\tpgn\nA10\tEnglish Opening\t1. c4\n"]);
    expect(book.rows).toBe(7);
    expect(bookNameAt(book, epdAt("c4"))).toEqual({ eco: "A10", name: "English Opening", plies: 1 });
    // 1.c4 and 1.Nf3 have one line each: UCI breaks the tie (c2c4 before g1f3).
    expect(mainstreamChildren(book, START_EPD).map((move) => move.san)).toEqual(["e4", "c4", "Nf3"]);
  });

  it("rejects a text with a wrong header", () => {
    expect(() => loadBookFromTsv([MINI_TSV, "name\tpgn\n"])).toThrow(/header/);
  });

  it("builds an empty book from no texts", () => {
    const book = loadBookFromTsv([]);
    expect(book.rows).toBe(0);
    expect([...book.positions]).toEqual([START_EPD]);
  });
});

describe("createBookLoader", () => {
  it("loads the texts and builds the book once, however often it is called", async () => {
    let loads = 0;
    const loader = createBookLoader(async () => {
      loads += 1;
      return [MINI_TSV];
    });
    const first = loader();
    const second = loader();
    expect(second).toBe(first);
    const book = await first;
    expect(book.rows).toBe(6);
    expect(await loader()).toBe(book);
    expect(loads).toBe(1);
  });

  it("yields to a timer before building", async () => {
    const order: string[] = [];
    const loader = createBookLoader(async () => {
      order.push("texts");
      return [MINI_TSV];
    });
    const built = loader().then(() => order.push("built"));
    setTimeout(() => order.push("timer"), 0);
    await built;
    expect(order).toEqual(["texts", "timer", "built"]);
  });

  it("tries again after a failed load", async () => {
    let calls = 0;
    const loader = createBookLoader(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network down");
      }
      return [MINI_TSV];
    });
    await expect(loader()).rejects.toThrow("network down");
    expect((await loader()).rows).toBe(6);
    expect(calls).toBe(2);
  });
});

describe("getOpeningBook", () => {
  it("builds the bundled lichess book once", async () => {
    const book = await getOpeningBook();
    expect(await getOpeningBook()).toBe(book);
    expect(book.rows).toBeGreaterThan(3000);
    expect(bookNameAt(book, epdAt("c4"))).toMatchObject({ eco: "A10", name: "English Opening" });
    expect(nameAt(book, epdsAfter("c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 Rb1"))).toMatchObject({ eco: "A26" });
    expect(mainstreamChildren(book, START_EPD).slice(0, 2).map((move) => move.san)).toEqual(["e4", "d4"]);
  });
});
