import { Link } from "react-router-dom";
import type { FixListResponse } from "../../shared/types";
import { formatCount } from "../utils/formatters";
import { isLeak } from "./FixCard";
import { FixCard, explainedLinesOf } from "./FixCard";

/** Home shows this many leaks; /leaks shows them all. */
export const HOME_LEAKS = 3;

/** Why a fix list is empty, in words (no games, too few games per line, or nothing above noise). */
export function EmptyLeaks({ data }: { data: FixListResponse }) {
  const games = data.games.white + data.games.black;
  if (!games) {
    return <p className="home-empty">No games in these filters yet. Sync above to import your games.</p>;
  }
  if (!data.tested) {
    return (
      <p className="home-empty">
        Not enough games yet: a move needs {data.thresholds.minN} games (and an effective {data.thresholds.minEss}) before it is
        tested, and none of your {formatCount(games)} games in these filters gets there. Try the 6-month window.
      </p>
    );
  }
  return (
    <p className="home-empty">
      No leak stands out from noise: {formatCount(data.tested)} of your moves with {data.thresholds.minN}+ games were
      tested, and none scores clearly below your Elo expectation once the number of lines tested is taken into account.
      {data.watch.length ? ` ${data.watch.length} line${data.watch.length === 1 ? " is" : "s are"} worth watching.` : ""}
    </p>
  );
}

/** Home: the top leaks from the results-only fix list, with a link to the full list. */
export function LeaksCard({ data, error }: { data: FixListResponse | null; error: string | null }) {
  const weighted = Boolean(data?.halfLifeDays);
  const top = data?.items.filter(isLeak).slice(0, HOME_LEAKS) ?? [];
  const more = data ? data.items.length - top.length : 0;

  return (
    <section className="panel home-card" aria-label="Biggest leaks">
      <div className="home-card-head">
        <div>
          <span className="eyebrow">Results only · no engine yet</span>
          <h2>Biggest leaks</h2>
        </div>
        {data ? (
          <Link className="text-link" to="/leaks">
            {more > 0 ? `All ${data.items.length} leaks` : "Full list"}
            {data.watch.length ? ` + ${data.watch.length} to watch` : ""} →
          </Link>
        ) : null}
      </div>
      {error ? (
        <p className="error-text">Could not load the fix list: {error}</p>
      ) : !data ? (
        <p className="home-empty">Loading…</p>
      ) : top.length ? (
        <div className="fix-list">
          {top.map((item, index) => (
            <FixCard key={item.id} item={item} rank={index + 1} weighted={weighted} explainedLines={explainedLinesOf(item, data.items.filter(isLeak))} />
          ))}
        </div>
      ) : (
        <EmptyLeaks data={data} />
      )}
      {data && top.length ? (
        <p className="home-card-foot">
          Your moves that score below your Elo expectation by more than noise, ranked by the points they cost. Each game's
          loss is counted once, at the deepest listed move.
        </p>
      ) : null}
    </section>
  );
}
