import { Link } from "react-router-dom";
import type { RepertoireCoverageResponse } from "../../shared/types";
import { pct } from "../utils/formatters";

/** Home's repertoire line: the share of games still in the repertoire through move 4 and 6, per colour. */
export function CoverageLine({ data, error }: { data: RepertoireCoverageResponse | null; error: string | null }) {
  if (error || !data) {
    return null;
  }
  if (!data.white.entries && !data.black.entries) {
    return (
      <p className="panel home-coverage">
        No repertoire yet. <Link to="/repertoire">Seed it from your games</Link> to see how long your games follow it.
      </p>
    );
  }
  const rate = (value: number | null | undefined) => (value === null || value === undefined ? "–" : pct(value));
  const plies = data.white.coverage.map((stat) => stat.ply);
  return (
    <p className="panel home-coverage">
      <strong>Repertoire:</strong>{" "}
      {plies.map((ply, index) => (
        <span key={ply}>
          {index ? " · " : ""}stayed in it through move {ply / 2}: <strong>{rate(data.white.coverage[index]?.rate)}</strong> (W) /{" "}
          <strong>{rate(data.black.coverage[index]?.rate)}</strong> (B)
        </span>
      ))}
      {data.white.needsReview + data.black.needsReview ? ` · ${data.white.needsReview + data.black.needsReview} moves to review` : ""} ·{" "}
      <Link to="/repertoire">Open the repertoire</Link>
    </p>
  );
}
