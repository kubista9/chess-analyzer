import { useWorkspace } from "../hooks/useWorkspace";

export function OpeningReportPage() {
  const { snapshot } = useWorkspace();

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <span className="eyebrow">Opening diagnostics</span>
          <h1>Opening Report</h1>
          <p>Use frequency plus quality together so you only spend study time where it actually pays back.</p>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No opening report yet</h2>
          <p>Run a bulk analysis and this page will group your openings by frequency, quality, and repair priority.</p>
        </section>
      ) : (
        <section className="panel">
          <div className="list-panel">
            {snapshot.topOpenings.map((opening) => (
              <article className="opening-card" key={opening.openingFamily}>
                <div className="opening-card-header">
                  <div>
                    <h2>{opening.openingFamily}</h2>
                    <p>{opening.games} games in sample</p>
                  </div>
                  <div className="opening-pill">{opening.winRate.toFixed(0)}% win rate</div>
                </div>

                <div className="opening-stats">
                  <div>
                    <span>Avg accuracy</span>
                    <strong>{opening.avgAccuracy?.toFixed(1) ?? "—"}%</strong>
                  </div>
                  <div>
                    <span>Avg blunders</span>
                    <strong>{opening.avgBlunders.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span>First major error</span>
                    <strong>{opening.avgFirstErrorPly?.toFixed(0) ?? "—"} ply</strong>
                  </div>
                </div>

                <p className="opening-recommendation">{opening.recommendation}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
