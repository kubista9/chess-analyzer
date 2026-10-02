import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Play, RotateCcw } from "lucide-react";
import { useAppData } from "../../app/AppData";
import { useEngine } from "../../app/engine";
import { START_FEN, opposite, type Color } from "../../core/chess/position";
import { formatLine, moveLabel } from "../../core/chess/format";
import { noteFor } from "../../core/content/catalog";
import { posKey, type Line, type PositionItem } from "../../core/content/types";
import { resultOf } from "../../core/training/hints";
import { dueLines } from "../../core/training/queue";
import type { LadderState, Result } from "../../core/training/types";
import { BoardToolbar } from "../../components/board/BoardToolbar";
import { CapturedPieces } from "../../components/board/CapturedPieces";
import { MoveInput } from "../../components/board/MoveInput";
import { MoveList, type MoveListEntry } from "../../components/board/MoveList";
import { TrainerBoard } from "../../components/board/TrainerBoard";
import { ARROW_COLOURS } from "../../components/board/boardTheme";
import { PageHeader } from "../../components/PageHeader";
import { LineStatusBadge } from "../../components/LineStatusBadge";
import { useHotkeys } from "../../hooks/useHotkeys";
import { useNow } from "../../hooks/useNow";
import { ExercisePanel } from "../../practice/ExercisePanel";
import { lineStepExercise } from "../../practice/specs";
import { useExercise, type ExerciseOutcome } from "../../practice/useExercise";
import { RESULT_LABELS } from "../../practice/session";

/** Play the Line: reproduce a whole variation from the starting position; the app plays the other side. */
export function PlayLinePage() {
  const [params] = useSearchParams();
  const lineId = params.get("line");
  const { catalog } = useAppData();
  const line = lineId ? catalog.lineById.get(lineId) : undefined;
  const [run, setRun] = useState(0);

  return (
    <div className="page">
      <PageHeader eyebrow="Practice · Play the line" title="Play the line">
        Play a whole line from the first move. The trainer answers with the opponent&rsquo;s moves; you find yours.
      </PageHeader>
      {line ? <LineRun key={`${line.id}:${run}`} line={line} onAgain={() => setRun((value) => value + 1)} /> : <LinePicker missing={lineId !== null} />}
    </div>
  );
}

