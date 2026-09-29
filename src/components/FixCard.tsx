import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Compass, GraduationCap, Lightbulb } from "lucide-react";
import { alternativesHref, explorerHref, trainHref } from "../utils/links";
import type { EngineHoleItem, FixItem as AnyFixItem, ResultsLeakItem as FixItem, LeakEngineStats, UnpreparedItem } from "../../shared/fixList";
import type { ExplorerFilters } from "../hooks/useFilters";
import { formatCount, formatDay, formatDelta, formatPoints, pct, pctOne } from "../utils/formatters";
import { ScoreWhisker, moveLabel } from "./MoveTable";
import { coverageText } from "./NodeEngine";

export { explorerHref } from "../utils/links";

/** "As Black · last 6 months · blitz + rapid · recent games count more". */
export function scopeText(filters: ExplorerFilters, halfLifeDays: number | null | undefined): string {
  return [
    filters.window === "3m" ? "last 3 months" : "last 6 months",
    filters.timeClass ?? "blitz + rapid",
    halfLifeDays ? `recent games count more (half-life ${halfLifeDays} days)` : "unweighted"
  ].join(" · ");
}

const resultLetter = (score: number) => (score === 1 ? "W" : score === 0 ? "L" : "D");

function TrendNote({ item }: { item: FixItem }) {
  const { trend } = item;
  const Icon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : ArrowRight;
  const scores =
    trend.recentScore !== null && trend.olderScore !== null ? ` (${pct(trend.recentScore)} vs ${pct(trend.olderScore)})` : "";
  return (
    <span className={`fix-trend trend-${trend.direction}`} title={`Score in the last ${trend.days} days vs before${scores}`}>
      {trend.direction === "none" ? null : <Icon size={15} aria-hidden="true" />}
      {formatCount(trend.recentN)} in the last {trend.days} days vs {formatCount(trend.olderN)} before
      {trend.direction === "up" ? ", scoring better lately" : trend.direction === "down" ? ", scoring worse lately" : ""}
    </span>
  );
}

/**
 * One fix-list line: the line and its book name, games, score with CI, the Elo expectation and
 * the difference, the points it is blamed for, trend, early losses, and links to the Explorer
 * and to recent losing games.
 */
