import type { GameResult, HistoryGameSummary, OpeningReportItem, PlayerColor } from "../../shared/types.js";

/** Score as a percentage: a win is 1, a draw 0.5, a loss 0. */
export function scorePercent(wins: number, draws: number, games: number): number {
  return games > 0 ? ((wins + 0.5 * draws) / games) * 100 : 0;
}

/**
 * Results per opening family, split by the owner's colour: the same family as White and as
 * Black are separate items. Sorted by colour (White first), then games (desc), then name.
 */
export function buildOpeningReport(games: HistoryGameSummary[]): OpeningReportItem[] {
  const grouped = new Map<string, { color: PlayerColor; openingFamily: string; counts: Record<GameResult, number> }>();

  for (const game of games) {
    const key = `${game.color}|${game.openingFamily}`;
    const bucket = grouped.get(key) ?? {
      color: game.color,
      openingFamily: game.openingFamily,
      counts: { win: 0, draw: 0, loss: 0 }
    };
    bucket.counts[game.result] += 1;
    grouped.set(key, bucket);
  }

  return [...grouped.values()]
    .map(({ color, openingFamily, counts }) => {
      const total = counts.win + counts.draw + counts.loss;
      return {
        color,
        openingFamily,
        games: total,
        wins: counts.win,
        draws: counts.draw,
        losses: counts.loss,
        scorePct: scorePercent(counts.win, counts.draw, total)
      };
    })
    .sort(
      (left, right) =>
        (left.color === right.color ? 0 : left.color === "white" ? -1 : 1) ||
        right.games - left.games ||
        left.openingFamily.localeCompare(right.openingFamily, "en")
    );
}
