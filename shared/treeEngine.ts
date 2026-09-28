import { classifyLoss, isOpeningError, scoreWinPercent } from "./eval.js";
import { START_EPD } from "./epd.js";
import {
  coverageOk,
  errorKnownThrough,
  meanEvalAt,
  rootVerdict,
  round2,
  sanOf,
  topFirstMistakes,
  whitePoint,
  type EvalLookup,
  type FirstMistake,
  type GameOpeningAnalysis,
  type OwnerMoveScored,
  type Pending,
  type WhiteEvalPoint
} from "./openingAnalysis.js";
import type { TreeEdge, TreeGame, TreeNode } from "./openingTree.js";
import type { MoveCategory, PlayerColor } from "./types.js";

// Engine fields for the Explorer: per move row (eval after it, loss, class, engine-best star)
// and per position (eval, the engine's move, first-error hotspots, the eval at move 10), from
// the position cache and the per-game analyses. Computed per request for one node.

/** The hotspot looks at the owner's next this-many moves from a position. */
export const HOTSPOT_OWNER_MOVES = 3;
/** The eval "at move 10" is the one after this ply. */
export const NODE_EVAL_PLY = 20;

export type EdgeEngine =
  | { status: "pending" }
  | {
      status: "scored";
      /** The eval after the move (its score at this root), from White's side. */
      eval: WhiteEvalPoint;
      /** The mover's win% loss against the engine's best, and its class. */
      loss: number;
      cls: MoveCategory;
      /** The mover's win% after the move. */
      winPlayed: number;
      /** Within the "best" class (loss < 1 win%). */
      isEngineBest: boolean;
      /** Opponent moves come from the shallower MultiPV 1 search: approximate. */
      approx: boolean;
    };

export interface NodeHotspot {
  ownerMoves: number;
  /** The plies the owner's next moves are played at: (fromPly, toPly]. */
  fromPly: number;
  toPly: number;
  /** Games where every owner move up to toPly is scored. */
  known: number;
  /** Of those, games whose first mistake falls in the span. */
  errors: number;
  rate: number | null;
  /** Enough coverage to show the claim (coverageOk). */
  shown: boolean;
  top: FirstMistake[];
}

export interface NodeEngine {
  /** The position's eval from White's side (the engine's best line). */
  eval: WhiteEvalPoint | Pending;
  bestUci: string | null;
  bestSan: string | null;
  /** The side to move's win% with the best move. */
  winBest: number | null;
  /** Games through this position, and those with every ply of their window scored. */
  games: number;
  complete: number;
  hotspot: NodeHotspot;
  /** The owner's mean eval after ply 20 over the games through here where it is known. */
  evalAt20: { known: number; cp: number; winPct: number; shown: boolean } | null;
}

function moverAt(epd: string): PlayerColor {
  return epd.split(" ")[1] === "b" ? "black" : "white";
}

/** The engine fields of one move row. */
export function edgeEngine(node: Pick<TreeNode, "epd" | "ownerToMove">, edge: Pick<TreeEdge, "uci">, lookup: EvalLookup): EdgeEngine {
  const verdict = rootVerdict(lookup(node.epd, node.ownerToMove ? "owner" : "opponent"), edge.uci);
  if (!verdict) {
    return { status: "pending" };
  }
  return {
    status: "scored",
    eval: whitePoint(verdict.played, moverAt(node.epd)),
    loss: round2(verdict.loss),
    cls: classifyLoss(verdict.loss),
    winPlayed: round2(scoreWinPercent(verdict.played)),
    isEngineBest: verdict.loss < 1,
    approx: !node.ownerToMove
  };
}

/** Each game that reaches `epd` within `maxPly` plies, with the plies played before it. */
export function gamesThrough(games: readonly TreeGame[], epd: string, maxPly: number): { game: TreeGame; index: number }[] {
  const result: { game: TreeGame; index: number }[] = [];
  for (const game of games) {
    if (epd === START_EPD) {
      result.push({ game, index: 0 });
      continue;
    }
    const plies = game.plies.slice(0, maxPly);
    const at = plies.findIndex((ply) => ply.epdAfter === epd);
    if (at >= 0) {
      result.push({ game, index: at + 1 });
    }
  }
  return result;
}

/** The engine fields of one position, over the games of the tree that pass through it. */
export function nodeEngine(
  node: Pick<TreeNode, "epd" | "ownerToMove" | "ply">,
  games: readonly TreeGame[],
  analysisOf: (game: TreeGame) => GameOpeningAnalysis,
  lookup: EvalLookup,
  maxPly: number
): NodeEngine {
  const evaluation = lookup(node.epd, node.ownerToMove ? "owner" : "opponent");
  const best = evaluation?.lines[0];
  const through = gamesThrough(games, node.epd, maxPly);
  const analyses = through.map(({ game }) => analysisOf(game));

  // The owner's next HOTSPOT_OWNER_MOVES moves after the position, at the fewest-plies path.
  const fromPly = node.ply;
  const toPly = Math.min(maxPly, fromPly + 2 * HOTSPOT_OWNER_MOVES - (node.ownerToMove ? 1 : 0));
  let known = 0;
  const errors: OwnerMoveScored[] = [];
  for (const [index, analysis] of analyses.entries()) {
    const at = through[index].index;
    const end = Math.min(analysis.plies, at + (toPly - fromPly));
    if (!errorKnownThrough(analysis, end)) {
      continue;
    }
    known += 1;
    const first = analysis.firstOwnerError;
    if (first && first !== "pending" && first.ply > at && first.ply <= end && isOpeningError(first.cls)) {
      errors.push(first);
    }
  }
  const mean = meanEvalAt(analyses, NODE_EVAL_PLY);

  return {
    eval: evaluation && (best || evaluation.terminal) ? whitePoint(evaluation.score, moverAt(node.epd)) : "pending",
    bestUci: best?.uci ?? null,
    bestSan: best ? sanOf(node.epd, best.uci) : null,
    winBest: best ? round2(scoreWinPercent(best)) : null,
    games: through.length,
    complete: analyses.filter((analysis) => analysis.status === "complete").length,
    hotspot: {
      ownerMoves: HOTSPOT_OWNER_MOVES,
      fromPly,
      toPly,
      known,
      errors: errors.length,
      rate: known ? errors.length / known : null,
      shown: coverageOk(known, through.length),
      top: topFirstMistakes(errors)
    },
    evalAt20: mean ? { ...mean, shown: coverageOk(mean.known, through.length) } : null
  };
}
