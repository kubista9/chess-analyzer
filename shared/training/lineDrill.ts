import { START_EPD } from "../epd.js";
import type { OpeningBook } from "../openingBook.js";
import type { PlayerColor } from "../types.js";
import type { RepGraph, RepMove } from "./cards.js";

// The line drill runner: one run from the start through the owner's repertoire. At the
// opponent's nodes a reply is sampled in proportion to its recency-weighted frequency in the
// owner's games, among the replies that land on a repertoire entry (so the runner never asks for
// an owner move without an entry). Without game data it falls back to the book's first reply,
// else to a uniform choice among the prepared replies. Branches that lead to a card the session
// still has to grade are preferred. The run stops at the repertoire's leaf or at the graph's
// maximum ply (16).

export interface LineStep {
  /** The move's ply (1-based). */
  ply: number;
  mover: "owner" | "opponent";
  /** The position before the move. */
  epd: string;
  uci: string;
  san: string;
  /** Owner moves: graded (a due or new card) or auto-played as known. */
  graded: boolean;
}

export interface LineRun {
  color: PlayerColor;
  steps: LineStep[];
}

/** A seeded RNG (mulberry32) returning [0, 1). */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RunOptions {
  rng: () => number;
  /** The games' weighted count of reply `uci` at `epd` (the opening tree's edge wN), 0 if unplayed. */
  replyWeight: (epd: string, uci: string) => number;
  /** Whether the owner's move at `epd` is graded (its card is due or new today). */
  graded: (epd: string) => boolean;
  book?: OpeningBook;
  /** EPDs (owner nodes) the session still has to grade; replies leading to one are preferred. */
  targets?: ReadonlySet<string>;
  /** How much a reply towards a target is preferred (a factor on its weight). */
  targetBoost?: number;
}

/** Whether a target is reachable from each node of the graph (memoised DFS; the graph is ply-bounded). */
export function reachesTargets(graph: RepGraph, targets: ReadonlySet<string>): (epd: string) => boolean {
  const memo = new Map<string, boolean>();
  const visit = (epd: string, depth: number): boolean => {
    const hit = memo.get(epd);
    if (hit !== undefined) {
      return hit;
    }
    if (depth > graph.maxPly + 1) {
      return false;
    }
    memo.set(epd, false);
    const result = targets.has(epd) || (graph.moves.get(epd) ?? []).some((move) => visit(move.toEpd, depth + 1));
    memo.set(epd, result);
    return result;
  };
  return (epd) => visit(epd, 0);
}

/** The reply weights at an opponent node: games first, else the book's first reply, else uniform. */
export function replyWeights(epd: string, replies: readonly RepMove[], options: Pick<RunOptions, "replyWeight" | "book">): number[] {
  const games = replies.map((reply) => Math.max(0, options.replyWeight(epd, reply.uci)));
  if (games.some((weight) => weight > 0)) {
    return games;
  }
  const bookMoves = options.book?.children.get(epd) ?? [];
  for (const bookMove of bookMoves) {
    const index = replies.findIndex((reply) => reply.uci === bookMove.uci);
    if (index >= 0) {
      return replies.map((_reply, other) => (other === index ? 1 : 0));
    }
  }
  return replies.map(() => 1);
}

function pick(weights: readonly number[], rng: () => number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng() * total;
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll < 0 && weight > 0) {
      return index;
    }
  }
  for (let index = weights.length - 1; index >= 0; index -= 1) {
    if (weights[index] > 0) {
      return index;
    }
  }
  return -1;
}

/** One run through the repertoire from the start. */
export function sampleLineRun(graph: RepGraph, options: RunOptions): LineRun {
  const steps: LineStep[] = [];
  const reaches = options.targets?.size ? reachesTargets(graph, options.targets) : null;
  const boost = options.targetBoost ?? 8;
  let epd = START_EPD;
  const visited = new Set<string>([epd]);
  for (let ply = 1; ply <= graph.maxPly; ply += 1) {
    const node = graph.nodes.get(epd);
    const moves = graph.moves.get(epd) ?? [];
    if (!node || !moves.length) {
      break;
    }
    let move: RepMove;
    if (node.ownerToMove) {
      move = moves[0];
    } else {
      const base = replyWeights(epd, moves, options);
      const weights = reaches
        ? base.map((weight, index) => (reaches(moves[index].toEpd) ? (weight + 0.05) * boost : weight))
        : base;
      const index = pick(weights, options.rng);
      if (index < 0) {
        break;
      }
      move = moves[index];
    }
    steps.push({
      ply,
      mover: node.ownerToMove ? "owner" : "opponent",
      epd,
      uci: move.uci,
      san: move.san,
      graded: node.ownerToMove && options.graded(epd)
    });
    if (visited.has(move.toEpd)) {
      break;
    }
    visited.add(move.toEpd);
    epd = move.toEpd;
  }
  return { color: graph.color, steps };
}

/**
 * The session's line runs: runs are sampled towards the cards still to grade until each is
 * covered or `maxRuns` is reached. A card is graded once per session (its first run).
 */
export function planLineRuns(graph: RepGraph, gradedEpds: ReadonlySet<string>, options: Omit<RunOptions, "graded" | "targets">, maxRuns = 6): LineRun[] {
  const left = new Set([...gradedEpds].filter((epd) => graph.nodes.has(epd)));
  const runs: LineRun[] = [];
  for (let attempt = 0; left.size && attempt < maxRuns * 3 && runs.length < maxRuns; attempt += 1) {
    const run = sampleLineRun(graph, { ...options, targets: left, graded: (epd) => left.has(epd) });
    const covered = run.steps.filter((step) => step.graded);
    if (!covered.length) {
      continue;
    }
    for (const step of covered) {
      left.delete(step.epd);
    }
    runs.push(run);
  }
  return runs;
}
