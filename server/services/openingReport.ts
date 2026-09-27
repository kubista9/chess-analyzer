import { average } from "../../shared/chess.js";
import type { HistoryGameSummary, OpeningReportItem } from "../../shared/types.js";

function averageForCategory(games: HistoryGameSummary[], category: keyof HistoryGameSummary["categories"]): number {
  return games.reduce((sum, game) => sum + game.categories[category], 0) / Math.max(games.length, 1);
}

function winRate(games: HistoryGameSummary[]): number {
  if (!games.length) {
    return 0;
  }

  const wins = games.filter((game) => game.result === "win").length;
  return (wins / games.length) * 100;
}

export function buildOpeningReport(games: HistoryGameSummary[]): OpeningReportItem[] {
  const grouped = new Map<string, HistoryGameSummary[]>();

  for (const game of games) {
    const bucket = grouped.get(game.openingFamily) ?? [];
    bucket.push(game);
    grouped.set(game.openingFamily, bucket);
  }

  return [...grouped.entries()]
    .map(([openingFamily, openingGames]) => {
      const openingWinRate = winRate(openingGames);
      const avgAccuracy = average(openingGames.map((game) => game.accuracy));
      const avgBlunders = averageForCategory(openingGames, "blunder");
      const avgFirstError = average(openingGames.map((game) => game.firstMajorErrorPly));

      let recommendation = "Stable enough to keep in your active rotation.";
      if (avgBlunders > 0.9) {
        recommendation = "Study the first 8-12 moves and review tactical traps before queueing more games.";
      } else if ((avgAccuracy ?? 0) < 78) {
        recommendation = "Rebuild the key plans and typical pawn structures from this opening family.";
      } else if (openingWinRate >= 55) {
        recommendation = "This looks like a strength. Use it as a confidence opening and refine your middlegame plans.";
      }

      return {
        openingFamily,
        games: openingGames.length,
        winRate: openingWinRate,
        avgAccuracy,
        avgBlunders,
        avgFirstErrorPly: avgFirstError,
        recommendation
      };
    })
    .sort((left, right) => right.games - left.games)
    .slice(0, 10);
}
