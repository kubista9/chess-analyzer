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
import { fetchRecentGamesWithCacheStatus } from "./chessCom.js";
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

function formatCacheTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
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
    timeControl: game.timeControl,
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
  const cached = await loadCachedGameSummary(username, game.id);
  if (cached) {
    return {
      ...cached,
      timeControl: cached.timeControl ?? game.timeControl
    };
  }

  const summary = await buildGameSummary(session, username, game);
  await writeCachedGameSummary(username, game.id, summary);
  return summary;
}

async function loadCachedGameSummary(username: string, gameId: string): Promise<HistoryGameSummary | null> {
  const cachePath = scanCachePath(username, gameId);
  const cached = await readJsonFile<CachedScan>(cachePath);
  return cached?.summary ?? null;
}

async function writeCachedGameSummary(
  username: string,
  gameId: string,
  summary: HistoryGameSummary
): Promise<void> {
  const cachePath = scanCachePath(username, gameId);
  await writeJsonFile(cachePath, { summary });
}

function buildDashboardSnapshot(
  username: string,
  limit: number,
  summaries: HistoryGameSummary[]
): DashboardSnapshot {
  const sortedSummaries = [...summaries].sort((left, right) => right.endTime - left.endTime);
  const metrics = buildMetricCards(sortedSummaries);
  const topOpenings = buildOpeningReport(sortedSummaries);
  const snapshot: DashboardSnapshot = {
    username,
    analyzedAt: new Date().toISOString(),
    limit,
    games: sortedSummaries,
    metrics,
    trends: sortedSummaries
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
    trainingPlan: buildTrainingPlan(username, sortedSummaries, topOpenings),
    highlights: []
  };
  snapshot.highlights = buildHighlights(snapshot);

  return snapshot;
}

export async function runBulkAnalysis(
  username: string,
  limit: number,
  onProgress?: (progress: BatchProgress) => void
): Promise<DashboardSnapshot> {
  const cachePath = snapshotCachePath(username, limit);
  const recentGames = await fetchRecentGamesWithCacheStatus(username, limit, { refresh: true });
  const { games } = recentGames;

  if (!games.length) {
    throw new Error(`No supported recent rapid, blitz, bullet, or daily games found for ${username}.`);
  }

  const previousFetch = recentGames.cache.previousFetchedAt
    ? formatCacheTimestamp(recentGames.cache.previousFetchedAt)
    : null;
  onProgress?.({
    completedGames: 0,
    totalGames: games.length,
    message: previousFetch
      ? `Last Chess.com fetch was ${previousFetch}; found ${recentGames.cache.newGames} new stored game(s).`
      : `Fetched Chess.com games for ${username}.`
  });

  const cachedSummaries = new Map<string, HistoryGameSummary>();
  const missingGameIds = new Set<string>();
  for (const game of games) {
    const cachedSummary = await loadCachedGameSummary(username, game.id);
    if (cachedSummary) {
      cachedSummaries.set(game.id, {
        ...cachedSummary,
        timeControl: cachedSummary.timeControl ?? game.timeControl
      });
    } else {
      missingGameIds.add(game.id);
    }
  }

  let session: StockfishSession | null = null;
  let analyzedNewGames = 0;

  try {
    const summaries: HistoryGameSummary[] = [];
    for (const [index, game] of games.entries()) {
      const cachedSummary = cachedSummaries.get(game.id);
      if (cachedSummary) {
        summaries.push(cachedSummary);

        onProgress?.({
          completedGames: index + 1,
          totalGames: games.length,
          message:
            missingGameIds.size > 0
              ? `Using cached scan ${index + 1}/${games.length}: ${cachedSummary.opponent}`
              : `All ${games.length} selected game(s) were already analyzed locally.`
        });

        continue;
      }

      if (!session) {
        session = new StockfishSession();
        await session.initialize();
      }

      const summary = await buildGameSummary(session, username, game);
      await writeCachedGameSummary(username, game.id, summary);
      analyzedNewGames += 1;
      summaries.push(summary);

      onProgress?.({
        completedGames: index + 1,
        totalGames: games.length,
        message: `Analyzing new game ${analyzedNewGames}/${missingGameIds.size}: ${summary.opponent} (${summary.openingFamily})`
      });
    }

    const snapshot = buildDashboardSnapshot(username, limit, summaries);

    await writeJsonFile(cachePath, snapshot);
    return snapshot;
  } finally {
    session?.close();
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
