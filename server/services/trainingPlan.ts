import {
  average,
  formatPercentage
} from "../../shared/chess.js";
import type {
  DashboardSnapshot,
  HistoryGameSummary,
  MetricCard,
  OpeningReportItem,
  TrainingPlan
} from "../../shared/types.js";

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

export function buildMetricCards(games: HistoryGameSummary[]): MetricCard[] {
  const accuracies = games.map((game) => game.accuracy);
  const avgAccuracy = average(accuracies);
  const avgMoves = average(games.map((game) => game.moves)) ?? 0;
  const avgOpponentRating = average(games.map((game) => game.opponentRating)) ?? 0;
  const avgPlayerRating = average(games.map((game) => game.playerRating)) ?? 0;
  const avgBlunders = averageForCategory(games, "blunder");
  const avgMistakes = averageForCategory(games, "mistake");
  const avgMisses = averageForCategory(games, "miss");
  const whiteWinRate = winRate(games.filter((game) => game.color === "white"));
  const blackWinRate = winRate(games.filter((game) => game.color === "black"));
  const drawRate = games.length
    ? (games.filter((game) => game.result === "draw").length / games.length) * 100
    : 0;
  const avgFirstError = average(games.map((game) => game.firstMajorErrorPly)) ?? 0;

  return [
    {
      key: "win-rate",
      label: "Overall win rate",
      value: formatPercentage(winRate(games)),
      tone: winRate(games) >= 50 ? "positive" : "warning",
      helper: "Your headline result across the analyzed sample."
    },
    {
      key: "avg-accuracy",
      label: "Average accuracy",
      value: formatPercentage(avgAccuracy),
      tone: (avgAccuracy ?? 0) >= 80 ? "positive" : "warning",
      helper: "A quick signal for how closely your play tracked engine recommendations."
    },
    {
      key: "draw-rate",
      label: "Draw rate",
      value: formatPercentage(drawRate),
      helper: "Useful for spotting whether you press enough in equal positions."
    },
    {
      key: "avg-moves",
      label: "Average game length",
      value: `${avgMoves.toFixed(0)} plies`,
      helper: "Shorter games often hint at opening issues or tactical collapses."
    },
    {
      key: "white-win-rate",
      label: "White win rate",
      value: formatPercentage(whiteWinRate),
      tone: whiteWinRate >= blackWinRate ? "positive" : "neutral",
      helper: "Checks whether your first-move advantage is turning into points."
    },
    {
      key: "black-win-rate",
      label: "Black win rate",
      value: formatPercentage(blackWinRate),
      helper: "Highlights how resilient your black repertoire is."
    },
    {
      key: "avg-blunders",
      label: "Blunders per game",
      value: avgBlunders.toFixed(2),
      tone: avgBlunders <= 0.7 ? "positive" : "danger",
      helper: "The most direct measure of points left on the table."
    },
    {
      key: "avg-mistakes",
      label: "Mistakes per game",
      value: avgMistakes.toFixed(2),
      helper: "Captures quieter slips before they become outright blunders."
    },
    {
      key: "avg-misses",
      label: "Missed chances",
      value: avgMisses.toFixed(2),
      helper: "Shows how often tactical opportunities go unclaimed."
    },
    {
      key: "rating-context",
      label: "Average rating context",
      value: `${avgPlayerRating.toFixed(0)} vs ${avgOpponentRating.toFixed(0)}`,
      helper: "Useful when interpreting accuracy and results against stronger opposition."
    },
    {
      key: "critical-error-move",
      label: "First major error",
      value: `${avgFirstError.toFixed(0)} ply`,
      helper: "If this lands early, your opening discipline needs attention."
    }
  ];
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

export function buildTrainingPlan(
  username: string,
  games: HistoryGameSummary[],
  openings: OpeningReportItem[]
): TrainingPlan {
  const avgAccuracy = average(games.map((game) => game.accuracy)) ?? 0;
  const avgBlunders = averageForCategory(games, "blunder");
  const avgMisses = averageForCategory(games, "miss");
  const openingWithMostRisk = openings.find((opening) => opening.avgBlunders >= 0.8) ?? openings[0];
  const endgameAccuracy = average(games.map((game) => game.phaseAccuracy.endgame));
  const openingAccuracy = average(games.map((game) => game.phaseAccuracy.opening));

  const focusAreas = [
    {
      title: "Reduce single-move collapses",
      reason: `You're averaging ${avgBlunders.toFixed(2)} blunders per game, which is the fastest way to leak rating.`,
      targetMetric: "Blunders per game under 0.60",
      actions: [
        "Run a 10-minute blunder check after every session and note the exact trigger: time trouble, tactics, or opening confusion.",
        "Before each critical move, pause for a forcing-moves scan: checks, captures, threats.",
        "Review only the first blunder in each loss so the lesson stays concrete."
      ]
    },
    {
      title: "Convert tactical chances",
      reason: `Missed opportunities are showing up ${avgMisses.toFixed(2)} times per game on average.`,
      targetMetric: "Missed chances under 0.50",
      actions: [
        "Solve 12-15 tactical puzzles in motifs you actually missed: forks, discovered attacks, and loose-piece punishments.",
        "When reviewing wins, mark positions where you could have finished faster.",
        "Practice candidate-move ranking instead of jumping to the first decent move."
      ]
    }
  ];

  if (openingWithMostRisk) {
    focusAreas.push({
      title: `Repair your ${openingWithMostRisk.openingFamily} positions`,
      reason: `${openingWithMostRisk.openingFamily} is one of your most common lines and still produces ${openingWithMostRisk.avgBlunders.toFixed(
        2
      )} blunders per game.`,
      targetMetric: `${openingWithMostRisk.openingFamily} average accuracy above 80%`,
      actions: [
        "Build a short repertoire note with your preferred move order and two model games.",
        "Replay the first 12 plies from memory before your next playing session.",
        "Add one opening checkpoint: what pawn breaks and piece squares matter most here?"
      ]
    });
  }

  if ((endgameAccuracy ?? 0) < 74) {
    focusAreas.push({
      title: "Stabilize your endgames",
      reason: "Your endgame accuracy is trailing the rest of your game, which makes winning positions harder to convert.",
      targetMetric: "Endgame accuracy above 78%",
      actions: [
        "Study king and pawn conversion themes for 20 minutes twice a week.",
        "Replay your last five endgames and stop at the first move where the engine swings.",
        "Practice simplifying only when the resulting king activity still favors you."
      ]
    });
  }

  const weeklySchedule = [
    {
      day: "Monday",
      title: "Opening repair block",
      duration: "35 min",
      details: `Review your recurring line in ${openingWithMostRisk?.openingFamily ?? "your main opening"} and play through two model games.`
    },
    {
      day: "Tuesday",
      title: "Tactical conversion",
      duration: "30 min",
      details: "Solve tactics with a notebook. Write the winning idea before moving pieces."
    },
    {
      day: "Wednesday",
      title: "Deep review session",
      duration: "40 min",
      details: "Pick one loss and study only the biggest swing plus the position five moves earlier."
    },
    {
      day: "Thursday",
      title: "Endgame fundamentals",
      duration: "25 min",
      details: "Work on king activity, opposition, and rook ending basics."
    },
    {
      day: "Friday",
      title: "Calibration games",
      duration: "45 min",
      details: "Play 2-3 focused games and apply a blunder-check ritual before every move that changes the structure."
    }
  ];

  return {
    headline: `${username}, your best improvement path is cleaner tactical discipline plus sharper opening recall.`,
    summary: `Across ${games.length} games, you're currently averaging ${formatPercentage(avgAccuracy)} accuracy. The fastest gain now is cutting obvious collapses and turning more promising positions into full points.`,
    focusAreas,
    weeklySchedule
  };
}

export function buildHighlights(snapshot: Pick<DashboardSnapshot, "games" | "topOpenings">): string[] {
  const wins = snapshot.games.filter((game) => game.result === "win").length;
  const recentSlice = snapshot.games.slice(0, 10);
  const recentAccuracy = average(recentSlice.map((game) => game.accuracy)) ?? 0;
  const sharpestOpening = snapshot.topOpenings[0];
  const biggestLeak = [...snapshot.topOpenings].sort((left, right) => right.avgBlunders - left.avgBlunders)[0];

  return [
    `You scored ${wins} wins in the analyzed sample, with ${formatPercentage(recentAccuracy)} average accuracy over your most recent 10 games.`,
    sharpestOpening
      ? `${sharpestOpening.openingFamily} is your most common opening family, appearing in ${sharpestOpening.games} games.`
      : "Opening data will appear once enough standard games are analyzed.",
    biggestLeak
      ? `${biggestLeak.openingFamily} is currently the cleanest opening repair target because it combines frequency with a high blunder rate.`
      : "The app will surface opening-specific repair targets once it has enough data."
  ];
}
