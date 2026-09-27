import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { ReviewSummary } from "../../shared/types.js";
import { config } from "../config.js";
import { REVIEW_SCHEMA_VERSION, reviewCachePath } from "../store/cachePaths.js";
import { readVersionedJson, writeVersionedJson } from "../store/fileStore.js";
import type { Db } from "../db/connection.js";
import { getGame, getGamePgn } from "../db/games.js";
import { parseGame } from "./gameParser.js";
import { getEnginePool } from "../engine/sharedPool.js";
import { annotateMoves, reviewHeader, reviewRequests } from "./reviewMoves.js";

// Interim opening review (a thin adapter until P4b/P6): the first OPENING_PLY_LIMIT plies on
// the engine pool at interactive priority, under the fixed-depth protocol. Each move's loss
// is measured at its own root (best line vs the played move, depth-matched searchmoves).
// Results are not written to the position cache yet (P4b). Cached in reviews-v3.

export async function readCachedGameReview(gameId: string): Promise<ReviewSummary | null> {
  return readVersionedJson<ReviewSummary>(
    reviewCachePath(config.cacheDir, config.owner, gameId),
    REVIEW_SCHEMA_VERSION
  );
}

/** Reviews a stored game's opening. The game and its full PGN come from the game store. */
export async function runGameReview(
  db: Db,
  gameId: string,
  onProgress?: (done: number, total: number) => void
): Promise<ReviewSummary> {
  const username = config.owner;
  const cached = await readCachedGameReview(gameId);
  if (cached) {
    return cached;
  }

  const game = getGame(db, gameId);
  const pgn = getGamePgn(db, gameId);
  if (!game || !pgn) {
    throw new Error(`Game ${gameId} is not in the game store. Sync from Home first.`);
  }

  const playerColor = game.color;
  const moves = parseGame(pgn).moves.slice(0, OPENING_PLY_LIMIT);
  if (!moves.length) {
    throw new Error(`Game ${gameId} has no moves to review.`);
  }

  const requests = reviewRequests(
    moves.map((move) => move.uci),
    playerColor
  );
  const evals = await getEnginePool().analyseGame(`review:${game.id}`, requests, { priority: "interactive", onProgress });

  const review: ReviewSummary = {
    gameId: game.id,
    color: playerColor,
    header: reviewHeader(game, username),
    moves: annotateMoves(moves, evals, playerColor)
  };

  await writeVersionedJson(reviewCachePath(config.cacheDir, username, gameId), REVIEW_SCHEMA_VERSION, review);
  return review;
}
