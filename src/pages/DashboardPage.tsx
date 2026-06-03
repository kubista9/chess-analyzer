import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
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
  const { snapshot } = useWorkspace();

  const topMetrics = useMemo(
    () =>
      snapshot?.metrics
        .filter((metric) => !["avg-accuracy", "avg-moves"].includes(metric.key))
        .slice(0, 6) ?? [],
    [snapshot]
  );

  return (
    <div className="page-content">
      <section className="page-header">
        <span className="eyebrow">Analysis dashboard</span>
        <h1>Dashboard</h1>
        <p>Your latest Chess.com analysis results, trends, and training signals.</p>
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
            Go to Home from the Chess Analyst logo and enter a public Chess.com username to populate the
            dashboard, history, opening report, and training pages.
          </p>
        </section>
      )}
    </div>
  );
}
