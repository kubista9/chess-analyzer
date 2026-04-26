import path from "node:path";
import {
  average,
  calculateAccuracy,
  categorizeMove,
  emptyCategoryCounts,
  emptyPhaseMap,
  normalizeResult,
  scoreToWinProbability,
  signalFromAccuracy
} from "../../shared/chess.js";
import type { AnnotatedMove, ArchiveGame, DashboardSnapshot, EngineLine, HistoryGameSummary, PlayerColor } from "../../shared/types.js";
import { noteForCategory } from "../../shared/notes.js";
import { config } from "../config.js";
import { parseGame, pieceValue, playerColorForGame } from "./gameParser.js";
import { StockfishSession } from "./stockfish.js";
import { buildHighlights, buildMetricCards, buildOpeningReport, buildTrainingPlan } from "./trainingPlan.js";
import { fetchRecentGames } from "./chessCom.js";
import { readJsonFile, safeKey, writeJsonFile } from "../store/fileStore.js";

interface BatchProgress {
  completedGames: number;
  totalGames: number;
  message: string;
}

interface CachedScan {
  summary: HistoryGameSummary;
}

function scanCachePath(username: string, gameId: string): string {
  return path.join(config.cacheDir, "scans", safeKey(username), `${safeKey(gameId)}.json`);
}

function snapshotCachePath(username: string, limit: number): string {
  return path.join(config.cacheDir, "snapshots", `${safeKey(username)}-${limit}.json`);
}

function scoreFromPerspective(scoreCp: number, sideToMove: PlayerColor, perspective: PlayerColor): number {
  return sideToMove === perspective ? scoreCp : -scoreCp;
}

function lineGap(lines: EngineLine[]): number | null {
  if (lines.length < 2) {
    return null;
  }

  return Math.abs(lines[0].scoreCp - lines[1].scoreCp);
}

async function buildGameSummary(
  session: StockfishSession,
  username: string,
  game: ArchiveGame
): Promise<HistoryGameSummary> {
  const playerColor = playerColorForGame(game, username);
  const parsed = parseGame(game);
  const playerMoves = parsed.moves.filter((move) => move.color === playerColor);
  const categories = emptyCategoryCounts();
  const lossesByPhase = emptyPhaseMap<number[]>([]);
  const swings: number[] = [];

  let firstMajorErrorPly: number | null = null;

  for (const move of playerMoves) {
    const bestLines = await session.analyzePosition({
      fen: move.fenBefore,
      multiPv: 3,
      moveTimeMs: config.batchMoveTimeMs
    });
    const replyLines = await session.analyzePosition({
      fen: move.fenAfter,
      multiPv: 1,
      moveTimeMs: config.batchReplyTimeMs
    });

    const bestLine = bestLines[0];
    const replyLine = replyLines[0];
    if (!bestLine || !replyLine) {
      continue;
    }

    const beforeScore = scoreFromPerspective(bestLine.scoreCp, move.color, playerColor);
    const afterScore = scoreFromPerspective(replyLine.scoreCp, move.color === "white" ? "black" : "white", playerColor);
    const lossCp = Math.max(0, beforeScore - afterScore);
    const bestGapCp = lineGap(bestLines);
    const onlyMove = (bestGapCp ?? 0) >= 140;
    const isSacrificeLike =
      pieceValue(move.piece) - pieceValue(move.captured) >= 2 && !move.san.includes("=");
    const category = categorizeMove({
      lossCp,
      bestGapCp,
      isOnlyMove: onlyMove,
      isSacrificeLike,
      resultingScoreCp: afterScore,
      preScoreCp: beforeScore
    });

    categories[category] += 1;
    lossesByPhase[move.phase].push(lossCp);
    swings.push(Math.abs(scoreToWinProbability(beforeScore) - scoreToWinProbability(afterScore)) * 100);

    if (firstMajorErrorPly === null && ["mistake", "miss", "blunder"].includes(category)) {
      firstMajorErrorPly = move.ply;
    }
  }

  const avgCentipawnLoss = average(Object.values(lossesByPhase).flat());

  const phaseAccuracy = {
    opening: calculateAccuracy(average(lossesByPhase.opening)),
    middlegame: calculateAccuracy(average(lossesByPhase.middlegame)),
    endgame: calculateAccuracy(average(lossesByPhase.endgame))
  };

  const player = playerColor === "white" ? game.white : game.black;
  const opponent = playerColor === "white" ? game.black : game.white;

  return {
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
    moves: parsed.moves.length,
    timeClass: game.timeClass,
    accuracy: calculateAccuracy(avgCentipawnLoss),
    avgCentipawnLoss,
    categories,
    phaseAccuracy,
    phaseSignals: {
      opening: signalFromAccuracy(phaseAccuracy.opening),
      middlegame: signalFromAccuracy(phaseAccuracy.middlegame),
      endgame: signalFromAccuracy(phaseAccuracy.endgame)
    },
    criticalMoments: categories.blunder + categories.miss + categories.mistake,
    firstMajorErrorPly,
    winProbabilitySwing: average(swings)
  };
}

