import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ColorSnapshot, SnapshotMove } from "../../shared/repertoireSnapshot";
import type { SnapshotResponse } from "../../shared/types";
import { formatCount, pct } from "../utils/formatters";
import { explorerHref } from "./FixCard";

const usageText = { fading: "rarely played lately", rising: "mostly lately" } as const;

function Answer({ move, color, groupMoves, leak }: { move: SnapshotMove; color: ColorSnapshot["color"]; groupMoves: string[]; leak: boolean }) {
  const hints = [
    move.usage ? usageText[move.usage] : null,
    move.lowSample ? "low sample" : null,
    leak ? "leak" : null
  ].filter(Boolean);
  const trend =
    move.direction === "up" ? (
      <ArrowUpRight size={14} className="trend-up" aria-label="scoring better in the last 90 days" />
    ) : move.direction === "down" ? (
      <ArrowDownRight size={14} className="trend-down" aria-label="scoring worse in the last 90 days" />
    ) : null;
  return (
    <Link
      className={`rep-answer${leak ? " rep-answer-leak" : ""}${move.lowSample ? " rep-answer-low" : ""}`}
      to={explorerHref(color, groupMoves, move.uci)}
      title={`${move.eco ? `${move.eco} ${move.name} · ` : ""}${formatCount(move.n)} games (${pct(move.share)}), score ${pct(move.score)} [${pct(move.ci[0])}–${pct(move.ci[1])}]; last 90 days ${move.recentN} vs ${move.olderN} before`}
    >
      <span className="rep-answer-move">{move.label}</span>
      <span className="rep-answer-score">{pct(move.score)}</span>
      <span className="cell-sub">({formatCount(move.n)})</span>
      {trend}
      {hints.length ? <span className="rep-answer-hint">{hints.join(" · ")}</span> : null}
    </Link>
  );
}

function ColorColumn({ snapshot, leakIds }: { snapshot: ColorSnapshot; leakIds: Set<string> }) {
  const title = snapshot.color === "white" ? "As White" : "As Black";
  return (
    <section className="rep-column" aria-label={title}>
      <h3>
        <span className={`mover-dot mover-dot-${snapshot.color}`} aria-hidden="true" />
        {title} <span className="cell-sub">· {formatCount(snapshot.games)} games</span>
      </h3>
      {snapshot.groups.length ? (
        <ul className="rep-groups">
          {snapshot.groups.map((group) => (
            <li key={group.moves.join(",") || "root"} className="rep-group">
              <Link className="rep-group-label" to={explorerHref(snapshot.color, group.moves)}>
                {group.label} <span className="cell-sub">({formatCount(group.n)})</span>
              </Link>
              <div className="rep-answers">
                {group.answers.map((move) => (
                  <Answer
                    key={move.uci}
                    move={move}
                    color={snapshot.color}
                    groupMoves={group.moves}
                    leak={leakIds.has(`${snapshot.color}:${move.moves.join(",")}`)}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="home-empty">
          {snapshot.games ? "Too few games in these filters for a snapshot." : `No games ${title.toLowerCase()} in these filters.`}
        </p>
      )}
    </section>
  );
}

/** Home: per colour, the opponent's main moves and your answers, with score, games and trend hints. */
export function RepertoireCard({
  data,
  error,
  leakIds
}: {
  data: SnapshotResponse | null;
  error: string | null;
  leakIds: Set<string>;
}) {
  return (
    <section className="panel home-card" aria-label="Repertoire snapshot">
      <div className="home-card-head">
        <div>
          <span className="eyebrow">What you play</span>
          <h2>Repertoire snapshot</h2>
        </div>
      </div>
      {error ? (
        <p className="error-text">Could not load the snapshot: {error}</p>
      ) : data ? (
        <>
          <div className="rep-columns">
            <ColorColumn snapshot={data.white} leakIds={leakIds} />
            <ColorColumn snapshot={data.black} leakIds={leakIds} />
          </div>
          <p className="home-card-foot">
            Your main answers with score and games; arrows compare the last 90 days with before, and a hint shows when
            you have mostly stopped or started playing a move. Click a move to open it in the Explorer.
          </p>
        </>
      ) : (
        <p className="home-empty">Loading…</p>
      )}
    </section>
  );
}
