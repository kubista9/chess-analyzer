import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Chess } from "chess.js";
import { BookOpen, History, LoaderCircle } from "lucide-react";
import type { Arrow } from "react-chessboard/dist/chessboard/types";
import { START_FEN } from "../../shared/epd";
import { moveLabel } from "../../shared/review";
import type { DrillAnswerResponse, LineRunItem, MistakeItem } from "../../shared/training/api";
import type { DrillKind } from "../../shared/training/scheduler";
import { postDrillAnswer } from "../api/client";
import { formatDay } from "../utils/formatters";
import { PlayableBoard, type PlayedMove } from "./PlayableBoard";
import { PvLine } from "./PvLine";

// The two drill kinds on PlayableBoard. They never share wording or styling:
// - "Your repertoire line": blue, BookOpen, played from move 1 against your opponents' replies.
// - "Position from your game": amber, History, one position where a game of yours went wrong.

export const DRILL_KIND_UI: Record<DrillKind, { badge: string; label: string; className: string; Icon: typeof BookOpen }> = {
  "repertoire-line": { badge: "YOUR REPERTOIRE LINE", label: "Your repertoire line", className: "drill-line", Icon: BookOpen },
  "own-mistake": { badge: "POSITION FROM YOUR GAME", label: "Position from your game", className: "drill-mistake", Icon: History }
};

export function DrillBadge({ kind }: { kind: DrillKind }) {
  const { badge, Icon } = DRILL_KIND_UI[kind];
  return (
    <span className={`drill-badge ${DRILL_KIND_UI[kind].className}-badge`}>
      <Icon size={14} aria-hidden="true" /> {badge}
    </span>
  );
}

/** "1.d4 d5 2.c4 e6" from SAN moves starting at ply 1. */
export function formatMoves(sans: readonly string[]): string {
  return sans.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ");
}

function arrowOf(uci: string, color = "rgba(91, 155, 213, 0.9)"): Arrow {
  return [uci.slice(0, 2), uci.slice(2, 4), color] as Arrow;
}

export interface DrillOutcome {
  cardId: string;
  kind: DrillKind;
  /** Only a graded (first) try counts; null: not graded here. */
  correct: boolean | null;
}

interface Feedback {
  tone: "good" | "bad" | "info" | "known";
  text: string;
}

const REPLY_DELAY_MS = 650;

// ---------------------------------------------------------------------------------------------

export interface LineDrillProps {
  item: LineRunItem;
  width: number;
  onFinish: (outcomes: DrillOutcome[]) => void;
}

