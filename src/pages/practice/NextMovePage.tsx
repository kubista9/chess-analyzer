import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAppData } from "../../app/AppData";
import { useEngine } from "../../app/engine";
import { opposite, type Color } from "../../core/chess/position";
import { linePositionKeys } from "../../core/content/tree";
import type { PositionItem } from "../../core/content/types";
import { resultOf } from "../../core/training/hints";
import { buildQueue, newIntroducedToday, remainingNewToday, type QueueEntry } from "../../core/training/queue";
import type { Result } from "../../core/training/types";
import { BoardToolbar } from "../../components/board/BoardToolbar";
import { CapturedPieces } from "../../components/board/CapturedPieces";
import { MoveInput } from "../../components/board/MoveInput";
import { MoveList } from "../../components/board/MoveList";
import { TrainerBoard } from "../../components/board/TrainerBoard";
import { ARROW_COLOURS } from "../../components/board/boardTheme";
import { PageHeader } from "../../components/PageHeader";
import { useHotkeys } from "../../hooks/useHotkeys";
import { ExercisePanel } from "../../practice/ExercisePanel";
import { afterText, positionExercise } from "../../practice/specs";
import { useExercise, type ExerciseOutcome } from "../../practice/useExercise";
import { RESULT_LABELS, SessionProgress } from "../../practice/session";

/** Positions per review session. */
export const SESSION_SIZE = 15;
/** A missed position comes back this many positions later in the same session. */
export const REQUEUE_AFTER = 3;

interface Session {
  entries: QueueEntry[];
  index: number;
  results: { key: string; label: string; result: Result }[];
  requeued: Set<string>;
  title: string;
}

