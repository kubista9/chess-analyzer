import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import type {
  DashboardSnapshot,
  HistoryGameSummary,
  PracticeDrill,
  PracticeGameRecommendation
} from "../../shared/types";
import { useWorkspace } from "../hooks/useWorkspace";

function makePracticeDrill(game: HistoryGameSummary, title: string, prompt: string): PracticeDrill {
  return {
    title,
    gameId: game.id,
    opponent: game.opponent,
    result: game.result,
    openingName: game.openingName,
    ply: game.firstMajorErrorPly,
    prompt
  };
}

function topGamesBy(
  games: HistoryGameSummary[],
  scoreGame: (game: HistoryGameSummary) => number,
  limit = 3
): HistoryGameSummary[] {
  return [...games]
    .filter((game) => scoreGame(game) > 0)
    .sort((left, right) => scoreGame(right) - scoreGame(left))
    .slice(0, limit);
}

function fallbackDrillsForPractice(
  snapshot: DashboardSnapshot,
  recommendation: PracticeGameRecommendation
): PracticeDrill[] {
  const title = recommendation.title.toLowerCase();
  const recentGames = snapshot.games.slice(0, 3);

  if (title.includes("blunder")) {
    const games = topGamesBy(
      snapshot.games,
      (game) => game.categories.blunder * 3 + game.categories.mistake
    );
    return (games.length ? games : recentGames).map((game) =>
      makePracticeDrill(
        game,
        `Retry the first danger moment vs ${game.opponent}`,
        "Open Retry mode and find the forcing-move scan before checking Best."
      )
    );
  }

  if (title.includes("tactical")) {
    const games = topGamesBy(
      snapshot.games,
      (game) => game.categories.miss * 3 + (game.winProbabilitySwing ?? 0) / 10
    );
    return (games.length ? games : recentGames).map((game) =>
      makePracticeDrill(
        game,
        `Find the missed tactic vs ${game.opponent}`,
        "List two candidate moves, then compare your idea with the engine line."
      )
    );
  }

  if (title.includes("endgame")) {
    const games = topGamesBy(
      snapshot.games,
      (game) => 100 - (game.phaseAccuracy.endgame ?? 100),
      2
    );
    return (games.length ? games : recentGames.slice(0, 2)).map((game) =>
      makePracticeDrill(
        game,
        `Convert the ending vs ${game.opponent}`,
        "Play forward from the key moment and explain each trade before checking Best."
      )
    );
  }

  const openingTarget = snapshot.topOpenings[0]?.openingFamily;
  const openingGames = openingTarget
    ? snapshot.games.filter((game) => game.openingFamily === openingTarget).slice(0, 3)
    : [];

  return (openingGames.length ? openingGames : recentGames).map((game) =>
    makePracticeDrill(
      game,
      `Replay the opening vs ${game.opponent}`,
      "Review the opening phase and name the pawn break or piece setup before revealing the answer."
    )
  );
}

function practiceGamesWithDrills(
  snapshot: DashboardSnapshot,
  recommendations: PracticeGameRecommendation[]
): PracticeGameRecommendation[] {
  return recommendations.map((recommendation) => ({
    ...recommendation,
    drills: recommendation.drills?.length
      ? recommendation.drills
      : fallbackDrillsForPractice(snapshot, recommendation)
  }));
}

function practiceGridColumns(count: number): number {
  if (count <= 1) {
    return 1;
  }

  return count % 2 === 0 ? 2 : Math.min(count, 3);
}

function drillUrl(drill: PracticeDrill): string {
  const params = new URLSearchParams({
    mode: "retry",
    autostart: "1"
  });

  if (drill.ply !== null) {
    params.set("ply", String(drill.ply));
  }

  return `/review/${drill.gameId}?${params.toString()}`;
}

