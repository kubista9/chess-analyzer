import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Compass } from "lucide-react";
import type { FixItem as AnyFixItem, ResultsLeakItem as FixItem } from "../../shared/fixList";

export const isLeak = (item: AnyFixItem): item is FixItem => item.kind === "results-leak";
import type { PlayerColor } from "../../shared/types";
import type { ExplorerFilters } from "../hooks/useFilters";
import { formatCount, formatDay, formatDelta, formatPoints, pct, pctOne } from "../utils/formatters";
import { ScoreWhisker } from "./MoveTable";

/** The Explorer at `moves`, with the row of `select` (a UCI move from there) highlighted. */
export function explorerHref(color: PlayerColor, moves: readonly string[], select?: string): string {
  const params = new URLSearchParams({ color });
  if (moves.length) {
    params.set("moves", moves.join(","));
  }
  if (select) {
    params.set("select", select);
  }
  return `/explorer?${params}`;
}

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
export function FixCard({
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
          {item.tier === "leak" ? `Leak · ${item.confidence} confidence` : "Watch · may be noise"}
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
        {shared ? (
          <li className="fix-blame">
            Ranked on {item.pointsLost.toFixed(1)} points lost in the {formatCount(item.residualN)} games not covered by{" "}
            {explainedLines.length ? explainedLines.join(", ") : "a deeper line"}.
          </li>
        ) : null}
      </ul>

      <footer className="fix-actions">
        <Link className="secondary-button fix-explore" to={explorerHref(item.color, parentMoves, lastUci)}>
          <Compass size={16} aria-hidden="true" /> Open in Explorer
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

/** item id -> line, to name the deeper items an item's blame excludes. */
export function explainedLinesOf(item: FixItem, all: readonly FixItem[]): string[] {
  return item.explainedBy.flatMap((id) => all.find((other) => other.id === id)?.line ?? []);
}
