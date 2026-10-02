import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Flag, LoaderCircle, Swords } from "lucide-react";
import { useAppData } from "../../app/AppData";
import { useEngine } from "../../app/engine";
import { START_EPD, START_FEN, applyMove, gameState, opposite, sideToMove, type AppliedMove, type Color } from "../../core/chess/position";
import { formatLine, moveLabel } from "../../core/chess/format";
import { noteFor } from "../../core/content/catalog";
import { nodeAt, userMovesAt } from "../../core/content/tree";
import { explainMoveScore } from "../../core/engine/explain";
import { nameAt, type OpeningBook } from "../../core/openingDb/book";
import { getOpeningBook } from "../../core/openingDb/loadBook";
import { judgeMove, needsEngine, withEngine, VERDICT_LABELS, SOUND_LOSS, MISTAKE_LOSS } from "../../core/training/judge";
import { newLadder } from "../../core/training/hints";
import { chooseOpponentMove, summariseSparring, type OpponentChoice } from "../../core/training/sparring";
import type { LadderState, Verdict } from "../../core/training/types";
import { hash32, seededRng } from "../../core/util/random";
import { BoardToolbar } from "../../components/board/BoardToolbar";
import { CapturedPieces } from "../../components/board/CapturedPieces";
import { MoveInput } from "../../components/board/MoveInput";
import { MoveList } from "../../components/board/MoveList";
import { TrainerBoard } from "../../components/board/TrainerBoard";
import { PageHeader } from "../../components/PageHeader";
import { VerdictBadge } from "../../components/VerdictBadge";
import { useHotkeys } from "../../hooks/useHotkeys";

interface UserMoveNote {
  ply: number;
  verdict: Verdict | "pending" | null;
  /** The user's repertoire move(s) here, when the move left the repertoire. */
  expected: string[];
  text: string | null;
  revealed: boolean;
}

const SOURCE_LABELS: Record<OpponentChoice["source"], string> = {
  repertoire: "Repertoire reply",
  book: "Known opening move",
  engine: "Engine move"
};

/** Repertoire Sparring: play your openings against the trainer, which follows your lines and then improvises. */
export function SparringPage() {
  const [params] = useSearchParams();
  const sideParam = params.get("side");
  const [side, setSide] = useState<Color | null>(sideParam === "white" || sideParam === "black" ? sideParam : null);
  const [game, setGame] = useState(0);

  return (
    <div className="page">
      <PageHeader eyebrow="Practice · Sparring" title="Sparring">
        Play your repertoire against the trainer. It answers with the replies your lines prepare for, and when you or it leave the lines it carries on
        with known opening moves or the engine.
      </PageHeader>
      {side ? (
        <SparringGame key={`${side}:${game}`} side={side} onNewGame={() => setGame((value) => value + 1)} onChangeSide={() => setSide(null)} />
      ) : (
        <SideChooser onChoose={setSide} />
      )}
    </div>
  );
}

function SideChooser({ onChoose }: { onChoose: (side: Color) => void }) {
  const { items, settings } = useAppData();
  return (
    <section className="panel stack" aria-labelledby="sparring-setup">
      <h2 id="sparring-setup">Which side do you play?</h2>
      <div className="row">
        {(["white", "black"] as const).map((value) => (
          <button key={value} type="button" className="button button-large" onClick={() => onChoose(value)} disabled={items[value].length === 0}>
            <Swords size={18} aria-hidden="true" />
            Play as {value === "white" ? "White" : "Black"}
          </button>
        ))}
      </div>
      {!settings.engine.enabled ? (
        <p className="notice notice-info">
          The engine is off, so sparring stops once neither your lines nor the opening list have a reply. Switch it on in Settings for longer games.
        </p>
      ) : null}
      {items.white.length + items.black.length === 0 ? (
        <p className="muted">
          No lines are switched on. <Link to="/repertoire">Choose your lines</Link> first.
        </p>
      ) : null}
    </section>
  );
}

