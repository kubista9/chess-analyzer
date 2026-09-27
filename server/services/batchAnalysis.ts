import type { HistoryGameSummary, OpeningsSnapshot } from "../../shared/types.js";
import { config } from "../config.js";
import { playerColorForGame } from "./gameParser.js";
import { summarizeGame } from "./gameSummary.js";
import { buildOpeningReport } from "./openingReport.js";
import { fetchRecentGamesWithCacheStatus } from "./chessCom.js";

// The bulk run is results-only: it refreshes the raw games cache from Chess.com and builds
// W/D/L summaries from it. It runs no engine and reads or writes no scan cache.

interface BatchProgress {
  completedGames: number;
  totalGames: number;
  message: string;
}

function formatCacheTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function buildOpeningsSnapshot(
  username: string,
  limit: number,
  summaries: HistoryGameSummary[]
): OpeningsSnapshot {
  const sortedSummaries = [...summaries].sort((left, right) => right.endTime - left.endTime);

  return {
    username,
    analyzedAt: new Date().toISOString(),
    limit,
    games: sortedSummaries,
    topOpenings: buildOpeningReport(sortedSummaries)
  };
}

export async function runBulkAnalysis(
  limit: number,
  onProgress?: (progress: BatchProgress) => void
): Promise<OpeningsSnapshot> {
  const username = config.owner;
  const recentGames = await fetchRecentGamesWithCacheStatus(username, limit, { refresh: true });

  // A game the owner did not play is skipped and reported, never summarised from a guessed side.
  const summaries: HistoryGameSummary[] = [];
  for (const game of recentGames.games) {
    const color = playerColorForGame(game, username);
    if (color) {
      summaries.push(summarizeGame(game, color));
    } else {
      console.warn(`Skipping game ${game.id}: ${username} is neither White nor Black.`);
    }
  }
  const skippedGames = recentGames.games.length - summaries.length;

  if (!summaries.length) {
    throw new Error(
      skippedGames > 0
        ? `None of the ${skippedGames} fetched game(s) were played by ${username}.`
        : `No supported recent rapid, blitz, bullet, or daily games found for ${username}.`
    );
  }

  const previousFetch = recentGames.cache.previousFetchedAt
    ? formatCacheTimestamp(recentGames.cache.previousFetchedAt)
    : null;
  const skippedNote = skippedGames > 0 ? ` Skipped ${skippedGames} game(s) ${username} did not play.` : "";
  onProgress?.({
    completedGames: summaries.length,
    totalGames: summaries.length,
    message: (previousFetch
      ? `Last Chess.com fetch was ${previousFetch}; found ${recentGames.cache.newGames} new stored game(s).`
      : `Fetched Chess.com games for ${username}.`) + skippedNote
  });

  return buildOpeningsSnapshot(username, limit, summaries);
}
