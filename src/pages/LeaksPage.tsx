import { useMemo } from "react";
import { OPENING_PLY_LIMIT } from "../../shared/constants";
import { fetchFixList, type RepertoireQuery } from "../api/client";
import { FilterBar } from "../components/FilterBar";
import { EmptyLeaks } from "../components/LeaksCard";
import { FixCard, explainedLinesOf, scopeText } from "../components/FixCard";
import { useFilters } from "../hooks/useFilters";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatCount } from "../utils/formatters";
import { isLeak } from "../components/FixCard";
import "../styles/leaks.css";

/** /leaks: the whole fix list, the watch list, and how the list is made. */
export function LeaksPage() {
  const [filters, setFilters] = useFilters();
  const { dataVersion } = useWorkspace();
  const query = useMemo<RepertoireQuery>(
    () => ({ window: filters.window, timeClass: filters.timeClass ?? undefined, weighted: filters.weighted }),
    [filters.window, filters.timeClass, filters.weighted]
  );
  const { data, error, loading } = useStoreQuery((signal) => fetchFixList(query, signal), [query, dataVersion]);
  const weighted = Boolean(data?.halfLifeDays);
  const all = data ? [...data.items.filter(isLeak), ...data.watch] : [];

  return (
    <div className="page-content leaks-page">
      <section className="page-header">
        <div>
          <span className="eyebrow">Fix list · results only</span>
          <h1>Leaks</h1>
          <p>
            Your own moves in the first {OPENING_PLY_LIMIT / 2} moves that score below your Elo expectation by more than
            chance explains. The engine is not involved yet, so a leak says where you lose points, not why.
          </p>
        </div>
      </section>

      <FilterBar filters={filters} onFiltersChange={setFilters} />
      {data ? <p className="explorer-scope">{scopeText(filters, data.halfLifeDays)}</p> : null}

      <section className={`panel home-card${loading && data ? " is-stale" : ""}`} aria-label="Leaks" aria-busy={loading}>
        <div className="home-card-head">
          <h2>{data ? `${data.items.length} leak${data.items.length === 1 ? "" : "s"}` : "Leaks"}</h2>
        </div>
        {error ? (
          <p className="error-text">Could not load the fix list: {error}</p>
        ) : !data ? (
          <p className="home-empty">Loading…</p>
        ) : data.items.length ? (
          <div className="fix-list">
            {data.items.filter(isLeak).map((item, index) => (
              <FixCard key={item.id} item={item} rank={index + 1} weighted={weighted} explainedLines={explainedLinesOf(item, all)} />
            ))}
          </div>
        ) : (
          <EmptyLeaks data={data} />
        )}
      </section>

      {data?.watch.length ? (
        <section className="panel home-card" aria-label="Worth watching">
          <div className="home-card-head">
            <div>
              <span className="eyebrow">Could be noise</span>
              <h2>Worth watching</h2>
            </div>
          </div>
          <p className="home-card-foot">
            Each of these is below expectation on its own (z ≥ {data.thresholds.minZ}), but not once the{" "}
            {formatCount(data.tested)} lines tested are taken into account. On coin-flip results about as many lines land here
            by chance, so treat them as hunches to keep an eye on, not as leaks.
          </p>
          <div className="fix-list">
            {data.watch.map((item) => (
              <FixCard key={item.id} item={item} weighted={weighted} explainedLines={explainedLinesOf(item, all)} />
            ))}
          </div>
        </section>
      ) : null}

      {data ? (
        <section className="panel home-card" aria-label="How the list is made">
          <h2>How the list is made</h2>
          <ul className="method-list">
            <li>
              Every move you played at least {data.thresholds.minN} times (effective n ≥ {data.thresholds.minEss} under the recency
              weights) is tested, as White and as Black: {formatCount(data.tested)} moves in these filters.
            </li>
            <li>
              A move is a leak when its score is below your Elo expectation with z ≥ {data.thresholds.minZ} and it survives a
              Benjamini-Hochberg false-discovery control at q = {data.thresholds.fdrQ} across all of them. Without that control,
              about as many lines get flagged on random results as on your real games.
            </li>
            <li>
              Blame goes to the deepest move: a game counted for a listed move no longer counts for the moves before it, so a
              line and its continuation are never listed for the same lost points. A shorter line is still listed when what is
              left loses at least {data.thresholds.minPoints} point.
            </li>
            <li>
              The ranking is the recency-weighted points lost against expectation. "Lost by move {data.thresholds.earlyLossPly / 2}"
              counts losses that ended within {data.thresholds.earlyLossPly} half-moves.
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}
