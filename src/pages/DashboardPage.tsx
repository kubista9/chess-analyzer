import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { BULK_ANALYSIS_LIMITS } from "../../shared/constants";
import type { DashboardSnapshot, JobState } from "../../shared/types";
import { startBulkAnalysis } from "../api/client";
import { useJobPolling } from "../hooks/useJobPolling";
import { useWorkspace } from "../hooks/useWorkspace";

const metricExplainers = [
  "Win rate tells you whether your current decisions are actually turning into points.",
  "Accuracy tracks how often your moves stay close to engine-approved play.",
  "Blunders per game are the fastest rating leak to fix.",
  "Mistakes and misses reveal quieter decision-quality issues before the position collapses.",
  "First major error move shows whether your trouble starts in the opening or later phases.",
  "White and black win rates expose repertoire imbalance.",
  "Average game length helps separate opening crashes from conversion problems.",
  "Opening, middlegame, and endgame accuracy reveal which phase deserves study time.",
  "Opening-family performance helps you choose what to keep, trim, or rebuild.",
  "Win-probability swings highlight emotional or tactical volatility.",
  "Opponent rating context keeps the numbers honest.",
  "Critical moments per game show how often the game hinges on one decision."
];

export function DashboardPage() {
  const { snapshot, setSnapshot, bulkJob, setBulkJob } = useWorkspace();
  const [username, setUsername] = useState(snapshot?.username ?? "");
  const [limit, setLimit] = useState<50 | 100 | 150>((snapshot?.limit as 50 | 100 | 150 | undefined) ?? 50);
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

  const topMetrics = useMemo(() => snapshot?.metrics.slice(0, 6) ?? [], [snapshot]);

  return (
    <div className="page-content">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Public Chess.com analytics</span>
          <h1>Run a local review pipeline for your last 50, 100, or 150 games.</h1>
          <p>
            This app fetches your public Chess.com archive, scans your games with Stockfish, and turns
            them into win-rate trends, opening diagnostics, and a personalized training plan.
          </p>
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

      {snapshot ? (
        <>
          <section className="section-grid">
            {topMetrics.map((metric) => (
              <article className={`stat-card tone-${metric.tone ?? "neutral"}`} key={metric.key}>
                <div className="stat-label">{metric.label}</div>
                <div className="stat-value">{metric.value}</div>
                <p className="stat-helper">{metric.helper}</p>
              </article>
            ))}
          </section>

          <section className="dual-grid">
            <article className="panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">Recent trend</span>
                  <h2>Accuracy and result rhythm</h2>
                </div>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={snapshot.trends}>
                    <defs>
                      <linearGradient id="accuracyGradient" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="5%" stopColor="#7ee37f" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#7ee37f" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis dataKey="label" stroke="#9ca7b8" />
                    <YAxis stroke="#9ca7b8" />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="accuracy"
                      stroke="#7ee37f"
                      fill="url(#accuracyGradient)"
                      strokeWidth={2.5}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="panel">
              <span className="eyebrow">What matters most</span>
              <h2>Improvement metrics to watch</h2>
              <div className="list-panel">
                {metricExplainers.map((item) => (
                  <div className="list-row" key={item}>
                    {item}
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="dual-grid">
            <article className="panel">
              <span className="eyebrow">Snapshot highlights</span>
              <h2>What the analysis is already telling you</h2>
              <div className="list-panel">
                {snapshot.highlights.map((highlight) => (
                  <div className="list-row" key={highlight}>
                    {highlight}
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <span className="eyebrow">Training direction</span>
              <h2>{snapshot.trainingPlan.headline}</h2>
              <p className="panel-summary">{snapshot.trainingPlan.summary}</p>
              <div className="focus-list">
                {snapshot.trainingPlan.focusAreas.slice(0, 2).map((area) => (
                  <div className="focus-card" key={area.title}>
                    <h3>{area.title}</h3>
                    <p>{area.reason}</p>
                    <div className="focus-target">{area.targetMetric}</div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      ) : (
        <section className="panel empty-panel">
          <span className="eyebrow">Ready when you are</span>
          <h2>No analysis loaded yet</h2>
          <p>
            Enter a public Chess.com username above to populate the dashboard, history, opening report,
            and training pages.
          </p>
        </section>
      )}
    </div>
  );
}
