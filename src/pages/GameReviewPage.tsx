import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Arrow, CustomSquareStyles } from "react-chessboard/dist/chessboard/types";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  RotateCcw,
  Sparkles,
  Target
} from "lucide-react";
import type { AnnotatedMove, JobState, MoveCategory, PlayerColor, ReviewSummary } from "../../shared/types";
import { startGameReview } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useWorkspace } from "../hooks/useWorkspace";

type ReviewMode = "show" | "best" | "retry";

const reviewCopy: Record<
  MoveCategory,
  {
    badge: string;
    sentence: string;
    tone: string;
  }
> = {
  brilliant: {
    badge: "Brilliant",
    sentence: "is brilliant",
    tone: "#14d1b1"
  },
  great: {
    badge: "Great",
    sentence: "is a great move",
    tone: "#63a2ff"
  },
  best: {
    badge: "Best",
    sentence: "is best",
    tone: "#9dd94e"
  },
  good: {
    badge: "Excellent",
    sentence: "is excellent",
    tone: "#81b64c"
  },
  mistake: {
    badge: "Inaccuracy",
    sentence: "is an inaccuracy",
    tone: "#ffbb67"
  },
  miss: {
    badge: "Miss",
    sentence: "misses a stronger continuation",
    tone: "#ff8b67"
  },
  blunder: {
    badge: "Blunder",
    sentence: "is a blunder",
    tone: "#ff4d6d"
  }
};

function parseUciMove(uci: string): { from: string; to: string; promotion?: "q" | "r" | "b" | "n" } | null {
  if (uci.length < 4) {
    return null;
  }

  const promotion = uci[4];
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: promotion && ["q", "r", "b", "n"].includes(promotion)
      ? (promotion as "q" | "r" | "b" | "n")
      : undefined
  };
}

function applyMoveToFen(fen: string, uci: string): { fen: string; san: string } | null {
  const parsed = parseUciMove(uci);
  if (!parsed) {
    return null;
  }

  const chess = new Chess(fen);
  const move = chess.move(parsed);
  if (!move) {
    return null;
  }

  return {
    fen: chess.fen(),
    san: move.san
  };
}

function formatEval(scoreCp: number): string {
  const value = scoreCp / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function evalBarPercent(scoreCp: number): number {
  return Math.max(0, Math.min(100, 50 + 45 * Math.tanh(scoreCp / 250)));
}

function buildSquareStyles(
  from: string | null,
  to: string | null,
  color: string,
  mode: ReviewMode
): CustomSquareStyles {
  const styles: CustomSquareStyles = {};

  if (from) {
    styles[from as keyof CustomSquareStyles] = {
      background: mode === "show" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)"
    };
  }

  if (to) {
    styles[to as keyof CustomSquareStyles] = {
      background: `color-mix(in srgb, ${color} 42%, transparent)`,
      boxShadow: `inset 0 0 0 2px ${color}`
    };
  }

  return styles;
}

function getReviewLabel(move: AnnotatedMove): { badge: string; sentence: string; tone: string } {
  if (move.phase === "opening" && move.category === "best" && move.ply <= 8) {
    return {
      badge: "Book",
      sentence: "is a book move",
      tone: "#d9aa73"
    };
  }

  return reviewCopy[move.category];
}

