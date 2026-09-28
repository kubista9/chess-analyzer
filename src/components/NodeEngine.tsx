import { Flame } from "lucide-react";
import type { EngineCoverage, PlayerColor, TreeNodeView } from "../../shared/types";
import { formatCount, pct } from "../utils/formatters";
import { EvalText, moveLabel } from "./MoveTable";

/** "engine data for 22 of 687 games" */
export function coverageText(coverage: Pick<EngineCoverage, "complete" | "games">): string {
  return `engine data for ${formatCount(coverage.complete)} of ${formatCount(coverage.games)} games`;
}

/**
 * The Explorer's engine facts about one position: its eval and the engine's move, the owner's
 * first-mistake hotspot over his next moves, and the mean eval at move 10. Claims about games
 * are shown only with enough coverage; below it the panel says how much is known.
 */
export function NodeEngine({ node, coverage, color }: { node: TreeNodeView; coverage: EngineCoverage | null; color: PlayerColor }) {
  const engine = node.engine;
  if (!engine || !coverage) {
    return <p className="node-engine-note">No engine data: install Stockfish (npm run setup:engine) and run the engine check on Home.</p>;
  }
  const { hotspot, evalAt20 } = engine;
  const top = hotspot.top[0];
  const topMove = top ? `${moveLabel(top.ply, top.san)} (best ${moveLabel(top.ply, top.bestSan)})` : null;

  return (
    <div className="node-engine">
      <dl className="node-stats">
        <div title="Stockfish's eval of this position, from White's side (M# = mate)">
          <dt>Eval</dt>
          <dd>
            <EvalText point={engine.eval} />
          </dd>
        </div>
        {engine.bestSan ? (
          <div title={`The engine's move here${node.ownerToMove ? " (the blue arrow)" : ""}`}>
            <dt>Engine's move</dt>
            <dd>{moveLabel(node.ply + 1, engine.bestSan)}</dd>
          </div>
        ) : null}
        {evalAt20?.shown ? (
          <div title={`Your mean eval after move 10 over the ${evalAt20.known} games through here where it is known`}>
            <dt>At move 10</dt>
            <dd>
              {evalAt20.cp > 0 ? "+" : ""}
              {(evalAt20.cp / 100).toFixed(2)} <span className="cell-sub">for you</span>
            </dd>
          </div>
        ) : null}
      </dl>
      {hotspot.shown ? (
        hotspot.errors && hotspot.rate !== null ? (
          <p className="hotspot-badge" title={`${hotspot.errors} of the ${hotspot.known} games through here where your next ${hotspot.ownerMoves} moves are engine-checked`}>
            <Flame size={15} aria-hidden="true" />
            <span>
              Your first mistake comes within {hotspot.ownerMoves} moves in {pct(hotspot.rate)} of games
              {topMove ? ` · usually ${topMove}` : ""}
            </span>
          </p>
        ) : (
          <p className="node-engine-note">No mistake in your next {hotspot.ownerMoves} moves in the {formatCount(hotspot.known)} engine-checked games through here.</p>
        )
      ) : (
        <p className="node-engine-note">
          Mistake hotspots need more engine data: {formatCount(hotspot.known)} of {formatCount(engine.games)} games through here are checked for your next{" "}
          {hotspot.ownerMoves} moves.
        </p>
      )}
      <p className="node-engine-note">
        Through here: {formatCount(engine.complete)} of {formatCount(engine.games)} games fully engine-checked · overall{" "}
        {coverageText(coverage)} as {color === "white" ? "White" : "Black"}.
      </p>
    </div>
  );
}
