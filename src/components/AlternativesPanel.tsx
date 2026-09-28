import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Arrow, Square } from "react-chessboard/dist/chessboard/types";
import { BookmarkCheck, BookmarkPlus, Compass, Info, LoaderCircle, Undo2 } from "lucide-react";
import type { Alternative, AlternativesResponse, AncestorSuggestion, AltReason } from "../../shared/alternatives";
import { isJobActive } from "../../shared/jobPolling";
import { formatLine } from "../../shared/openingTree";
import type { JobState, PlayerColor } from "../../shared/types";
import { fetchAlternatives, putRepEntry, type TreeQuery } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { formatCount, pct } from "../utils/formatters";
import { boardColors, boardTheme } from "./boardTheme";
import { evalLabel } from "./EvalBar";
import { alternativesHref, explorerHref } from "../utils/links";
import { moveLabel } from "./MoveTable";

export { alternativesHref } from "../utils/links";

const KIND_LABEL: Record<Alternative["kind"], string> = {
  owned: "you play it",
  book: "book move",
  "engine-idea": "engine idea"
};

function Reasons({ reasons }: { reasons: AltReason[] }) {
  return (
    <ul className="alt-reasons">
      {reasons.map((reason) => (
        <li key={`${reason.feature}-${reason.text}`} className={reason.points > 0 ? "is-plus" : reason.points < 0 ? "is-minus" : undefined}>
          <span className="alt-points" aria-label={`${reason.points} points`}>
            {reason.points > 0 ? "+" : ""}
            {Number.isInteger(reason.points) ? reason.points : reason.points.toFixed(1)}
          </span>
          {reason.text}
        </li>
      ))}
    </ul>
  );
}

/** The board after `count` plies of `ucis` from `epd`. */
function fenAfter(epd: string, ucis: readonly string[], count: number): { fen: string; last: string | null } {
  const chess = new Chess(`${epd} 0 1`);
  let last: string | null = null;
  for (const uci of ucis.slice(0, count)) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      last = uci;
    } catch {
      break;
    }
  }
  return { fen: chess.fen(), last };
}

export interface AlternativesPanelProps {
  color: PlayerColor;
  moves: string[];
  uci: string | null;
  tree: TreeQuery;
}