/** A run through the repertoire from move 1: the opponent's replies are played for you; the due moves are yours to find. */
export function LineDrill({ item, width, onFinish }: LineDrillProps) {
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [boardKey, setBoardKey] = useState(0);
  const [reveal, setReveal] = useState<string | null>(null);
  const tries = useRef(new Map<string, number>());
  const outcomes = useRef(new Map<string, DrillOutcome>());
  const shownAt = useRef(Date.now());

  const fens = useMemo(() => {
    const chess = new Chess(START_FEN);
    const out = [chess.fen()];
    for (const step of item.steps) {
      chess.move({ from: step.uci.slice(0, 2), to: step.uci.slice(2, 4), promotion: step.uci[4] });
      out.push(chess.fen());
    }
    return out;
  }, [item]);

  const step = item.steps[index];
  const done = index >= item.steps.length;
  const card = step?.graded ? item.cards[step.epd] : undefined;

  useEffect(() => {
    shownAt.current = Date.now();
    if (!step || step.graded) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (step.mover === "owner") {
        setFeedback({ tone: "known", text: `Known: ${moveLabel(step.ply, step.san)}` });
      }
      setIndex((current) => current + 1);
    }, REPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [index, step]);

  const advance = () => {
    setReveal(null);
    setIndex((current) => current + 1);
  };

  const onMove = (move: PlayedMove) => {
    if (!step || !card || busy) {
      return false;
    }
    const previous = tries.current.get(card.id) ?? 0;
    setBusy(true);
    setFeedback(null);
    void postDrillAnswer({ id: card.id, uci: move.uci, attempts: previous + 1, ms: Date.now() - shownAt.current })
      .then((result) => {
        const yours = moveLabel(step.ply, result.repertoire?.san ?? step.san);
        const played = moveLabel(step.ply, result.san);
        if (result.verdict === "correct") {
          if (!outcomes.current.has(card.id)) {
            outcomes.current.set(card.id, { cardId: card.id, kind: "repertoire-line", correct: result.graded ? true : null });
          }
          setFeedback({ tone: "good", text: `Correct: ${played} is your repertoire move.` });
          window.setTimeout(advance, REPLY_DELAY_MS);
          return;
        }
        tries.current.set(card.id, previous + 1);
        if (!outcomes.current.has(card.id)) {
          outcomes.current.set(card.id, { cardId: card.id, kind: "repertoire-line", correct: result.graded ? false : null });
        }
        setFeedback(
          result.verdict === "sound-other"
            ? { tone: "info", text: `${played} is sound, but not your repertoire move. Your line continues ${yours}: play it.` }
            : { tone: "bad", text: `${played} is not your repertoire move. Your move here is ${yours}: play it.` }
        );
        setReveal(result.repertoire?.uci ?? step.uci);
        setBoardKey((key) => key + 1);
      })
      .catch((error: unknown) => {
        setFeedback({ tone: "bad", text: error instanceof Error ? error.message : "The move could not be checked." });
        setBoardKey((key) => key + 1);
      })
      .finally(() => setBusy(false));
    return true;
  };

  const played = item.steps.slice(0, index).map((done) => done.san);
  const name = card?.lineName ?? item.lineName;
  const graded = [...outcomes.current.values()];
  const fromMemory = graded.filter((outcome) => outcome.correct === true).length;
  const gradedCount = item.steps.filter((candidate) => candidate.graded).length;

  return (
    <section className="drill-card drill-line" aria-label={`Your repertoire line drill, playing ${item.color}`}>
      <header className="drill-card-head">
        <DrillBadge kind="repertoire-line" />
        <span className="drill-card-meta">You play {item.color}</span>
      </header>
      <p className="drill-headline">
        This is your current line: <strong>{played.length ? formatMoves(played) : "the start position"}</strong>
        {name ? ` (${name})` : ""}
      </p>
      <div className="drill-body">
        <div className="drill-board" style={{ width, height: width }}>
          <PlayableBoard
            key={`${item.key}-${boardKey}`}
            id={`drill-${item.key}`}
            fen={fens[Math.min(index, fens.length - 1)]}
            orientation={item.color}
            width={width}
            disabled={done || busy || !step?.graded}
            onMove={onMove}
            arrows={reveal ? [arrowOf(reveal)] : []}
          />
        </div>
        <div className="drill-side">
          {done ? (
            <div className="drill-feedback drill-feedback-good" role="status">
              End of your line: {fromMemory} of {gradedCount} move{gradedCount === 1 ? "" : "s"} right on the first try.
            </div>
          ) : step?.graded ? (
            <p className="drill-prompt">
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking your move…
                </>
              ) : (
                <>Your move: what does your repertoire play here?</>
              )}
            </p>
          ) : (
            <p className="drill-prompt drill-prompt-muted">{step?.mover === "opponent" ? "Your opponent replies…" : "Playing your known move…"}</p>
          )}
          {feedback ? (
            <div className={`drill-feedback drill-feedback-${feedback.tone}`} role="status">
              {feedback.text}
            </div>
          ) : null}
          {card && card.sourceCount ? (
            <p className="drill-note">
              You went wrong here in {card.sourceCount} game{card.sourceCount === 1 ? "" : "s"}
              {card.sources[0] ? (
                <>
                  {" "}
                  (last: <Link to={`/review/${card.sources[0].gameId}?ply=${card.sources[0].ply}`}>{moveLabel(card.sources[0].ply, card.sources[0].playedSan)} vs {card.sources[0].opponent}</Link>)
                </>
              ) : null}
              .
            </p>
          ) : null}
          {done ? (
            <button type="button" className="primary-button drill-continue" onClick={() => onFinish(graded)} autoFocus>
              Continue <kbd>Enter</kbd>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export interface MistakeDrillProps {
  item: MistakeItem;
  width: number;
  /** Graded tries at this card earlier in the session (a re-queued card is practice, not graded). */
  priorTries: number;
  onFinish: (outcome: DrillOutcome, requeue: boolean) => void;
}

const verdictText: Record<string, string> = {
  best: "Correct: that is the engine's best move.",
  "good-enough": "Good enough: within 3% win chance of the engine's best.",
  repertoire: "Correct: your repertoire move, and it is sound here."
};

/** One position from a game of yours where you went wrong: find a better move. */
export function MistakeDrill({ item, width, priorTries, onFinish }: MistakeDrillProps) {
  const { card } = item;
  const [result, setResult] = useState<DrillAnswerResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [pvIndex, setPvIndex] = useState<number | null>(null);
  const shownAt = useRef(Date.now());
  const source = card.sources[0];

  const onMove = (move: PlayedMove) => {
    if (busy || result) {
      return false;
    }
    setBusy(true);
    setError(null);
    void postDrillAnswer({ id: card.id, uci: move.uci, attempts: priorTries + 1, ms: Date.now() - shownAt.current })
      .then(setResult)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The move could not be checked.");
        setBoardKey((key) => key + 1);
      })
      .finally(() => setBusy(false));
    return true;
  };

  const lineFen = useMemo(() => {
    if (!result?.best || pvIndex === null) {
      return null;
    }
    try {
      const chess = new Chess(card.fen);
      for (const san of result.best.pvSan.slice(0, pvIndex + 1)) {
        chess.move(san);
      }
      return chess.fen();
    } catch {
      return null;
    }
  }, [card.fen, pvIndex, result]);

  const finish = () => onFinish({ cardId: card.id, kind: "own-mistake", correct: result?.graded ? result.correct : null }, result ? !result.correct : false);
  const arrows: Arrow[] = result?.best && pvIndex === null ? [arrowOf(result.best.uci, "rgba(240, 180, 93, 0.95)")] : [];

  return (
    <section className="drill-card drill-mistake" aria-label={`Position from your game drill, playing ${card.color}`}>
      <header className="drill-card-head">
        <DrillBadge kind="own-mistake" />
        <span className="drill-card-meta">
          {card.sourceCount > 1 ? `The same position in ${card.sourceCount} of your games` : "From one of your games"}
        </span>
      </header>
      <p className="drill-headline">
        Position from your game vs <strong>{source?.opponent ?? "?"}</strong>
        {source ? ` (${source.oppRating}) on ${formatDay(source.endTime)}` : ""}: you played{" "}
        <strong>{source ? `${moveLabel(source.ply, source.playedSan)}?` : "a mistake"}</strong>. Find a better move.
      </p>
      <p className="drill-path">{card.pathSan.length ? formatMoves(card.pathSan) : "Start position"}{card.lineName ? ` · ${card.lineName}` : ""}</p>
      <div className="drill-body">
        <div className="drill-board" style={{ width, height: width }}>
          <PlayableBoard
            key={`${item.key}-${boardKey}`}
            id={`drill-${item.key}`}
            fen={lineFen ?? card.fen}
            orientation={card.color}
            width={width}
            disabled={busy || result !== null}
            onMove={onMove}
            arrows={arrows}
          />
        </div>
        <div className="drill-side">
          {!result ? (
            <p className="drill-prompt">
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking your move with Stockfish…
                </>
              ) : (
                <>Find a better move than {source ? moveLabel(source.ply, source.playedSan) : "the game's"}.</>
              )}
            </p>
          ) : (
            <div className={`drill-feedback drill-feedback-${result.correct ? "good" : "bad"}`} role="status">
              {result.correct
                ? verdictText[result.verdict]
                : `${moveLabel(card.ply, result.san)} loses ${result.loss?.toFixed(1) ?? "?"}% win chance. The engine plays ${result.best ? moveLabel(card.ply, result.best.san) : "another move"}.`}
              {result.correct && result.loss !== null && result.loss >= 1 ? ` (−${result.loss.toFixed(1)}%)` : ""}
            </div>
          )}
          {error ? (
            <div className="drill-feedback drill-feedback-bad" role="alert">
              {error}
            </div>
          ) : null}
          {result ? (
            <>
              {result.acceptable.length ? (
                <p className="drill-accepted">
                  Accepted here:{" "}
                  {result.acceptable.map((move, index) => (
                    <span key={move.uci}>
                      {index ? ", " : ""}
                      <strong>{moveLabel(card.ply, move.san)}</strong>
                      {move.why === "best" ? " (best)" : move.why === "repertoire" ? " (your repertoire)" : ` (−${move.loss.toFixed(1)}%)`}
                    </span>
                  ))}
                </p>
              ) : null}
              {result.best ? (
                <PvLine line={result.best} firstPly={card.ply} activeIndex={pvIndex} onStep={setPvIndex} label="Engine line" />
              ) : null}
              <ul className="drill-sources" aria-label="Your games with this position">
                {card.sources.map((game) => (
                  <li key={game.gameId}>
                    <Link to={`/review/${game.gameId}?ply=${game.ply}`}>
                      vs {game.opponent} ({game.oppRating}), {formatDay(game.endTime)}: {moveLabel(game.ply, game.playedSan)} (−{game.loss.toFixed(1)}%)
                    </Link>
                  </li>
                ))}
              </ul>
              {source ? (
                <Link className="secondary-button drill-review-link" to={`/review/${source.gameId}?ply=${source.ply}`}>
                  Open the review at {moveLabel(source.ply, source.playedSan)}
                </Link>
              ) : null}
              <button type="button" className="primary-button drill-continue" onClick={finish} autoFocus>
                {result.correct ? "Continue" : "Continue (it comes back later)"} <kbd>Enter</kbd>
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
