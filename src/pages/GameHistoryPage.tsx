import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Equal, Minus, Plus, Timer, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { familyFromOpening } from "../../shared/chess";
import { OWNER_USERNAME } from "../../shared/constants";
import type { GameResult, PlayerColor, TimeClass } from "../../shared/types";
import { fetchGames } from "../api/client";
import { WindowToggle } from "../components/WindowToggle";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatCount, resultLabel } from "../utils/formatters";

const timeClassMeta: Record<TimeClass, { label: string; fallback: string; Icon: LucideIcon }> = {
  blitz: {
    label: "Blitz",
    fallback: "3 min",
    Icon: Zap
  },
  rapid: {
    label: "Rapid",
    fallback: "10 min",
    Icon: Timer
  }
};

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
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
  const { gameWindow, dataVersion } = useWorkspace();
  const { data, error, loading } = useStoreQuery((signal) => fetchGames({ window: gameWindow }, signal), [
    gameWindow,
    dataVersion
  ]);
  const [resultFilter, setResultFilter] = useState<"all" | GameResult>("all");
  const [colorFilter, setColorFilter] = useState<"all" | PlayerColor>("all");
  const [timeClassFilter, setTimeClassFilter] = useState<"all" | TimeClass>("all");
  const [openingQuery, setOpeningQuery] = useState("");

  const games = useMemo(
    () => (data?.games ?? []).map((game) => ({ ...game, openingFamily: familyFromOpening(game.openingName) })),
    [data]
  );

  const filteredGames = useMemo(() => {
    const needle = openingQuery.trim().toLowerCase();
    return games.filter((game) => {
      if (resultFilter !== "all" && game.result !== resultFilter) {
        return false;
      }

      if (colorFilter !== "all" && game.color !== colorFilter) {
        return false;
      }

      if (timeClassFilter !== "all" && game.timeClass !== timeClassFilter) {
        return false;
      }

      if (needle && !`${game.openingName} ${game.openingFamily} ${game.eco ?? ""}`.toLowerCase().includes(needle)) {
        return false;
      }

      return true;
    });
  }, [games, resultFilter, colorFilter, timeClassFilter, openingQuery]);

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <h1>Game History</h1>
          <p>Every stored blitz and rapid game in the window, newest first. Review opens the first 10 moves.</p>
        </div>
        <WindowToggle />
      </section>

      {error ? <div className="error-text">Could not load your games: {error}</div> : null}

      {!data || !games.length ? (
        <section className="panel empty-panel">
          <h2>{loading ? "Loading your games" : "No games in this window"}</h2>
          <p>{loading ? "Reading your games from the local store." : "Sync your games from Home first."}</p>
        </section>
      ) : (
        <section className="panel">
          <div className="filters-row">
            <select
              aria-label="Result"
              value={resultFilter}
              onChange={(event) => setResultFilter(event.target.value as typeof resultFilter)}
            >
              <option value="all">All results</option>
              <option value="win">Wins</option>
              <option value="loss">Losses</option>
              <option value="draw">Draws</option>
            </select>

            <select
              aria-label="Colour"
              value={colorFilter}
              onChange={(event) => setColorFilter(event.target.value as typeof colorFilter)}
            >
              <option value="all">Both colors</option>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>

            <select
              aria-label="Time class"
              value={timeClassFilter}
              onChange={(event) => setTimeClassFilter(event.target.value as typeof timeClassFilter)}
            >
              <option value="all">Blitz and rapid</option>
              <option value="blitz">Blitz</option>
              <option value="rapid">Rapid</option>
            </select>

            <input
              aria-label="Opening"
              value={openingQuery}
              onChange={(event) => setOpeningQuery(event.target.value)}
              placeholder="Filter opening or ECO..."
            />
          </div>

          <div className="history-list">
            <div className="history-list-title">
              Game History ({formatCount(filteredGames.length)}
              {filteredGames.length === games.length ? "" : ` of ${formatCount(games.length)}`})
            </div>
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
              const me = { name: OWNER_USERNAME, rating: game.myRating };
              const opponent = { name: game.oppName, rating: game.oppRating };
              const white = game.color === "white" ? me : opponent;
              const black = game.color === "black" ? me : opponent;
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

                  <div className="history-result-stack" aria-label={`${resultLabel(game.result)} for ${OWNER_USERNAME}`}>
                    <div className="history-score-pair">
                      <span>{whiteScore}</span>
                      <span>{blackScore}</span>
                    </div>
                    <span className={`history-result-marker history-result-${game.result}`}>
                      <ResultIcon size={16} strokeWidth={3} aria-hidden="true" />
                    </span>
                  </div>

                  <div className="history-review-cell">
                    <Link className="history-review-button" to={`/review/${game.id}`}>
                      Review
                    </Link>
                  </div>

                  <div className="history-moves">{Math.ceil(game.plyCount / 2)}</div>
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
