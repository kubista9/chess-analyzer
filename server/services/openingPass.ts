import { MOVE_CATEGORIES, OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { classifyLoss, isOpeningError, moveAccuracy, rootMoveLoss, toWhiteEval, winPercentFor } from "../../shared/eval.js";
import type {
  EngineLine,
  EngineTier,
  GameOpeningSummary,
  MoveCategory,
  OpeningMoveVerdict,
  OpeningSideSummary,
  OwnerViewEval,
  PlayerColor,
  PositionEval
} from "../../shared/types.js";
import type { Db } from "../db/connection.js";
import { recordGameAnalysis } from "../db/gameAnalysis.js";
import { getPositionEval, putPositionEval } from "../db/positions.js";
import { lineFor, type PositionRequest } from "../engine/analysePosition.js";
import type { EnginePool, Priority } from "../engine/pool.js";

// The opening pass: a game's positions 0..L-1 (L = min(OPENING_PLY_LIMIT, its length)),
// position i being the one before ply i + 1. The owner's positions get the owner tier, the
// opponent's the opponent tier, and each position's played move is scored at that root.
// Evals come from the position cache first; only what the cache cannot answer goes to the
// engine pool, and every result is stored as soon as it arrives, so an interrupted game is
// redone from the cache. A game's game_analysis row is written only once all its positions
// are answered (the INCREMENTAL RULE then skips it for good under this config).

/** Plies after which the summary records the eval (those the game reaches). */
export const SUMMARY_EVAL_PLIES = [12, 16, 20] as const;

export interface OpeningPosition {
  /** 0-based: the position before ply index + 1. */
  index: number;
  ply: number;
  epd: string;
  mover: PlayerColor;
  tier: EngineTier;
  /** UCI moves from the start position to this position. */
  moves: string[];
  /** The move the game played here. */
  played: string;
  san: string;
}

export interface OpeningMove {
  uci: string;
  san: string;
  epdBefore: string;
}

/** A game's opening positions (at most `limit`), from its moves and the owner's colour. */
export function openingPositions(moves: readonly OpeningMove[], ownerColor: PlayerColor, limit = OPENING_PLY_LIMIT): OpeningPosition[] {
  const ucis = moves.map((move) => move.uci);
  return moves.slice(0, limit).map((move, index) => {
    const mover: PlayerColor = index % 2 === 0 ? "white" : "black";
    return {
      index,
      ply: index + 1,
      epd: move.epdBefore,
      mover,
      tier: mover === ownerColor ? "owner" : "opponent",
      moves: ucis.slice(0, index),
      played: move.uci,
      san: move.san
    };
  });
}

/** The cache key of a position request: one per (tier, EPD). */
export function positionKey(position: Pick<OpeningPosition, "tier" | "epd">): string {
  return `${position.tier}|${position.epd}`;
}

/** Whether a stored eval answers a position: it has lines (or is terminal) and scores every move in `played`. */
export function isAnswered(evaluation: PositionEval | undefined, played: Iterable<string>): boolean {
  if (!evaluation) {
    return false;
  }
  if (evaluation.terminal) {
    return true;
  }
  if (!evaluation.lines.length) {
    return false;
  }
  for (const uci of played) {
    if (!lineFor(evaluation, uci)) {
      return false;
    }
  }
  return true;
}

export interface OpeningItem {
  position: OpeningPosition;
  /** Every move to score at this root (the game's own move, or all moves played from the EPD). */
  played: readonly string[];
}

export interface EvaluatedInfo {
  /** False when the cache answered the position without a search. */
  searched: boolean;
  /** Nodes searched for this position now (0 when cached). */
  nodes: number;
}

export interface EvaluateOptions {
  priority: Priority;
  onProgress?: (done: number, total: number) => void;
  /** Called once per item, as its eval is known (cache hits first, then searches as they finish). */
  onEvaluated?: (index: number, evaluation: PositionEval, info: EvaluatedInfo) => void;
}

export interface OpeningDeps {
  db: Db;
  pool: Pick<EnginePool, "analyseGame">;
  configId: number;
}

/**
 * Evals for `items`, in order: the position cache answers what it can, the pool searches the
 * rest as one group (a partial row is passed as `cached`, so only its missing moves are
 * searched), and each result is stored at once.
 */
export async function evaluateOpening(
  deps: OpeningDeps,
  groupId: string,
  items: readonly OpeningItem[],
  options: EvaluateOptions
): Promise<PositionEval[]> {
  const evals: (PositionEval | undefined)[] = new Array(items.length);
  const pending: { index: number; request: PositionRequest; cachedNodes: number }[] = [];

  for (const [index, item] of items.entries()) {
    const stored = getPositionEval(deps.db, deps.configId, item.position.epd, item.position.tier);
    if (stored && isAnswered(stored, item.played)) {
      evals[index] = stored;
      options.onEvaluated?.(index, stored, { searched: false, nodes: 0 });
    } else {
      pending.push({
        index,
        request: { moves: item.position.moves, tier: item.position.tier, played: item.played, cached: stored ?? null },
        cachedNodes: stored?.lines.length ? stored.nodes : 0
      });
    }
  }

  const answered = items.length - pending.length;
  options.onProgress?.(answered, items.length);
  if (pending.length) {
    await deps.pool.analyseGame(
      groupId,
      pending.map((entry) => entry.request),
      {
        priority: options.priority,
        onProgress: (done) => options.onProgress?.(answered + done, items.length),
        onResult: (slot, evaluation) => {
          const entry = pending[slot];
          putPositionEval(deps.db, deps.configId, evaluation);
          evals[entry.index] = evaluation;
          options.onEvaluated?.(entry.index, evaluation, { searched: true, nodes: Math.max(0, evaluation.nodes - entry.cachedNodes) });
        }
      }
    );
  }

  return evals.map((evaluation, index) => {
    if (!evaluation) {
      throw new Error(`Position ${items[index].position.epd} was not evaluated`);
    }
    return evaluation;
  });
}

interface Verdict extends OpeningMoveVerdict {
  mover: PlayerColor;
  line: EngineLine;
  rawLoss: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sideSummary(verdicts: Verdict[]): OpeningSideSummary {
  const categories = Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, 0])) as Record<MoveCategory, number>;
  let worst: Verdict | null = null;
  for (const verdict of verdicts) {
    categories[verdict.category] += 1;
    if (!worst || verdict.rawLoss > worst.rawLoss) {
      worst = verdict;
    }
  }
  const strip = (verdict: Verdict | null | undefined): OpeningMoveVerdict | null =>
    verdict ? { ply: verdict.ply, san: verdict.san, uci: verdict.uci, lossWinPct: verdict.lossWinPct, category: verdict.category } : null;
  const n = verdicts.length;
  return {
    moves: n,
    categories,
    avgLoss: n ? round2(verdicts.reduce((sum, verdict) => sum + verdict.rawLoss, 0) / n) : 0,
    accuracy: n ? round2(verdicts.reduce((sum, verdict) => sum + moveAccuracy(verdict.rawLoss), 0) / n) : 0,
    firstError: strip(verdicts.find((verdict) => isOpeningError(verdict.category))),
    worst: strip(worst)
  };
}

