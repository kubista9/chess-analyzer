import { cleanSan } from "./position";

// SAN display helpers and movetext parsing. Moves are shown as "1.c4", "2...Nc6" (three dots for
// Black) and lines as "1.c4 e5 2.Nc3"; plies are 1-based (ply 1 = White's first move).

/** "3.Nc3" for ply 5, "3...Qa5" for ply 6. */
export function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}.${san}` : `${number}...${san}`;
}

/** The move number of a ply (ply 1 and 2 are move 1). */
export function moveNumber(ply: number): number {
  return Math.ceil(ply / 2);
}

/**
 * A line of SAN moves with move numbers: "1.c4 e5 2.Nc3", or "2...Nc6 3.g3" when it starts on
 * Black's move (`firstPly` even).
 */
export function formatLine(sans: readonly string[], firstPly = 1): string {
  const parts: string[] = [];
  sans.forEach((san, index) => {
    const ply = firstPly + index;
    if (ply % 2 === 1) {
      parts.push(`${moveNumber(ply)}.${san}`);
    } else if (index === 0) {
      parts.push(`${moveNumber(ply)}...${san}`);
    } else {
      parts.push(san);
    }
  });
  return parts.join(" ");
}

const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

/**
 * The SAN tokens of a movetext such as "1.c4 e5 2.Nc3 Nf6", "1. c4 e5 2. Nc3" or "1...e5 2.Nf3".
 * Move numbers, comments ({...} and ;...), NAGs ($1), annotation glyphs (!, ?), "e.p." and a
 * result token are dropped. Variations in parentheses are skipped (only the main line is read).
 * The tokens are not checked for legality here: replay them with replayMoves.
 */
export function parseMovetext(text: string): string[] {
  const withoutComments = text.replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ");
  let depth = 0;
  let main = "";
  for (const char of withoutComments) {
    if (char === "(") {
      depth += 1;
      main += " ";
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      main += " ";
    } else if (depth === 0) {
      main += char;
    }
  }
  const sans: string[] = [];
  for (const raw of main.split(/\s+/)) {
    if (!raw || RESULT_TOKENS.has(raw) || /^\$\d+$/.test(raw) || raw === "e.p.") {
      continue;
    }
    // "1.c4" -> "c4", "1...e5" -> "e5", "12." -> "".
    const token = cleanSan(raw.replace(/^\d+\.+/, ""));
    // A bare "..." or "…" stands for Black's move number in "12. ... Nf6".
    if (token && !/^[.…]+$/u.test(token)) {
      sans.push(token);
    }
  }
  return sans;
}

/**
 * The canonical key of a move path (used for content notes): SAN moves joined by single spaces,
 * without numbers, e.g. "c4 e5 Nc3". Accepts any movetext parseMovetext reads.
 */
export function pathKey(movetextOrSans: string | readonly string[]): string {
  const sans = typeof movetextOrSans === "string" ? parseMovetext(movetextOrSans) : movetextOrSans;
  return sans.join(" ");
}

/** The SAN of a move without check marks, for comparing a typed move with a stored one. */
export function bareSan(san: string): string {
  return cleanSan(san).replace(/[+#]$/u, "");
}
