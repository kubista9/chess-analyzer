import { loadBookFromTsv, type OpeningBook } from "./book";

// The app's opening book: the five lichess TSVs (data/chess-openings, about 400 kB) are imported
// as raw text in their own chunk and indexed on first use, so neither the download nor the
// index build (a few thousand replayed lines) holds up the first render.

/**
 * A loader that builds the book from `loadTexts` once: every call returns the same promise. The
 * build waits for a setTimeout(0) first, so the caller's work (a render, a click) goes first. A
 * failed load is forgotten, so the next call tries again.
 */
export function createBookLoader(loadTexts: () => Promise<readonly string[]>): () => Promise<OpeningBook> {
  let pending: Promise<OpeningBook> | null = null;
  return () => {
    if (!pending) {
      const attempt = (async () => {
        const texts = await loadTexts();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return loadBookFromTsv(texts);
      })();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) {
          pending = null;
        }
      });
    }
    return pending;
  };
}

async function bundledTsvs(): Promise<string[]> {
  const files = await Promise.all([
    import("../../../data/chess-openings/a.tsv?raw"),
    import("../../../data/chess-openings/b.tsv?raw"),
    import("../../../data/chess-openings/c.tsv?raw"),
    import("../../../data/chess-openings/d.tsv?raw"),
    import("../../../data/chess-openings/e.tsv?raw")
  ]);
  return files.map((file) => file.default);
}

const loadBundledBook = createBookLoader(bundledTsvs);

/** The opening-name index of the bundled lichess TSVs, built once per page on first use. */
export function getOpeningBook(): Promise<OpeningBook> {
  return loadBundledBook();
}
