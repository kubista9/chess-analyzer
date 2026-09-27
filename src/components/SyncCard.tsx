import { OPENING_PLY_LIMIT, OWNER_USERNAME } from "../../shared/constants";
import { isJobActive } from "../../shared/jobPolling";
import { useNow } from "../hooks/useNow";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatAgo, formatCount, formatDay } from "../utils/formatters";

/** Home: what the game store holds for the 6-month window, and the Sync button. */
export function SyncCard() {
  const { status, statusError, syncJob, startSync } = useWorkspace();
  const now = useNow();
  const isSyncing = isJobActive(syncJob);
  const counts = status?.counts;
  const lastSyncAt = status?.lastSync?.at ?? null;
  const warnings = !isSyncing ? (status?.lastSync?.warnings ?? []) : [];

  const summary = counts
    ? [
        `${formatCount(counts.byTimeClass.blitz)} blitz / ${formatCount(counts.byTimeClass.rapid)} rapid`,
        `${formatDay(status.window.start)} – ${formatDay(status.window.end)}`,
        lastSyncAt ? `synced ${formatAgo(lastSyncAt, now)}` : "never synced"
      ].join(" · ")
    : null;

  return (
    <section className="hero sync-card" aria-label="Game sync">
      <div className="hero-copy">
        <span className="eyebrow">Chess.com · {OWNER_USERNAME}</span>
        <h1>{counts ? `${formatCount(counts.total)} games` : "Your games"}</h1>
        {summary ? <p className="sync-summary">{summary}</p> : null}
        <p>
          Standard blitz and rapid games from the last 6 months, stored locally. The Opening Report and Game
          History cover every one of them; Stockfish reviews the first {OPENING_PLY_LIMIT / 2} moves of a game you
          open.
        </p>
        {status?.stale && !isSyncing ? (
          <p className="sync-note">The last successful sync is more than a day old. Sync to pick up new games.</p>
        ) : null}
      </div>

      <div className="hero-form">
        <button className="primary-button" type="button" disabled={isSyncing} onClick={() => void startSync()}>
          {isSyncing ? "Syncing..." : "Sync"}
        </button>
        <button className="secondary-button" type="button" disabled={isSyncing} onClick={() => void startSync(true)}>
          Full re-check
        </button>
        <p className="sync-help">
          Sync checks the current and previous month. Full re-check also revalidates older months, in case
          Chess.com amended them.
        </p>

        {isSyncing && syncJob ? (
          <div className="job-panel" role="status">
            <div className="job-header">
              <span>{syncJob.message}</span>
              <span>{syncJob.progress}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${syncJob.progress}%` }} />
            </div>
          </div>
        ) : null}

        {syncJob?.status === "failed" ? (
          <div className="job-error" role="alert">
            <span className="error-text">Sync failed: {syncJob.error ?? "unknown error"}</span>
            <button className="secondary-button" type="button" onClick={() => void startSync()}>
              Retry
            </button>
          </div>
        ) : null}

        {warnings.length ? (
          <ul className="sync-warnings" aria-label="Warnings from the last sync">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        {statusError ? <div className="error-text">Could not read the game store: {statusError}</div> : null}
      </div>
    </section>
  );
}