function fallbackPracticeGames(snapshot: DashboardSnapshot): PracticeGameRecommendation[] {
  const openingTarget = snapshot.topOpenings[0]?.openingFamily ?? "your main opening";

  return [
    {
      title: "Blunder-check rapid set",
      games: "3 games",
      timeControl: "10+5 rapid",
      focus: "Slow down before irreversible moves.",
      instructions: [
        "Pause before every capture, pawn break, or queen move.",
        "Scan checks, captures, and threats before committing.",
        "Review the first move where the position clearly turned."
      ],
      reviewPrompt: "After each game, write down the first warning sign you ignored.",
      successMetric: "Finish the set with fewer obvious one-move collapses."
    },
    {
      title: `${openingTarget} repair games`,
      games: "2 games",
      timeControl: "10+5 rapid",
      focus: `Practice reaching playable middlegames from ${openingTarget}.`,
      instructions: [
        "Name your target pawn break before move 10.",
        "Choose development and king safety when the opening goes off script.",
        "Review only the first 12 plies after the game."
      ],
      reviewPrompt: "Mark the first moment your plan became unclear.",
      successMetric: "Reach the middlegame with a plan you can explain."
    },
    {
      title: "Tactical conversion games",
      games: "3 games",
      timeControl: "5+3 blitz",
      focus: "Turn promising positions into concrete threats.",
      instructions: [
        "List two candidate moves when you are attacking.",
        "Look for loose pieces before trading.",
        "Use your clock to calculate forcing moves."
      ],
      reviewPrompt: "Find one position where a stronger forcing move existed.",
      successMetric: "Convert at least one advantage cleanly."
    }
  ];
}

export function TrainingPlanPage() {
  const { snapshot } = useWorkspace();
  const practiceGames = snapshot
    ? practiceGamesWithDrills(snapshot, snapshot.trainingPlan.practiceGames ?? fallbackPracticeGames(snapshot))
    : [];
  const practiceGridStyle = {
    "--practice-columns": practiceGridColumns(practiceGames.length)
  } as CSSProperties;

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <h1>Personal Game Plan</h1>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No training plan yet</h2>
          <p>Run the analysis first and this page will generate a focused improvement plan from your own games.</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <span className="eyebrow">Practice games</span>
            <h2>What to play next</h2>
            <div className="practice-grid" style={practiceGridStyle}>
              {practiceGames.map((game) => (
                <article className="practice-card" key={game.title}>
                  <div className="practice-card-header">
                    <div>
                      <div className="practice-games">{game.games}</div>
                      <h3>{game.title}</h3>
                    </div>
                    <div className="practice-time">{game.timeControl}</div>
                  </div>
                  <p>{game.focus}</p>
                  <ul className="action-list">
                    {game.instructions.map((instruction) => (
                      <li key={instruction}>{instruction}</li>
                    ))}
                  </ul>
                  <div className="practice-review">
                    <strong>Review:</strong> {game.reviewPrompt}
                  </div>
                  {game.drills?.length ? (
                    <div className="practice-drills">
                      <strong>From your recent games</strong>
                      {game.drills.map((drill) => (
                        <div className="practice-drill-card" key={`${game.title}-${drill.gameId}-${drill.title}`}>
                          <div>
                            <div className="practice-drill-title">{drill.title}</div>
                            <div className="practice-drill-meta">
                              <span className={`pill pill-${drill.result}`}>{drill.result}</span>
                              <span>{drill.openingName}</span>
                              <span>{drill.ply === null ? "review game" : `ply ${drill.ply}`}</span>
                            </div>
                            <p>{drill.prompt}</p>
                          </div>
                          <Link className="practice-drill-link" to={drillUrl(drill)}>
                            Open puzzle
                          </Link>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="focus-target">{game.successMetric}</div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <span className="eyebrow">Focus areas</span>
            <h2>What to fix first</h2>
            <div className="focus-list">
              {snapshot.trainingPlan.focusAreas.map((area) => (
                <div className="focus-card" key={area.title}>
                  <h3>{area.title}</h3>
                  <p>{area.reason}</p>
                  <div className="focus-target">{area.targetMetric}</div>
                  <ul className="action-list">
                    {area.actions.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
