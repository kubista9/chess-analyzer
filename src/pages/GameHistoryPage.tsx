import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GameResult, PlayerColor } from "../../shared/types";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatDate, resultLabel } from "../utils/formatters";

export function GameHistoryPage() {
  const { snapshot } = useWorkspace();
  const navigate = useNavigate();
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
          <span className="eyebrow">Game archive</span>
          <h1>Game History</h1>
          <p>Filter by result, color, and opening family, then launch a deep review for a selected game.</p>
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

          <div className="table-wrap">
            <table className="game-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Opponent</th>
                  <th>Color</th>
                  <th>Opening</th>
                  <th>Result</th>
                  <th>Moves</th>
                  <th>Accuracy</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredGames.map((game) => (
                  <tr key={game.id}>
                    <td>{formatDate(game.endTime)}</td>
                    <td>{game.opponent}</td>
                    <td>
                      <span className={`pill pill-${game.color}`}>{game.color}</span>
                    </td>
                    <td title={game.openingName}>{game.openingName}</td>
                    <td>
                      <span className={`pill pill-${game.result}`}>{resultLabel(game.result)}</span>
                    </td>
                    <td>{game.moves}</td>
                    <td>{game.accuracy?.toFixed(1) ?? "—"}</td>
                    <td>
                      <button className="secondary-button" onClick={() => navigate(`/review/${game.id}`)}>
                        Analyze
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
