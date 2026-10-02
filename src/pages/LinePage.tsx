import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Copy, Crosshair, Download, FileJson, ListOrdered, Pencil, Trash2 } from "lucide-react";
import { useAppData } from "../app/AppData";
import { useEngine } from "../app/engine";
import { START_EPD, START_FEN, opposite, type AppliedMove } from "../core/chess/position";
import { formatLine, moveLabel } from "../core/chess/format";
import { lineToContentJson, lineToPgn, noteFor } from "../core/content/catalog";
import { opponentRepliesAt, userMovesAt } from "../core/content/tree";
import { explainMoveScore } from "../core/engine/explain";
import type { Explanation } from "../core/engine/types";
import { nameAt, type OpeningBook } from "../core/openingDb/book";
import { getOpeningBook } from "../core/openingDb/loadBook";
import type { LineStatus } from "../core/training/types";
import { AddLineDialog } from "../components/AddLineDialog";
import { BoardToolbar } from "../components/board/BoardToolbar";
import { CapturedPieces } from "../components/board/CapturedPieces";
import { MoveInput } from "../components/board/MoveInput";
import { MoveList } from "../components/board/MoveList";
import { TrainerBoard } from "../components/board/TrainerBoard";
import { ARROW_COLOURS } from "../components/board/boardTheme";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LINE_STATUS_LABELS } from "../components/LineStatusBadge";
import { PageHeader } from "../components/PageHeader";
import { useHotkeys } from "../hooks/useHotkeys";
import { pct } from "../utils/formatters";

const PRIORITY_LABELS = { main: "Main line", secondary: "Secondary line", sideline: "Sideline" } as const;

/** One line: step through it with its notes, try other moves on the board, see its plans and traps. */
export function LinePage() {
  const { lineId = "" } = useParams();
  const { catalog } = useAppData();
  const line = catalog.lineById.get(lineId);
  if (!line) {
    return (
      <div className="page">
        <PageHeader eyebrow="Repertoire" title="Line not found">
          This line is not in your repertoire (it may have been renamed or deleted).
        </PageHeader>
        <Link className="button" to="/repertoire">
          Back to the repertoire
        </Link>
      </div>
    );
  }
  return <LineView key={line.id} lineId={line.id} />;
}

