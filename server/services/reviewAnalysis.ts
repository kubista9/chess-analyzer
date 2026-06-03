import path from "node:path";
import {
  average,
  calculateAccuracy,
  categorizeMove,
  normalizeResult
} from "../../shared/chess.js";
import type {
  AnnotatedMove,
  HistoryGameSummary,
  ReviewSummary
} from "../../shared/types.js";
import { config } from "../config.js";
import { readJsonFile, safeKey, writeJsonFile } from "../store/fileStore.js";
import { findGameForUser } from "./chessCom.js";
import { parseGame, pieceValue, playerColorForGame } from "./gameParser.js";
import { buildKeyThemes, buildSideSummary, noteForCategory } from "./batchAnalysis.js";
import { StockfishSession } from "./stockfish.js";

function reviewCachePath(username: string, gameId: string): string {
  return path.join(config.cacheDir, "reviews", safeKey(username), `${safeKey(gameId)}.json`);
}

export async function readCachedGameReview(username: string, gameId: string): Promise<ReviewSummary | null> {
  return readJsonFile<ReviewSummary>(reviewCachePath(username, gameId));
}

export async function runGameReview(
  username: string,
  gameId: string,
  fallbackGameSummary: HistoryGameSummary | null = null
): Promise<ReviewSummary> {
  const cachePath = reviewCachePath(username, gameId);
  const cached = await readCachedGameReview(username, gameId);
  if (cached) {
    return cached;
  }

  const game = await findGameForUser(username, gameId);
  if (!game) {
    throw new Error(`Could not find game ${gameId} for ${username}. Run bulk analysis first.`);
  }

  const parsed = parseGame(game);
  const playerColor = playerColorForGame(game, username);
  const session = new StockfishSession();
  await session.initialize();

  try {
    const annotatedMoves: AnnotatedMove[] = [];

    for (const move of parsed.moves) {
      const bestLines = await session.analyzePosition({
        fen: move.fenBefore,
        multiPv: 4,
        moveTimeMs: config.reviewMoveTimeMs
      });
      const replyLines = await session.analyzePosition({
        fen: move.fenAfter,
        multiPv: 1,
        moveTimeMs: config.reviewReplyTimeMs
      });

      const bestLine = bestLines[0];
      const replyLine = replyLines[0];
      if (!bestLine || !replyLine) {
        continue;
      }

      const scoreBeforeCp = bestLine.scoreCp;
      const scoreAfterCp = -replyLine.scoreCp;
      const lossCp = Math.max(0, scoreBeforeCp - scoreAfterCp);
      const secondLine = bestLines[1];
      const bestGapCp = secondLine ? Math.abs(bestLine.scoreCp - secondLine.scoreCp) : null;
      const category = categorizeMove({
        lossCp,
        bestGapCp,
        isOnlyMove: (bestGapCp ?? 0) >= 140,
        isSacrificeLike: pieceValue(move.piece) - pieceValue(move.captured) >= 2 && !move.san.includes("="),
        resultingScoreCp: scoreAfterCp,
        preScoreCp: scoreBeforeCp
      });

      annotatedMoves.push({
        ply: move.ply,
        moveNumber: move.moveNumber,
        san: move.san,
        uci: move.uci,
        color: move.color,
        phase: move.phase,
        category,
        scoreBeforeCp,
        scoreAfterCp,
        lossCp,
        bestLine,
        alternativeLines: bestLines.slice(1),
        fenBefore: move.fenBefore,
        fenAfter: move.fenAfter,
        note: noteForCategory(category, lossCp),
        isPlayerMove: move.color === playerColor
      });
    }

    let gameSummary = fallbackGameSummary;
    if (!gameSummary) {
      const whiteMoves = annotatedMoves.filter((move) => move.color === "white");
      const playerMoves = annotatedMoves.filter((move) => move.color === playerColor);
      const phaseLosses = {
        opening: playerMoves.filter((move) => move.phase === "opening").map((move) => move.lossCp),
        middlegame: playerMoves.filter((move) => move.phase === "middlegame").map((move) => move.lossCp),
        endgame: playerMoves.filter((move) => move.phase === "endgame").map((move) => move.lossCp)
      };
      const categories = playerMoves.reduce(
        (accumulator, move) => {
          accumulator[move.category] += 1;
          return accumulator;
        },
        {
          brilliant: 0,
          great: 0,
          best: 0,
          good: 0,
          mistake: 0,
          miss: 0,
          blunder: 0
        }
      );

      const player = playerColor === "white" ? game.white : game.black;
      const opponent = playerColor === "white" ? game.black : game.white;
      const avgCentipawnLoss = average(playerMoves.map((move) => move.lossCp)) ?? 0;

      gameSummary = {
        id: game.id,
        url: game.url,
        opponent: opponent.username,
        opponentRating: opponent.rating,
        playerRating: player.rating,
        color: playerColor,
        result: normalizeResult(playerColor, game.white.result, game.black.result),
        openingName: game.openingName,
        openingFamily: game.openingFamily,
        endTime: game.endTime,
        moves: annotatedMoves.length,
        timeClass: game.timeClass,
        accuracy: calculateAccuracy(avgCentipawnLoss),
        avgCentipawnLoss,
        categories,
        phaseAccuracy: {
          opening: calculateAccuracy(average(phaseLosses.opening)),
          middlegame: calculateAccuracy(average(phaseLosses.middlegame)),
          endgame: calculateAccuracy(average(phaseLosses.endgame))
        },
        phaseSignals: {
          opening: "solid",
          middlegame: "solid",
          endgame: "solid"
        },
        criticalMoments: categories.blunder + categories.mistake + categories.miss,
        firstMajorErrorPly:
          playerMoves.find((move) => ["mistake", "miss", "blunder"].includes(move.category))?.ply ?? null,
        winProbabilitySwing: average(playerMoves.map((move) => move.lossCp / 10))
      };
    }

    const review: ReviewSummary = {
      game: gameSummary,
      white: buildSideSummary(annotatedMoves, "white"),
      black: buildSideSummary(annotatedMoves, "black"),
      moves: annotatedMoves,
      keyThemes: buildKeyThemes(gameSummary, annotatedMoves)
    };

    await writeJsonFile(cachePath, review);
    return review;
  } finally {
    session.close();
  }
}