function SparringGame({ side, onNewGame, onChangeSide }: { side: Color; onNewGame: () => void; onChangeSide: () => void }) {
  const { catalog, trees, items, settings, actions } = useAppData();
  const engine = useEngine();
  const tree = trees[side];
  const [moves, setMoves] = useState<AppliedMove[]>([]);
  const [notes, setNotes] = useState<Record<number, UserMoveNote>>({});
  const [sources, setSources] = useState<Record<number, OpponentChoice>>({});
  const [thinking, setThinking] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [book, setBook] = useState<OpeningBook | null>(null);
  const thinkRef = useRef<AbortController | null>(null);
  const seed = useMemo(() => hash32(`${side}:${Date.now()}`), [side]);

  useEffect(() => {
    let cancelled = false;
    getOpeningBook().then(
      (loaded) => {
        if (!cancelled) {
          setBook(loaded);
        }
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => thinkRef.current?.abort(), []);

  const fen = moves.length === 0 ? START_FEN : moves[moves.length - 1].fenAfter;
  const turn = sideToMove(fen);
  const over = gameState(fen);
  const stopped = finished || ended !== null || over !== null;

  // The trainer's reply: one search per position (a new move, a take-back or the opening list
  // arriving restarts it).
  useEffect(() => {
    if (stopped || turn === side) {
      return;
    }
    const controller = new AbortController();
    thinkRef.current = controller;
    setThinking(true);
    const delay = moves.length === 0 ? 300 : settings.practice.replyDelayMs;
    const timer = window.setTimeout(() => {
      chooseOpponentMove({
        fen,
        history: moves,
        tree,
        book,
        rng: seededRng(seed + moves.length * 7919),
        engine,
        level: settings.engine.sparringLevel,
        movetimeMs: settings.engine.analysisMs,
        signal: controller.signal
      })
        .then((choice) => {
          if (controller.signal.aborted) {
            return;
          }
          setThinking(false);
          if (!choice) {
            setEnded(
              engine
                ? "The trainer has no reply here."
                : "You are past your lines and the opening list, and the engine is off, so the game stops here. Switch the engine on in Settings to play on."
            );
            return;
          }
          const played = applyMove(fen, choice.uci);
          if (!played) {
            setEnded("The trainer could not find a legal reply.");
            return;
          }
          setSources((current) => ({ ...current, [moves.length + 1]: choice }));
          setMoves((current) => [...current, played]);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setThinking(false);
            setEnded("The trainer could not choose a reply (the engine stopped). Take back a move or start a new game.");
          }
        });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setThinking(false);
    };
  }, [fen, turn, side, stopped, book, moves, tree, engine, seed, settings.practice.replyDelayMs, settings.engine.sparringLevel, settings.engine.analysisMs]);

  const onMove = useCallback(
    (move: AppliedMove): boolean => {
      if (stopped || turn !== side || thinking) {
        return false;
      }
      const ply = moves.length + 1;
      const node = nodeAt(tree, move.epdBefore);
      const repertoire = node && node.userToMove ? userMovesAt(tree, move.epdBefore) : [];
      setMoves((current) => [...current, move]);

      if (repertoire.length === 0) {
        // Out of the repertoire already: only the engine can say anything about the move.
        if (engine) {
          setNotes((current) => ({ ...current, [ply]: { ply, verdict: "pending", expected: [], text: null, revealed: false } }));
          engine
            .scoreMove(move.fenBefore, move.uci)
            .then((score) => {
              const verdict: Verdict = score.loss < SOUND_LOSS ? "alternative" : score.loss < MISTAKE_LOSS ? "inaccuracy" : "mistake";
              const explanation = explainMoveScore({ score, move, history: moves });
              setNotes((current) => ({ ...current, [ply]: { ply, verdict, expected: [], text: explanation.headline, revealed: false } }));
            })
            .catch(() => setNotes((current) => ({ ...current, [ply]: { ply, verdict: null, expected: [], text: null, revealed: false } })));
        }
        return true;
      }

      const note = noteFor(catalog, move.epdBefore, repertoire[0].uci) ?? null;
      const judgement = judgeMove({ move, expected: repertoire, siblings: repertoire, note });
      const item = items[side].find((entry) => entry.key === `${side}|${move.epdBefore}`);
      if (item) {
        actions.recordPositionAttempt({
          item,
          mode: "sparring",
          lineId: null,
          ladder: ladderFor(judgement.verdict),
          tries: [{ san: move.san, verdict: judgement.verdict }],
          startedAt: Date.now()
        });
      }
      const expected = repertoire.map((edge) => edge.san);
      setNotes((current) => ({
        ...current,
        [ply]: { ply, verdict: needsEngine(judgement) && engine ? "pending" : judgement.verdict, expected: judgement.verdict === "book" ? [] : expected, text: judgement.note, revealed: false }
      }));
      if (needsEngine(judgement) && engine) {
        engine
          .scoreMove(move.fenBefore, move.uci)
          .then((score) => {
            const explanation = explainMoveScore({ score, move, history: moves });
            const judged = withEngine(judgement, score, explanation);
            setNotes((current) => ({ ...current, [ply]: { ...current[ply], verdict: judged.verdict, text: explanation.headline } }));
          })
          .catch(() => setNotes((current) => ({ ...current, [ply]: { ...current[ply], verdict: "unverified" } })));
      }
      return true;
    },
    [stopped, turn, side, thinking, moves, tree, engine, catalog, items, actions]
  );

  const takeBack = useCallback(() => {
    thinkRef.current?.abort();
    setThinking(false);
    setEnded(null);
    setFinished(false);
    setMoves((current) => {
      // Take back to the last position where it is the user's move, removing their last move too.
      let next = current.slice(0, -1);
      while (next.length > 0 && sideToMove(next[next.length - 1].fenAfter) !== side) {
        next = next.slice(0, -1);
      }
      if (sideToMove(next.length === 0 ? START_FEN : next[next.length - 1].fenAfter) !== side) {
        next = [];
      }
      return next;
    });
  }, [side]);

  useHotkeys({ f: () => setFlipped((value) => !value) });

  const summary = useMemo(() => summariseSparring(tree, moves), [tree, moves]);
  const opening = useMemo(() => (book ? nameAt(book, [START_EPD, ...moves.map((move) => move.epdAfter)]) : null), [book, moves]);
  const orientation = flipped ? opposite(side) : side;
  const lastMove = moves[moves.length - 1] ?? null;
  const lastSource = sources[moves.length];
  const listMoves = moves.map((move, index) => {
    const note = notes[index + 1];
    const verdict = note && note.verdict !== "pending" ? note.verdict : null;
    return { san: move.san, verdict };
  });
  const deviations = Object.values(notes)
    .filter((note) => note.expected.length > 0)
    .sort((left, right) => left.ply - right.ply);
  const latestUserNote = [...Object.values(notes)].sort((left, right) => right.ply - left.ply)[0];

  return (
    <>
      <div className="stage">
        <div className="stage-board">
          <CapturedPieces fen={fen} side={opposite(orientation)} />
          <TrainerBoard
            id="sparring-board"
            fen={fen}
            orientation={orientation}
            movable={stopped || thinking ? null : side}
            onMove={onMove}
            lastMove={lastMove}
            label={`Sparring as ${side === "white" ? "White" : "Black"}`}
          />
          <CapturedPieces fen={fen} side={orientation} />
          <BoardToolbar onFlip={() => setFlipped((value) => !value)} onUndo={takeBack} canUndo={moves.some((move) => move.color === side)} onReset={onNewGame} canReset={moves.length > 0} />
        </div>
        <div className="stage-side">
          <section className="panel stack" aria-label="Game">
            <div className="row-between">
              <h2>{side === "white" ? "You play White" : "You play Black"}</h2>
              {thinking ? (
                <span className="loading small" role="status">
                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  The trainer is thinking…
                </span>
              ) : null}
            </div>
            <p className="muted small">{opening ? `${opening.name} (${opening.eco})` : moves.length === 0 ? "Starting position." : "No opening name for this position."}</p>
            <p className="small">
              {summary.leftBy === null
                ? moves.length === 0
                  ? side === "white"
                    ? "Make your first move."
                    : "The trainer moves first."
                  : `In your repertoire so far (${summary.inRepertoireThrough} move${summary.inRepertoireThrough === 1 ? "" : "s"}).`
                : summary.leftBy === "user"
                  ? `You left your repertoire at move ${Math.ceil((summary.inRepertoireThrough + 1) / 2)}.`
                  : `The trainer left your repertoire after ${formatLine(moves.slice(0, summary.inRepertoireThrough).map((move) => move.san))}. Use the opening principles from here.`}
            </p>
            {lastSource && lastMove ? (
              <p className="row small">
                <span className={`chip source-chip-${lastSource.source}`}>{SOURCE_LABELS[lastSource.source]}</span>
                <span>
                  Trainer played <span className="san">{moveLabel(moves.length, lastMove.san)}</span>
                  {lastSource.bookName ? ` · ${lastSource.bookName}` : ""}
                </span>
              </p>
            ) : null}
            {latestUserNote && latestUserNote.ply <= moves.length ? <LatestMoveNote note={latestUserNote} moves={moves} onReveal={(ply) => setNotes((current) => ({ ...current, [ply]: { ...current[ply], revealed: true } }))} /> : null}
            {over ? <p className="notice notice-info">{over === "checkmate" ? "Checkmate." : over === "stalemate" ? "Stalemate." : "The game is drawn."}</p> : null}
            {ended ? <p className="notice notice-info">{ended}</p> : null}
            <div className="row">
              {!finished ? (
                <button type="button" className="button" onClick={() => setFinished(true)} disabled={moves.length === 0}>
                  <Flag size={16} aria-hidden="true" />
                  Finish and review
                </button>
              ) : null}
              <button type="button" className="button button-ghost" onClick={onChangeSide}>
                Change side
              </button>
            </div>
          </section>
          {!stopped && !thinking && turn === side ? <MoveInput fen={fen} onMove={onMove} /> : null}
          <MoveList moves={listMoves} current={moves.length} bookEnd={summary.inRepertoireThrough > 0 && summary.leftBy ? summary.inRepertoireThrough : null} label="Game moves" />
          {finished || ended || over ? <SparringReview deviations={deviations} moves={moves} summary={summary} onNewGame={onNewGame} /> : null}
        </div>
      </div>
    </>
  );
}

function LatestMoveNote({ note, moves, onReveal }: { note: UserMoveNote; moves: readonly AppliedMove[]; onReveal: (ply: number) => void }) {
  const move = moves[note.ply - 1];
  if (!move) {
    return null;
  }
  if (note.verdict === "pending") {
    return (
      <p className="loading small" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        Checking {moveLabel(note.ply, move.san)} with the engine…
      </p>
    );
  }
  if (note.verdict === null) {
    return null;
  }
  const left = note.expected.length > 0;
  return (
    <div className={`feedback feedback-${note.verdict === "book" ? "good" : note.verdict === "alternative" ? "info" : note.verdict === "inaccuracy" ? "warning" : note.verdict === "mistake" ? "bad" : "neutral"}`} role="status">
      <div className="feedback-head">
        <VerdictBadge verdict={note.verdict} />
        <span className="san">{moveLabel(note.ply, move.san)}</span>
      </div>
      <p>
        {note.verdict === "book"
          ? "Your repertoire move."
          : left
            ? `${move.san} is not your repertoire move here.${note.text ? ` ${note.text}` : ""}`
            : (note.text ?? VERDICT_LABELS[note.verdict])}
      </p>
      {left ? (
        note.revealed ? (
          <p>
            Your repertoire move was <span className="san">{note.expected.map((san) => moveLabel(note.ply, san)).join(" or ")}</span>. Take back to play it, or play on.
          </p>
        ) : (
          <button type="button" className="text-button" onClick={() => onReveal(note.ply)}>
            Show my repertoire move
          </button>
        )
      ) : null}
    </div>
  );
}

function SparringReview({
  deviations,
  moves,
  summary,
  onNewGame
}: {
  deviations: UserMoveNote[];
  moves: readonly AppliedMove[];
  summary: ReturnType<typeof summariseSparring>;
  onNewGame: () => void;
}) {
  return (
    <section className="panel summary" aria-labelledby="sparring-review">
      <h2 id="sparring-review">Game review</h2>
      <p>
        {summary.bookMoves} of your {summary.userMoves} moves were repertoire moves.
        {summary.leftBy === "opponent" ? " The trainer left your lines first." : summary.leftBy === "user" ? " You left your lines first." : ""}
      </p>
      {deviations.length > 0 ? (
        <ul className="list summary-list">
          {deviations.map((note) => (
            <li key={note.ply}>
              <span>
                You played <span className="san">{moveLabel(note.ply, moves[note.ply - 1]?.san ?? "?")}</span>, your line has{" "}
                <span className="san">{note.expected.map((san) => moveLabel(note.ply, san)).join(" or ")}</span>
              </span>
              {note.verdict && note.verdict !== "pending" ? <VerdictBadge verdict={note.verdict} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">You never left your repertoire while it had a move for you.</p>
      )}
      <div className="row">
        <button type="button" className="button button-primary" onClick={onNewGame}>
          New game
        </button>
        <Link className="button" to="/practice/next-move">
          Review your positions
        </Link>
      </div>
    </section>
  );
}

/** A sparring move as a one-step ladder: the repertoire move is clean, a sound other move "hinted", anything else missed. */
function ladderFor(verdict: Verdict): LadderState {
  if (verdict === "book") {
    return newLadder();
  }
  if (verdict === "alternative") {
    return { ...newLadder(), level: 1 };
  }
  return { wrongTries: 1, level: 3, hintsRequested: 0, revealed: true, solutionRequested: false };
}
