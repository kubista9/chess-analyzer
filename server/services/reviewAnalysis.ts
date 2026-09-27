import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { ReviewSummary } from "../../shared/types.js";
import { config } from "../config.js";
import { REVIEW_SCHEMA_VERSION, reviewCachePath } from "../store/cachePaths.js";
import { readVersionedJson, writeVersionedJson } from "../store/fileStore.js";
import type { Db } from "../db/connection.js";
import { getGame, getGamePgn } from "../db/games.js";
import { parseGame } from "./gameParser.js";
import { analysisFromLines, annotateMoves, reviewHeader, terminalAnalysis, type PositionAnalysis } from "./reviewMoves.js";
import { StockfishSession } from "./stockfish.js";

// Interim opening review: the first OPENING_PLY_LIMIT plies, one movetime search per
// position (P4 replaces the engine protocol). Cached in reviews-v2 with a schemaVersion.

const REVIEW_MULTI_PV = 2;

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

  // Every position from before the first move to after the last reviewed move. The eval
  // after ply N is the eval before ply N + 1, so the eval bar never jumps between plies.
  const positions = [moves[0].fenBefore, ...moves.map((move) => move.fenAfter)];
  const session = new StockfishSession();

  try {
    await session.initialize();
    const analyses: PositionAnalysis[] = [];
    for (const fen of positions) {
      onProgress?.(analyses.length, positions.length);
      const terminal = terminalAnalysis(fen);
      if (terminal) {
        analyses.push(terminal);
        continue;
      }

      const lines = await session.analyzePosition({
        fen,
        multiPv: REVIEW_MULTI_PV,
        moveTimeMs: config.reviewMoveTimeMs
      });
      analyses.push(analysisFromLines(fen, lines));
    }

    const review: ReviewSummary = {
      gameId: game.id,
      color: playerColor,
      header: reviewHeader(game, username),
      moves: annotateMoves(moves, analyses, playerColor)
    };

    await writeVersionedJson(reviewCachePath(config.cacheDir, username, gameId), REVIEW_SCHEMA_VERSION, review);
    return review;
  } finally {
    session.close();
  }
}
