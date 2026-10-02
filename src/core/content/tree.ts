import { sideToMove, type AppliedMove, type Color } from "../chess/position";
import { PRIORITIES, type Priority } from "./schema";
import { posKey, type Catalog, type Line, type PositionItem, type RepertoireTree, type TreeEdge, type TreeNode } from "./types";

// The repertoire as a position graph: one node per EPD across all enabled lines of a side, so
// transpositions share a node (and its progress), and one edge per move out of a position.

const PRIORITY_RANK: Record<Priority, number> = { main: 0, secondary: 1, sideline: 2 };

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** The better (earlier in PRIORITIES) of two priorities. */
function bestPriority(left: Priority, right: Priority): Priority {
  return PRIORITY_RANK[left] <= PRIORITY_RANK[right] ? left : right;
}

/** Sorts priorities as PRIORITIES lists them: main, secondary, sideline. */
export function comparePriority(left: Priority, right: Priority): number {
  return PRIORITIES.indexOf(left) - PRIORITIES.indexOf(right);
}

/**
 * Builds the position graph of `side` from the catalog's lines for which `isEnabled` is true.
 * Lines are taken in teaching order, so every lineIds list is in teaching order. An edge's
 * priority is the best of its lines; edges are sorted by priority, then their first line's
 * order, then UCI. A node's minPly, pathSans and fen come from the shortest route (ties: the
 * first line in teaching order).
 */
export function buildTree(catalog: Catalog, side: Color, isEnabled: (lineId: string) => boolean): RepertoireTree {
  const lines = catalog.lines.filter((line) => line.side === side && isEnabled(line.id)).sort((left, right) => left.order - right.order);
  const nodes = new Map<string, TreeNode>();
  const firstOrder = new Map<TreeEdge, number>();

  const visit = (line: Line, ply: number): TreeNode => {
    const epd = line.epds[ply];
    const fen = ply === 0 ? line.moves[0].fenBefore : line.moves[ply - 1].fenAfter;
    let node = nodes.get(epd);
    if (!node) {
      const toMove = sideToMove(epd);
      node = { epd, fen, toMove, userToMove: toMove === side, minPly: ply, pathSans: line.sans.slice(0, ply), edges: [], lineIds: [] };
      nodes.set(epd, node);
    } else if (ply < node.minPly) {
      node.minPly = ply;
      node.pathSans = line.sans.slice(0, ply);
      node.fen = fen;
    }
    if (!node.lineIds.includes(line.id)) {
      node.lineIds.push(line.id);
    }
    return node;
  };

  for (const line of lines) {
    line.moves.forEach((move, index) => {
      const node = visit(line, index);
      let edge = node.edges.find((candidate) => candidate.uci === move.uci);
      if (!edge) {
        edge = {
          uci: move.uci,
          san: move.san,
          from: move.from,
          to: move.to,
          mover: move.color === side ? "user" : "opponent",
          lineIds: [],
          priority: line.priority
        };
        node.edges.push(edge);
        firstOrder.set(edge, line.order);
      }
      if (!edge.lineIds.includes(line.id)) {
        edge.lineIds.push(line.id);
      }
      edge.priority = bestPriority(edge.priority, line.priority);
    });
    visit(line, line.moves.length);
  }

  for (const node of nodes.values()) {
    node.edges.sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        firstOrder.get(left)! - firstOrder.get(right)! ||
        compareText(left.uci, right.uci)
    );
  }
  return { side, nodes, lineIds: new Set(lines.map((line) => line.id)) };
}

/** The node of a position, if the enabled repertoire reaches it. */
export function nodeAt(tree: RepertoireTree, epd: string): TreeNode | undefined {
  return tree.nodes.get(epd);
}

/** The user's repertoire moves in a position (empty when the opponent is to move or the position is not in the tree). */
export function userMovesAt(tree: RepertoireTree, epd: string): TreeEdge[] {
  return (tree.nodes.get(epd)?.edges ?? []).filter((edge) => edge.mover === "user");
}

/** The opponent replies the repertoire prepares for in a position. */
export function opponentRepliesAt(tree: RepertoireTree, epd: string): TreeEdge[] {
  return (tree.nodes.get(epd)?.edges ?? []).filter((edge) => edge.mover === "opponent");
}

/**
 * Every position where the user has to find a repertoire move, as a review item. Sorted for
 * teaching: best priority first, then the order of the item's first line, then the ply, then EPD.
 */
export function positionItems(tree: RepertoireTree, catalog: Catalog): PositionItem[] {
  const orderOf = (lineId: string) => catalog.lineById.get(lineId)?.order ?? Number.MAX_SAFE_INTEGER;
  const items: PositionItem[] = [];
  for (const node of tree.nodes.values()) {
    const expected = node.userToMove ? node.edges.filter((edge) => edge.mover === "user") : [];
    if (expected.length === 0) {
      continue;
    }
    // The lines that ask this question: the ones whose move here is one of the user's edges.
    const lineIds = [...new Set(expected.flatMap((edge) => edge.lineIds))].sort(
      (left, right) => orderOf(left) - orderOf(right) || compareText(left, right)
    );
    items.push({
      key: posKey(tree.side, node.epd),
      side: tree.side,
      epd: node.epd,
      fen: node.fen,
      expected,
      lineIds,
      minPly: node.minPly,
      pathSans: node.pathSans,
      priority: expected.map((edge) => edge.priority).reduce(bestPriority),
      order: orderOf(lineIds[0])
    });
  }
  return items.sort(
    (left, right) =>
      PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
      left.order - right.order ||
      left.minPly - right.minPly ||
      compareText(left.epd, right.epd)
  );
}

/** posKey of the position before each of the user's moves in a line, in order, without repeats. */
export function linePositionKeys(line: Line): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const ply of line.userPlies) {
    const key = posKey(line.side, line.epds[ply - 1]);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** How far a game follows the repertoire tree, and where it leaves it. */
export interface LineWalk {
  /** Plies from the start that are edges of the tree (0 when the first move already leaves it). */
  inRepertoireThrough: number;
  /**
   * The first move that is not an edge: its 1-based ply, who played it, the move, and the
   * repertoire's moves in that position (empty when the repertoire ends there or never reached
   * it). Null when every move is in the repertoire.
   */
  deviation: { ply: number; by: "user" | "opponent"; played: AppliedMove; expected: TreeEdge[] } | null;
}

/** Follows a game from the start along the tree while its moves are tree edges. */
export function walkTree(tree: RepertoireTree, moves: readonly AppliedMove[]): LineWalk {
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const edges = tree.nodes.get(move.epdBefore)?.edges ?? [];
    if (!edges.some((edge) => edge.uci === move.uci)) {
      return {
        inRepertoireThrough: index,
        deviation: { ply: index + 1, by: move.color === tree.side ? "user" : "opponent", played: move, expected: edges }
      };
    }
  }
  return { inRepertoireThrough: moves.length, deviation: null };
}
