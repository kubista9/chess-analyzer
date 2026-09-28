import { trendDirection, type TrendDirection } from "./moveSignals.js";
import { formatLine, type OpeningTree, type TreeEdge, type TreeNode } from "./openingTree.js";
import { START_EPD } from "./epd.js";
import { LOW_SAMPLE_N } from "./stats.js";
import type { PlayerColor } from "./types.js";

// Home's repertoire snapshot: per colour, the opponent's main moves at the first position where
// the opponent chooses, and the owner's main answers to each ("vs 1.e4: 1...d5 55% (222) ·
// 1...e5 40% (216)"). As White the owner moves first, so his first moves come first and the
// groups are the replies to his main first move. Pure; built from a memoised tree.

/** Opponent moves shown per colour... */
export const SNAPSHOT_GROUPS = 4;
/** ...each with at least this many games. */
export const SNAPSHOT_MIN_GROUP_N = LOW_SAMPLE_N;
/** Owner answers shown per group. */
export const SNAPSHOT_ANSWERS = 3;
/** An answer is listed if it has this share of the group's games (the main answer always is). */
export const SNAPSHOT_MIN_SHARE = 0.05;
/**
 * Usage hints compare an answer's share of the group's last-90-day games with its share before:
 * "fading" when the recent share is at most half the older one, "rising" when it is at least
 * double. Both sides need SNAPSHOT_TREND_MIN_N games in the group and the larger share must be
 * at least SNAPSHOT_TREND_MIN_SHARE.
 */
export const SNAPSHOT_TREND_MIN_N = LOW_SAMPLE_N;
export const SNAPSHOT_TREND_MIN_SHARE = 0.15;

export type UsageHint = "fading" | "rising" | null;

export interface SnapshotMove {
  san: string;
  uci: string;
  /** UCI moves from the start, this move last. */
  moves: string[];
  /** "1...d5" */
  label: string;
  n: number;
  /** Share of the group's games. */
  share: number;
  /** In the tree's view (recency-weighted when it is). */
  score: number;
  ci: [number, number];
  delta: number;
  lowSample: boolean;
  recentN: number;
  olderN: number;
  /** Score trend over the 90-day split. */
  direction: TrendDirection;
  usage: UsageHint;
  name: string | null;
  eco: string | null;
}

export interface SnapshotGroup {
  /** UCI moves to the owner-to-move position the answers are played from. */
  moves: string[];
  /** "vs 1.e4", "vs 1.c4 e5", or "First move" for White's opening move. */
  label: string;
  n: number;
  answers: SnapshotMove[];
}

export interface ColorSnapshot {
  color: PlayerColor;
  games: number;
  groups: SnapshotGroup[];
}

function answersAt(node: TreeNode, moves: string[]): SnapshotMove[] {
  const ply = moves.length + 1;
  const recentTotal = node.edges.reduce((sum, edge) => sum + edge.trend.recentN, 0);
  const olderTotal = node.edges.reduce((sum, edge) => sum + edge.trend.olderN, 0);
  const total = node.edges.reduce((sum, edge) => sum + edge.n, 0);
  return node.edges
    .filter((edge, index) => index === 0 || edge.n / total >= SNAPSHOT_MIN_SHARE)
    .slice(0, SNAPSHOT_ANSWERS)
    .map((edge) => answer(edge, [...moves, edge.uci], ply, total, recentTotal, olderTotal));
}

function usage(edge: TreeEdge, recentTotal: number, olderTotal: number): UsageHint {
  if (recentTotal < SNAPSHOT_TREND_MIN_N || olderTotal < SNAPSHOT_TREND_MIN_N) {
    return null;
  }
  const recent = edge.trend.recentN / recentTotal;
  const older = edge.trend.olderN / olderTotal;
  if (older >= SNAPSHOT_TREND_MIN_SHARE && recent <= older / 2) {
    return "fading";
  }
  if (recent >= SNAPSHOT_TREND_MIN_SHARE && recent >= older * 2) {
    return "rising";
  }
  return null;
}

function answer(edge: TreeEdge, moves: string[], ply: number, total: number, recentTotal: number, olderTotal: number): SnapshotMove {
  return {
    san: edge.san,
    uci: edge.uci,
    moves,
    label: formatLine([edge.san], ply),
    n: edge.n,
    share: total ? edge.n / total : 0,
    score: edge.weighted.score,
    ci: edge.weighted.ci,
    delta: edge.weighted.delta,
    lowSample: edge.lowSample,
    recentN: edge.trend.recentN,
    olderN: edge.trend.olderN,
    direction: trendDirection(edge.trend),
    usage: usage(edge, recentTotal, olderTotal),
    name: edge.name,
    eco: edge.eco
  };
}

export function buildSnapshot(tree: OpeningTree): ColorSnapshot {
  const groups: SnapshotGroup[] = [];
  const root = tree.nodes.get(START_EPD);
  let base: { node: TreeNode; moves: string[]; sans: string[] } | null = root ? { node: root, moves: [], sans: [] } : null;

  if (base && base.node.ownerToMove) {
    // As White: the first moves, then the replies to the main one.
    if (base.node.edges.length) {
      groups.push({ moves: [], label: "First move", n: base.node.n, answers: answersAt(base.node, []) });
    }
    const main = base.node.edges[0];
    const next = main ? tree.nodes.get(main.toEpd) : undefined;
    base = main && next ? { node: next, moves: [main.uci], sans: [main.san] } : null;
  }

  if (base) {
    for (const edge of base.node.edges.slice(0, SNAPSHOT_GROUPS)) {
      const node = tree.nodes.get(edge.toEpd);
      if (!node || edge.n < SNAPSHOT_MIN_GROUP_N || !node.edges.length) {
        continue;
      }
      const moves = [...base.moves, edge.uci];
      groups.push({ moves, label: `vs ${formatLine([...base.sans, edge.san])}`, n: edge.n, answers: answersAt(node, moves) });
    }
  }

  return { color: tree.color, games: tree.games, groups };
}
