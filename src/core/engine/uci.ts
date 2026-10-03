import { START_FEN, fenOf } from "../chess/position";
import { scoreWinPercent } from "./score";
import type { EngineLine } from "./types";

// Pure UCI "info" parsing. A search reports its lines iteration by iteration; a depth or
// node limit (or a stop) can end it in the middle of an iteration, and Stockfish then prints
// the ranks it has not re-searched yet with the previous depth's label and score. Taking
// "the latest line per rank" mixes iterations and yields duplicate moves across ranks. So:
// - bound (lowerbound / upperbound) lines are skipped;
// - a line labelled with a depth below the deepest depth seen so far is ignored (those are
//   the stop-print leftovers of an unfinished iteration);
// - the result is the deepest iteration in which all K ranks completed at the same depth
//   with K distinct moves. Only when no iteration completed does it fall back to the deepest
//   partial one (deduped, marked incomplete).

/** At most this many moves of a principal variation are kept (plies). */
export const PV_MAX_MOVES = 10;

export interface InfoLine {
  depth: number;
  multipv: number;
  cp: number | null;
  mate: number | null;
  bound: "lower" | "upper" | null;
  nodes: number | null;
  pv: string[];
}

/** Parses an "info ... score ... pv ..." line. Returns null for any other line. */
export function parseInfoLine(line: string): InfoLine | null {
  if (!line.startsWith("info ")) {
    return null;
  }
  const tokens = line.trim().split(/\s+/);
  const depthIndex = tokens.indexOf("depth");
  const scoreIndex = tokens.indexOf("score");
  const pvIndex = tokens.indexOf("pv");
  if (depthIndex === -1 || scoreIndex === -1 || pvIndex === -1 || pvIndex + 1 >= tokens.length) {
    return null;
  }

  const depth = Number(tokens[depthIndex + 1]);
  const kind = tokens[scoreIndex + 1];
  const value = Number(tokens[scoreIndex + 2]);
  if (!Number.isInteger(depth) || !Number.isFinite(value) || (kind !== "cp" && kind !== "mate")) {
    return null;
  }

  const multipvIndex = tokens.indexOf("multipv");
  const multipv = multipvIndex === -1 ? 1 : Number(tokens[multipvIndex + 1]);
  const nodesIndex = tokens.indexOf("nodes");
  const afterScore = tokens[scoreIndex + 3];
  const bound = afterScore === "lowerbound" ? "lower" : afterScore === "upperbound" ? "upper" : null;

  return {
    depth,
    multipv: Number.isInteger(multipv) && multipv > 0 ? multipv : 1,
    cp: kind === "cp" ? value : null,
    mate: kind === "mate" ? value : null,
    bound,
    nodes: nodesIndex === -1 ? null : Number(tokens[nodesIndex + 1]),
    pv: tokens.slice(pvIndex + 1)
  };
}

/** The last "nodes N" value on any info line (bound and currmove lines included), or null. */
export function parseNodes(line: string): number | null {
  if (!line.startsWith("info ")) {
    return null;
  }
  const match = / nodes (\d+)/.exec(line);
  return match ? Number(match[1]) : null;
}

/** The EngineLine of an info line: win% from the side to move, pv cut to PV_MAX_MOVES. */
export function toEngineLine(info: InfoLine): EngineLine {
  const score = { cp: info.cp, mate: info.mate };
  return {
    uci: info.pv[0],
    cp: info.cp,
    mate: info.mate,
    winPct: scoreWinPercent(score),
    depth: info.depth,
    pv: info.pv.slice(0, PV_MAX_MOVES)
  };
}

export interface CollectedSearch {
  lines: EngineLine[];
  /** Depth of the iteration the lines come from (0 when there are none). */
  depth: number;
  /** True when all expected ranks completed at `depth` with distinct moves. */
  complete: boolean;
  nodes: number;
}

/** Collects the info lines of one search and picks the lines to trust. */
export class MultiPvCollector {
  private readonly byDepth = new Map<number, Map<number, InfoLine>>();
  private maxDepth = 0;
  private nodes = 0;

  /** @param expectedRanks K: min(MultiPV, number of root moves the search may consider). */
  constructor(private readonly expectedRanks: number) {
    if (!Number.isInteger(expectedRanks) || expectedRanks < 1) {
      throw new Error(`expectedRanks must be a positive integer, got ${expectedRanks}`);
    }
  }

  /** Feeds one engine output line; anything that is not a usable info line is ignored. */
  push(line: string): void {
    const nodes = parseNodes(line);
    if (nodes !== null) {
      this.nodes = Math.max(this.nodes, nodes);
    }

    const info = parseInfoLine(line);
    if (!info || info.bound || info.multipv > this.expectedRanks || info.depth < this.maxDepth) {
      return;
    }
    this.maxDepth = info.depth;
    let ranks = this.byDepth.get(info.depth);
    if (!ranks) {
      ranks = new Map();
      this.byDepth.set(info.depth, ranks);
    }
    ranks.set(info.multipv, info);
  }

