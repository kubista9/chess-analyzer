import { useCallback, useState, type FormEvent } from "react";
import {
  BULK_ANALYSIS_LIMITS,
  DEFAULT_BULK_ANALYSIS_LIMIT,
  type BulkAnalysisLimit
} from "../../shared/constants";
import type { DashboardSnapshot, JobState } from "../../shared/types";
import { startBulkAnalysis } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useWorkspace } from "../hooks/useWorkspace";

function isBulkAnalysisLimit(value: number | undefined): value is BulkAnalysisLimit {
  return BULK_ANALYSIS_LIMITS.includes(value as BulkAnalysisLimit);
}

export function AnalysisLauncher() {
  const { snapshot, setSnapshot, bulkJob, setBulkJob } = useWorkspace();
  const [username, setUsername] = useState(snapshot?.username ?? "");
  const [limit, setLimit] = useState<BulkAnalysisLimit>(
    isBulkAnalysisLimit(snapshot?.limit) ? snapshot.limit : DEFAULT_BULK_ANALYSIS_LIMIT
  );
  const [error, setError] = useState<string | null>(null);

  const handleJobUpdate = useCallback(
    (job: JobState<DashboardSnapshot>) => {
      setBulkJob(job);
      if (job?.status === "completed" && job.result) {
        setSnapshot(job.result);
      }
    },
    [setBulkJob, setSnapshot]
  );

  useJobPolling(bulkJob, handleJobUpdate);

  const isLoading = bulkJob?.status === "queued" || bulkJob?.status === "running";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      const job = await startBulkAnalysis(username, limit);
      setBulkJob(job);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not start analysis.");
    }
  };

  return (
    <section className="hero">
      <div className="hero-copy">
        <h1>Run a local review pipeline for 1, 5, 10, or 25 recent games.</h1>
      </div>

      <form className="hero-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Chess.com username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. hikaru"
            required
          />
        </label>

        <label className="field">
          <span>Games to analyze</span>
          <div className="limit-toggle">
            {BULK_ANALYSIS_LIMITS.map((option) => (
              <button
                key={option}
                type="button"
                className={`limit-chip${limit === option ? " limit-chip-active" : ""}`}
                onClick={() => setLimit(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </label>

        <button className="primary-button" type="submit" disabled={isLoading}>
          {isLoading ? "Running bulk analysis..." : "Start Deep Analysis"}
        </button>

        {bulkJob ? (
          <div className="job-panel">
            <div className="job-header">
              <span>{bulkJob.message}</span>
              <span>{bulkJob.progress}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${bulkJob.progress}%` }} />
            </div>
          </div>
        ) : null}

        {error ? <div className="error-text">{error}</div> : null}
      </form>
    </section>
  );
}
