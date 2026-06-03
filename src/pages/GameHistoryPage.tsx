import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Equal, Minus, Plus, Rocket, Sun, Timer, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { GameResult, PlayerColor, TimeClass } from "../../shared/types";
import { useWorkspace } from "../hooks/useWorkspace";
import { resultLabel } from "../utils/formatters";

const timeClassMeta: Record<TimeClass, { label: string; fallback: string; Icon: LucideIcon }> = {
  bullet: {
    label: "Bullet",
    fallback: "1 min",
    Icon: Rocket
  },
  blitz: {
    label: "Blitz",
    fallback: "3 min",
    Icon: Zap
  },
  rapid: {
    label: "Rapid",
    fallback: "10 min",
    Icon: Timer
  },
  daily: {
    label: "Daily",
    fallback: "1 day",
    Icon: Sun
  }
};

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400);
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hr${hours === 1 ? "" : "s"}`;
  }

  if (seconds >= 60) {
    return `${Math.round(seconds / 60)} min`;
  }

  return `${seconds} sec`;
}

function formatTimeControl(timeControl: string | undefined, timeClass: TimeClass): string {
  const fallback = timeClassMeta[timeClass].fallback;
  if (!timeControl) {
    return fallback;
  }

  const dailyParts = timeControl.split("/");
  if (dailyParts.length > 1) {
    const seconds = Number(dailyParts.at(-1));
    return formatDuration(seconds) ?? fallback;
  }

  const baseSeconds = Number(timeControl.split("+")[0]);
  return formatDuration(baseSeconds) ?? fallback;
}

function formatHistoryDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function scorePair(result: GameResult): { player: string; opponent: string } {
  if (result === "win") {
    return { player: "1", opponent: "0" };
  }

  if (result === "loss") {
    return { player: "0", opponent: "1" };
  }

  return { player: "0.5", opponent: "0.5" };
}

export function GameHistoryPage() {
  const { snapshot } = useWorkspace();
  const [resultFilter, setResultFilter] = useState<"all" | GameResult>("all");
  const [colorFilter, setColorFilter] = useState<"all" | PlayerColor>("all");
  const [openingQuery, setOpeningQuery] = useState("");

  const filteredGames = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return snapshot.games.filter((game) => {
      if (resultFilter !== "all" && game.result !== resultFilter) {
        return false;
      }

      if (colorFilter !== "all" && game.color !== colorFilter) {
        return false;
      }

      if (
        openingQuery.trim() &&
        !`${game.openingName} ${game.openingFamily}`.toLowerCase().includes(openingQuery.trim().toLowerCase())
      ) {
        return false;
      }

      return true;
    });
  }, [snapshot, resultFilter, colorFilter, openingQuery]);

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <h1>Game History</h1>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No game history yet</h2>
          <p>Run the dashboard analysis first so this table has something to work with.</p>
        </section>
      ) : (
        <section className="panel">
          <div className="filters-row">
            <select value={resultFilter} onChange={(event) => setResultFilter(event.target.value as typeof resultFilter)}>
              <option value="all">All results</option>
              <option value="win">Wins</option>
              <option value="loss">Losses</option>
              <option value="draw">Draws</option>
            </select>

            <select value={colorFilter} onChange={(event) => setColorFilter(event.target.value as typeof colorFilter)}>
              <option value="all">Both colors</option>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>

            <input
              value={openingQuery}
              onChange={(event) => setOpeningQuery(event.target.value)}
              placeholder="Filter opening..."
            />
          </div>

          <div className="history-list">
            <div className="history-list-title">Game History ({filteredGames.length})</div>
            <div className="history-list-header" aria-hidden="true">
              <span />
              <span>Players</span>
              <span>Result</span>
              <span>Review</span>
              <span>Moves</span>
              <span>Date</span>
            </div>

            {filteredGames.map((game) => {
              const { Icon, label } = timeClassMeta[game.timeClass];
              const scores = scorePair(game.result);
              const white = game.color === "white"
                ? { name: snapshot.username, rating: game.playerRating, isPlayer: true }
                : { name: game.opponent, rating: game.opponentRating, isPlayer: false };
              const black = game.color === "black"
                ? { name: snapshot.username, rating: game.playerRating, isPlayer: true }
                : { name: game.opponent, rating: game.opponentRating, isPlayer: false };
              const whiteScore = game.color === "white" ? scores.player : scores.opponent;
              const blackScore = game.color === "black" ? scores.player : scores.opponent;
              const ResultIcon = game.result === "win" ? Plus : game.result === "loss" ? Minus : Equal;

              return (
                <article className={`history-game-row game-row-${game.result}`} key={game.id}>
                  <div className={`history-speed time-class-${game.timeClass}`} title={label}>
                    <Icon size={28} strokeWidth={2.8} aria-hidden="true" />
                    <span>{formatTimeControl(game.timeControl, game.timeClass)}</span>
                  </div>

                  <div className="history-players">
                    <div className="history-player-row">
                      <span className="history-color-dot history-color-white" />
                      <strong>{white.name}</strong>
                      <span>({white.rating})</span>
                    </div>
                    <div className="history-player-row">
                      <span className="history-color-dot history-color-black" />
                      <strong>{black.name}</strong>
                      <span>({black.rating})</span>
                    </div>
                    <div className="history-opening-line" title={game.openingName}>
                      {game.openingFamily}
                    </div>
                  </div>

                  <div className="history-result-stack" aria-label={`${resultLabel(game.result)} for ${snapshot.username}`}>
                    <div className="history-score-pair">
                      <span>{whiteScore}</span>
                      <span>{blackScore}</span>
                    </div>
                    <span className={`history-result-marker history-result-${game.result}`}>
                      <ResultIcon size={16} strokeWidth={3} aria-hidden="true" />
                    </span>
                  </div>

                  <div className="history-review-cell">
                    <Link className="history-review-button" to={`/review/${game.id}?autostart=1`}>
                      Review
                    </Link>
                    <span>{game.accuracy === null ? "No accuracy" : `${game.accuracy.toFixed(1)}% accuracy`}</span>
                  </div>

                  <div className="history-moves">{game.moves}</div>
                  <div className="history-date">{formatHistoryDate(game.endTime)}</div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
