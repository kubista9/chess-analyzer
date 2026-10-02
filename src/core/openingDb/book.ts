import { Chess } from "chess.js";
import { START_EPD, START_FEN, toEpd, type Color } from "../chess/position";

// An index over the lichess chess-openings TSVs (eco, name, pgn), keyed by EPD so a name is
// found whatever the move order. The dataset is a list of names, not a theory book: it names
// unsound lines too (Busch-Gass, Latvian, Damiano), so book membership never means "sound".

export interface BookRow {
  eco: string;
  name: string;
  pgn: string;
}

export interface BookName {
  eco: string;
  name: string;
  /** Plies of the (shortest) line that names this position. */
  plies: number;
}

export interface BookMove {
  san: string;
  uci: string;
  toEpd: string;
}

export interface OpeningBook {
  rows: number;
  /** Every position on any line, including the start position. */
  positions: Set<string>;
  /** The positions a line ends on, with that line's name. */
  named: Map<string, BookName>;
  /** Book moves out of a position, in first-seen order. */
  children: Map<string, BookMove[]>;
  /** How many lines pass through (or end on) a position: a rough proxy for "how much theory". */
  lineCount: Map<string, number>;
}

/** Parses one TSV file with the header `eco	name	pgn`. */
export function parseBookTsv(text: string): BookRow[] {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines[0] !== "eco\tname\tpgn") {
    throw new Error(`Unexpected opening-book header "${lines[0]}"`);
  }
  return lines.slice(1).map((line, index) => {
    const [eco, name, pgn, extra] = line.split("\t");
    if (!eco || !name || !pgn || extra !== undefined) {
      throw new Error(`Malformed opening-book row ${index + 2}: "${line}"`);
    }
    return { eco, name, pgn };
  });
}

/** The SAN moves of a book pgn such as "1. e4 e5 2. Nf3". */
export function bookSans(pgn: string): string[] {
  return pgn
    .trim()
    .split(/\s+/)
    .filter((token) => !/^\d+\.+$/.test(token));
}

/**
 * Replays every row once and indexes the positions. Rows share long prefixes, so each
 * position reached by an already-seen move sequence comes from a prefix cache instead of
 * chess.js. When two lines end on the same position, the shorter line names it (ties: the
 * first row).
 */
export function buildBook(rows: BookRow[]): OpeningBook {
  const positions = new Set<string>([START_EPD]);
  const named = new Map<string, BookName>();
  const children = new Map<string, BookMove[]>();
  const lineCount = new Map<string, number>();
  // "e4 e5 Nf3" -> the FEN after it.
  const prefixFen = new Map<string, string>();
  const chess = new Chess();

  for (const row of rows) {
    const sans = bookSans(row.pgn);
    let key = "";
    let fen = START_FEN;
    let loaded = false;
    const seen = new Set<string>([START_EPD]);

    for (const san of sans) {
      const fromEpd = toEpd(fen);
      key = key ? `${key} ${san}` : san;
      let nextFen = prefixFen.get(key);
      let move: BookMove | undefined;

      if (nextFen === undefined) {
        if (!loaded) {
          chess.load(fen);
          loaded = true;
        }
        let played;
        try {
          played = chess.move(san);
        } catch {
          throw new Error(`Illegal move "${san}" in book line ${row.eco} "${row.name}": ${row.pgn}`);
        }
        nextFen = chess.fen();
        prefixFen.set(key, nextFen);
        move = { san: played.san, uci: `${played.from}${played.to}${played.promotion ?? ""}`, toEpd: toEpd(nextFen) };
      }
      // A prefix is cached only if its own prefix was, so after the first miss every later
      // move of this row misses too and chess.js stays in step.

      const toEpdKey = toEpd(nextFen);
      if (move) {
        const list = children.get(fromEpd) ?? [];
        if (!list.some((child) => child.uci === move.uci)) {
          list.push(move);
        }
        children.set(fromEpd, list);
      }
      positions.add(toEpdKey);
      seen.add(toEpdKey);
      fen = nextFen;
    }

    for (const epd of seen) {
      lineCount.set(epd, (lineCount.get(epd) ?? 0) + 1);
    }
    const end = toEpd(fen);
    const current = named.get(end);
    if (!current || sans.length < current.plies) {
      named.set(end, { eco: row.eco, name: row.name, plies: sans.length });
    }
  }

  return { rows: rows.length, positions, named, children, lineCount };
}

export function bookChildren(book: OpeningBook, epd: string): BookMove[] {
  return book.children.get(epd) ?? [];
}

/** The family of a name: the part before the first colon ("Sicilian Defense: Najdorf" -> "Sicilian Defense"). */
export function openingFamily(name: string): string {
  return name.split(":")[0].trim();
}

export interface NamedPosition extends BookName {
  epd: string;
  /** Index into the given EPD list. */
  index: number;
}

/** The deepest named position along a game (EPDs in move order), or null. */
export function nameAt(book: OpeningBook, epds: readonly string[]): NamedPosition | null {
  for (let index = epds.length - 1; index >= 0; index -= 1) {
    const hit = book.named.get(epds[index]);
    if (hit) {
      return { ...hit, epd: epds[index], index };
    }
  }
  return null;
}

export interface BookExit {
  /** How many plies from the start stay on book positions (0 = the first move left the book). */
  lastBookPly: number;
  /** Who played the first non-book move; null if the game never left the book in the given plies. */
  exitBy: "owner" | "opponent" | null;
}

/**
 * Where a game leaves the book. `epdsAfter[i]` is the position after ply i + 1 (so White moves
 * at even indices). A ply is "in book" when the position it reaches is a book position.
 */
export function bookExit(book: OpeningBook, epdsAfter: readonly string[], color: Color): BookExit {
  let lastBookPly = 0;
  while (lastBookPly < epdsAfter.length && book.positions.has(epdsAfter[lastBookPly])) {
    lastBookPly += 1;
  }
  if (lastBookPly === epdsAfter.length) {
    return { lastBookPly, exitBy: null };
  }
  const exitMover: Color = lastBookPly % 2 === 0 ? "white" : "black";
  return { lastBookPly, exitBy: exitMover === color ? "owner" : "opponent" };
}
