import { scoreWinPercent } from "../../shared/eval.js";
import type { EngineLine } from "../../shared/types.js";

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
