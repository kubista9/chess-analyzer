import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { OPENING_PLY_LIMIT } from "../../shared/constants";
import type { PlayerColor } from "../../shared/types";
import type { TreeQuery } from "../api/client";
import { AlternativesPanel } from "../components/AlternativesPanel";
import { useFilters } from "../hooks/useFilters";
import "../styles/explorer.css";
import "../styles/repertoire.css";
import "../styles/review.css";
import "../styles/alternatives.css";

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** /alternatives?color=&moves=&uci=: the alternatives panel for one of the owner's positions. */
export function AlternativesPage() {
  const [searchParams] = useSearchParams();
  const color: PlayerColor = searchParams.get("color") === "black" ? "black" : "white";
  const rawMoves = searchParams.get("moves") ?? "";
  const moves = useMemo(() => rawMoves.split(",").filter((uci) => UCI.test(uci)).slice(0, OPENING_PLY_LIMIT), [rawMoves]);
  const rawUci = searchParams.get("uci");
  const uci = rawUci && UCI.test(rawUci) ? rawUci : null;
  const [filters] = useFilters();
  const tree = useMemo<TreeQuery>(
    () => ({ color, window: filters.window, timeClass: filters.timeClass ?? undefined, weighted: filters.weighted }),
    [color, filters.window, filters.timeClass, filters.weighted]
  );

  return (
    <div className="page-content alternatives-page">
      <section className="page-header">
        <div>
          <span className="eyebrow">What else to play</span>
          <h1>Alternatives</h1>
          <p>
            Engine-sound moves for this position, ranked by how well they fit your games: moves you already play, named lines,
            familiar pawn structures and quiet lines first. Everything is computed offline from your games, the opening book and
            Stockfish.
          </p>
        </div>
      </section>
      <p className="explorer-scope">
        {[
          color === "white" ? "As White" : "As Black",
          filters.window === "3m" ? "last 3 months" : "last 6 months",
          filters.timeClass ?? "blitz + rapid",
          filters.weighted ? "recent games count more" : "unweighted"
        ].join(" · ")}
      </p>
      <AlternativesPanel color={color} moves={moves} uci={uci} tree={tree} />
    </div>
  );
}
