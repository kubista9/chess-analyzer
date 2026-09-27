import { useCallback, useState, type FormEvent } from "react";
import {
  BULK_ANALYSIS_LIMITS,
  DEFAULT_BULK_ANALYSIS_LIMIT,
  OPENING_PLY_LIMIT,
  OWNER_USERNAME,
  type BulkAnalysisLimit
} from "../../shared/constants";
import type { OpeningsSnapshot, JobState } from "../../shared/types";
import { startBulkAnalysis } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useWorkspace } from "../hooks/useWorkspace";

function isBulkAnalysisLimit(value: number | undefined): value is BulkAnalysisLimit {
  return BULK_ANALYSIS_LIMITS.includes(value as BulkAnalysisLimit);
}

export function AnalysisLauncher() {
  const { snapshot, setSnapshot, bulkJob, setBulkJob } = useWorkspace();
  const [limit, setLimit] = useState<BulkAnalysisLimit>(
    isBulkAnalysisLimit(snapshot?.limit) ? snapshot.limit : DEFAULT_BULK_ANALYSIS_LIMIT
  );
  const [error, setError] = useState<string | null>(null);

  const handleJobUpdate = useCallback(
    (job: JobState<OpeningsSnapshot>) => {
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
      const job = await startBulkAnalysis(limit);
      setBulkJob(job);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not load games.");
    }
  };

  return (
    <section className="hero">
      <div className="hero-copy">
        <h1>Load your 1, 5, 10, or 25 most recent games.</h1>
        <p>
          Chess.com player: {OWNER_USERNAME}. Results only, no engine: the Opening Report shows W/D/L and
          score per colour. Stockfish reviews the first {OPENING_PLY_LIMIT / 2} moves of a game you open.
        </p>
      </div>

      <form className="hero-form" onSubmit={handleSubmit}>

        <label className="field">
          <span>Games to load</span>
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
          {isLoading ? "Loading games..." : "Load games"}
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
