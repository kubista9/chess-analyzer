import { OPENING_PLY_LIMIT } from "./constants.js";
import { START_EPD } from "./epd.js";
import type { OpeningBook } from "./openingBook.js";
import {
  addGame,
  ageDays,
  eloExpected,
  emptyAccumulator,
  isLowSample,
  recencyWeight,
  summarize,
  type ScoreAccumulator,
  type ScoreSummary
} from "./stats.js";
import type { GameRecord, OpeningPly, PlayerColor, TreeBreadcrumb, TreeNodeView } from "./types.js";

// A per-colour opening tree keyed by EPD, so transpositions land on one node. Built in memory
// from the stored opening plies (no replay); nothing here is persisted.

/** Days that count as "recent" in the trend. */
export const TREND_DAYS = 90;

export interface TreePly {
  san: string;
  uci: string;
  epdBefore: string;
  epdAfter: string;
  /** Time the move took, in ms (null without clock data). */
  spentMs: number | null;
}

/** One game as the tree needs it. */
export interface TreeGame {
  id: string;
  /** Unix seconds. */
  endTime: number;
  color: PlayerColor;
  score: 0 | 0.5 | 1;
  /** The owner's rating for the Elo expectation (pre-game where known). */
  myRating: number;
  oppRating: number;
  /** Base time in ms, for think time as a share of the clock; null if unknown. */
  baseMs: number | null;
  /** The opening plies in order, starting from the standard position. */
  plies: TreePly[];
}

export interface BuildTreeOptions {
  color: PlayerColor;
  /** Unix seconds: recency ages and the trend split are measured from here. */
  now: number;
  /** Recency half-life in days, or null for unweighted. */
  halfLifeDays: number | null;
  /** Plies per game (default OPENING_PLY_LIMIT). */
  maxPly?: number;
  /** Names and book markers; without it every name is null. */
  book?: OpeningBook;
}

export interface TreeTrend {
  days: number;
  recentN: number;
  /** Raw score of the recent games, or null if none. */
  recentScore: number | null;
  olderN: number;
  olderScore: number | null;
}

export interface ThinkTime {
  /** Owner moves with clock data. */
  n: number;
  avgMs: number;
  /** Average share of the base time spent on the move (null without a base time). */
  avgShareOfBase: number | null;
}

export interface TreeEdge {
  san: string;
  uci: string;
  toEpd: string;
  /** True when the owner played this move. */
  owner: boolean;
  /** Raw games that played this move here. */
  n: number;
  wins: number;
  draws: number;
  losses: number;
  /** Unweighted results (score, Elo expectation, delta, Wilson CI on n, z). */
  raw: ScoreSummary;
  /** Recency-weighted results (Wilson CI on the effective n); equal to raw when unweighted. */
  weighted: ScoreSummary;
  lowSample: boolean;
  trend: TreeTrend;
  /** Owner moves only. */
  thinkTime: ThinkTime | null;
  /** Name of the position the move reaches (see TreeNode.name). */
  name: string | null;
  eco: string | null;
  nameExact: boolean;
  /** The position the move reaches is on a book line. */
  inBook: boolean;
  /** Newest first. */
  gameIds: string[];
}

export interface TreeNode {
  epd: string;
  /** Fewest plies from the start at which the games reached this position. */
  ply: number;
  ownerToMove: boolean;
  /** Games that reached this position (each game once). */
  n: number;
  /** Games whose walk ended here: out of plies, the game ended, or the next move repeated a position. */
  ended: number;
  wN: number;
  ess: number;
  /**
   * The book name: the position's own name if it is named (nameExact), otherwise the deepest
   * name the games passed on the way here (the most common one, if move orders differ).
   */
  name: string | null;
  eco: string | null;
  nameExact: boolean;
  inBook: boolean;
  /** Sorted by raw n, then weighted n, then SAN. */
  edges: TreeEdge[];
}

export interface OpeningTree {
  color: PlayerColor;
  now: number;
  halfLifeDays: number | null;
  maxPly: number;
  /** Games of this colour in the tree. */
  games: number;
  nodes: Map<string, TreeNode>;
  /** Games whose walk stopped early because a move returned to a position already seen. */
  repetitionStops: number;
}

interface EdgeAcc {
  san: string;
  uci: string;
  toEpd: string;
  owner: boolean;
  wins: number;
  draws: number;
  losses: number;
  raw: ScoreAccumulator;
  weighted: ScoreAccumulator;
  recentN: number;
  recentS: number;
  olderN: number;
  olderS: number;
  spentN: number;
  spentMs: number;
  shareN: number;
  shareSum: number;
  gameIds: string[];
}

interface NodeAcc {
  epd: string;
  ply: number;
  n: number;
  ended: number;
  sumW: number;
  sumW2: number;
  /** "eco\tname" of the deepest name on the way here -> games. */
  inherited: Map<string, number>;
  edges: Map<string, EdgeAcc>;
}

function sideToMove(epd: string): PlayerColor {
  return epd.split(" ")[1] === "b" ? "black" : "white";
}

