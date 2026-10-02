import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Color } from "../core/chess/position";
import { formatLine, moveLabel } from "../core/chess/format";
import { accuracyByChapter, attemptsPerDay, overallAccuracy, recentMistakes, reviewForecast, weakestPositions } from "../core/training/stats";
import { dueCount } from "../core/training/queue";
import { linePositionKeys } from "../core/content/tree";
import { DAY_MS } from "../core/util/time";
import { useAppData } from "../app/AppData";
import { useNow } from "../hooks/useNow";
import { DayBars } from "../components/DayBars";
import { LineStatusBadge } from "../components/LineStatusBadge";
import { PageHeader } from "../components/PageHeader";
import { PositionLabel } from "../components/PositionLabel";
import { formatAgo, pct } from "../utils/formatters";

/** Days shown in the activity chart and used for recent accuracy. */
export const ACTIVITY_DAYS = 30;
/** Days of review forecast. */
export const FORECAST_DAYS = 14;

/** Progress: accuracy, mistakes, mastery per line and the review schedule. */
export function ProgressPage() {
  const { items, positions, attempts, catalog, isEnabled, lineView } = useAppData();
  const now = useNow(60_000);
  const [side, setSide] = useState<Color>("white");
  const allItems = useMemo(() => [...items.white, ...items.black], [items]);
  const itemByKey = useMemo(() => new Map(allItems.map((item) => [item.key, item])), [allItems]);
  const tracked = useMemo(() => [...positions.values()].filter((progress) => itemByKey.has(progress.key)), [positions, itemByKey]);

  const recent = attempts.filter((attempt) => attempt.at >= now - ACTIVITY_DAYS * DAY_MS && attempt.mode !== "recall");
  const accuracy = overallAccuracy(recent);
  const due = dueCount(allItems, positions, now);
  const forecast = reviewForecast(
    tracked.map((progress) => progress.srs),
    now,
    FORECAST_DAYS
  );
  const activity = attemptsPerDay(attempts, now, ACTIVITY_DAYS);
  const chapters = accuracyByChapter(recent, catalog);
  const mistakes = recentMistakes(attempts, 12);
  const weakest = weakestPositions(tracked, 10);
  const lines = catalog.lines.filter((line) => line.side === side && isEnabled(line.id));
  const averageMastery = tracked.length === 0 ? null : tracked.reduce((sum, progress) => sum + progress.mastery, 0) / tracked.length;

  return (
    <div className="page">
      <PageHeader eyebrow="Progress" title="Progress">
        How often you find your move first time, where you go wrong, how well each line is known and when positions come back for review.
      </PageHeader>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">First-try accuracy</span>
          <span className="stat-value">{accuracy.accuracy === null ? "–" : pct(accuracy.accuracy)}</span>
          <span className="stat-note">Last {ACTIVITY_DAYS} days · {accuracy.attempts} answers</span>
        </div>
        <div className="stat">
          <span className="stat-label">Positions practised</span>
          <span className="stat-value">
            {tracked.length} / {allItems.length}
          </span>
          <span className="stat-note">In switched-on lines</span>
        </div>
        <div className="stat">
          <span className="stat-label">Average mastery</span>
          <span className="stat-value">{averageMastery === null ? "–" : pct(averageMastery)}</span>
          <span className="stat-note">Of the positions practised</span>
        </div>
        <div className="stat">
          <span className="stat-label">Due now</span>
          <span className="stat-value">{due}</span>
          <span className="stat-note">
            <Link className="text-link" to="/practice/next-move">
              Review them
            </Link>
          </span>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <DayBars title={`Review schedule, next ${FORECAST_DAYS} days`} unit="position" bars={forecast.map((entry) => ({ day: entry.day, value: entry.count }))} firstLabel="Today (with overdue)" />
        </section>
        <section className="panel">
          <DayBars
            title={`Answers per day, last ${ACTIVITY_DAYS} days`}
            unit="answer"
            bars={activity.map((entry) => ({ day: entry.day, value: entry.attempts, detail: entry.attempts > 0 ? `${entry.clean} on the first try` : undefined }))}
          />
        </section>
      </div>

      <section className="panel" aria-labelledby="chapters-title">
        <div className="panel-head">
          <h2 id="chapters-title">Accuracy by opening</h2>
          <span className="small muted">First try without a hint, last {ACTIVITY_DAYS} days</span>
        </div>
        {chapters.every((group) => group.attempts === 0) ? (
          <p className="muted">No answers in the last {ACTIVITY_DAYS} days yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Chapter</th>
                <th scope="col">Side</th>
                <th scope="col">Answers</th>
                <th scope="col">First try</th>
              </tr>
            </thead>
            <tbody>
              {chapters
                .filter((group) => group.attempts > 0)
                .map((group) => (
                  <tr key={group.id}>
                    <td>{group.label}</td>
                    <td>{group.side === "white" ? "White" : "Black"}</td>
                    <td className="tabular">{group.attempts}</td>
                    <td className="tabular">{group.accuracy === null ? "–" : pct(group.accuracy)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="mastery-title">
        <div className="panel-head">
          <h2 id="mastery-title">Mastery by line</h2>
          <div className="segmented" role="group" aria-label="Side">
            {(["white", "black"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)}>
                {value === "white" ? "White" : "Black"}
              </button>
            ))}
          </div>
        </div>
        {lines.length === 0 ? (
          <p className="muted">No {side} lines are switched on.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Status</th>
                <th scope="col">Mastery</th>
                <th scope="col">Positions seen</th>
                <th scope="col">Last practised</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const view = lineView(line.id);
                if (!view) {
                  return null;
                }
                const keys = new Set(linePositionKeys(line));
                const last = Math.max(view.progress?.lastPracticedAt ?? 0, ...tracked.filter((progress) => keys.has(progress.key)).map((progress) => progress.lastPracticedAt ?? 0));
                return (
                  <tr key={line.id}>
                    <td>
                      <Link className="text-link" to={`/repertoire/line/${encodeURIComponent(line.id)}`}>
                        {line.name}
                      </Link>
                      <span className="small muted"> · {line.chapter}</span>
                    </td>
                    <td>
                      <LineStatusBadge status={view.status} />
                    </td>
                    <td>
                      <span className="mastery-cell">
                        <span className={`meter meter-${view.status}`} aria-hidden="true">
                          <span style={{ width: `${view.mastery * 100}%` }} />
                        </span>
                        <span className="tabular small">{pct(view.mastery)}</span>
                      </span>
                    </td>
                    <td className="tabular">
                      {view.seen} / {view.total}
                    </td>
                    <td className="small muted">{last > 0 ? formatAgo(last, now) : "Never"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="progress-mistakes">
          <div className="panel-head">
            <h2 id="progress-mistakes">Recent mistakes</h2>
          </div>
          {mistakes.length === 0 ? (
            <p className="muted">No mistakes recorded.</p>
          ) : (
            <ul className="list">
              {mistakes.map((attempt) => {
                const item = attempt.posKey ? itemByKey.get(attempt.posKey) : undefined;
                const ply = item ? item.pathSans.length + 1 : null;
                const wrong = attempt.tries.filter((entry) => entry.verdict !== "book" && entry.verdict !== "alternative").map((entry) => entry.san);
                return (
                  <li key={attempt.id ?? attempt.at} className="stack-tight">
                    <span>
                      {item ? `After ${formatLine(item.pathSans) || "the start"}` : "A position no longer in your repertoire"}
                      {ply ? (
                        <>
                          : your move <span className="san">{attempt.expected.map((san) => moveLabel(ply, san)).join(" or ")}</span>
                        </>
                      ) : null}
                    </span>
                    <span className="small muted">
                      {wrong.length > 0 ? `Tried ${wrong.join(", ")}` : attempt.revealed ? "Asked for the answer" : "Used a hint"} · {formatAgo(attempt.at, now)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="progress-weakest">
          <div className="panel-head">
            <h2 id="progress-weakest">Weakest positions</h2>
          </div>
          {weakest.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul className="list">
              {weakest.map((progress) => {
                const item = itemByKey.get(progress.key);
                if (!item) {
                  return null;
                }
                const weakMove = progress.weakMoves[0];
                return (
                  <li key={progress.key} className="row-between">
                    <span className="stack-tight">
                      <PositionLabel item={item} progress={progress} />
                      {weakMove ? (
                        <span className="small muted">
                          Most common wrong move: <span className="san">{weakMove.san}</span> ({weakMove.count}×)
                        </span>
                      ) : null}
                    </span>
                    <Link className="button button-small" to={`/practice/next-move?pos=${encodeURIComponent(item.key)}`}>
                      Practise
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