function LeakCard({
  item,
  rank,
  explainedLines = [],
  weighted
}: {
  item: FixItem;
  rank?: number;
  /** Lines of the deeper items that explain part of this line's games. */
  explainedLines?: string[];
  weighted: boolean;
}) {
  const colorLabel = item.color === "white" ? "As White" : "As Black";
  const parentMoves = item.moves.slice(0, -1);
  const lastUci = item.moves[item.moves.length - 1];
  const view = weighted ? "recency-weighted" : "unweighted";
  const shared = item.residualN < item.n;

  return (
    <article className={`fix-card fix-card-${item.tier}`}>
      <header className="fix-card-head">
        {rank ? <span className="fix-rank">#{rank}</span> : null}
        <span className="fix-color">
          <span className={`mover-dot mover-dot-${item.color}`} aria-hidden="true" />
          {colorLabel}
        </span>
        <span
          className={`move-tag ${item.tier === "leak" ? "move-tag-leak" : "move-tag-low-sample"}`}
          title={`z ${item.z.toFixed(2)}, one-sided p ${item.p.toFixed(4)}, Benjamini-Hochberg q ${item.q.toFixed(3)}`}
        >
          {item.tier === "leak" ? `Results leak · ${item.confidence} confidence` : "Watch · may be noise"}
        </span>
      </header>

      <h3 className="fix-line">{item.line}</h3>
      <p className="fix-name">
        {item.name ? (
          <>
            <span className="eco-badge">{item.eco}</span> {item.name}
            {item.inBook ? "" : " (out of book: last named line on the way)"}
          </>
        ) : (
          "Out of book"
        )}
      </p>

      <dl className="fix-stats">
        <div title={`Raw games that played ${item.sans[item.sans.length - 1]} here; ESS is the effective n under the recency weights`}>
          <dt>Games</dt>
          <dd>
            {formatCount(item.n)}
            {weighted ? <span className="cell-sub"> · ESS {Math.round(item.ess)}</span> : null}
          </dd>
        </div>
        <div
          title={`Score ${pctOne(item.score)} (${view}; 95% Wilson CI ${pct(item.ci[0])}–${pct(item.ci[1])}); raw ${pctOne(item.raw.score)}. W/D/L ${item.wins}/${item.draws}/${item.losses}`}
        >
          <dt>Score</dt>
          <dd>
            {pct(item.score)} <span className="cell-sub">[{pct(item.ci[0])}–{pct(item.ci[1])}]</span>
            <ScoreWhisker score={item.score} expected={item.expected} ci={item.ci} />
          </dd>
        </div>
        <div title="Your Elo expectation against these opponents (pre-game ratings)">
          <dt>Expected</dt>
          <dd>{pct(item.expected)}</dd>
        </div>
        <div
          title={`Score minus expectation: ${formatDelta(item.delta)} per 100 games, ${formatPoints(item.deltaPts)} points over the line (${view}); raw ${formatDelta(item.raw.delta)} per 100, ${formatPoints(item.raw.deltaPts)} points`}
        >
          <dt>vs Elo</dt>
          <dd className="fix-delta">
            {formatDelta(item.delta)}
            <span className="cell-sub"> / 100 · {formatPoints(item.deltaPts)} pts</span>
          </dd>
        </div>
      </dl>

      <ul className="fix-notes">
        <li>
          <TrendNote item={item} />
        </li>
        <li>
          {formatCount(item.earlyLoss.n)} of {formatCount(item.n)} games ({pct(item.earlyLoss.rate)}) lost by move {item.earlyLoss.ply / 2}
        </li>
        {item.engine ? <LeakEngineNote stats={item.engine} /> : null}
        {shared ? (
          <li className="fix-blame">
            Ranked on {item.pointsLost.toFixed(1)} points lost in the {formatCount(item.residualN)} games not covered by{" "}
            {explainedLines.length ? explainedLines.join(", ") : "a deeper line"}.
          </li>
        ) : null}
      </ul>

      <footer className="fix-actions">
        <Link className="primary-button fix-explore" to={alternativesHref(item.color, parentMoves, lastUci)}>
          <Lightbulb size={16} aria-hidden="true" /> Try this instead
        </Link>
        <Link className="secondary-button fix-explore" to={explorerHref(item.color, parentMoves, lastUci)}>
          <Compass size={16} aria-hidden="true" /> Open in Explorer
        </Link>
        <Link className="secondary-button fix-explore" to={trainHref({ color: item.color, moves: parentMoves })}>
          <GraduationCap size={16} aria-hidden="true" /> Drill this
        </Link>
        {item.examples.length ? (
          <div className="fix-examples">
            <span className="cell-sub">{item.examples.some((example) => example.score === 0) ? "Recent losses" : "Recent games"}</span>
            {item.examples.map((example) => (
              <Link
                key={example.id}
                className={`fix-example fix-example-${resultLetter(example.score)}`}
                to={`/review/${example.id}?ply=${example.ply}`}
                title={`Review this game from move ${Math.ceil(example.ply / 2)}`}
              >
                <span className="fix-example-result">{resultLetter(example.score)}</span>
                {formatDay(example.endTime)}
              </Link>
            ))}
          </div>
        ) : null}
      </footer>
    </article>
  );
}

/** A signed eval in pawns from a cp / mate pair: "-0.45", "+1.87", "M3", "-M2". */
function pawns(score: { cp: number; mate: number | null }): string {
  if (score.mate !== null && score.mate !== 0) {
    return score.mate > 0 ? `M${score.mate}` : `-M${-score.mate}`;
  }
  const value = score.cp / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** The engine facts on a results leak, or how much engine data there is when too little to claim anything. */
function LeakEngineNote({ stats }: { stats: LeakEngineStats }) {
  const parts: string[] = [];
  if (stats.evalAt20?.shown) {
    parts.push(`average eval at move 10: ${pawns({ cp: stats.evalAt20.cp, mate: null })} for you`);
  }
  if (stats.firstError.shown && stats.firstError.rate !== null) {
    parts.push(`a first mistake by move 10 in ${pct(stats.firstError.rate)} of ${formatCount(stats.firstError.known)} checked games`);
  }
  const top = stats.topFirstMistake;
  if (top && stats.firstError.shown) {
    parts.push(`most common first mistake ${moveLabel(top.ply, top.san)} (${top.count}×; engine: ${moveLabel(top.ply, top.bestSan)})`);
  }
  return (
    <li className="fix-engine" title="From Stockfish's check of these games' openings">
      {parts.length ? `Engine: ${parts.join(" · ")}. ` : "Engine: too few of these games are checked for engine claims yet. "}
      <span className="cell-sub">({coverageText(stats)})</span>
    </li>
  );
}

/** A theory hole: an owner move the engine refutes, whatever its results. */
function HoleCard({ item, rank }: { item: EngineHoleItem; rank?: number }) {
  const colorLabel = item.color === "white" ? "As White" : "As Black";
  const ply = item.moves.length;
  const move = moveLabel(ply, item.sans[ply - 1]);
  const best = moveLabel(ply, item.bestSan);
  const gates = [item.gates.loss ? "loses 7+ win%" : "", item.gates.reply ? "the reply is +1.00 or more for the opponent" : ""].filter(Boolean).join("; ");
  return (
    <article className="fix-card fix-card-hole">
      <header className="fix-card-head">
        {rank ? <span className="fix-rank">#{rank}</span> : null}
        <span className="fix-color">
          <span className={`mover-dot mover-dot-${item.color}`} aria-hidden="true" />
          {colorLabel}
        </span>
        <span className="move-tag move-tag-hole" title={`Listed because the move ${gates}. Engine facts, not a results test.`}>
          Theory hole · {item.cls}
        </span>
      </header>

      <h3 className="fix-line">Theory hole: {move}</h3>
      <p className="fix-name">
        after {item.before || "the start"}
        {item.name ? (
          <>
            {" "}
            · <span className="eco-badge">{item.eco}</span> {item.name}
          </>
        ) : null}
      </p>

      <dl className="fix-stats">
        <div title="Win% your move gives away against the engine's best move, at the same depth">
          <dt>Loss</dt>
          <dd>
            {item.loss.toFixed(1)} <span className="cell-sub">win%</span>
          </dd>
        </div>
        <div title="The engine's eval for you (your side's view) with its move and with yours">
          <dt>Eval for you</dt>
          <dd>
            {pawns(item.ownerEval.best)} <span className="cell-sub">vs</span> {pawns(item.ownerEval.played)}
          </dd>
        </div>
        <div title="The engine's move here">
          <dt>Engine</dt>
          <dd>{best}</dd>
        </div>
        <div title={`Raw score with ${move}; expected ${pct(item.expected)} from the ratings`}>
          <dt>Games</dt>
          <dd>
            {formatCount(item.n)} <span className="cell-sub">· {pct(item.score)}</span>
          </dd>
        </div>
      </dl>

      <ul className="fix-notes">
        <li>
          {item.reply
            ? `${item.color === "white" ? "Black" : "White"}'s best reply is ${moveLabel(ply + 1, item.reply.san)}: ${pawns({ cp: item.reply.cpForThem, mate: item.reply.mate })} for ${item.color === "white" ? "Black" : "White"}.`
            : "The reply is not engine-checked yet."}
        </li>
        <li>
          You score {pct(item.score)} with it (expected {pct(item.expected)}): the engine flags the move whatever the results.
        </li>
      </ul>

      <footer className="fix-actions">
        <Link className="primary-button fix-explore" to={alternativesHref(item.color, item.moves.slice(0, -1), item.moves[ply - 1])}>
          <Lightbulb size={16} aria-hidden="true" /> Try this instead
        </Link>
        <Link className="secondary-button fix-explore" to={explorerHref(item.color, item.moves.slice(0, -1), item.moves[ply - 1])}>
          <Compass size={16} aria-hidden="true" /> Open in Explorer
        </Link>
        <Link className="secondary-button fix-explore" to={trainHref({ color: item.color, moves: item.moves.slice(0, -1) })}>
          <GraduationCap size={16} aria-hidden="true" /> Drill this
        </Link>
        {item.examples.length ? (
          <div className="fix-examples">
            <span className="cell-sub">Recent games</span>
            {item.examples.map((example) => (
              <Link
                key={example.id}
                className={`fix-example fix-example-${resultLetter(example.score)}`}
                to={`/review/${example.id}?ply=${example.ply}`}
                title={`Review this game from move ${Math.ceil(example.ply / 2)}`}
              >
                <span className="fix-example-result">{resultLetter(example.score)}</span>
                {formatDay(example.endTime)}
              </Link>
            ))}
          </div>
        ) : null}
      </footer>
    </article>
  );
}

/** An opponent reply the repertoire has no answer to yet. */
function UnpreparedCard({ item, rank }: { item: UnpreparedItem; rank?: number }) {
  const colorLabel = item.color === "white" ? "As White" : "As Black";
  const ply = item.moves.length;
  const reply = moveLabel(ply, item.sans[ply - 1]);
  return (
    <article className="fix-card fix-card-unprepared">
      <header className="fix-card-head">
        {rank ? <span className="fix-rank">#{rank}</span> : null}
        <span className="fix-color">
          <span className={`mover-dot mover-dot-${item.color}`} aria-hidden="true" />
          {colorLabel}
        </span>
        <span className="move-tag move-tag-unprepared" title="Games that followed your repertoire until this reply, which it has no answer to">
          Unprepared reply
        </span>
      </header>

      <h3 className="fix-line">Not prepared: {reply}</h3>
      <p className="fix-name">
        after {item.before || "the start"}
        {item.name ? (
          <>
            {" "}
            · <span className="eco-badge">{item.eco}</span> {item.name}
          </>
        ) : null}
      </p>

      <dl className="fix-stats">
        <div title="Games that followed your repertoire to this reply">
          <dt>Games</dt>
          <dd>{formatCount(item.n)}</dd>
        </div>
        <div title="Your raw score in those games">
          <dt>Score</dt>
          <dd>{pct(item.score)}</dd>
        </div>
        <div title="Recency-weighted points below your Elo expectation in those games">
          <dt>Points lost</dt>
          <dd>{formatPoints(-item.pointsLost)}</dd>
        </div>
      </dl>

      <ul className="fix-notes">
        <li>Your repertoire has no move after {reply}. See the suggestions, or pick one in the Explorer with “Set as my move”.</li>
      </ul>

      <footer className="fix-actions">
        <Link className="primary-button fix-explore" to={alternativesHref(item.color, item.moves)}>
          <Lightbulb size={16} aria-hidden="true" /> See suggestions
        </Link>
        <Link className="secondary-button fix-explore" to={explorerHref(item.color, item.moves)}>
          <Compass size={16} aria-hidden="true" /> Open in Explorer
        </Link>
        {item.examples.length ? (
          <div className="fix-examples">
            <span className="cell-sub">Recent games</span>
            {item.examples.map((example) => (
              <Link
                key={example.id}
                className={`fix-example fix-example-${resultLetter(example.score)}`}
                to={`/review/${example.id}?ply=${example.ply}`}
                title={`Review this game from move ${Math.ceil(example.ply / 2)}`}
              >
                <span className="fix-example-result">{resultLetter(example.score)}</span>
                {formatDay(example.endTime)}
              </Link>
            ))}
          </div>
        ) : null}
      </footer>
    </article>
  );
}

/** One fix-list item: a results leak (or watch line), a theory hole or an unprepared reply. */
export function FixCard({
  item,
  rank,
  explainedLines,
  weighted
}: {
  item: AnyFixItem;
  rank?: number;
  explainedLines?: string[];
  weighted: boolean;
}) {
  if (item.kind === "unprepared") {
    return <UnpreparedCard item={item} rank={rank} />;
  }
  return item.kind === "engine-hole" ? (
    <HoleCard item={item} rank={rank} />
  ) : (
    <LeakCard item={item} rank={rank} explainedLines={explainedLines} weighted={weighted} />
  );
}

/** item id -> line, to name the deeper items an item's blame excludes. */
export function explainedLinesOf(item: AnyFixItem, all: readonly AnyFixItem[]): string[] {
  return item.kind === "results-leak" ? item.explainedBy.flatMap((id) => all.find((other) => other.id === id)?.line ?? []) : [];
}