const NO_NAME = "";

export function buildTree(games: readonly TreeGame[], options: BuildTreeOptions): OpeningTree {
  const { color, now, halfLifeDays, book } = options;
  const maxPly = options.maxPly ?? OPENING_PLY_LIMIT;
  const nodes = new Map<string, NodeAcc>();
  let repetitionStops = 0;

  const nodeAt = (epd: string, ply: number): NodeAcc => {
    let node = nodes.get(epd);
    if (!node) {
      node = { epd, ply, n: 0, ended: 0, sumW: 0, sumW2: 0, inherited: new Map(), edges: new Map() };
      nodes.set(epd, node);
    }
    node.ply = Math.min(node.ply, ply);
    return node;
  };

  // The root exists even with no games, so an empty filter still has a start node.
  nodeAt(START_EPD, 0);

  // Newest first, so every edge's game ids come out newest first.
  const ordered = games.filter((game) => game.color === color).sort((a, b) => b.endTime - a.endTime || (a.id < b.id ? 1 : -1));

  for (const game of ordered) {
    const w = recencyWeight(ageDays(game.endTime, now), halfLifeDays);
    const e = eloExpected(game.myRating, game.oppRating);
    const s = game.score;
    const recent = ageDays(game.endTime, now) <= TREND_DAYS;
    const visited = new Set<string>([START_EPD]);
    let inheritedName = NO_NAME;

    let node = nodeAt(START_EPD, 0);
    node.n += 1;
    node.sumW += w;
    node.sumW2 += w * w;
    node.inherited.set(inheritedName, (node.inherited.get(inheritedName) ?? 0) + 1);

    for (const [index, ply] of game.plies.slice(0, maxPly).entries()) {
      if (ply.epdBefore !== node.epd) {
        throw new Error(`Game ${game.id}: ply ${index + 1} does not start from the previous position`);
      }
      if (visited.has(ply.epdAfter)) {
        // Count each position once per game: stop at the first move that repeats one.
        repetitionStops += 1;
        break;
      }
      visited.add(ply.epdAfter);

      let edge = node.edges.get(ply.uci);
      if (!edge) {
        edge = {
          san: ply.san,
          uci: ply.uci,
          toEpd: ply.epdAfter,
          owner: sideToMove(node.epd) === color,
          wins: 0,
          draws: 0,
          losses: 0,
          raw: emptyAccumulator(),
          weighted: emptyAccumulator(),
          recentN: 0,
          recentS: 0,
          olderN: 0,
          olderS: 0,
          spentN: 0,
          spentMs: 0,
          shareN: 0,
          shareSum: 0,
          gameIds: []
        };
        node.edges.set(ply.uci, edge);
      }
      if (s === 1) {
        edge.wins += 1;
      } else if (s === 0.5) {
        edge.draws += 1;
      } else {
        edge.losses += 1;
      }
      addGame(edge.raw, 1, s, e);
      addGame(edge.weighted, w, s, e);
      if (recent) {
        edge.recentN += 1;
        edge.recentS += s;
      } else {
        edge.olderN += 1;
        edge.olderS += s;
      }
      if (edge.owner && ply.spentMs !== null) {
        edge.spentN += 1;
        edge.spentMs += ply.spentMs;
        if (game.baseMs) {
          edge.shareN += 1;
          edge.shareSum += ply.spentMs / game.baseMs;
        }
      }
      edge.gameIds.push(game.id);

      const named = book?.named.get(ply.epdAfter);
      if (named) {
        inheritedName = `${named.eco}\t${named.name}`;
      }
      node = nodeAt(ply.epdAfter, index + 1);
      node.n += 1;
      node.sumW += w;
      node.sumW2 += w * w;
      node.inherited.set(inheritedName, (node.inherited.get(inheritedName) ?? 0) + 1);
    }
    node.ended += 1;
  }

  const finalNodes = new Map<string, TreeNode>();
  for (const acc of nodes.values()) {
    finalNodes.set(acc.epd, finishNode(acc, color, halfLifeDays, book));
  }
  // An edge's name is the name of the node it leads to.
  for (const node of finalNodes.values()) {
    for (const edge of node.edges) {
      const target = finalNodes.get(edge.toEpd)!;
      edge.name = target.name;
      edge.eco = target.eco;
      edge.nameExact = target.nameExact;
      edge.inBook = target.inBook;
    }
  }

  return { color, now, halfLifeDays, maxPly, games: ordered.length, nodes: finalNodes, repetitionStops };
}

