import { useMemo } from "react";
import { fetchFixList, fetchRepertoireCoverage, fetchSnapshot, type RepertoireQuery } from "../api/client";
import { CoverageLine } from "../components/CoverageLine";
import { scopeText } from "../components/FixCard";
import { EngineCard } from "../components/EngineCard";
import { LeaksCard } from "../components/LeaksCard";
import { RepertoireCard } from "../components/RepertoireCard";
import { SyncCard } from "../components/SyncCard";
import { useFilters } from "../hooks/useFilters";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import "../styles/leaks.css";

export function HomePage() {
  // The Explorer's filters (window, time class, weighting), so the numbers match it.
  const [filters] = useFilters();
  const { dataVersion } = useWorkspace();
  const query = useMemo<RepertoireQuery>(
    () => ({ window: filters.window, timeClass: filters.timeClass ?? undefined, weighted: filters.weighted }),
    [filters.window, filters.timeClass, filters.weighted]
  );
  const fixList = useStoreQuery((signal) => fetchFixList(query, signal), [query, dataVersion]);
  const snapshot = useStoreQuery((signal) => fetchSnapshot(query, signal), [query, dataVersion]);
  const coverage = useStoreQuery((signal) => fetchRepertoireCoverage(query, signal), [query, dataVersion]);
  const leakIds = useMemo(() => new Set(fixList.data?.items.map((item) => item.id) ?? []), [fixList.data]);
  const halfLife = fixList.data?.halfLifeDays ?? snapshot.data?.halfLifeDays;

  return (
    <div className="page-content">
      <SyncCard />
      <EngineCard />
      {fixList.data || snapshot.data ? (
        <p className="explorer-scope home-scope">
          {scopeText(filters, halfLife)} · the Explorer's filters
        </p>
      ) : null}
      <LeaksCard data={fixList.data} error={fixList.error} />
      <CoverageLine data={coverage.data} error={coverage.error} />
      <RepertoireCard data={snapshot.data} error={snapshot.error} leakIds={leakIds} />
    </div>
  );
}
