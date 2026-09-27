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
import { OPENING_PLY_LIMIT } from "../../shared/constants";
import { formatEval, whiteWinPercent, type WhiteEval } from "../../shared/eval";
import { isJobActive } from "../../shared/jobPolling";
import type { AnnotatedMove, GameRecord, JobState, MoveCategory, PlayerColor, ReviewSummary } from "../../shared/types";
import { fetchGame, startGameReview } from "../api/client";
import { boardTheme } from "../components/boardTheme";
import { useJobPolling } from "../hooks/useJobPolling";
import { useStoreQuery } from "../hooks/useStoreQuery";
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
  best: {
    badge: "Best",
    sentence: "is best",
    tone: "#9dd94e"
  },
  good: {
    badge: "Good",
    sentence: "is good",
    tone: "#81b64c"
  },
  inaccuracy: {
    badge: "Inaccuracy",
    sentence: "is an inaccuracy",
    tone: "#f7c948"
  },
  mistake: {
    badge: "Mistake",
    sentence: "is a mistake",
    tone: "#ffa459"
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

function applyMoveToFen(fen: string, uci: string): string | null {
  const parsed = parseUciMove(uci);
  if (!parsed) {
    return null;
  }

  try {
    const chess = new Chess(fen);
    chess.move(parsed);
    return chess.fen();
  } catch {
    return null;
  }
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

function buildModeState(move: AnnotatedMove, mode: ReviewMode) {
  const label = reviewCopy[move.category];
  const actualMove = parseUciMove(move.uci);
  const bestMove = parseUciMove(move.bestLine.uci);
  const actualTone = label.tone;
  const bestTone = reviewCopy.best.tone;
  const evalBefore: WhiteEval = { cp: move.whiteCpBefore, mate: move.mateBefore };
  const evalAfter: WhiteEval = { cp: move.whiteCpAfter, mate: move.mateAfter };
  const bestLineText = move.bestLine.pvSan.slice(0, 7).join(" ");

  if (mode === "retry") {
    return {
      position: move.fenBefore,
      arrows: [] as Arrow[],
      squareStyles: {} as CustomSquareStyles,
      evaluation: evalBefore,
      headline: `Retry this position`,
      badge: "Retry",
      tone: "#9ca7b8",
      summary: `Find a stronger move for ${move.color}. Then use Show or Best to compare your idea.`,
      line: `Engine evaluation before the move: ${formatEval(evalBefore)}`
    };
  }

  if (mode === "best") {
    return {
      position: applyMoveToFen(move.fenBefore, move.bestLine.uci) ?? move.fenBefore,
      arrows: bestMove ? ([[bestMove.from, bestMove.to, bestTone]] as Arrow[]) : ([] as Arrow[]),
      squareStyles: buildSquareStyles(bestMove?.from ?? null, bestMove?.to ?? null, bestTone, "best"),
      evaluation: { cp: move.bestLine.whiteCp, mate: move.bestLine.mate },
      headline: `${move.bestLine.san} is best`,
      badge: "Best",
      tone: bestTone,
      summary:
        move.category === "best"
          ? move.isPlayerMove
            ? "Your move was already among the strongest options here."
            : "The game move was already among the strongest options here."
          : `This engine move keeps the cleaner evaluation path and improves on ${move.san}.`,
      line: `Best line: ${bestLineText}`
    };
  }

  return {
    position: move.fenAfter,
    arrows: actualMove ? ([[actualMove.from, actualMove.to, actualTone]] as Arrow[]) : ([] as Arrow[]),
    squareStyles: buildSquareStyles(actualMove?.from ?? null, actualMove?.to ?? null, actualTone, "show"),
    evaluation: evalAfter,
    headline: `${move.san} ${label.sentence}`,
    badge: label.badge,
    tone: actualTone,
    summary: move.note,
    line:
      move.category === "best"
        ? `Engine line: ${bestLineText}`
        : `Use Best to compare this move against the stronger engine continuation.`
  };
}

/** "Lost as Black vs x (1210) · Scandinavian Defense · Sep 26, 2026", from the stored game. */
function gameSubtitle(game: Pick<GameRecord, "result" | "color" | "oppName" | "oppRating" | "openingName" | "endTime">): string {
  const result = game.result === "win" ? "Won" : game.result === "loss" ? "Lost" : "Drew";
  const date = new Date(game.endTime * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return `${result} as ${colorLabel(game.color)} vs ${game.oppName} (${game.oppRating}) · ${game.openingName} · ${date}.`;
}

function reviewSubtitle(review: ReviewSummary): string {
  const { header } = review;
  const opponent = header[oppositeColor(review.color)];
  return `${gameSubtitle({
    result: header.result,
    color: review.color,
    oppName: opponent.username,
    oppRating: opponent.rating,
    openingName: header.openingName,
    endTime: header.endTime
  })} First ${OPENING_PLY_LIMIT / 2} moves; evals are from White's side.`;
}

function railLabel(move: AnnotatedMove): string {
  return `${move.moveNumber}${move.color === "black" ? "..." : "."} ${move.san}`;
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

  const isCompactLayout = window.innerWidth < 900;
  const availableHeight = isCompactLayout ? window.innerHeight - 220 : window.innerHeight - 190;
  const availableWidth = columnWidth > 0
    ? columnWidth
    : window.innerWidth - (isCompactLayout ? 72 : 0);

  if (isCompactLayout) {
    const minimumSize = Math.min(240, availableWidth);
    return Math.round(Math.max(minimumSize, Math.min(560, availableWidth, availableHeight)));
  }

  return Math.round(Math.max(420, Math.min(920, availableWidth, availableHeight)));
}

export function GameReviewPage() {
  const { gameId } = useParams();
  const [searchParams] = useSearchParams();
  // Any stored game opens here: the header comes from GET /api/games/:id, and the server
  // reviews the game from the store (joining a review of the same game that is running).
  const { reviewCache, setReview, reviewJobs, setReviewJob } = useWorkspace();
  const gameQuery = useStoreQuery(
    (signal) => (gameId ? fetchGame(gameId, signal).then((response) => response.game) : Promise.resolve(null)),
    [gameId]
  );
  const game = gameQuery.data;
  const review = gameId ? reviewCache[gameId] : null;
  const reviewJob = gameId ? reviewJobs[gameId] ?? null : null;
  const [selectedPly, setSelectedPly] = useState<number | null>(null);
  const [mode, setMode] = useState<ReviewMode>("show");
  const [error, setError] = useState<string | null>(null);
  const [boardSize, setBoardSize] = useState(calculateReviewBoardSize);
  const reviewStageRef = useRef<HTMLElement | null>(null);
  const reviewBoardColumnRef = useRef<HTMLDivElement | null>(null);
  const focusedReviewKeyRef = useRef<string | null>(null);
  // Starts each game's review once, even when StrictMode runs the effect twice in dev
  // (two starts would run two Stockfish reviews of the same game side by side).
  const startedReviewsRef = useRef(new Set<string>());
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
    if (!gameId) {
      return;
    }

    setError(null);
    try {
      const job = await startGameReview(gameId);
      setReviewJob(gameId, job);
      if (job.status === "completed" && job.result) {
        setReview(gameId, job.result);
      }
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not start review.");
    }
  }, [gameId, setReview, setReviewJob]);

  useEffect(() => {
    if (!game || review || reviewJob || !gameId || startedReviewsRef.current.has(gameId)) {
      return;
    }

    startedReviewsRef.current.add(gameId);
    void handleStartReview();
  }, [game, gameId, handleStartReview, review, reviewJob]);

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
    if (!review) {
      return null;
    }

    const opponentColor = oppositeColor(review.color);
    return {
      top: {
        color: opponentColor,
        name: review.header[opponentColor].username
      },
      bottom: {
        color: review.color,
        name: review.header[review.color].username
      }
    };
  }, [review]);

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
          <span className="eyebrow">Opening review</span>
          <h1>Game Review</h1>
          <p>
            {review
              ? reviewSubtitle(review)
              : game
                ? `${gameSubtitle(game)} Stockfish reviews the first ${OPENING_PLY_LIMIT / 2} moves.`
                : `Stockfish reviews the opening: the first ${OPENING_PLY_LIMIT / 2} moves of the game.`}
          </p>
        </div>
      </section>

      {!gameId ? (
        <section className="panel empty-panel">
          <h2>No game selected</h2>
          <p>Open the Explorer, pick a move and choose a game from its games list.</p>
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
                        boardOrientation={review.color}
                        arePiecesDraggable={false}
                        areArrowsAllowed={false}
                        showBoardNotation={false}
                        customArrows={modeState.arrows}
                        customSquareStyles={modeState.squareStyles}
                        {...boardTheme}
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
                    <div className="review-eval-score" title="Engine eval from White's side">
                      {formatEval(modeState.evaluation)}
                    </div>
                    <div className="review-eval-bar" aria-hidden="true">
                      <div
                        className="review-eval-fill"
                        style={{ width: `${whiteWinPercent(modeState.evaluation)}%` }}
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
                    <div className="review-callout-score">{formatEval(modeState.evaluation)}</div>
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
                        const label = reviewCopy[move.category];
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
              {gameQuery.error ? (
                <>
                  <h2>Game not found</h2>
                  <p>{gameQuery.error}</p>
                </>
              ) : reviewJob?.status === "failed" ? (
                <>
                  <h2>Opening review failed</h2>
                  <p className="error-text">{reviewJob.error ?? reviewJob.message}</p>
                  <button className="primary-button" type="button" onClick={() => void handleStartReview()}>
                    Retry
                  </button>
                </>
              ) : (
                <>
                  <h2>{isJobActive(reviewJob) ? "Preparing opening review" : "Opening review starting"}</h2>
                  <p>
                    {isJobActive(reviewJob)
                      ? `Stockfish is reviewing the first ${OPENING_PLY_LIMIT / 2} moves of this game.`
                      : gameQuery.loading
                        ? "Loading the game from the local store."
                        : "This review will start automatically for the selected game."}
                  </p>
                  {reviewJob && isJobActive(reviewJob) ? (
                    <div className="job-panel review-job-panel" role="status">
                      <div className="job-header">
                        <span>{reviewJob.message}</span>
                        <span>{reviewJob.progress}%</span>
                      </div>
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${reviewJob.progress}%` }} />
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