function finishNode(acc: NodeAcc, color: PlayerColor, halfLifeDays: number | null, book: OpeningBook | undefined): TreeNode {
  const exact = book?.named.get(acc.epd);
  let name: string | null = exact?.name ?? null;
  let eco: string | null = exact?.eco ?? null;
  if (!exact) {
    let best = NO_NAME;
    let bestCount = 0;
    for (const [key, count] of acc.inherited) {
      if (key !== NO_NAME && (count > bestCount || (count === bestCount && key < best))) {
        best = key;
        bestCount = count;
      }
    }
    if (best !== NO_NAME) {
      [eco, name] = best.split("\t");
    }
  }

  const edges = [...acc.edges.values()].map((edge) => finishEdge(edge, halfLifeDays));
  edges.sort((a, b) => b.n - a.n || b.weighted.wN - a.weighted.wN || (a.san < b.san ? -1 : a.san > b.san ? 1 : 0));

  return {
    epd: acc.epd,
    ply: acc.ply,
    ownerToMove: sideToMove(acc.epd) === color,
    n: acc.n,
    ended: acc.ended,
    wN: acc.sumW,
    ess: acc.sumW2 > 0 ? (acc.sumW * acc.sumW) / acc.sumW2 : 0,
    name,
    eco,
    nameExact: Boolean(exact),
    inBook: book?.positions.has(acc.epd) ?? false,
    edges
  };
}

function finishEdge(acc: EdgeAcc, halfLifeDays: number | null): TreeEdge {
  const raw = summarize(acc.raw);
  return {
    san: acc.san,
    uci: acc.uci,
    toEpd: acc.toEpd,
    owner: acc.owner,
    n: acc.raw.n,
    wins: acc.wins,
    draws: acc.draws,
    losses: acc.losses,
    raw,
    weighted: halfLifeDays === null ? raw : summarize(acc.weighted),
    lowSample: isLowSample(acc.raw.n),
    trend: {
      days: TREND_DAYS,
      recentN: acc.recentN,
      recentScore: acc.recentN ? acc.recentS / acc.recentN : null,
      olderN: acc.olderN,
      olderScore: acc.olderN ? acc.olderS / acc.olderN : null
    },
    thinkTime: acc.owner && acc.spentN
      ? { n: acc.spentN, avgMs: acc.spentMs / acc.spentN, avgShareOfBase: acc.shareN ? acc.shareSum / acc.shareN : null }
      : null,
    name: null,
    eco: null,
    nameExact: false,
    inBook: false,
    gameIds: acc.gameIds
  };
}

/** A stored game and its opening plies as a TreeGame; `myRating` defaults to the post-game rating. */
export function treeGameFrom(record: GameRecord, plies: readonly OpeningPly[], myRating: number = record.myRating): TreeGame {
  return {
    id: record.id,
    endTime: record.endTime,
    color: record.color,
    score: record.score,
    myRating,
    oppRating: record.oppRating,
    baseMs: record.tc ? record.tc.base * 1000 : null,
    plies: plies.map(({ san, uci, epdBefore, epdAfter, spentMs }) => ({ san, uci, epdBefore, epdAfter, spentMs }))
  };
}

export interface MovesWalk {
  /** The node the moves reach, or undefined if the games never got there. */
  node: TreeNode | undefined;
  /** One breadcrumb per move that the games played. */
  path: TreeBreadcrumb[];
  /** Index of the first move no game played from its position, or null. */
  missingAt: number | null;
}

/** Follows UCI moves from the start through the tree, collecting breadcrumbs. */
export function walkMoves(tree: OpeningTree, ucis: readonly string[]): MovesWalk {
  let node = tree.nodes.get(START_EPD);
  const path: TreeBreadcrumb[] = [];
  for (const [index, uci] of ucis.entries()) {
    const edge = node?.edges.find((candidate) => candidate.uci === uci);
    if (!edge) {
      return { node: undefined, path, missingAt: index };
    }
    path.push({
      ply: index + 1,
      san: edge.san,
      uci: edge.uci,
      epd: edge.toEpd,
      n: edge.n,
      name: edge.name,
      eco: edge.eco,
      nameExact: edge.nameExact
    });
    node = tree.nodes.get(edge.toEpd);
  }
  return { node, path, missingAt: null };
}

/** The node reached from the start by a list of UCI moves, or undefined if the games never got there. */
export function nodeByMoves(tree: OpeningTree, ucis: readonly string[]): TreeNode | undefined {
  return walkMoves(tree, ucis).node;
}

/** A node as the API sends it: every edge without its game ids. */
export function nodeView(node: TreeNode): TreeNodeView {
  return { ...node, edges: node.edges.map(({ gameIds: _gameIds, ...edge }) => edge) };
}

/**
 * The owner's pre-game rating per game id: the post-game rating of his previous game in the
 * same time class (Chess.com reports post-game ratings only). A time class's first game keeps
 * its own post-game rating.
 */
export function preGameRatings(
  games: readonly { id: string; timeClass: string; endTime: number; myRating: number }[]
): Map<string, number> {
  const ordered = [...games].sort((a, b) => a.endTime - b.endTime || (a.id < b.id ? -1 : 1));
  const last = new Map<string, number>();
  const result = new Map<string, number>();
  for (const game of ordered) {
    result.set(game.id, last.get(game.timeClass) ?? game.myRating);
    last.set(game.timeClass, game.myRating);
  }
  return result;
}