function LinePicker({ missing }: { missing: boolean }) {
  const { catalog, isEnabled, lineProgress, lineView } = useAppData();
  const now = useNow(60_000);
  const [side, setSide] = useState<Color>("white");
  const enabled = catalog.lines.filter((line) => line.side === side && isEnabled(line.id));
  const due = dueLines(enabled, lineProgress, now);
  const dueIds = new Set(due.map((line) => line.id));
  const neverRun = enabled.filter((line) => !lineProgress.get(line.id) && !dueIds.has(line.id));
  const rest = enabled.filter((line) => !dueIds.has(line.id) && lineProgress.get(line.id));

  const section = (title: string, lines: Line[], empty: string) => (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      {lines.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="pick-list">
          {lines.map((line) => {
            const view = lineView(line.id);
            return (
              <li key={line.id} className="pick-item">
                <div className="pick-item-text">
                  <span className="row">
                    <strong>{line.name}</strong>
                    {line.eco ? <span className="eco">{line.eco}</span> : null}
                    {view ? <LineStatusBadge status={view.status} /> : null}
                  </span>
                  <span className="san-line">{formatLine(line.sans)}</span>
                </div>
                <Link className="button button-small" to={`/practice/play-line?line=${encodeURIComponent(line.id)}`} aria-label={`Play ${line.name}`}>
                  <Play size={14} aria-hidden="true" />
                  Play
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <>
      {missing ? <p className="notice">That line is not in the repertoire any more. Pick another one.</p> : null}
      <div className="segmented" role="group" aria-label="Side">
        {(["white", "black"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)}>
            As {value === "white" ? "White" : "Black"}
          </button>
        ))}
      </div>
      {enabled.length === 0 ? (
        <div className="empty">
          <h3>No lines switched on for {side === "white" ? "White" : "Black"}</h3>
          <p>Choose the lines you play on the Repertoire page.</p>
          <Link className="button" to="/repertoire">
            Open the repertoire
          </Link>
        </div>
      ) : (
        <>
          {section("Due for a run", due, "No line is due. Lines you have played come back here when their review date arrives.")}
          {section("Not played yet", neverRun, "You have played every switched-on line at least once.")}
          {section("Played before", rest, "Nothing here yet.")}
        </>
      )}
    </>
  );
}

interface StepResult {
  ply: number;
  san: string;
  result: Result;
}

function LineRun({ line, onAgain }: { line: Line; onAgain: () => void }) {
  const { catalog, trees, items, settings, actions } = useAppData();
  const engine = useEngine();
  const navigate = useNavigate();
  const tree = trees[line.side];
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [results, setResults] = useState<StepResult[]>([]);
  const laddersRef = useRef<LadderState[]>([]);
  const stepStarted = useRef(Date.now());
  const recorded = useRef(false);
  const total = line.moves.length;
  const done = index >= total;
  const move = done ? null : line.moves[index];
  const userTurn = move !== null && move.color === line.side;

  // The opponent's moves are played by the trainer after a short pause.
  useEffect(() => {
    if (move && !userTurn) {
      const timer = window.setTimeout(() => setIndex((value) => value + 1), index === 0 ? 350 : settings.practice.replyDelayMs);
      return () => window.clearTimeout(timer);
    }
    stepStarted.current = Date.now();
    return undefined;
  }, [move, userTurn, index, settings.practice.replyDelayMs]);

  useEffect(() => {
    if (done && !recorded.current && laddersRef.current.length > 0) {
      recorded.current = true;
      actions.recordLineRun({ line, ladders: laddersRef.current });
    }
  }, [done, line, actions]);

  const spec = useMemo(() => (move && userTurn ? lineStepExercise(line, index, tree, catalog, `${line.id}:${index}`) : null), [move, userTurn, line, index, tree, catalog]);

  const onComplete = useCallback(
    ({ ladder, tries }: ExerciseOutcome) => {
      if (!move) {
        return;
      }
      const item = itemForStep(line, index, items[line.side]);
      actions.recordPositionAttempt({ item, mode: "play-line", lineId: line.id, ladder, tries, startedAt: stepStarted.current });
      laddersRef.current = [...laddersRef.current, ladder];
      setResults((current) => [...current, { ply: index + 1, san: move.san, result: resultOf(ladder) }]);
      window.setTimeout(() => setIndex((value) => value + 1), 450);
    },
    [move, line, index, items, actions]
  );

  const exercise = useExercise(spec, { engine, revealAfter: settings.practice.revealAfter, onComplete });
  const state = exercise.state;

  useHotkeys({
    h: state?.phase === "awaiting" ? exercise.requestHint : undefined,
    f: () => setFlipped((value) => !value),
    Enter: state?.phase === "revealed" ? exercise.playSolution : undefined
  });

  const played = line.moves.slice(0, index);
  const solvedMove = state?.phase === "solved" ? state.solvedWith : null;
  const fen = solvedMove ? solvedMove.fenAfter : index === 0 ? START_FEN : line.moves[index - 1].fenAfter;
  const lastMove = solvedMove ?? played[played.length - 1] ?? null;
  const orientation = flipped ? opposite(line.side) : line.side;
  const lastOpponent = [...played].reverse().find((entry) => entry.color !== line.side);
  const opponentNote = lastOpponent ? noteFor(catalog, lastOpponent.epdBefore, lastOpponent.uci) : undefined;
  const marks: Record<string, "hint"> = {};
  if (state && state.phase === "awaiting" && state.ladder.level >= 2) {
    for (const square of state.hints.narrowSquares) {
      marks[square] = "hint";
    }
  }
  const arrows = state?.phase === "revealed" && spec ? [[spec.primary.from, spec.primary.to, ARROW_COLOURS.solution] as [typeof spec.primary.from, typeof spec.primary.to, string]] : [];
  const listMoves: MoveListEntry[] = [...played, ...(solvedMove ? [solvedMove] : [])].map((entry) => ({ san: entry.san }));
  const movable = state && (state.phase === "awaiting" || state.phase === "revealed") ? line.side : null;

  return (
    <>
      <div className="session-bar">
        <div className="session-progress">
          <span>
            <strong>{line.name}</strong> · move {Math.min(Math.ceil((index + 1) / 2), Math.ceil(total / 2))} of {Math.ceil(total / 2)}
          </span>
          <div className="meter" role="progressbar" aria-label="Line progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index}>
            <span style={{ width: `${(index / total) * 100}%` }} />
          </div>
        </div>
        <Link className="button button-small" to={`/repertoire/line/${encodeURIComponent(line.id)}`}>
          About this line
        </Link>
      </div>
      <div className="stage">
        <div className="stage-board">
          <CapturedPieces fen={fen} side={opposite(orientation)} />
          <TrainerBoard id="play-line-board" fen={fen} orientation={orientation} movable={movable} onMove={exercise.playMove} lastMove={lastMove} marks={marks} arrows={arrows} />
          <CapturedPieces fen={fen} side={orientation} />
          <BoardToolbar onFlip={() => setFlipped((value) => !value)} onReset={onAgain} canReset={index > 0} />
        </div>
        <div className="stage-side">
          {done ? (
            <section className="panel summary" aria-labelledby="run-done">
              <h2 id="run-done">End of the line</h2>
              <p>
                {results.filter((step) => step.result === "clean").length} of {results.length} moves found on the first try without a hint.
              </p>
              <ul className="list summary-list">
                {results.map((step) => (
                  <li key={step.ply}>
                    <span className="san">{moveLabel(step.ply, step.san)}</span>
                    <span className={`result-${step.result}`}>{RESULT_LABELS[step.result]}</span>
                  </li>
                ))}
              </ul>
              {line.plans.length > 0 ? (
                <div className="stack-tight">
                  <h3>How play continues</h3>
                  <ul>
                    {line.plans.map((plan) => (
                      <li key={plan}>{plan}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="row">
                <button type="button" className="button button-primary" onClick={onAgain} autoFocus>
                  <RotateCcw size={16} aria-hidden="true" />
                  Play it again
                </button>
                <button type="button" className="button" onClick={() => navigate("/practice/play-line")}>
                  Choose another line
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </section>
          ) : (
            <div className="panel">
              {state && spec ? (
                <ExercisePanel
                  state={state}
                  prompt={
                    <>
                      <h2>Your move: {moveLabel(spec.ply, "…")}</h2>
                      <p className="exercise-context">{index === 0 ? "The line starts from the first move." : `After ${formatLine(played.map((entry) => entry.san))}`}</p>
                    </>
                  }
                  onHint={exercise.requestHint}
                  onShowSolution={exercise.showSolution}
                  onPlaySolution={exercise.playSolution}
                />
              ) : (
                <p className="loading" role="status">
                  The opponent is moving…
                </p>
              )}
            </div>
          )}
          {!done && opponentNote && lastOpponent ? (
            <p className="opponent-note">
              <strong>{moveLabel(played.lastIndexOf(lastOpponent) + 1, lastOpponent.san)}</strong> — {opponentNote.why}
            </p>
          ) : null}
          {movable && spec ? <MoveInput fen={spec.fen} onMove={exercise.playMove} /> : null}
          <MoveList moves={listMoves} current={listMoves.length} label="Moves of the line so far" />
        </div>
      </div>
    </>
  );
}

/** The position item a line step belongs to (built ad hoc when the line is switched off). */
function itemForStep(line: Line, index: number, items: readonly PositionItem[]): PositionItem {
  const move = line.moves[index];
  const key = posKey(line.side, move.epdBefore);
  const existing = items.find((item) => item.key === key);
  if (existing) {
    return existing;
  }
  return {
    key,
    side: line.side,
    epd: move.epdBefore,
    fen: move.fenBefore,
    expected: [{ uci: move.uci, san: move.san, from: move.epdBefore, to: move.epdAfter, mover: "user", lineIds: [line.id], priority: line.priority }],
    lineIds: [line.id],
    minPly: index,
    pathSans: line.sans.slice(0, index),
    priority: line.priority,
    order: line.order
  };
}