async function scanOrLoadGameSummary(
  session: StockfishSession,
  username: string,
  game: ArchiveGame
): Promise<HistoryGameSummary> {
  const cachePath = scanCachePath(username, game.id);
  const cached = await readJsonFile<CachedScan>(cachePath);
  if (cached?.summary) {
    return cached.summary;
  }

  const summary = await buildGameSummary(session, username, game);
  await writeJsonFile(cachePath, { summary });
  return summary;
}

export async function runBulkAnalysis(
  username: string,
  limit: number,
  onProgress?: (progress: BatchProgress) => void
): Promise<DashboardSnapshot> {
  const cachePath = snapshotCachePath(username, limit);
  const cachedSnapshot = await readJsonFile<DashboardSnapshot>(cachePath);
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const games = await fetchRecentGames(username, limit);
  const session = new StockfishSession();
  await session.initialize();

  try {
    const summaries: HistoryGameSummary[] = [];
    for (const [index, game] of games.entries()) {
      const summary = await scanOrLoadGameSummary(session, username, game);
      summaries.push(summary);

      onProgress?.({
        completedGames: index + 1,
        totalGames: games.length,
        message: `Scanning ${index + 1}/${games.length}: ${summary.opponent} (${summary.openingFamily})`
      });
    }

    const metrics = buildMetricCards(summaries);
    const topOpenings = buildOpeningReport(summaries);
    const snapshot: DashboardSnapshot = {
      username,
      analyzedAt: new Date().toISOString(),
      limit,
      games: summaries.sort((left, right) => right.endTime - left.endTime),
      metrics,
      trends: summaries
        .slice(0, 12)
        .map((game) => ({
          label: new Date(game.endTime * 1000).toLocaleDateString("en-GB", {
            month: "short",
            day: "numeric"
          }),
          winRate: game.result === "win" ? 100 : game.result === "draw" ? 50 : 0,
          accuracy: game.accuracy,
          blunders: game.categories.blunder
        }))
        .reverse(),
      topOpenings,
      trainingPlan: buildTrainingPlan(username, summaries, topOpenings),
      highlights: []
    };
    snapshot.highlights = buildHighlights(snapshot);

    await writeJsonFile(cachePath, snapshot);
    return snapshot;
  } finally {
    session.close();
  }
}

function buildSideSummary(moves: AnnotatedMove[], side: PlayerColor) {
  const sideMoves = moves.filter((move) => move.color === side);
  const categories = emptyCategoryCounts();
  const losses = sideMoves.map((move) => move.lossCp);
  const phaseLosses = emptyPhaseMap<number[]>([]);

  for (const move of sideMoves) {
    categories[move.category] += 1;
    phaseLosses[move.phase].push(move.lossCp);
  }

  const avgCentipawnLoss = average(losses) ?? 0;
  return {
    accuracy: calculateAccuracy(avgCentipawnLoss),
    avgCentipawnLoss,
    categories,
    phaseAccuracy: {
      opening: calculateAccuracy(average(phaseLosses.opening)),
      middlegame: calculateAccuracy(average(phaseLosses.middlegame)),
      endgame: calculateAccuracy(average(phaseLosses.endgame))
    }
  };
}

function buildKeyThemes(game: HistoryGameSummary, reviewMoves: AnnotatedMove[]): string[] {
  const themes: string[] = [];
  const playerMoves = reviewMoves.filter((move) => move.isPlayerMove);
  const playerCriticals = playerMoves.filter((move) =>
    ["mistake", "miss", "blunder"].includes(move.category)
  );
  const openingMistakes = playerCriticals.filter((move) => move.phase === "opening").length;
  const missedChances = playerMoves.filter((move) => move.category === "miss").length;

  if (openingMistakes >= 2) {
    themes.push("Opening discipline slipped early, so your first repair step should be move-order clarity and structure awareness.");
  }

  if (missedChances >= 2) {
    themes.push("There were multiple missed tactical chances. Candidate-move comparison should become part of your routine.");
  }

  if (game.categories.blunder > 0) {
    themes.push("The biggest rating swing came from a single tactical collapse, which means a blunder-check ritual is high leverage.");
  }

  if (!themes.length) {
    themes.push("This was comparatively stable. The next upgrade comes from converting small edges more cleanly.");
  }

  return themes;
}

export { buildSideSummary, buildKeyThemes, noteForCategory };
export { buildGameSummary };