/** Next Move: one repertoire position at a time, find the move; the spaced-review session. */
export function NextMovePage() {
  const data = useAppData();
  const { catalog, items, positions, settings, actions } = data;
  const engine = useEngine();
  const [params] = useSearchParams();
  const sideParam = params.get("side");
  const side: Color | null = sideParam === "white" || sideParam === "black" ? sideParam : null;
  const lineId = params.get("line");
  const posParam = params.get("pos");
  const [flipped, setFlipped] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  const buildSession = useCallback((): Session => {
    const now = Date.now();
    const pool: PositionItem[] = side ? items[side] : [...items.white, ...items.black];
    const line = lineId ? catalog.lineById.get(lineId) : undefined;
    if (posParam || line) {
      const keys = line ? new Set(linePositionKeys(line)) : new Set([posParam as string]);
      const chosen = pool.filter((item) => keys.has(item.key)).sort((left, right) => left.order - right.order || left.minPly - right.minPly);
      const entries = chosen.map<QueueEntry>((item) => ({ item, reason: "extra", score: 0, progress: positions.get(item.key) ?? null }));
      return { entries, index: 0, results: [], requeued: new Set(), title: line ? line.name : "One position" };
    }
    const newLimit = remainingNewToday(settings.practice.newPerDay, newIntroducedToday(positions.values(), now));
    const entries = buildQueue(pool, positions, { now, newLimit, limit: SESSION_SIZE, includeExtra: true });
    return { entries, index: 0, results: [], requeued: new Set(), title: side ? `${side === "white" ? "White" : "Black"} review` : "Review" };
    // The session is a snapshot: progress made during it must not reshuffle the queue, so only
    // the URL (which session) is a dependency.
  }, [side, lineId, posParam]);

  const [session, setSession] = useState<Session>(buildSession);
  const entry = session.entries[session.index] ?? null;
  const item = entry?.item ?? null;

  const spec = useMemo(() => (item ? positionExercise(item, catalog, `${session.index}:${item.key}`) : null), [item, catalog, session.index]);

  const onComplete = useCallback(
    ({ ladder, tries }: ExerciseOutcome) => {
      if (!item || !spec) {
        return;
      }
      actions.recordPositionAttempt({ item, mode: "next-move", lineId: lineId ?? null, ladder, tries, startedAt });
      const result = resultOf(ladder);
      setSession((current) => {
        const entries = [...current.entries];
        const requeued = new Set(current.requeued);
        if (result !== "clean" && !requeued.has(item.key)) {
          requeued.add(item.key);
          const at = Math.min(entries.length, current.index + 1 + REQUEUE_AFTER);
          entries.splice(at, 0, { ...entries[current.index], reason: "due" });
        }
        return { ...current, entries, requeued, results: [...current.results, { key: item.key, label: spec.primary.san, result }] };
      });
    },
    [item, spec, actions, lineId, startedAt]
  );

  const exercise = useExercise(spec, { engine, revealAfter: settings.practice.revealAfter, onComplete });
  const state = exercise.state;
  const solved = state?.phase === "solved";

  const next = useCallback(() => {
    setFlipped(false);
    setStartedAt(Date.now());
    setSession((current) => ({ ...current, index: current.index + 1 }));
  }, []);

  useHotkeys({
    h: state?.phase === "awaiting" ? exercise.requestHint : undefined,
    f: () => setFlipped((value) => !value),
    Enter: solved ? next : state?.phase === "revealed" ? exercise.playSolution : undefined
  });

  const header = (
    <PageHeader eyebrow="Practice · Next move" title="Next move">
      A position from your repertoire: find your move. A wrong try gets a hint, not the answer.
    </PageHeader>
  );

  if (session.entries.length === 0) {
    return (
      <div className="page">
        {header}
        <div className="empty">
          <h3>Nothing to practise here</h3>
          <p>
            {items.white.length + items.black.length === 0
              ? "No lines are switched on. Choose the lines you play on the Repertoire page."
              : "All caught up: nothing is due and today's new positions are done. Come back tomorrow, or play a line."}
          </p>
          <div className="row">
            <Link className="button" to="/repertoire">
              Open the repertoire
            </Link>
            <Link className="button" to="/practice/play-line">
              Play a line
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!entry || !spec || !state || !item) {
    return (
      <div className="page">
        {header}
        <SessionSummary results={session.results} onAgain={() => setSession(buildSession())} />
      </div>
    );
  }

  const orientation = flipped ? opposite(item.side) : item.side;
  const shownFen = solved && state.solvedWith ? state.solvedWith.fenAfter : spec.fen;
  const lastMove = solved && state.solvedWith ? state.solvedWith : (spec.history[spec.history.length - 1] ?? null);
  const marks: Record<string, "hint"> = {};
  if (!solved && state.ladder.level >= 2 && state.phase !== "revealed") {
    for (const square of state.hints.narrowSquares) {
      marks[square] = "hint";
    }
  }
  const arrows = state.phase === "revealed" ? [[spec.primary.from, spec.primary.to, ARROW_COLOURS.solution] as [typeof spec.primary.from, typeof spec.primary.to, string]] : [];
  const lines = item.lineIds.map((id) => catalog.lineById.get(id)).filter((line) => line !== undefined);
  const movable = state.phase === "awaiting" || state.phase === "revealed" ? item.side : null;
  const historySans = [...spec.history.map((move) => move.san), ...(solved && state.solvedWith ? [state.solvedWith.san] : [])];

  return (
    <div className="page">
      {header}
      <SessionProgress title={session.title} done={session.index} total={session.entries.length} reason={entry.reason} />
      <div className="stage">
        <div className="stage-board">
          <CapturedPieces fen={shownFen} side={opposite(orientation)} />
          <TrainerBoard
            id="next-move-board"
            fen={shownFen}
            orientation={orientation}
            movable={movable}
            onMove={exercise.playMove}
            lastMove={lastMove}
            marks={marks}
            arrows={arrows}
            label={`${item.side === "white" ? "White" : "Black"} to move`}
          />
          <CapturedPieces fen={shownFen} side={orientation} />
          <BoardToolbar onFlip={() => setFlipped((value) => !value)} />
        </div>
        <div className="stage-side">
          <div className="panel">
            <ExercisePanel
              state={state}
              prompt={
                <>
                  <h2>{item.side === "white" ? "White" : "Black"} to move: find your repertoire move</h2>
                  <p className="exercise-context">
                    Position {afterText(item.pathSans)}
                    {lines.length > 0 ? ` · ${lines[0]!.name}${lines.length > 1 ? ` and ${lines.length - 1} more line${lines.length > 2 ? "s" : ""}` : ""}` : ""}
                  </p>
                </>
              }
              onHint={exercise.requestHint}
              onShowSolution={exercise.showSolution}
              onPlaySolution={exercise.playSolution}
              after={
                <button type="button" className="button button-primary" onClick={next} autoFocus>
                  {session.index + 1 < session.entries.length ? "Next position" : "Finish"}
                  <ArrowRight size={16} aria-hidden="true" />
                  <kbd aria-hidden="true">Enter</kbd>
                </button>
              }
            />
          </div>
          {movable ? <MoveInput fen={spec.fen} onMove={exercise.playMove} /> : null}
          <MoveList moves={historySans.map((san) => ({ san }))} current={historySans.length} label="Moves so far" />
        </div>
      </div>
    </div>
  );
}

function SessionSummary({ results, onAgain }: { results: Session["results"]; onAgain: () => void }) {
  const clean = results.filter((entry) => entry.result === "clean").length;
  const firstTry = new Map<string, Result>();
  for (const entry of results) {
    if (!firstTry.has(entry.key)) {
      firstTry.set(entry.key, entry.result);
    }
  }
  const firstClean = [...firstTry.values()].filter((result) => result === "clean").length;
  return (
    <section className="panel summary" aria-labelledby="summary-title">
      <h2 id="summary-title">Session done</h2>
      <p>
        {firstTry.size} position{firstTry.size === 1 ? "" : "s"} practised · {firstClean} found on the first try without a hint
        {results.length > clean ? ` · ${results.length - clean} ${results.length - clean === 1 ? "try" : "tries"} needed help` : ""}.
      </p>
      <ul className="list summary-list">
        {results.map((entry, index) => (
          <li key={`${entry.key}-${index}`}>
            <span className="san">{entry.label}</span>
            <span className={`result-${entry.result}`}>{RESULT_LABELS[entry.result]}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="button button-primary" onClick={onAgain}>
          Start another session
        </button>
        <Link className="button" to="/">
          Back to Home
        </Link>
      </div>
    </section>
  );
}
