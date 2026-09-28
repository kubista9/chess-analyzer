import { ArrowDownRight, ArrowRight, ArrowUpRight, BookmarkCheck, BookmarkPlus, ListVideo, Star } from "lucide-react";
import { formatEval } from "../../shared/eval";
import { moveSignals, trendDirection, type MoveSignal } from "../../shared/moveSignals";
import type { WhiteEvalPoint } from "../../shared/openingAnalysis";
import type { PlayerColor, TreeEdgeView, TreeNodeView } from "../../shared/types";
import { formatCount, formatDelta, formatPoints, pct, pctOne } from "../utils/formatters";

function formatSeconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** "e5" as "1...e5" / "Nf3" as "2.Nf3", from the ply the move is played at. */
export function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}.${san}` : `${number}...${san}`;
}

const signalLabel: Record<MoveSignal, string | null> = {
  leak: "Below expectation",
  strength: "Above expectation",
  neutral: null,
  "low-sample": "Low sample"
};

/** Score dot, 95% CI bar, 50% tick and an amber tick at the Elo expectation, on a 0-100% axis. */
export function ScoreWhisker({ score, expected, ci }: { score: number; expected: number; ci: [number, number] }) {
  const x = (value: number) => 4 + value * 92;
  return (
    <svg className="score-whisker" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
      <line className="score-whisker-axis" x1={x(0)} x2={x(1)} y1="7" y2="7" />
      <line className="score-whisker-mid" x1={x(0.5)} x2={x(0.5)} y1="3" y2="11" />
      <line className="score-whisker-ci" x1={x(ci[0])} x2={x(ci[1])} y1="7" y2="7" />
      <line className="score-whisker-expected" x1={x(expected)} x2={x(expected)} y1="1" y2="13" />
      <circle className="score-whisker-dot" cx={x(score)} cy="7" r="2.6" />
    </svg>
  );
}

function TrendCell({ edge }: { edge: TreeEdgeView }) {
  const { trend } = edge;
  const direction = trendDirection(trend);
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  const describe = (n: number, score: number | null) => `${formatCount(n)} game${n === 1 ? "" : "s"}${score === null ? "" : ` at ${pct(score)}`}`;
  const title = `Last ${trend.days} days: ${describe(trend.recentN, trend.recentScore)}; before: ${describe(trend.olderN, trend.olderScore)}.${
    direction === "none" ? " An arrow needs 8 games on each side." : ""
  }`;
  return (
    <span className={`trend-cell trend-${direction}`} title={title}>
      {direction === "none" ? <span className="trend-none" aria-hidden="true">·</span> : <Icon size={16} aria-hidden="true" />}
      <span className="cell-sub">
        {formatCount(trend.recentN)} / {formatCount(trend.olderN)}
      </span>
    </span>
  );
}

/** "+0.45", "-M3" (White's view), or "pending" for a position the engine has not seen yet. */
export function EvalText({ point }: { point: WhiteEvalPoint | "pending" | null | undefined }) {
  if (!point || point === "pending") {
    return <span className="eval-pending" title="Not engine-checked yet">pending</span>;
  }
  return <span className={`eval-text${point.cp > 0 ? " eval-white" : point.cp < 0 ? " eval-black" : ""}`}>{formatEval(point)}</span>;
}

const CLASS_LABEL = { best: "Best", good: "Good", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" } as const;

/** Eval after the move (White's side) and, for the owner's moves, the win% it gives away with its class. */
function EngineCells({ edge }: { edge: TreeEdgeView }) {
  const engine = edge.engine;
  if (!engine || engine.status === "pending") {
    return (
      <>
        <td>
          <EvalText point="pending" />
        </td>
        <td>
          <span className="cell-sub">–</span>
        </td>
      </>
    );
  }
  return (
    <>
      <td title={`Eval after the move, from White's side${engine.approx ? " (opponent's move: a shallower search)" : ""}`}>
        <span className="cell-main">
          <EvalText point={engine.eval} />
        </span>
      </td>
      <td
        title={
          engine.approx
            ? `Opponent's move: ${engine.loss.toFixed(1)} win% below the engine's best (approximate)`
            : `${CLASS_LABEL[engine.cls]}: ${engine.loss.toFixed(1)} win% below the engine's best at this position`
        }
      >
        {engine.approx ? (
          <span className="cell-sub">{engine.loss.toFixed(1)}</span>
        ) : (
          <span className={`loss-cell loss-${engine.cls}`}>
            <span className={`class-dot class-dot-${engine.cls}`} aria-hidden="true" />
            <span className="cell-main">{engine.loss.toFixed(1)}</span>
            <span className="cell-sub">{CLASS_LABEL[engine.cls].toLowerCase()}</span>
          </span>
        )}
      </td>
    </>
  );
}

