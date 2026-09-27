import { Chess } from "chess.js";
import { toEpd } from "./epd.js";

// Pure PGN helpers for Chess.com archive games. They avoid chess.js loadPgn, which took
// ~16-27 s over 1,377 games: headers and SAN tokens are read with a small tokenizer, and
// only the first plies of a game are replayed with chess.js (to get UCI moves and EPDs).

export type PgnHeaders = Record<string, string>;

export interface PgnMove {
  san: string;
  /** The mover's remaining clock after the move (%clk), in seconds, or null if absent. */
  clockSec: number | null;
}

export interface TimeControl {
  /** Base time in seconds. */
  base: number;
  /** Increment per move in seconds. */
  inc: number;
}

const HEADER_LINE = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);
const CLOCK = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/;

export function parsePgnHeaders(pgn: string): PgnHeaders {
  const headers: PgnHeaders = {};
  for (const line of pgn.split(/\r?\n/)) {
    const match = HEADER_LINE.exec(line);
    if (match) {
      headers[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
    } else if (line.trim() && !line.trimStart().startsWith("[")) {
      break;
    }
  }
  return headers;
}

/** "0:02:58.9" -> 178.9 seconds. */
export function parseClock(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  return match ? clockSeconds(match) : null;
}

function clockSeconds(match: RegExpExecArray): number {
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** The movetext after the header block. */
function movetext(pgn: string): string {
  const lines = pgn.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (HEADER_LINE.test(lines[index]) || !lines[index].trim())) {
    index += 1;
  }
  return lines.slice(index).join("\n");
}

/**
 * SAN moves in order, each with the %clk comment that follows it. Comments, variations,
 * NAGs, move numbers and the result token are skipped.
 */
export function parsePgnMoves(pgn: string): PgnMove[] {
  const text = movetext(pgn);
  const moves: PgnMove[] = [];
  let token = "";

  const flush = () => {
    const san = token.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    token = "";
    if (!san || /^\d+\.*$/.test(san) || RESULT_TOKENS.has(san) || san.startsWith("$")) {
      return;
    }
    moves.push({ san, clockSec: null });
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "{") {
      flush();
      const close = text.indexOf("}", index + 1);
      const comment = text.slice(index + 1, close === -1 ? text.length : close);
      const clock = CLOCK.exec(comment);
      const last = moves.at(-1);
      if (clock && last && last.clockSec === null) {
        last.clockSec = clockSeconds(clock);
      }
      index = close === -1 ? text.length : close;
    } else if (char === "(") {
      flush();
      let depth = 1;
      while (depth > 0 && ++index < text.length) {
        const inner = text[index];
        if (inner === "{") {
          const close = text.indexOf("}", index + 1);
          index = close === -1 ? text.length : close;
        } else if (inner === "(") {
          depth += 1;
        } else if (inner === ")") {
          depth -= 1;
        }
      }
    } else if (char === ";") {
      flush();
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
    }
  }
  flush();

  return moves;
}

/** Chess.com TimeControl: "180", "180+2", "600". Daily ("1/86400") and "-" give null. */
export function parseTimeControl(value: string | null | undefined): TimeControl | null {
  const match = /^(\d+)(?:\+(\d+))?$/.exec((value ?? "").trim());
  if (!match) {
    return null;
  }
  return { base: Number(match[1]), inc: Number(match[2] ?? 0) };
}

/**
 * Seconds each ply took: previous own clock - clock after the move + increment, floored
 * at 0. A side's first move starts from the base time. Null when a clock is missing.
 */
export function spentSeconds(clocks: (number | null)[], tc: TimeControl | null): (number | null)[] {
  const lastOwn: [number | null, number | null] = [tc?.base ?? null, tc?.base ?? null];

  return clocks.map((clock, index) => {
    const side = index % 2;
    const previous = lastOwn[side];
    lastOwn[side] = clock;
    if (clock === null || previous === null || !tc) {
      return null;
    }
    return Math.max(0, round1(previous - clock + tc.inc));
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ReplayedPly {
  san: string;
  uci: string;
  epdBefore: string;
  epdAfter: string;
}

/**
 * Replays the first `limit` SAN moves from the standard start position with chess.js.
 * Throws on an illegal move, so a broken PGN never yields a half-parsed opening.
 */
export function replayOpening(sans: string[], limit: number): ReplayedPly[] {
  const chess = new Chess();
  const plies: ReplayedPly[] = [];

  for (const san of sans.slice(0, limit)) {
    const epdBefore = toEpd(chess.fen());
    const move = chess.move(san);
    plies.push({
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      epdBefore,
      epdAfter: toEpd(chess.fen())
    });
  }

  return plies;
}