function buildModeState(move: AnnotatedMove, mode: ReviewMode) {
  const label = getReviewLabel(move);
  const actualMove = parseUciMove(move.uci);
  const bestMove = parseUciMove(move.bestLine.move);
  const actualTone = label.tone;
  const bestTone = "#9dd94e";

  if (mode === "retry") {
    return {
      position: move.fenBefore,
      arrows: [] as Arrow[],
      squareStyles: {} as CustomSquareStyles,
      scoreCp: move.scoreBeforeCp,
      headline: `Retry this position`,
      badge: "Retry",
      tone: "#9ca7b8",
      summary: `Find a stronger move for ${move.color}. Then use Show or Best to compare your idea.`,
      line: `Engine evaluation before the move: ${formatEval(move.scoreBeforeCp)}`
    };
  }

  if (mode === "best") {
    const bestPosition = applyMoveToFen(move.fenBefore, move.bestLine.move);

    return {
      position: bestPosition?.fen ?? move.fenBefore,
      arrows: bestMove ? ([[bestMove.from, bestMove.to, bestTone]] as Arrow[]) : ([] as Arrow[]),
      squareStyles: buildSquareStyles(bestMove?.from ?? null, bestMove?.to ?? null, bestTone, "best"),
      scoreCp: move.bestLine.scoreCp,
      headline: `${bestPosition?.san ?? move.bestLine.move} is best`,
      badge: "Best",
      tone: bestTone,
      summary:
        move.category === "best" || move.category === "brilliant" || move.category === "great"
          ? "Your move was already among the strongest options here."
          : `This engine move keeps the cleaner evaluation path and improves on the game move.`,
      line: `Best line: ${move.bestLine.pv.slice(0, 7).join(" ")}`
    };
  }

  return {
    position: move.fenAfter,
    arrows: actualMove ? ([[actualMove.from, actualMove.to, actualTone]] as Arrow[]) : ([] as Arrow[]),
    squareStyles: buildSquareStyles(actualMove?.from ?? null, actualMove?.to ?? null, actualTone, "show"),
    scoreCp: move.scoreAfterCp,
    headline: `${move.san} ${label.sentence}`,
    badge: label.badge,
    tone: actualTone,
    summary: move.note,
    line:
      move.category === "best" || move.category === "great" || move.category === "brilliant"
        ? `Engine line: ${move.bestLine.pv.slice(0, 7).join(" ")}`
        : `Use Best to compare this move against the stronger engine continuation.`
  };
}

function railLabel(move: AnnotatedMove): string {
  return `${move.moveNumber}. ${move.san}`;
}

