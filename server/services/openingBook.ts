import fs from "node:fs";
import path from "node:path";
import { buildBook, parseBookTsv, type OpeningBook } from "../../shared/openingBook.js";
import { config } from "../config.js";

export const BOOK_FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"] as const;

/** Reads and indexes the vendored TSVs in `dir` (about 1 s). */
export function loadOpeningBook(dir: string = config.openingBookDir): OpeningBook {
  const rows = BOOK_FILES.flatMap((file) => parseBookTsv(fs.readFileSync(path.join(dir, file), "utf8")));
  return buildBook(rows);
}

let cached: OpeningBook | undefined;

/** The app's opening book, built on first use and kept for the life of the process. */
export function getOpeningBook(): OpeningBook {
  cached ??= loadOpeningBook();
  return cached;
}