  /** The lines to trust so far (callable at any time, usually after bestmove). */
  result(): CollectedSearch {
    const depths = [...this.byDepth.keys()].sort((left, right) => right - left);

    for (const depth of depths) {
      const ranks = this.byDepth.get(depth)!;
      const lines: InfoLine[] = [];
      for (let rank = 1; rank <= this.expectedRanks; rank += 1) {
        const line = ranks.get(rank);
        if (line) {
          lines.push(line);
        }
      }
      const distinct = new Set(lines.map((line) => line.pv[0]));
      if (lines.length === this.expectedRanks && distinct.size === lines.length) {
        return { lines: lines.map(toEngineLine), depth, complete: true, nodes: this.nodes };
      }
    }

    // No completed iteration: the deepest one that has rank 1, deduped by move.
    for (const depth of depths) {
      const ranks = this.byDepth.get(depth)!;
      if (!ranks.has(1)) {
        continue;
      }
      const seen = new Set<string>();
      const lines: EngineLine[] = [];
      for (const rank of [...ranks.keys()].sort((left, right) => left - right)) {
        const line = ranks.get(rank)!;
        if (!seen.has(line.pv[0])) {
          seen.add(line.pv[0]);
          lines.push(toEngineLine(line));
        }
      }
      return { lines, depth, complete: false, nodes: this.nodes };
    }

    return { lines: [], depth: 0, complete: false, nodes: this.nodes };
  }
}

// Commands and replies of the UCI protocol that the Stockfish client sends and reads. Every
// command is built here from validated parts, so a malformed FEN or move can never smuggle a
// second command (a newline) into the engine.

/** A move in UCI notation: from square, to square, optional promotion piece ("e2e4", "e7e8q"). */
export const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const FEN_CHARACTERS = /^[A-Za-z0-9/ -]+$/;

/** "position fen <fen>", or "position startpos" for the standard start position. Throws on text that is not a FEN. */
export function positionCommand(fen: string): string {
  const normalised = fen.trim().split(/\s+/).join(" ");
  const fields = normalised.split(" ");
  if (!FEN_CHARACTERS.test(normalised) || (fields.length !== 4 && fields.length !== 6)) {
    throw new Error(`Not a FEN: "${fen}"`);
  }
  const full = fenOf(normalised);
  return full === START_FEN ? "position startpos" : `position fen ${full}`;
}

export interface GoOptions {
  /** Plies; a positive integer. */
  depth?: number;
  /** Milliseconds; rounded, at least 1. */
  movetimeMs?: number;
  /** Restrict the root to these UCI moves. */
  searchMoves?: readonly string[];
}

/**
 * "go depth 14 movetime 800 searchmoves e2e4 d2d4". A search needs a depth or a movetime limit
 * (an unlimited search would only end on "stop"); throws otherwise or on a malformed value.
 */
export function goCommand(options: GoOptions): string {
  const parts = ["go"];
  if (options.depth !== undefined) {
    if (!Number.isInteger(options.depth) || options.depth < 1) {
      throw new Error(`A search depth must be a positive integer, got ${options.depth}`);
    }
    parts.push("depth", String(options.depth));
  }
  if (options.movetimeMs !== undefined) {
    if (!Number.isFinite(options.movetimeMs) || options.movetimeMs <= 0) {
      throw new Error(`A search movetime must be a positive number of ms, got ${options.movetimeMs}`);
    }
    parts.push("movetime", String(Math.max(1, Math.round(options.movetimeMs))));
  }
  if (parts.length === 1) {
    throw new Error("A search needs a depth or a movetime limit");
  }
  if (options.searchMoves && options.searchMoves.length > 0) {
    const bad = options.searchMoves.find((move) => !UCI_MOVE_PATTERN.test(move));
    if (bad !== undefined) {
      throw new Error(`Not a UCI move: "${bad}"`);
    }
    parts.push("searchmoves", ...options.searchMoves);
  }
  return parts.join(" ");
}

/** "setoption name <name> value <value>". */
export function setOptionCommand(name: string, value: string | number): string {
  const text = String(value);
  if (/[\r\n]/.test(name) || /[\r\n]/.test(text)) {
    throw new Error("A UCI option cannot contain a line break");
  }
  return `setoption name ${name} value ${text}`;
}

/**
 * Reads a "bestmove <move> [ponder <move>]" line; null for any other line. "bestmove (none)" (no
 * legal move) and the null move "0000" give best null.
 */
export function parseBestMove(line: string): { best: string | null; ponder: string | null } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "bestmove") {
    return null;
  }
  const move = (token: string | undefined): string | null => (token !== undefined && UCI_MOVE_PATTERN.test(token) ? token : null);
  const best = move(tokens[1]);
  const ponderIndex = tokens.indexOf("ponder");
  return { best, ponder: best !== null && ponderIndex > 1 ? move(tokens[ponderIndex + 1]) : null };
}

/** The value of an "id name <name>" line ("Stockfish 19 Lite WASM"); null for any other line. */
export function parseIdName(line: string): string | null {
  const match = /^id name (.+)$/.exec(line.trim());
  return match ? match[1].trim() : null;
}
