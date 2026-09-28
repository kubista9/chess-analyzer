import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Chess, type Square } from "chess.js";
import type { Arrow } from "react-chessboard/dist/chessboard/types";
import { ChevronLeft, ChevronRight, Eye, FlipVertical2, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { OPENING_PLY_LIMIT, OWNER_USERNAME } from "../../shared/constants";
import { isOpeningError, type WhiteEval } from "../../shared/eval";
import { isJobActive } from "../../shared/jobPolling";
import { OPPONENT_ERROR_LOSS } from "../../shared/openingAnalysis";
import {
  RETRY_REVEAL_AFTER,
  bookExitCopy,
  cleanOpeningCopy,
  moveLabel,
  openingPly,
  type OpeningReview,
  type RetryResult,
  type ReviewPly
} from "../../shared/review";
import type { GameRecord, JobState, PlayerColor, ReviewLine } from "../../shared/types";
import { fetchGame, fetchGameAnalysis, postRetry } from "../api/client";
import { boardColors } from "../components/boardTheme";
import { EvalBar, evalLabel } from "../components/EvalBar";
import { CLASS_LABELS, MoveList } from "../components/MoveList";
import { PlayableBoard, type PlayedMove } from "../components/PlayableBoard";
import { PvLine } from "../components/PvLine";
import { ReviewBoard } from "../components/ReviewBoard";
import { useJobPolling } from "../hooks/useJobPolling";
import { useStoreQuery } from "../hooks/useStoreQuery";
import "../styles/review.css";

type ReviewMode = "show" | "best" | "retry";
type LineKind = "best" | "played";

const CLASS_TONES = {
  best: "#9dd94e",
  good: "#81b64c",
  inaccuracy: "#f0b45d",
  mistake: "#ec8a3f",
  blunder: "#d95f5f"
} as const;

function squaresOf(uci: string): [Square, Square] {
  return [uci.slice(0, 2) as Square, uci.slice(2, 4) as Square];
}

/** The position after `sans` from `fen`, and the last move's squares (null if a move does not apply). */
function playSans(fen: string, sans: readonly string[]): { fen: string; last: [Square, Square] | null } {
  const chess = new Chess(fen);
  let last: [Square, Square] | null = null;
  for (const san of sans) {
    try {
      const move = chess.move(san);
      last = [move.from, move.to];
    } catch {
      break;
    }
  }
  return { fen: chess.fen(), last };
}

function lineEval(line: ReviewLine | null | undefined): WhiteEval | null {
  return line ? { cp: line.whiteCp, mate: line.mate } : null;
}

/** "−14% win chance" (one decimal under 1%). */
function lossCopy(loss: number): string {
  return `−${loss < 1 ? loss.toFixed(1) : Math.round(loss)}% win chance`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

interface Callout {
  badge: string;
  tone: string;
  headline: string;
  detail: string | null;
}

function calloutFor(ply: ReviewPly): Callout {
  const label = moveLabel(ply.ply, ply.san);
  const best = ply.lines[0];
  const bestCopy = best && best.uci !== ply.uci ? `Best was ${moveLabel(ply.ply, best.san)}` : null;
  if (ply.loss === null || !ply.cls) {
    return { badge: "Pending", tone: "#9ca7b8", headline: label, detail: "The engine has not checked this move yet." };
  }
  if (ply.owner) {
    const cls = CLASS_LABELS[ply.cls].label;
    if (ply.cls === "best") {
      // "Engine agrees" is only ever said about the owner's own moves.
      return { badge: cls, tone: CLASS_TONES.best, headline: `Engine agrees: ${label} is the best move here`, detail: null };
    }
    return {
      badge: cls,
      tone: CLASS_TONES[ply.cls],
      headline: `${label} is ${article(ply.cls)} ${ply.cls} (${lossCopy(ply.loss)})`,
      detail: bestCopy
    };
  }
  if (ply.loss >= OPPONENT_ERROR_LOSS) {
    return {
      badge: "Opponent error",
      tone: CLASS_TONES.mistake,
      headline: `${label} by your opponent gives away about ${Math.round(ply.loss)}% win chance`,
      detail: `${bestCopy ?? ""}${bestCopy ? ". " : ""}Approximate: the opponent's moves get a quicker engine check.`
    };
  }
  return {
    badge: "Opponent",
    tone: "#9ca7b8",
    headline: `${label} by your opponent`,
    detail: best && best.uci !== ply.uci ? `The engine preferred ${moveLabel(ply.ply, best.san)}.` : null
  };
}

function gameSubtitle(game: Pick<GameRecord, "result" | "color" | "oppName" | "oppRating" | "openingName" | "endTime">): string {
  const result = game.result === "win" ? "Won" : game.result === "loss" ? "Lost" : "Drew";
  const date = new Date(game.endTime * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${result} as ${colorLabel(game.color)} vs ${game.oppName} (${game.oppRating}) · ${game.openingName} · ${date}.`;
}

function oppositeColor(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function colorLabel(color: PlayerColor): string {
  return color === "white" ? "White" : "Black";
}

function BoardPlayerLabel({ color, isUser, name }: { color: PlayerColor; isUser?: boolean; name: string }) {
  return (
    <div className="review-board-player">
      <div className="review-board-player-main">
        <span className={`review-board-color-dot review-board-color-${color}`} aria-hidden="true" />
        <span className="review-board-player-name">{name}</span>
        {isUser ? <span className="review-board-you">You</span> : null}
      </div>
      <span className={`review-board-color-label review-board-color-label-${color}`}>{colorLabel(color)}</span>
    </div>
  );
}

/** Below this width the eval bar is a strip above the board instead of a bar beside it. */
const EVAL_STRIP_BELOW = 760;
const EVAL_BAR_SPACE = 32;

function calculateReviewBoardSize(columnWidth = 0): number {
  if (typeof window === "undefined") {
    return 560;
  }

  const isCompactLayout = window.innerWidth < 900;
  const barSpace = window.innerWidth < EVAL_STRIP_BELOW ? 0 : EVAL_BAR_SPACE;
  const availableHeight = isCompactLayout ? window.innerHeight - 220 : window.innerHeight - 190;
  const availableWidth = (columnWidth > 0 ? columnWidth : window.innerWidth - (isCompactLayout ? 72 : 0)) - barSpace;

  if (isCompactLayout) {
    const minimumSize = Math.min(240, availableWidth);
    return Math.round(Math.max(minimumSize, Math.min(560, availableWidth, availableHeight)));
  }

  return Math.round(Math.max(420, Math.min(920, availableWidth, availableHeight)));
}

interface RetryState {
  ply: number;
  /** Bumped to put the board back to the position before the move. */
  boardKey: number;
  checking: boolean;
  misses: number;
  revealed: boolean;
  last: RetryResult | null;
  error: string | null;
}

const freshRetry = (ply: number): RetryState => ({ ply, boardKey: 0, checking: false, misses: 0, revealed: false, last: null, error: null });

export function GameReviewPage() {
  const { gameId } = useParams();
  const [searchParams] = useSearchParams();
  const gameQuery = useStoreQuery(
    (signal) => (gameId ? fetchGame(gameId, signal).then((response) => response.game) : Promise.resolve(null)),
    [gameId]
  );
  const game = gameQuery.data;
  const [review, setReview] = useState<OpeningReview | null>(null);
  const [job, setJob] = useState<JobState<OpeningReview> | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPly, setSelectedPly] = useState(0);
  const [mode, setMode] = useState<ReviewMode>("show");
  const [lineStep, setLineStep] = useState<{ kind: LineKind; index: number } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [retry, setRetry] = useState<RetryState>(freshRetry(0));
  const [boardSize, setBoardSize] = useState(calculateReviewBoardSize);
  const reviewStageRef = useRef<HTMLElement | null>(null);
  const reviewBoardColumnRef = useRef<HTMLDivElement | null>(null);
  const landedRef = useRef<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const requestedPly = useMemo(() => {
    const value = Number(searchParams.get("ply"));
    return Number.isFinite(value) && value > 0 ? value : null;
  }, [searchParams]);
  const requestedMode: ReviewMode = searchParams.get("mode") === "retry" ? "retry" : "show";

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!gameId) {
        return;
      }
      setError(null);
      fetchGameAnalysis(gameId, signal)
        .then((response) => {
          setReview(response.review);
          setJob(response.job);
          setEngineError(response.engineError);
        })
        .catch((loadError: unknown) => {
          if (!signal?.aborted) {
            setError(loadError instanceof Error ? loadError.message : "Could not load the review.");
          }
        });
    },
    [gameId]
  );

  useEffect(() => {
    setReview(null);
    setJob(null);
    landedRef.current = null;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useJobPolling(job, (next) => {
    setJob(next);
    if (next.status === "completed" && next.result) {
      setReview(next.result);
    }
  });

  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    },
    []
  );

  // The review shows once it is complete, or when no engine job is filling it in any more.
  const ready = review !== null && (review.status === "complete" || !isJobActive(job));

  // Open at ?ply=, else the owner's first mistake, else the book exit: once per game.
  useEffect(() => {
    if (!ready || !review || !review.plies.length) {
      return;
    }
    const key = `${review.gameId}|${requestedPly ?? ""}|${requestedMode}`;
    if (landedRef.current === key) {
      return;
    }
    landedRef.current = key;
    const ply = openingPly(review, requestedPly);
    setSelectedPly(ply);
    setLineStep(null);
    setMode(requestedMode === "retry" && review.plies[ply - 1]?.owner ? "retry" : "show");
    setRetry(freshRetry(ply));
    window.requestAnimationFrame(() => reviewStageRef.current?.scrollIntoView({ block: "start" }));
  }, [ready, review, requestedPly, requestedMode]);

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
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    if (reviewBoardColumnRef.current) {
      resizeObserver?.observe(reviewBoardColumnRef.current);
    }
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [ready]);

  const plies = review?.plies ?? [];
  const ply: ReviewPly | undefined = plies[selectedPly - 1];
  const orientation: PlayerColor = review ? (flipped ? oppositeColor(review.color) : review.color) : "white";
  const mistakes = useMemo(() => plies.filter((entry) => entry.owner && entry.cls && isOpeningError(entry.cls)).map((entry) => entry.ply), [plies]);

  const select = useCallback(
    (next: number, nextMode: ReviewMode = "show") => {
      if (!plies.length) {
        return;
      }
      const clamped = Math.max(1, Math.min(plies.length, next));
      setSelectedPly(clamped);
      setLineStep(null);
      setMode(nextMode === "retry" && !plies[clamped - 1].owner ? "show" : nextMode);
      setRetry(freshRetry(clamped));
    },
    [plies]
  );

  const changeMode = useCallback(
    (next: ReviewMode) => {
      if (next === "retry" && !ply?.owner) {
        return;
      }
      setMode(next);
      setLineStep(null);
      if (next === "retry") {
        setRetry(freshRetry(selectedPly));
      }
    },
    [ply, selectedPly]
  );

  const lineOf = (kind: LineKind): ReviewLine | null => (kind === "best" ? ply?.lines[0] ?? null : ply?.played ?? null);
  const steppedLine = lineStep ? lineOf(lineStep.kind) : null;

  // Keyboard: ←/→ moves (or steps the engine line being shown), Home/End, ↑/↓ the owner's
  // previous/next mistake, s/b/r modes, f flips the board, Esc back to the game.
  useEffect(() => {
    if (!ready) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, select, textarea")) {
        return;
      }
      const key = event.key;
      const handled = () => event.preventDefault();
      if (lineStep && steppedLine && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
        handled();
        const last = steppedLine.pvSan.length - 1;
        const index = key === "Home" ? 0 : key === "End" ? last : lineStep.index + (key === "ArrowRight" ? 1 : -1);
        setLineStep(index < 0 ? null : { ...lineStep, index: Math.min(last, index) });
        return;
      }
      if (key === "ArrowLeft") {
        handled();
        select(selectedPly - 1);
      } else if (key === "ArrowRight") {
        handled();
        select(selectedPly + 1);
      } else if (key === "Home") {
        handled();
        select(1);
      } else if (key === "End") {
        handled();
        select(plies.length);
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        handled();
        const next = key === "ArrowUp" ? [...mistakes].reverse().find((at) => at < selectedPly) : mistakes.find((at) => at > selectedPly);
        if (next) {
          select(next);
        }
      } else if (key === "s" || key === "b" || key === "r") {
        handled();
        changeMode(key === "s" ? "show" : key === "b" ? "best" : "retry");
      } else if (key === "f") {
        handled();
        setFlipped((value) => !value);
      } else if (key === "Escape") {
        handled();
        if (lineStep) {
          setLineStep(null);
        } else {
          changeMode("show");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, lineStep, steppedLine, select, selectedPly, plies.length, mistakes, changeMode]);

  const onRetryMove = (move: PlayedMove): boolean => {
    if (!gameId || !ply || retry.checking) {
      return false;
    }
    const at = ply.ply;
    setRetry((current) => ({ ...current, checking: true, error: null }));
    postRetry(gameId, { ply: at, uci: move.uci })
      .then((result) => {
        setRetry((current) => {
          if (current.ply !== at) {
            return current;
          }
          const missed = result.verdict === "try-again";
          const misses = current.misses + (missed ? 1 : 0);
          return { ...current, checking: false, last: result, misses, revealed: current.revealed || !missed || misses >= RETRY_REVEAL_AFTER };
        });
        if (result.verdict === "try-again") {
          // Put the piece back after a moment, keeping the verdict on screen.
          retryTimerRef.current = window.setTimeout(() => {
            setRetry((current) => (current.ply === at ? { ...current, boardKey: current.boardKey + 1 } : current));
          }, 900);
        }
      })
      .catch((retryError: unknown) => {
        setRetry((current) => ({
          ...current,
          checking: false,
          boardKey: current.boardKey + 1,
          error: retryError instanceof Error ? retryError.message : "Could not check the move."
        }));
      });
    return true;
  };

  // What the board shows: a stepped engine line, the played move, the best move, or the retry position.
  const view = useMemo(() => {
    if (!ply) {
      return null;
    }
    const arrows: Arrow[] = [];
    if (lineStep && steppedLine) {
      const played = playSans(ply.fenBefore, steppedLine.pvSan.slice(0, lineStep.index + 1));
      if (played.last) {
        arrows.push([played.last[0], played.last[1], lineStep.kind === "best" ? boardColors.best : boardColors.arrow]);
      }
      return { fen: played.fen, arrows, evaluation: lineEval(steppedLine) };
    }
    if (mode === "best" && ply.lines[0]) {
      const best = playSans(ply.fenBefore, [ply.lines[0].san]);
      const [from, to] = squaresOf(ply.lines[0].uci);
      return { fen: best.fen, arrows: [[from, to, boardColors.best]] as Arrow[], evaluation: lineEval(ply.lines[0]) };
    }
    if (mode === "retry") {
      if (retry.revealed && ply.lines[0]) {
        const [from, to] = squaresOf(ply.lines[0].uci);
        arrows.push([from, to, boardColors.best]);
      }
      return { fen: ply.fenBefore, arrows, evaluation: retry.last ? lineEval(retry.last.played) : lineEval(ply.lines[0]) };
    }
    const [from, to] = squaresOf(ply.uci);
    arrows.push([from, to, ply.owner && ply.cls ? CLASS_TONES[ply.cls] : boardColors.arrow]);
    return { fen: ply.fenAfter, arrows, evaluation: ply.evalAfter === "pending" ? null : { cp: ply.evalAfter.cp, mate: ply.evalAfter.mate } };
  }, [ply, mode, lineStep, steppedLine, retry.revealed, retry.last]);

  const opponentName = game?.oppName ?? "Opponent";
  const players = review
    ? {
        top: { color: oppositeColor(orientation), name: oppositeColor(orientation) === review.color ? OWNER_USERNAME : opponentName },
        bottom: { color: orientation, name: orientation === review.color ? OWNER_USERNAME : opponentName }
      }
    : null;
  const divider = review?.bookExit ? bookExitCopy(review.bookExit, plies) : null;
  const callout = ply ? calloutFor(ply) : null;
  const bestLine = ply?.lines[0] ?? null;
  const playedLine = ply?.played && ply.played.uci !== bestLine?.uci ? ply.played : null;
  const alternatives = ply?.lines.slice(1) ?? [];

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <span className="eyebrow">Opening review</span>
          <h1>Game Review</h1>
          <p>
            {game ? `${gameSubtitle(game)} ` : ""}
            The first {OPENING_PLY_LIMIT / 2} moves, from the engine check; evals are from White's side.
          </p>
        </div>
      </section>

      {!gameId ? (
        <section className="panel empty-panel">
          <h2>No game selected</h2>
          <p>Open the Explorer, pick a move and choose a game from its games list.</p>
        </section>
      ) : error || gameQuery.error ? (
        <section className="panel empty-panel">
          <h2>Game not found</h2>
          <p className="error-text">{error ?? gameQuery.error}</p>
        </section>
      ) : ready && review && ply && view && callout ? (
        <section className="review-stage-shell" ref={reviewStageRef}>
          <article className="panel review-stage-panel">
            <div className="review-board-column" ref={reviewBoardColumnRef}>
              <div className="review-board-stack">
                {players ? <BoardPlayerLabel color={players.top.color} isUser={players.top.color === review.color} name={players.top.name} /> : null}
                <div className="review-board-row">
                  <EvalBar evaluation={view.evaluation} orientation={orientation} />
                  <div className="board-wrap review-board-wrap" style={{ width: boardSize }}>
                    {mode === "retry" ? (
                      <PlayableBoard
                        key={`${ply.ply}-${retry.boardKey}`}
                        id="review-retry-board"
                        fen={ply.fenBefore}
                        orientation={orientation}
                        width={boardSize}
                        disabled={retry.checking || (retry.last !== null && retry.last.verdict !== "try-again")}
                        onMove={onRetryMove}
                        arrows={view.arrows}
                      />
                    ) : (
                      <ReviewBoard id="review-board" fen={view.fen} orientation={orientation} width={boardSize} arrows={view.arrows} />
                    )}
                  </div>
                </div>
                {players ? (
                  <BoardPlayerLabel color={players.bottom.color} isUser={players.bottom.color === review.color} name={players.bottom.name} />
                ) : null}
              </div>
            </div>

            <aside className="review-controls-panel">
              {review.firstOwnerError === null ? (
                <p className="review-clean" role="status">
                  {cleanOpeningCopy(plies.length)}
                </p>
              ) : null}
              {review.status === "partial" ? (
                <p className="review-partial" role="status">
                  Engine data for {review.coverage.pliesScored} of {review.coverage.plies} moves.{" "}
                  {engineError ?? (job?.status === "failed" ? `The engine check failed: ${job.error ?? job.message}` : "")}
                </p>
              ) : null}

              {mode === "retry" ? (
                <RetryPanel ply={ply} retry={retry} onReveal={() => setRetry((current) => ({ ...current, revealed: true }))} onAgain={() => setRetry((current) => ({ ...freshRetry(current.ply), boardKey: current.boardKey + 1 }))} />
              ) : (
                <div className="review-callout">
                  <div className="review-callout-copy">
                    <div className="review-callout-badges">
                      <span className="review-callout-badge" style={{ backgroundColor: callout.tone }}>
                        {callout.badge}
                      </span>
                      {ply.inBook ? <span className="review-callout-badge review-callout-book">Book</span> : null}
                    </div>
                    <h2>{callout.headline}</h2>
                    {callout.detail ? <p>{callout.detail}</p> : null}
                    {mode === "best" && alternatives.length ? (
                      <p>
                        Other engine moves:{" "}
                        {alternatives.map((line) => `${moveLabel(ply.ply, line.san)} ${evalLabel({ cp: line.whiteCp, mate: line.mate })}`).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="review-callout-score" title="Engine eval from White's side">
                    {view.evaluation ? evalLabel(view.evaluation) : "pending"}
                  </div>
                </div>
              )}

              {mode !== "retry" && bestLine ? (
                <div className="review-lines">
                  <PvLine
                    label="Best line"
                    line={bestLine}
                    firstPly={ply.ply}
                    activeIndex={lineStep?.kind === "best" ? lineStep.index : null}
                    onStep={(index) => setLineStep(index === null ? null : { kind: "best", index })}
                  />
                  {playedLine ? (
                    <PvLine
                      label={ply.owner ? "Your move's line" : "The game's line"}
                      line={playedLine}
                      firstPly={ply.ply}
                      activeIndex={lineStep?.kind === "played" ? lineStep.index : null}
                      onStep={(index) => setLineStep(index === null ? null : { kind: "played", index })}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="review-toolbar">
                <div className="review-mode-actions" role="group" aria-label="Board mode">
                  <button type="button" className={`review-action-chip${mode === "show" ? " review-action-chip-active" : ""}`} aria-pressed={mode === "show"} title="Show the game move (S)" onClick={() => changeMode("show")}>
                    <Eye size={16} aria-hidden="true" />
                    <span>Show</span>
                  </button>
                  <button type="button" className={`review-action-chip${mode === "best" ? " review-action-chip-active" : ""}`} aria-pressed={mode === "best"} title="Show the engine's best move (B)" onClick={() => changeMode("best")}>
                    <Sparkles size={16} aria-hidden="true" />
                    <span>Best</span>
                  </button>
                  <button
                    type="button"
                    className={`review-action-chip${mode === "retry" ? " review-action-chip-active" : ""}`}
                    aria-pressed={mode === "retry"}
                    disabled={!ply.owner}
                    title={ply.owner ? "Play your own move from the position before (R)" : "Retry is for your own moves"}
                    onClick={() => changeMode("retry")}
                  >
                    <RotateCcw size={16} aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                </div>
                <div className="review-step-actions">
                  <button type="button" className="review-step-back" aria-label="Previous move (←)" title="Previous move (←)" onClick={() => select(selectedPly - 1)} disabled={selectedPly <= 1}>
                    <ChevronLeft size={20} aria-hidden="true" />
                  </button>
                  <button type="button" className="review-step-back" aria-label="Flip board (F)" title="Flip board (F)" aria-pressed={flipped} onClick={() => setFlipped((value) => !value)}>
                    <FlipVertical2 size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="review-step-next" aria-label="Next move (→)" onClick={() => select(selectedPly + 1)} disabled={selectedPly >= plies.length}>
                    <span>{selectedPly >= plies.length ? "End of review" : "Next move"}</span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <MoveList
                plies={plies}
                selectedPly={selectedPly}
                onSelect={(next) => select(next)}
                divider={divider && review.bookExit ? { afterPly: review.bookExit.lastBookPly, text: divider } : null}
                later={review.later}
                gameUrl={game?.url ?? null}
              />
              <p className="review-keys">← → moves · Home End · ↑ ↓ your mistakes · S B R modes · F flip · Esc back</p>
            </aside>
          </article>
        </section>
      ) : (
        <section className="panel empty-panel">
          {job?.status === "failed" && !review ? (
            <>
              <h2>Opening review failed</h2>
              <p className="error-text">{job.error ?? job.message}</p>
              <button className="primary-button" type="button" onClick={() => load()}>
                Try again
              </button>
            </>
          ) : (
            <>
              <h2>{isJobActive(job) ? "Checking the opening" : "Loading the review"}</h2>
              <p>
                {isJobActive(job)
                  ? `Stockfish is checking the ${review ? review.coverage.plies - review.coverage.pliesScored : ""} positions of this game's first ${OPENING_PLY_LIMIT / 2} moves that are not in the engine cache yet.`
                  : "Reading the game and the engine cache."}
              </p>
              {job && isJobActive(job) ? (
                <div className="job-panel review-job-panel" role="status">
                  <div className="job-header">
                    <span>{job.message}</span>
                    <span>{job.progress}%</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${job.progress}%` }} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      )}
    </div>
  );
}

const VERDICT_COPY = {
  correct: { badge: "Correct", tone: CLASS_TONES.best },
  playable: { badge: "Good enough", tone: CLASS_TONES.good },
  "try-again": { badge: "Try again", tone: CLASS_TONES.mistake }
} as const;

function RetryPanel({ ply, retry, onReveal, onAgain }: { ply: ReviewPly; retry: RetryState; onReveal: () => void; onAgain: () => void }) {
  const best = ply.lines[0];
  const last = retry.last;
  const bestLabel = best ? moveLabel(ply.ply, best.san) : null;
  const verdict = last ? VERDICT_COPY[last.verdict] : null;
  const done = last !== null && last.verdict !== "try-again";

  return (
    <div className="review-callout review-retry" aria-live="polite">
      <div className="review-callout-copy">
        <div className="review-callout-badges">
          <span className="review-callout-badge" style={{ backgroundColor: verdict?.tone ?? "#9ca7b8" }}>
            {verdict?.badge ?? "Retry"}
          </span>
        </div>
        {retry.checking ? (
          <h2 className="review-retry-checking">
            <LoaderCircle size={18} className="spin" aria-hidden="true" /> Checking your move with Stockfish…
          </h2>
        ) : last ? (
          <h2>
            {last.verdict === "correct"
              ? `Correct: ${moveLabel(ply.ply, last.san)} is as good as the engine's best`
              : last.verdict === "playable"
                ? `Good enough: ${moveLabel(ply.ply, last.san)} (${lossCopy(last.loss)})`
                : `${moveLabel(ply.ply, last.san)} loses ${lossCopy(last.loss).slice(1)}. Try again`}
          </h2>
        ) : (
          <h2>
            Find a better move than {moveLabel(ply.ply, ply.san)}
          </h2>
        )}
        <p>
          {retry.error
            ? retry.error
            : retry.revealed && bestLabel
              ? `Best was ${bestLabel}${last && last.uci === best?.uci ? ", your move" : ""}.`
              : `You are ${colorLabel(ply.color)}. Drag a piece, or tap it and then its square.${retry.misses ? ` Misses: ${retry.misses} of ${RETRY_REVEAL_AFTER} before the answer shows.` : ""}`}
        </p>
        <div className="review-retry-actions">
          {!retry.revealed ? (
            <button type="button" className="review-action-chip" onClick={onReveal}>
              Show the answer
            </button>
          ) : null}
          {done || retry.revealed ? (
            <button type="button" className="review-action-chip" onClick={onAgain}>
              Retry again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