function LineView({ lineId }: { lineId: string }) {
  const { catalog, trees, lineView, actions, customLines } = useAppData();
  const engine = useEngine();
  const navigate = useNavigate();
  const view = lineView(lineId)!;
  const line = view.line;
  const tree = trees[line.side];
  const custom = customLines.find((record) => record.id === line.id);
  const [path, setPath] = useState<AppliedMove[]>(line.moves);
  const [cursor, setCursor] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [book, setBook] = useState<OpeningBook | null>(null);
  const [engineNote, setEngineNote] = useState<{ ply: number; text: Explanation | null; best: string | null; loading: boolean; failed: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOpeningBook().then(
      (loaded) => !cancelled && setBook(loaded),
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const onLine = path.length <= line.moves.length && path.every((move, index) => move.uci === line.moves[index].uci);
  const fen = cursor === 0 ? START_FEN : path[cursor - 1].fenAfter;
  const current = cursor === 0 ? null : path[cursor - 1];
  const next = cursor < path.length ? path[cursor] : null;
  const deviatedAt = onLine ? null : path.findIndex((move, index) => line.moves[index]?.uci !== move.uci);

  const goTo = useCallback((ply: number) => {
    setCursor(Math.max(0, Math.min(ply, path.length)));
    setEngineNote(null);
  }, [path.length]);

  const onMove = (move: AppliedMove): boolean => {
    setEngineNote(null);
    if (next && next.uci === move.uci) {
      setCursor(cursor + 1);
      return true;
    }
    const played = [...path.slice(0, cursor), move];
    const backOnLine = played.every((entry, index) => line.moves[index]?.uci === entry.uci);
    setPath(backOnLine ? line.moves : played);
    setCursor(cursor + 1);
    return true;
  };

  const takeBack = () => {
    if (cursor === 0) {
      return;
    }
    setEngineNote(null);
    const shorter = path.slice(0, cursor - 1);
    const backOnLine = shorter.every((entry, index) => line.moves[index]?.uci === entry.uci);
    setPath(backOnLine ? line.moves : shorter);
    setCursor(cursor - 1);
  };

  const reset = () => {
    setPath(line.moves);
    setCursor(0);
    setEngineNote(null);
  };

  useHotkeys({
    ArrowLeft: () => goTo(cursor - 1),
    ArrowRight: () => goTo(cursor + 1),
    Home: () => goTo(0),
    End: () => goTo(path.length),
    f: () => setFlipped((value) => !value)
  });

  const askEngine = () => {
    if (!engine || !current) {
      return;
    }
    const ply = cursor;
    setEngineNote({ ply, text: null, best: null, loading: true, failed: false });
    engine
      .scoreMove(current.fenBefore, current.uci)
      .then((score) => {
        const explanation = explainMoveScore({ score, move: current, history: path.slice(0, ply - 1) });
        setEngineNote({ ply, text: explanation, best: score.best.uci === current.uci ? null : score.best.san, loading: false, failed: false });
      })
      .catch(() => setEngineNote({ ply, text: null, best: null, loading: false, failed: true }));
  };

  const download = (content: string, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };

  const pgn = useMemo(() => lineToPgn(line, { comments: true, notes: catalog }), [line, catalog]);
  const note = current ? noteFor(catalog, current.epdBefore, current.uci) : undefined;
  const nextNote = next && onLine ? noteFor(catalog, next.epdBefore, next.uci) : undefined;
  const opening = book ? nameAt(book, [START_EPD, ...path.slice(0, cursor).map((move) => move.epdAfter)]) : null;
  const inRepertoire = current
    ? [...userMovesAt(tree, current.epdBefore), ...opponentRepliesAt(tree, current.epdBefore)].find((edge) => edge.uci === current.uci)
    : undefined;
  const orientation = flipped ? opposite(line.side) : line.side;
  const arrows = next && onLine ? [[next.from, next.to, ARROW_COLOURS.solution] as [typeof next.from, typeof next.to, string]] : [];
  const statusValue = view.statusManual ? view.status : "auto";

  return (
    <div className="page">
      <PageHeader
        eyebrow={`${line.family} · ${line.chapter}`}
        title={line.name}
        actions={
          <>
            <Link className="button button-primary" to={`/practice/play-line?line=${encodeURIComponent(line.id)}`}>
              <ListOrdered size={16} aria-hidden="true" />
              Play the line
            </Link>
            <Link className="button" to={`/practice/next-move?line=${encodeURIComponent(line.id)}`}>
              <Crosshair size={16} aria-hidden="true" />
              Practise its positions
            </Link>
          </>
        }
      >
        {line.description}
      </PageHeader>

      <div className="line-meta row">
        {line.eco ? <span className="eco">{line.eco}</span> : null}
        <span className="chip">{PRIORITY_LABELS[line.priority]}</span>
        <span className="chip">{Math.ceil(line.sans.length / 2)} moves deep</span>
        <span className="chip">
          {view.seen} of {view.total} positions practised · mastery {pct(view.mastery)}
        </span>
        <label className="row small">
          <span>In my repertoire</span>
          <button type="button" role="switch" className="switch" aria-checked={view.enabled} aria-label="In my repertoire" onClick={() => actions.setLinesEnabled([line.id], !view.enabled)} />
        </label>
        <label className="row small">
          <span>Status</span>
          <select
            className="select status-select"
            value={statusValue}
            onChange={(event) => actions.setLineStatus(line.id, event.target.value === "auto" ? null : (event.target.value as LineStatus))}
          >
            <option value="auto">Automatic: {LINE_STATUS_LABELS[view.status].toLowerCase()}</option>
            <option value="learning">Learning</option>
            <option value="reviewing">Reviewing</option>
            <option value="mastered">Mastered</option>
          </select>
        </label>
      </div>

      <div className="stage">
        <div className="stage-board">
          <CapturedPieces fen={fen} side={opposite(orientation)} />
          <TrainerBoard id="line-board" fen={fen} orientation={orientation} movable={fen.split(" ")[1] === "w" ? "white" : "black"} onMove={onMove} lastMove={current} arrows={arrows} label={`${line.name}, after ${cursor} plies`} />
          <CapturedPieces fen={fen} side={orientation} />
          <BoardToolbar
            onStart={() => goTo(0)}
            onBack={() => goTo(cursor - 1)}
            onForward={() => goTo(cursor + 1)}
            onEnd={() => goTo(path.length)}
            canBack={cursor > 0}
            canForward={cursor < path.length}
            onUndo={onLine ? undefined : takeBack}
            canUndo={cursor > 0}
            onReset={reset}
            canReset={cursor > 0 || !onLine}
            onFlip={() => setFlipped((value) => !value)}
          />
          <p className="small muted board-help">Move pieces to try other moves; ← and → step through the line.</p>
        </div>

        <div className="stage-side">
          <section className="panel stack" aria-live="polite" aria-label="This move">
            <p className="small muted">{opening ? `${opening.name} · ${opening.eco}` : cursor === 0 ? "Starting position" : "No opening name for this position"}</p>
            {!onLine && deviatedAt !== null ? (
              <div className="notice notice-info">
                <p>
                  You are off the line: it continues {moveLabel(deviatedAt + 1, line.moves[deviatedAt].san)} at move {Math.ceil((deviatedAt + 1) / 2)}.{" "}
                  <button type="button" className="text-button" onClick={reset}>
                    Back to the line
                  </button>
                </p>
              </div>
            ) : null}
            {current ? (
              <div className="stack-tight">
                <h2>
                  <span className="san">{moveLabel(cursor, current.san)}</span>
                  {onLine ? null : inRepertoire ? <span className="badge badge-book">In your repertoire</span> : <span className="badge badge-unverified">Not in your repertoire</span>}
                </h2>
                {note ? (
                  <>
                    <p>{note.why}</p>
                    {note.fits ? (
                      <p className="muted">
                        <strong>Why it fits: </strong>
                        {note.fits}
                      </p>
                    ) : null}
                    {note.avoids ? (
                      <p className="muted">
                        <strong>What it avoids: </strong>
                        {note.avoids}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">{onLine ? "No note for this move yet." : "Use the opening principles: centre, development, king safety."}</p>
                )}
                {!onLine && engine ? (
                  engineNote && engineNote.ply === cursor ? (
                    engineNote.loading ? (
                      <p className="loading small" role="status">
                        Asking the engine…
                      </p>
                    ) : engineNote.failed ? (
                      <p className="small error-text">The engine could not check this move.</p>
                    ) : engineNote.text ? (
                      <div className="feedback feedback-neutral">
                        <p>{engineNote.text.headline}</p>
                        {engineNote.text.details.map((detail) => (
                          <p key={detail} className="small muted">
                            {detail}
                          </p>
                        ))}
                      </div>
                    ) : null
                  ) : (
                    <button type="button" className="button button-small" onClick={askEngine}>
                      Ask the engine about this move
                    </button>
                  )
                ) : null}
              </div>
            ) : (
              <p className="muted">Press → or click a move to step through the line.</p>
            )}
            {next && onLine ? (
              <p className="small">
                Next: <span className="san">{moveLabel(cursor + 1, next.san)}</span>
                {nextNote?.alternatives && nextNote.alternatives.length > 0 ? (
                  <span className="muted"> · also playable: {nextNote.alternatives.map((alternative) => alternative.san).join(", ")}</span>
                ) : null}
              </p>
            ) : null}
          </section>

          {!onLine ? <MoveInput fen={fen} onMove={onMove} /> : null}
          <MoveList moves={path.map((move) => ({ san: move.san }))} current={cursor} onSelect={goTo} label="Moves of the line" />

          <section className="panel stack-tight" aria-labelledby="plans-title">
            <h2 id="plans-title">Plans</h2>
            <ul className="plain-list">
              {line.plans.map((plan) => (
                <li key={plan}>{plan}</li>
              ))}
            </ul>
            {line.ideas.length > 0 ? (
              <>
                <h3>Key ideas</h3>
                <ul className="plain-list">
                  {line.ideas.map((idea) => (
                    <li key={idea}>{idea}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          {line.traps.length > 0 ? (
            <section className="panel stack-tight" aria-labelledby="traps-title">
              <h2 id="traps-title">Traps</h2>
              <ul className="list">
                {line.traps.map((trap) => (
                  <li key={trap.name} className="stack-tight">
                    <span className="row">
                      <strong>{trap.name}</strong>
                      <span className={`badge ${trap.side === "for" ? "badge-book" : "badge-mistake"}`}>{trap.side === "for" ? "For you" : "Avoid it"}</span>
                    </span>
                    <span className="line-moves">{formatLine(trap.sans)}</span>
                    <span className="small muted">{trap.description}</span>
                    <button
                      type="button"
                      className="text-button small"
                      onClick={() => {
                        setPath(trap.played);
                        setCursor(trap.played.length);
                        setEngineNote(null);
                      }}
                    >
                      Show on the board
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel stack-tight" aria-labelledby="export-title">
            <h2 id="export-title">Export</h2>
            <div className="row">
              <button type="button" className="button button-small" onClick={() => download(pgn, `${line.id}.pgn`, "application/x-chess-pgn")}>
                <Download size={14} aria-hidden="true" />
                PGN
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  void navigator.clipboard?.writeText(formatLine(line.sans)).then(() => setCopied(true));
                }}
              >
                <Copy size={14} aria-hidden="true" />
                {copied ? "Copied" : "Copy the moves"}
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => download(JSON.stringify(lineToContentJson(line, catalog), null, 2), `${line.id}.json`, "application/json")}
              >
                <FileJson size={14} aria-hidden="true" />
                Content JSON
              </button>
            </div>
            <p className="small muted">The content JSON can be pasted into the lines of a chapter file in the content folder.</p>
            {custom ? (
              <div className="row">
                <button type="button" className="button button-small" onClick={() => setEditing(true)}>
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </button>
                <button type="button" className="button button-small button-danger" onClick={() => setDeleting(true)}>
                  <Trash2 size={14} aria-hidden="true" />
                  Delete
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {editing && custom ? <AddLineDialog defaultSide={line.side} existing={custom} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        open={deleting}
        title="Delete this line?"
        confirmLabel="Delete the line"
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          void actions.deleteCustomLine(line.id).then(() => navigate("/repertoire"));
        }}
      >
        It is removed from this browser. Practice records of its positions stay, so they still count if the positions are in other lines.
      </ConfirmDialog>
    </div>
  );
}