/**
 * A game's opening summary from its positions and their evals (evals[i] answers positions[i]).
 * Every played move is judged at its own root; the eval after ply N is the played move's
 * score at that root, from the owner's side.
 */
export function summariseOpening(
  positions: readonly OpeningPosition[],
  evals: readonly PositionEval[],
  ownerColor: PlayerColor
): GameOpeningSummary {
  if (evals.length !== positions.length) {
    throw new Error(`Expected ${positions.length} evals, got ${evals.length}`);
  }
  const verdicts: Verdict[] = positions.map((position, index) => {
    const evaluation = evals[index];
    const best = evaluation.lines[0];
    const line = lineFor(evaluation, position.played);
    if (!best || !line) {
      throw new Error(`${position.san} at ply ${position.ply} is not scored`);
    }
    const rawLoss = rootMoveLoss(best, line);
    return {
      ply: position.ply,
      san: position.san,
      uci: position.played,
      lossWinPct: round2(rawLoss),
      category: classifyLoss(rawLoss),
      mover: position.mover,
      line,
      rawLoss
    };
  });

  const evalAfter: OwnerViewEval[] = SUMMARY_EVAL_PLIES.filter((ply) => ply <= verdicts.length).map((ply) => {
    const verdict = verdicts[ply - 1];
    const white = toWhiteEval(verdict.line, verdict.mover);
    const sign = ownerColor === "white" ? 1 : -1;
    return {
      ply,
      cp: sign * white.cp,
      mate: white.mate === null ? null : sign * white.mate,
      winPct: round2(winPercentFor(white, ownerColor))
    };
  });

  return {
    version: 1,
    color: ownerColor,
    plies: positions.length,
    owner: sideSummary(verdicts.filter((verdict) => verdict.mover === ownerColor)),
    opponent: sideSummary(verdicts.filter((verdict) => verdict.mover !== ownerColor)),
    evalAfter
  };
}

/**
 * Writes the game's game_analysis row from the stored evals, if every position is answered
 * in the store. Returns the summary, or null (nothing written) when a position is missing,
 * e.g. because another writer replaced its row meanwhile; the game then stays queued.
 */
export function recordOpeningFromStore(
  db: Db,
  configId: number,
  gameId: string,
  positions: readonly OpeningPosition[],
  ownerColor: PlayerColor,
  now = Date.now()
): GameOpeningSummary | null {
  const evals: PositionEval[] = [];
  for (const position of positions) {
    const stored = getPositionEval(db, configId, position.epd, position.tier);
    if (!stored || !isAnswered(stored, [position.played])) {
      return null;
    }
    evals.push(stored);
  }
  const summary = summariseOpening(positions, evals, ownerColor);
  recordGameAnalysis(db, { gameId, configId, plies: positions.length, analyzedAt: now, summary });
  return summary;
}