function BookName({ edge }: { edge: TreeEdgeView }) {
  if (!edge.inBook) {
    return (
      <span className="move-book move-book-out" title={edge.name ? `Last named line on the way: ${edge.eco} ${edge.name}` : undefined}>
        out of book
      </span>
    );
  }
  if (!edge.name) {
    return <span className="move-book">named line</span>;
  }
  return (
    <span
      className={`move-book${edge.nameExact ? "" : " move-book-inherited"}`}
      title={edge.nameExact ? `${edge.eco} ${edge.name}` : `A book position without its own name; last named: ${edge.eco} ${edge.name}`}
    >
      {edge.eco} {edge.name}
    </span>
  );
}

export interface MoveTableProps {
  node: TreeNodeView;
  /** The owner's colour. */
  color: PlayerColor;
  /** Ply of the moves in this table (node ply + 1 along the current path). */
  ply: number;
  selected: number;
  onSelect: (index: number) => void;
  onFollow: (edge: TreeEdgeView) => void;
  onShowGames: (edge: TreeEdgeView) => void;
  weighted: boolean;
  /** Plies per game in the tree. */
  maxPly: number;
  /** At the owner's positions: the repertoire's move here (null = none yet), and how to set one. */
  repertoire?: { uci: string | null; busy: boolean; onSet: (edge: TreeEdgeView) => void };
}