function oppositeColor(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function colorLabel(color: PlayerColor): string {
  return color === "white" ? "White" : "Black";
}

function BoardPlayerLabel({
  color,
  isUser,
  name
}: {
  color: PlayerColor;
  isUser?: boolean;
  name: string;
}) {
  return (
    <div className="review-board-player">
      <div className="review-board-player-main">
        <span className={`review-board-color-dot review-board-color-${color}`} aria-hidden="true" />
        <span className="review-board-player-name">{name}</span>
        {isUser ? <span className="review-board-you">You</span> : null}
      </div>
      <span className={`review-board-color-label review-board-color-label-${color}`}>
        {colorLabel(color)}
      </span>
    </div>
  );
}

function calculateReviewBoardSize(columnWidth = 0): number {
  if (typeof window === "undefined") {
    return 560;
  }

  const availableHeight = window.innerWidth < 900 ? window.innerHeight - 180 : window.innerHeight - 190;

  if (window.innerWidth < 900) {
    return Math.round(Math.max(300, Math.min(560, window.innerWidth - 56, availableHeight)));
  }

  const availableWidth = columnWidth > 0 ? columnWidth : window.innerWidth * 0.42;

  return Math.round(Math.max(420, Math.min(920, availableWidth, availableHeight)));
}

export function GameReviewPage() {
  const { gameId } = useParams();
  const [searchParams] = useSearchParams();
  const { snapshot, reviewCache, setReview, reviewJobs, setReviewJob } = useWorkspace();
  const game = snapshot?.games.find((entry) => entry.id === gameId) ?? null;
  const review = gameId ? reviewCache[gameId] : null;
  const reviewJob = gameId ? reviewJobs[gameId] ?? null : null;
  const [selectedPly, setSelectedPly] = useState<number | null>(null);
  const [mode, setMode] = useState<ReviewMode>("show");
  const [error, setError] = useState<string | null>(null);
  const [boardSize, setBoardSize] = useState(calculateReviewBoardSize);
  const reviewStageRef = useRef<HTMLElement | null>(null);
  const reviewBoardColumnRef = useRef<HTMLDivElement | null>(null);
  const focusedReviewKeyRef = useRef<string | null>(null);
  const requestedPly = useMemo(() => {
    const value = Number(searchParams.get("ply"));
    return Number.isFinite(value) && value > 0 ? value : null;
  }, [searchParams]);
  const requestedMode = searchParams.get("mode") === "retry" ? "retry" : "show";

  useEffect(() => {
    let frameId = 0;
    const handleResize = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const columnWidth = reviewBoardColumnRef.current?.getBoundingClientRect().width ?? 0;
        setBoardSize(calculateReviewBoardSize(columnWidth));
      });
    };

    handleResize();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);

    if (reviewBoardColumnRef.current) {
      resizeObserver?.observe(reviewBoardColumnRef.current);
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [review?.moves.length]);

  const handleReviewUpdate = useCallback(
    (job: JobState<ReviewSummary>) => {
      if (!gameId) {
        return;
      }

      setReviewJob(gameId, job);
      if (job.status === "completed" && job.result) {
        setReview(gameId, job.result);
      }
    },
    [gameId, setReview, setReviewJob]
  );

  useJobPolling(reviewJob, handleReviewUpdate);

  const handleStartReview = useCallback(async () => {
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
      if (job.status === "completed" && job.result) {
        setReview(game.id, job.result);
      }
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not start review.");
    }
  }, [game, setReview, setReviewJob, snapshot]);

  useEffect(() => {
    if (review || reviewJob || !snapshot || !game) {
      return;
    }

    void handleStartReview();
  }, [game, handleStartReview, review, reviewJob, snapshot]);

  useEffect(() => {
    if (!review?.moves.length) {
      return;
    }

    const requestedMove =
      requestedPly === null
        ? null
        : review.moves.find((move) => move.ply >= requestedPly) ?? review.moves.at(-1) ?? null;

    setSelectedPly((current) => {
      if (requestedMove) {
        return requestedMove.ply;
      }

      return current !== null && review.moves.some((move) => move.ply === current) ? current : review.moves[0].ply;
    });
    setMode(requestedMove ? requestedMode : "show");
  }, [review, gameId, requestedMode, requestedPly]);

  const selectedIndex = useMemo(() => {
    if (!review?.moves.length || selectedPly === null) {
      return -1;
    }

    return review.moves.findIndex((move) => move.ply === selectedPly);
  }, [review, selectedPly]);

  const selectedMove = useMemo(() => {
    if (!review?.moves.length) {
      return null;
    }

    if (selectedIndex >= 0) {
      return review.moves[selectedIndex];
    }

    return review.moves[0];
  }, [review, selectedIndex]);

  useEffect(() => {
    if (!review?.moves.length || !selectedMove || !gameId) {
      return;
    }

    const reviewKey = `${gameId}-${review.moves.length}`;
    if (focusedReviewKeyRef.current === reviewKey) {
      return;
    }

    focusedReviewKeyRef.current = reviewKey;
    window.requestAnimationFrame(() => {
      reviewStageRef.current?.scrollIntoView({ block: "start" });
    });
  }, [gameId, review, selectedMove]);

  const modeState = useMemo(() => {
    if (!selectedMove) {
      return null;
    }

    return buildModeState(selectedMove, mode);
  }, [selectedMove, mode]);

  const boardPlayers = useMemo(() => {
    if (!snapshot || !game) {
      return null;
    }

    return {
      top: {
        color: oppositeColor(game.color),
        name: game.opponent
      },
      bottom: {
        color: game.color,
        name: snapshot.username
      }
    };
  }, [game, snapshot]);

  const railMoves = useMemo(() => {
    if (!review?.moves.length || selectedIndex < 0) {
      return [];
    }

    const start = Math.max(0, selectedIndex - 3);
    const end = Math.min(review.moves.length, selectedIndex + 4);
    return review.moves.slice(start, end);
  }, [review, selectedIndex]);

  const goToIndex = (nextIndex: number) => {
    if (!review?.moves.length) {
      return;
    }

    const clampedIndex = Math.max(0, Math.min(review.moves.length - 1, nextIndex));
    setSelectedPly(review.moves[clampedIndex].ply);
    setMode("show");
  };

  const goPrev = () => {
    if (selectedIndex <= 0) {
      return;
    }

    goToIndex(selectedIndex - 1);
  };

  const goNext = () => {
    if (!review?.moves.length || selectedIndex >= review.moves.length - 1) {
      return;
    }

    goToIndex(selectedIndex + 1);
  };

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <span className="eyebrow">Deep review</span>
          <h1>Game Review</h1>
          <p>Move through this game with the board, engine notes, and controls in one review workspace.</p>
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
          {error ? <div className="error-text">{error}</div> : null}

          {review && selectedMove && modeState ? (
            <section className="review-stage-shell" ref={reviewStageRef}>
              <article className="panel review-stage-panel">
                <div className="review-board-column" ref={reviewBoardColumnRef}>
                  <div className="review-board-stack" style={{ width: boardSize }}>
                    {boardPlayers ? (
                      <BoardPlayerLabel
                        color={boardPlayers.top.color}
                        name={boardPlayers.top.name}
                      />
                    ) : null}
                    <div className="board-wrap review-board-wrap">
                      <Chessboard
                        id="review-board"
                        position={modeState.position}
                        boardWidth={boardSize}
                        boardOrientation={game.color}
                        arePiecesDraggable={false}
                        areArrowsAllowed={false}
                        showBoardNotation={false}
                        customArrows={modeState.arrows}
                        customSquareStyles={modeState.squareStyles}
                        customDarkSquareStyle={{ backgroundColor: "#779954" }}
                        customLightSquareStyle={{ backgroundColor: "#eeeed2" }}
                        customBoardStyle={{
                          borderRadius: "10px",
                          overflow: "hidden",
                          boxShadow: "0 24px 40px rgba(0, 0, 0, 0.32)"
                        }}
                      />
                    </div>
                    {boardPlayers ? (
                      <BoardPlayerLabel
                        color={boardPlayers.bottom.color}
                        isUser
                        name={boardPlayers.bottom.name}
                      />
                    ) : null}
                  </div>
                </div>

                <aside className="review-controls-panel">
                  <div className="review-eval-wrap">
                    <div className="review-eval-score">{formatEval(modeState.scoreCp)}</div>
                    <div className="review-eval-bar">
                      <div
                        className="review-eval-fill"
                        style={{ width: `${evalBarPercent(modeState.scoreCp)}%` }}
                      />
                    </div>
                  </div>

                  <div className="review-callout">
                    <div className="review-callout-copy">
                      <span className="review-callout-badge" style={{ backgroundColor: modeState.tone }}>
                        {modeState.badge}
                      </span>
                      <h2>{modeState.headline}</h2>
                      <p>{modeState.summary}</p>
                    </div>
                    <div className="review-callout-score">{formatEval(modeState.scoreCp)}</div>
                  </div>

                  <div className="review-line-note">
                    <strong>{mode === "best" ? "Engine says" : "Review note"}</strong>
                    <span>{modeState.line}</span>
                  </div>

                  <div className="review-toolbar">
                    <div className="review-mode-actions">
                      <button
                        className={`review-action-chip${mode === "show" ? " review-action-chip-active" : ""}`}
                        onClick={() => setMode("show")}
                      >
                        <Eye size={16} />
                        <span>Show</span>
                      </button>
                      <button
                        className={`review-action-chip${mode === "best" ? " review-action-chip-active" : ""}`}
                        onClick={() => setMode("best")}
                      >
                        <Sparkles size={16} />
                        <span>Best</span>
                      </button>
                      <button
                        className={`review-action-chip${mode === "retry" ? " review-action-chip-active" : ""}`}
                        onClick={() => setMode("retry")}
                      >
                        <RotateCcw size={16} />
                        <span>Retry</span>
                      </button>
                    </div>

                    <div className="review-step-actions">
                      <button className="review-step-back" onClick={goPrev} disabled={selectedIndex <= 0}>
                        <ChevronLeft size={20} />
                      </button>
                      <button
                        className="review-step-next"
                        onClick={goNext}
                        disabled={!review.moves.length || selectedIndex >= review.moves.length - 1}
                      >
                        <Target size={18} />
                        <span>{selectedIndex >= review.moves.length - 1 ? "End of review" : "Next move"}</span>
                      </button>
                    </div>
                  </div>

                  <div className="review-rail">
                    <button className="review-nav-button" onClick={goPrev} disabled={selectedIndex <= 0}>
                      <ChevronLeft size={20} />
                    </button>

                    <div className="review-rail-track">
                      {railMoves.map((move) => {
                        const label = getReviewLabel(move);
                        const isActive = move.ply === selectedMove.ply;

                        return (
                          <button
                            key={`${move.ply}-${move.uci}`}
                            className={`review-rail-chip${isActive ? " review-rail-chip-active" : ""}`}
                            onClick={() => {
                              setSelectedPly(move.ply);
                              setMode("show");
                            }}
                          >
                            <span className="review-rail-chip-label">{railLabel(move)}</span>
                            <span className="review-rail-chip-tag" style={{ color: label.tone }}>
                              {label.badge}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <button
                      className="review-nav-button"
                      onClick={goNext}
                      disabled={!review.moves.length || selectedIndex >= review.moves.length - 1}
                    >
                      <ChevronRight size={20} />
                    </button>
                  </div>
                </aside>
              </article>
            </section>
          ) : (
            <section className="panel empty-panel">
              <h2>{reviewJob ? "Preparing deep review" : "Deep review starting"}</h2>
              <p>
                {reviewJob
                  ? "Stockfish is building the move-by-move review for this game."
                  : "This review will start automatically for the selected game."}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