export function AlternativesPanel({ color, moves, uci, tree }: AlternativesPanelProps) {
  const [version, setVersion] = useState(0);
  const movesKey = moves.join(",");
  const { data, error, loading } = useStoreQuery((signal) => fetchAlternatives(tree, moves, uci, signal), [tree, movesKey, uci, version]);
  const [job, setJob] = useState<JobState<AlternativesResponse> | null>(null);
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setJob(data?.job ?? null);
  }, [data]);
  useEffect(() => {
    setSelected(0);
    setStep(1);
    setNotice(null);
  }, [movesKey, uci]);
  useJobPolling(job, setJob);

  // The job's result replaces the preliminary answer once the deep search is done.
  const response = job?.status === "completed" && job.result ? job.result : data;
  const result = response?.result ?? null;
  const running = isJobActive(job);
  const failed = job?.status === "failed" ? job.error ?? job.message : null;
  const gated = useMemo(() => (result ? [...result.alternatives, ...result.others] : []), [result]);
  const current = gated[Math.min(selected, Math.max(0, gated.length - 1))] ?? null;
  const ply = result?.ply ?? moves.length + 1;

  const board = useMemo(() => {
    if (!result) {
      return null;
    }
    if (!current) {
      return { fen: `${result.epd} 0 1`, arrows: [] as Arrow[] };
    }
    const { fen, last } = fenAfter(result.epd, current.sampleLine.ucis, step);
    const arrows: Arrow[] = last ? [[last.slice(0, 2) as Square, last.slice(2, 4) as Square, step === 1 ? boardColors.best : boardColors.arrow]] : [];
    return { fen, arrows };
  }, [current, result, step]);

  const setMove = useCallback(
    async (target: { epd: string; ply: number; uci: string; san: string; replaces?: { uci: string; loss: number | null; reason: string } }) => {
      setBusy(true);
      try {
        await putRepEntry({ color, epd: target.epd, uci: target.uci, ply: target.ply, replaces: target.replaces });
        setNotice(`${moveLabel(target.ply, target.san)} is now your repertoire move there (edited, locked).`);
        setVersion((value) => value + 1);
      } catch (caught) {
        setNotice(`Could not set the move: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [color]
  );

  if (error && !data) {
    return <p className="error-text">Could not load the alternatives: {error}</p>;
  }
  if (!result || !response) {
    return <p className="home-empty">{loading ? "Loading the alternatives…" : "No data."}</p>;
  }

  const question = result.current;
  const replacesCurrent = (alternative: Alternative) =>
    question && question.uci !== alternative.uci
      ? {
          uci: question.uci,
          loss: question.eval?.gap ?? null,
          reason: `Set from the alternatives: ${moveLabel(ply, alternative.san)} (${alternative.reasons
            .filter((reason) => reason.points > 0)
            .map((reason) => reason.feature)
            .join(", ") || "engine-sound"}).`
        }
      : undefined;

  const lost = result.pointsLost;
  const maxLost = lost ? Math.max(0.01, ...lost.rows.map((row) => Math.abs(row.pointsLost))) : 1;

  return (
    <div className="alt-panel">
      <header className="panel alt-head">
        <p className="rep-panel-line">{formatLine(result.sans) || "Start position"}</p>
        {result.name ? (
          <p className="node-name-note">
            <span className="eco-badge">{result.eco}</span> {result.name} · {formatCount(result.n)} of your games
          </p>
        ) : (
          <p className="node-name-note">{formatCount(result.n)} of your games reached it</p>
        )}
        {question ? (
          <div className="alt-question">
            <h2>
              Your move: {moveLabel(ply, question.san)}
              {question.isRepertoire ? <span className="rep-chip rep-chip-from-games">repertoire</span> : null}
            </h2>
            <ul className="alt-why">
              {question.eval ? (
                <li>
                  Engine: {evalLabel(question.eval.white)} after it,{" "}
                  {question.eval.gap < 1 ? "as good as the best move" : `${question.eval.gap.toFixed(1)} win% below the best move`}
                  {question.hole ? " (an engine hole)" : ""}.
                </li>
              ) : (
                <li>Not scored by the engine yet.</li>
              )}
              {question.flag ? (
                <li className="is-flag">
                  {question.flag.tier === "leak" ? "Results leak" : "Watch-tier results"}: you score {pct(question.flag.score)} over{" "}
                  {question.flag.n} games (expected {pct(question.flag.expected)}, z {question.flag.z.toFixed(2)}).
                  {question.eval && question.eval.gap < 1 ? " It is the engine's best move, so the points are lost later: see below. The moves here are suggestions only." : ""}
                </li>
              ) : question.ownerStats ? (
                <li>
                  You play it in {formatCount(question.ownerStats.n)} games at {pct(question.ownerStats.score)}
                  {question.ownerStats.lowSample ? " (a low sample)" : ""}.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        <div className="rep-actions">
          <Link className="secondary-button" to={explorerHref(color, moves, question?.uci)}>
            <Compass size={15} aria-hidden="true" /> Explorer
          </Link>
          <Link className="secondary-button" to={`/repertoire?color=${color}`}>
            Repertoire
          </Link>
        </div>
        <p className="cell-sub alt-engine">
          {response.status === "no-engine"
            ? response.engineError
            : result.engine
              ? `Engine: ${result.engine.tier === "deep" ? "deep check" : "regular check"} (depth ${result.engine.depth}, ${result.engine.multipv} lines, ${formatCount(result.engine.nodes)} nodes). Gate: within ${result.gate} win% of the best move.`
              : "No engine data here yet."}
          {response.cost ? ` This open searched ${response.cost.searched} positions in ${(response.cost.ms / 1000).toFixed(1)} s.` : ""}
        </p>
        {running ? (
          <div className="alt-running" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
            <span>
              {job?.message ?? "Deep engine check"} · {job?.progress ?? 0}%. The cards below are preliminary (the regular engine data) until it finishes.
            </span>
          </div>
        ) : null}
        {failed ? <p className="error-text">The deep check failed: {failed}</p> : null}
        {notice ? (
          <p className="explorer-notice" role="status">
            {notice}
          </p>
        ) : null}
      </header>

      <div className="alt-grid">
        <section className="panel alt-board-panel" aria-label="Sample line">
          {board ? (
            <div className="alt-board">
              <Chessboard id="alternatives-board" position={board.fen} boardOrientation={color} arePiecesDraggable={false} customArrows={board.arrows} {...boardTheme} />
            </div>
          ) : null}
          {current ? (
            <div className="pv-line">
              <div className="pv-line-head">
                <strong>Sample line: {moveLabel(ply, current.san)}</strong>
                <span className="pv-line-eval">{evalLabel(current.eval.white)}</span>
              </div>
              <div className="pv-line-moves" role="group" aria-label="Step through the sample line">
                {current.sampleLine.sans.map((san, index) => {
                  const at = ply + index;
                  const number = at % 2 === 1 ? `${Math.ceil(at / 2)}.` : index === 0 ? `${Math.ceil(at / 2)}...` : "";
                  const active = step === index + 1;
                  return (
                    <button key={`${index}-${san}`} type="button" className={`pv-chip${active ? " pv-chip-active" : ""}`} aria-pressed={active} onClick={() => setStep(index + 1)}>
                      {number}
                      {san}
                    </button>
                  );
                })}
                <button type="button" className="pv-chip" aria-label="Back to the position" onClick={() => setStep(0)}>
                  <Undo2 size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <p className="cell-sub">No move passes the engine gate here{response.status === "preliminary" ? " yet" : ""}.</p>
          )}
        </section>

        <section className={`alt-cards${response.status === "preliminary" ? " is-preliminary" : ""}`} aria-label="Alternatives" aria-busy={running}>
          {gated.map((alternative, index) => (
            <article
              key={alternative.uci}
              className={`panel alt-card${index === selected ? " is-selected" : ""}${index >= result.alternatives.length ? " is-other" : ""}`}
            >
              <header className="alt-card-head">
                <button type="button" className="alt-card-title" onClick={() => { setSelected(index); setStep(1); }} aria-pressed={index === selected}>
                  <span className="alt-rank">{index < result.alternatives.length ? `#${index + 1}` : "+"}</span>
                  <strong>{moveLabel(ply, alternative.san)}</strong>
                  <span className={`alt-kind alt-kind-${alternative.kind}`}>{KIND_LABEL[alternative.kind]}</span>
                </button>
                <span className="alt-eval" title={`Your win chance ${alternative.eval.winPct.toFixed(1)}%`}>
                  {evalLabel(alternative.eval.white)}
                  <span className="cell-sub">{alternative.eval.gap < 0.05 ? " best" : ` −${alternative.eval.gap.toFixed(1)}%`}</span>
                </span>
              </header>
              <p className="node-name-note">
                {alternative.name ? (
                  <>
                    {alternative.eco ? <span className="eco-badge">{alternative.eco}</span> : null} {alternative.name}
                    {alternative.nameExact ? "" : " (the line it stays on)"}
                  </>
                ) : (
                  "Not a named line"
                )}
                {alternative.ownerStats ? (
                  <>
                    {" "}
                    · you: {formatCount(alternative.ownerStats.n)} games, {pct(alternative.ownerStats.score)} (95% {pct(alternative.ownerStats.ci[0])}–
                    {pct(alternative.ownerStats.ci[1])}){alternative.ownerStats.lowSample ? ", low sample" : ""}
                  </>
                ) : null}
              </p>
              <Reasons reasons={alternative.reasons} />
              {alternative.replies.length ? (
                <p className="cell-sub alt-replies">
                  Typical replies:{" "}
                  {alternative.replies
                    .map((reply) => `${moveLabel(ply + 1, reply.san)}${reply.n ? ` (${reply.n} of your games)` : reply.source === "engine" ? " (engine)" : " (book)"}`)
                    .join(", ")}
                </p>
              ) : null}
              <div className="rep-actions">
                <button type="button" className="secondary-button" onClick={() => { setSelected(index); setStep(1); }}>
                  Show line
                </button>
                {alternative.isRepertoire ? (
                  <span className="rep-mark">
                    <BookmarkCheck size={14} aria-hidden="true" /> My move
                  </span>
                ) : (
                  <button
                    type="button"
                    className="rep-set"
                    disabled={busy || running}
                    onClick={() => setMove({ epd: result.epd, ply, uci: alternative.uci, san: alternative.san, replaces: replacesCurrent(alternative) })}
                  >
                    <BookmarkPlus size={14} aria-hidden="true" /> Set as my move
                  </button>
                )}
              </div>
            </article>
          ))}
          {result.rejected.length ? (
            <p className="cell-sub">
              Not offered:{" "}
              {result.rejected
                .map((move) => `${moveLabel(ply, move.san)} (${move.gap === null ? "not scored" : `−${move.gap.toFixed(1)}%`})`)
                .join(", ")}
              .
            </p>
          ) : null}
        </section>
      </div>

      {lost ? (
        <section className="panel alt-lost" aria-label="Where the points are lost">
          <h2>Where the points are lost after {moveLabel(ply, lost.san)}</h2>
          <p className="cell-sub">
            {formatCount(lost.n)} games at {pct(lost.score)}; {lost.pointsLost >= 0 ? `${lost.pointsLost.toFixed(1)} points below` : `${(-lost.pointsLost).toFixed(1)} points above`} your Elo
            expectation (recent games count more), split by the reply and your answer.
          </p>
          <ul className="alt-lost-rows">
            {lost.rows.map((row) => (
              <li key={row.uci || "end"}>
                <span className="alt-lost-label">
                  {row.uci ? moveLabel(ply + 1, row.san) : row.san} <span className="cell-sub">{formatCount(row.n)} · {pct(row.score)}</span>
                </span>
                <span className="alt-lost-bar" aria-hidden="true">
                  <span className={row.pointsLost >= 0 ? "is-lost" : "is-gained"} style={{ width: `${Math.max(2, (Math.abs(row.pointsLost) / maxLost) * 100)}%` }} />
                </span>
                <span className="alt-lost-value">{row.pointsLost >= 0 ? `−${row.pointsLost.toFixed(2)}` : `+${(-row.pointsLost).toFixed(2)}`}</span>
                {row.answers.length ? (
                  <span className="cell-sub alt-lost-answers">
                    then{" "}
                    {row.answers.map((answer) => `${moveLabel(ply + 2, answer.san)} ${answer.n} (${answer.pointsLost >= 0 ? "−" : "+"}${Math.abs(answer.pointsLost).toFixed(2)})`).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {lost.otherN ? <p className="cell-sub">Other replies: {formatCount(lost.otherN)} games, {lost.otherPointsLost.toFixed(2)} points.</p> : null}
        </section>
      ) : null}

      {result.ancestors.length ? (
        <section className="panel alt-earlier" aria-label="Change earlier">
          <h2>Change earlier</h2>
          {result.ancestors.map((suggestion) => (
            <Ancestor key={`${suggestion.epd}-${suggestion.kind}`} color={color} suggestion={suggestion} busy={busy || running} onSet={setMove} />
          ))}
        </section>
      ) : null}

      <section className="panel alt-honesty" aria-label="How to read this">
        <h2>
          <Info size={16} aria-hidden="true" /> How to read this
        </h2>
        <ul>
          {result.honesty.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Ancestor({
  color,
  suggestion,
  busy,
  onSet
}: {
  color: PlayerColor;
  suggestion: AncestorSuggestion;
  busy: boolean;
  onSet: (target: { epd: string; ply: number; uci: string; san: string; replaces?: { uci: string; loss: number | null; reason: string } }) => void;
}) {
  const at = formatLine(suggestion.sans) || "the start";
  return (
    <div className="alt-ancestor">
      <p>
        After <strong>{at}</strong> play{" "}
        {suggestion.play.map((move, index) => (
          <span key={move.uci}>
            {index ? " / " : ""}
            <strong>{moveLabel(suggestion.ply, move.san)}</strong>
          </span>
        ))}{" "}
        instead of {moveLabel(suggestion.ply, suggestion.instead.san)}.
      </p>
      <p className="cell-sub">{suggestion.reason}</p>
      <div className="rep-actions">
        {suggestion.play.slice(0, 3).map((move) => (
          <button
            key={move.uci}
            type="button"
            className="rep-set"
            disabled={busy}
            onClick={() =>
              onSet({
                epd: suggestion.epd,
                ply: suggestion.ply,
                uci: move.uci,
                san: move.san,
                replaces: { uci: suggestion.instead.uci, loss: suggestion.instead.gap, reason: `Changed earlier from the alternatives: ${suggestion.reason}` }
              })
            }
          >
            <BookmarkPlus size={14} aria-hidden="true" /> Set {moveLabel(suggestion.ply, move.san)}
          </button>
        ))}
        <Link className="secondary-button" to={alternativesHref(color, suggestion.moves, suggestion.instead.uci)}>
          Alternatives there
        </Link>
      </div>
    </div>
  );
}