/** The moves played from one position: frequency, results, score vs Elo, trend, think time, book. */
export function MoveTable({ node, color, ply, selected, onSelect, onFollow, onShowGames, weighted, maxPly, repertoire }: MoveTableProps) {
  const signals = moveSignals(node.edges);
  const mover: PlayerColor = node.ownerToMove ? color : color === "white" ? "black" : "white";
  const played = node.edges.reduce((sum, edge) => sum + edge.n, 0);
  const scoreNote = weighted ? "recency-weighted" : "unweighted";
  const engine = node.engine !== null;

  if (!node.edges.length) {
    return (
      <p className="move-table-empty">
        {node.n
          ? `No game continued from here within the tree's first ${maxPly} plies.`
          : "No games in these filters."}
      </p>
    );
  }

  return (
    <div className="move-table-scroll">
      <table className="move-table">
        <caption className="move-table-caption">
          <span className={`mover-dot mover-dot-${mover}`} aria-hidden="true" />
          {node.ownerToMove ? "Your moves" : "Opponent replies"} · {formatCount(played)} game{played === 1 ? "" : "s"}
        </caption>
        <thead>
          <tr>
            <th scope="col">Move</th>
            {engine ? (
              <>
                <th scope="col" title="Stockfish's eval after the move, from White's side (M# = mate); pending = not engine-checked yet">
                  Eval
                </th>
                <th scope="col" title="Win% the move gives away against the engine's best move here, and its class (your moves)">
                  Loss
                </th>
              </>
            ) : null}
            <th scope="col" title="Raw games that played the move here, their share, and the effective n under recency weights">
              Games
            </th>
            <th scope="col" title="Raw wins / draws / losses">W / D / L</th>
            <th
              scope="col"
              title={`Your points per game (${scoreNote}). Whisker: 95% Wilson interval on the effective n; tall tick: Elo expectation.`}
            >
              Score
            </th>
            <th scope="col" title={`Score minus Elo expectation per 100 games, and in points over all the games (${scoreNote})`}>
              vs Elo
            </th>
            <th scope="col" title="Score in the last 90 days vs before; games in each part">Trend</th>
            <th scope="col" title="Your average time on this move">Think</th>
            <th scope="col">
              <span className="visually-hidden">Games list</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {node.edges.map((edge, index) => {
            const signal = signals[index];
            const share = node.n ? edge.n / node.n : 0;
            const { weighted: summary } = edge;
            const tag = signalLabel[signal];
            return (
              <tr
                key={edge.uci}
                className={`move-row move-row-${signal}${index === selected ? " move-row-selected" : ""}`}
                onClick={() => onFollow(edge)}
                onMouseEnter={() => onSelect(index)}
                aria-selected={index === selected}
              >
                <th scope="row" className="move-cell">
                  <div className="move-cell-main">
                    <span className={`mover-dot mover-dot-${mover}`} title={node.ownerToMove ? "Your move" : "Opponent's move"} />
                    <button
                      type="button"
                      className="move-san"
                      onClick={(event) => {
                        event.stopPropagation();
                        onFollow(edge);
                      }}
                    >
                      {moveLabel(ply, edge.san)}
                    </button>
                    {edge.engine?.status === "scored" && edge.engine.isEngineBest ? (
                      <Star className="engine-star" size={14} aria-label="The engine's best move (within 1 win%)" />
                    ) : null}
                    {tag ? <span className={`move-tag move-tag-${signal}`}>{tag}</span> : null}
                    {repertoire && node.ownerToMove ? (
                      repertoire.uci === edge.uci ? (
                        <span className="rep-mark" title="Your repertoire move here">
                          <BookmarkCheck size={14} aria-hidden="true" /> My move
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="rep-set"
                          disabled={repertoire.busy}
                          aria-label={`Set as my move: ${moveLabel(ply, edge.san)}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            repertoire.onSet(edge);
                          }}
                        >
                          <BookmarkPlus size={14} aria-hidden="true" /> Set as my move
                        </button>
                      )
                    ) : null}
                  </div>
                  <BookName edge={edge} />
                </th>
                {engine ? <EngineCells edge={edge} /> : null}
                <td>
                  <div className="freq-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(2, share * 100)}%` }} />
                  </div>
                  <span className="cell-main">
                    {formatCount(edge.n)} <span className="cell-sub">· {pct(share)}</span>
                  </span>
                  {weighted ? (
                    <span className="cell-sub" title={`Recency-weighted n ${summary.wN.toFixed(1)}; effective n ${summary.ess.toFixed(1)}`}>
                      ESS {Math.round(summary.ess)}
                    </span>
                  ) : null}
                </td>
                <td>
                  <div className="wdl-bar" aria-hidden="true">
                    <span className="wdl-win" style={{ flexGrow: edge.wins }} />
                    <span className="wdl-draw" style={{ flexGrow: edge.draws }} />
                    <span className="wdl-loss" style={{ flexGrow: edge.losses }} />
                  </div>
                  <span className="cell-sub">
                    {edge.wins} / {edge.draws} / {edge.losses}
                  </span>
                </td>
                <td
                  title={`Score ${pctOne(summary.score)} (95% CI ${pct(summary.ci[0])}–${pct(summary.ci[1])}), Elo expectation ${pctOne(summary.expected)}${
                    weighted ? `; raw ${pctOne(edge.raw.score)} over ${edge.n}` : ""
                  }`}
                >
                  <span className="cell-main">{pct(summary.score)}</span>
                  <ScoreWhisker {...summary} />
                  <span className="cell-sub">
                    {pct(summary.ci[0])}–{pct(summary.ci[1])}
                  </span>
                </td>
                <td
                  className="delta-cell"
                  title={`Score minus Elo expectation: ${formatDelta(summary.delta)} points per 100 games, ${formatPoints(summary.deltaPts)} points in total${
                    weighted ? " (weighted)" : ""
                  }; z ${summary.z === null ? "–" : summary.z.toFixed(2)} (positive z = below expectation)${
                    weighted ? `. Raw: ${formatDelta(edge.raw.delta)} per 100 games, ${formatPoints(edge.raw.deltaPts)} points` : ""
                  }`}
                >
                  <span className="cell-main">{formatDelta(summary.delta)}</span>
                  <span className="cell-sub">{formatPoints(summary.deltaPts)} pts</span>
                </td>
                <td>
                  <TrendCell edge={edge} />
                </td>
                <td>
                  {edge.thinkTime ? (
                    <span
                      className="cell-main"
                      title={`Average over ${edge.thinkTime.n} move${edge.thinkTime.n === 1 ? "" : "s"} with clock data${
                        edge.thinkTime.avgShareOfBase === null ? "" : `; ${pctOne(edge.thinkTime.avgShareOfBase)} of the base time`
                      }`}
                    >
                      {formatSeconds(edge.thinkTime.avgMs)}
                    </span>
                  ) : (
                    <span className="cell-sub">–</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-button"
                    title={`Games with ${moveLabel(ply, edge.san)}`}
                    aria-label={`Show the ${edge.n} games with ${moveLabel(ply, edge.san)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onShowGames(edge);
                    }}
                  >
                    <ListVideo size={18} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
