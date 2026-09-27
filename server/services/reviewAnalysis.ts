import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { toEpd } from "../../shared/epd.js";
import type { PositionEval, ReviewSummary } from "../../shared/types.js";
import { config } from "../config.js";
import type { Db } from "../db/connection.js";
import { getGameAnalysis } from "../db/gameAnalysis.js";
import { getGame, getGamePgn } from "../db/games.js";
import { getPositionEval } from "../db/positions.js";
import type { EnginePool } from "../engine/pool.js";
import { parseGame, type ParsedMove } from "./gameParser.js";
import { evaluateOpening, isAnswered, openingPositions, recordOpeningFromStore, type OpeningPosition } from "./openingPass.js";
import { annotateMoves, reviewHeader } from "./reviewMoves.js";

// Interim opening review (P6 replaces it): the first OPENING_PLY_LIMIT plies under the
// current engine config. Each position comes from the position cache when it is there (a
// backfilled game's review needs no engine at all); the rest runs on the engine pool at
// interactive priority, ahead of any backfill, and is stored as it arrives. Once every
// position is answered the game also gets its game_analysis row, so the backfill skips it.

interface ReviewGame {
  gameId: string;
  moves: ParsedMove[];
  positions: OpeningPosition[];
  build: (evals: PositionEval[]) => ReviewSummary;
}

function loadReviewGame(db: Db, gameId: string): ReviewGame {
  const game = getGame(db, gameId);
  const pgn = getGamePgn(db, gameId);
  if (!game || !pgn) {
    throw new Error(`Game ${gameId} is not in the game store. Sync from Home first.`);
  }
  const moves = parseGame(pgn).moves.slice(0, OPENING_PLY_LIMIT);
  if (!moves.length) {
    throw new Error(`Game ${gameId} has no moves to review.`);
  }
  const positions = openingPositions(
    moves.map((move) => ({ uci: move.uci, san: move.san, epdBefore: toEpd(move.fenBefore) })),
    game.color
  );
  return {
    gameId: game.id,
    moves,
    positions,
    build: (evals) => ({
      gameId: game.id,
      color: game.color,
      header: reviewHeader(game, config.owner),
      moves: annotateMoves(moves, evals, game.color)
    })
  };
}

function recordIfNew(db: Db, configId: number, review: ReviewGame, color: ReviewSummary["color"]): void {
  if (!getGameAnalysis(db, review.gameId, configId)) {
    recordOpeningFromStore(db, configId, review.gameId, review.positions, color);
  }
}

/** The review built from the position cache alone, or null when a position still needs the engine. */
export function cachedGameReview(db: Db, gameId: string, configId: number): ReviewSummary | null {
  const review = loadReviewGame(db, gameId);
  const evals: PositionEval[] = [];
  for (const position of review.positions) {
    const stored = getPositionEval(db, configId, position.epd, position.tier);
    if (!stored || !isAnswered(stored, [position.played])) {
      return null;
    }
    evals.push(stored);
  }
  const summary = review.build(evals);
  recordIfNew(db, configId, review, summary.color);
  return summary;
}

/** Reviews a stored game's opening: the cache first, the pool (interactive) for the rest. */
export async function runGameReview(
  db: Db,
  pool: Pick<EnginePool, "analyseGame">,
  configId: number,
  gameId: string,
  onProgress?: (done: number, total: number) => void
): Promise<ReviewSummary> {
  const review = loadReviewGame(db, gameId);
  const evals = await evaluateOpening(
    { db, pool, configId },
    `review:${gameId}`,
    review.positions.map((position) => ({ position, played: [position.played] })),
    { priority: "interactive", onProgress }
  );
  const summary = review.build(evals);
  recordIfNew(db, configId, review, summary.color);
  return summary;
}
