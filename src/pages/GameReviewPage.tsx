import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { CATEGORY_COLORS } from "../../shared/constants";
import type { JobState, ReviewSummary } from "../../shared/types";
import { startGameReview } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useWorkspace } from "../hooks/useWorkspace";
import { categoryLabel, resultLabel } from "../utils/formatters";

function SideBreakdown({ title, review, side }: { title: string; review: ReviewSummary; side: "white" | "black" }) {
  const summary = review[side];

  return (
    <div className="summary-card">
      <div className="summary-top">
        <div>
          <div className="stat-label">{title}</div>
          <div className="summary-accuracy">{summary.accuracy.toFixed(1)}</div>
        </div>
        <div className="summary-small">ACPL {summary.avgCentipawnLoss.toFixed(0)}</div>
      </div>

      <div className="category-grid">
        {Object.entries(summary.categories).map(([category, count]) => (
          <div className="category-row" key={category}>
            <span>{categoryLabel(category as keyof typeof summary.categories)}</span>
            <strong style={{ color: CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS] }}>{count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GameReviewPage() {
  const { gameId } = useParams();
  const { snapshot, reviewCache, setReview, reviewJobs, setReviewJob } = useWorkspace();
  const game = snapshot?.games.find((entry) => entry.id === gameId) ?? null;
  const review = gameId ? reviewCache[gameId] : null;
  const reviewJob = gameId ? reviewJobs[gameId] ?? null : null;
  const [selectedPly, setSelectedPly] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleReviewUpdate = useCallback(
    (job: JobState<ReviewSummary>) => {
      if (!gameId) {
        return;
      }

      setReviewJob(gameId, job);
      if (job?.status === "completed" && job.result) {
        setReview(gameId, job.result);
      }
    },
    [gameId, setReview, setReviewJob]
  );

  useJobPolling(reviewJob, handleReviewUpdate);

  const selectedMove = useMemo(() => {
    if (!review?.moves.length) {
      return null;
    }

    return review.moves.find((move) => move.ply === selectedPly) ?? review.moves[0];
  }, [review, selectedPly]);

  const handleStartReview = async () => {
    if (!snapshot || !game) {
      return;
    }

    setError(null);
    try {
      const job = await startGameReview({
        username: snapshot.username,
        gameId: game.id,
        gameSummary: game
      });
      setReviewJob(game.id, job);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not start review.");
    }
  };

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <span className="eyebrow">Deep review</span>
          <h1>Post-Game Analysis</h1>
          <p>Choose a game from history and run a move-by-move Stockfish review for both sides.</p>
        </div>
      </section>

      {!snapshot || !gameId ? (
        <section className="panel empty-panel">
          <h2>No game selected</h2>
          <p>Open the Game History page and click Analyze on a game you want to review.</p>
        </section>
      ) : !game ? (
        <section className="panel empty-panel">
          <h2>Game not found in the current workspace</h2>
          <p>Run a fresh bulk analysis or pick a game from the current history table.</p>
        </section>
      ) : (
        <>
          <section className="panel review-hero">
            <div>
              <span className="eyebrow">{game.openingFamily}</span>
              <h2>{game.opponent}</h2>
              <p>
                {game.color} · {resultLabel(game.result)} · {game.moves} plies · {game.timeClass}
              </p>
            </div>
            <div className="review-actions">
              <button className="primary-button" onClick={handleStartReview} disabled={reviewJob?.status === "running"}>
                {review ? "Re-run Deep Review" : "Run Deep Review"}
              </button>
              {reviewJob ? (
                <div className="job-inline">
                  <span>{reviewJob.message}</span>
                  <span>{reviewJob.progress}%</span>
                </div>
              ) : null}
            </div>
          </section>

          {error ? <div className="error-text">{error}</div> : null}

          {review ? (
            <section className="review-layout">
              <article className="panel board-panel">
                <div className="board-wrap">
                  <Chessboard
                    id="review-board"
                    position={selectedMove?.fenAfter ?? "start"}
                    boardWidth={540}
                    arePiecesDraggable={false}
                    customDarkSquareStyle={{ backgroundColor: "#5d7b63" }}
                    customLightSquareStyle={{ backgroundColor: "#d8dcc6" }}
                  />
                </div>

                {selectedMove ? (
                  <div className="move-detail">
                    <div className="detail-pill" style={{ background: CATEGORY_COLORS[selectedMove.category] }}>
                      {categoryLabel(selectedMove.category)}
                    </div>
                    <h3>
                      {selectedMove.moveNumber}. {selectedMove.san}
                    </h3>
                    <p>{selectedMove.note}</p>
                    <div className="line-box">
                      <strong>Best line:</strong> {selectedMove.bestLine.pv.slice(0, 6).join(" ")}
                    </div>
                  </div>
                ) : null}
              </article>

              <div className="review-sidebar">
                <section className="panel">
                  <div className="summary-grid">
                    <SideBreakdown title="White accuracy" review={review} side="white" />
                    <SideBreakdown title="Black accuracy" review={review} side="black" />
                  </div>
                </section>

                <section className="panel">
                  <span className="eyebrow">Key themes</span>
                  <h2>What this game says</h2>
                  <div className="list-panel">
                    {review.keyThemes.map((theme) => (
                      <div className="list-row" key={theme}>
                        {theme}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="panel move-list-panel">
                  <span className="eyebrow">Move list</span>
                  <h2>Critical moments</h2>
                  <div className="move-list">
                    {review.moves.map((move) => (
                      <button
                        key={`${move.ply}-${move.uci}`}
                        className={`move-row${selectedMove?.ply === move.ply ? " move-row-active" : ""}`}
                        onClick={() => setSelectedPly(move.ply)}
                      >
                        <span className="move-row-main">
                          {move.moveNumber}. {move.san}
                        </span>
                        <span className="move-row-tag" style={{ color: CATEGORY_COLORS[move.category] }}>
                          {categoryLabel(move.category)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </section>
          ) : (
            <section className="panel empty-panel">
              <h2>Deep review not started yet</h2>
              <p>
                The history table already gives you quick filters. This page is where you run the fuller move-by-move
                review with labels, accuracy, and coaching notes.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
