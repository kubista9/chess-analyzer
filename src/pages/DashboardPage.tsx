import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Target } from "lucide-react";
import { useAppData } from "../app/AppData";
import { formatLine, moveLabel } from "../core/chess/format";
import { accuracyByChapter, overallAccuracy, practiceStreak, recentMistakes, weakestPositions } from "../core/training/stats";
import { dueCount, dueLines, newIntroducedToday, nextDueAt, remainingNewToday } from "../core/training/queue";
import { DAY_MS } from "../core/util/time";
import { formatAgo, pct } from "../utils/formatters";
import { useNow } from "../hooks/useNow";
import { PageHeader } from "../components/PageHeader";
import { PositionLabel } from "../components/PositionLabel";

/** How far back "recent" accuracy looks. */
export const RECENT_DAYS = 30;

/** Home: what is due, how practice is going, and the positions that need work. */
export function DashboardPage() {
  const { items, positions, attempts, practiceDays, catalog, isEnabled, lineProgress, settings, lineView } = useAppData();
  const now = useNow(60_000);
  const allItems = useMemo(() => [...items.white, ...items.black], [items]);
  const itemByKey = useMemo(() => new Map(allItems.map((item) => [item.key, item])), [allItems]);

  const due = dueCount(allItems, positions, now);
  const unseen = allItems.filter((item) => !positions.has(item.key)).length;
  const fresh = Math.min(unseen, remainingNewToday(settings.practice.newPerDay, newIntroducedToday(positions.values(), now)));
  const enabledLines = catalog.lines.filter((line) => isEnabled(line.id));
  const linesDue = dueLines(enabledLines, lineProgress, now);
  const streak = practiceStreak(practiceDays, now);
  const recent = attempts.filter((attempt) => attempt.at >= now - RECENT_DAYS * DAY_MS && attempt.mode !== "recall");
  const accuracy = overallAccuracy(recent);
  const learned = allItems.filter((item) => (positions.get(item.key)?.srs.box ?? 0) > 0).length;
  const mastered = enabledLines.filter((line) => lineView(line.id)?.status === "mastered").length;
  const weak = weakestPositions(
    [...positions.values()].filter((progress) => itemByKey.has(progress.key)),
    5
  );
  const mistakes = recentMistakes(attempts, 5);
  const chapters = accuracyByChapter(recent, catalog).filter((group) => group.attempts > 0);
  const upcoming = nextDueAt([...positions.values()].filter((progress) => itemByKey.has(progress.key)).map((progress) => progress.srs));
  const firstRun = attempts.length === 0;

  return (
    <div className="page">
      <PageHeader eyebrow="Home" title="Today">
        {firstRun
          ? "Your White English Opening and your Black defences, one position at a time. Start with the main lines; the trainer schedules each position again just before you would forget it."
          : "What is due, how your practice is going, and the positions that need work."}
      </PageHeader>

      <section className="panel today" aria-labelledby="today-title">
        <div className="today-main">
          <span className="eyebrow">Due now</span>
          <h2 id="today-title" className="today-count tabular">
            {due > 0 ? `${due} position${due === 1 ? "" : "s"}` : "Nothing due"}
          </h2>
          <p className="muted">
            {[
              fresh > 0 ? `${fresh} new position${fresh === 1 ? "" : "s"} to learn today` : unseen > 0 ? "Today's new positions are done" : "Every position has been introduced",
              linesDue.length > 0 ? `${linesDue.length} line${linesDue.length === 1 ? "" : "s"} due for a run` : null,
              due === 0 && upcoming ? `next review ${formatUpcoming(upcoming, now)}` : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="today-actions">
          <Link className="button button-primary button-large" to="/practice/next-move">
            <Target size={18} aria-hidden="true" />
            Start practice
          </Link>
          {linesDue.length > 0 ? (
            <Link className="button" to={`/practice/play-line?line=${encodeURIComponent(linesDue[0].id)}`}>
              Play {linesDue[0].name}
            </Link>
          ) : (
            <Link className="button" to="/practice">
              Other practice modes
            </Link>
          )}
        </div>
      </section>

      <div className="stats" aria-label="Your progress">
        <div className="stat">
          <span className="stat-label">Practice streak</span>
          <span className="stat-value">{streak.current === 0 ? "–" : `${streak.current} day${streak.current === 1 ? "" : "s"}`}</span>
          <span className="stat-note">{streak.practisedToday ? "Practised today" : streak.current > 0 ? "Not yet today" : "Practise on consecutive days to build one"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">First-try accuracy</span>
          <span className="stat-value">{accuracy.accuracy === null ? "–" : pct(accuracy.accuracy)}</span>
          <span className="stat-note">
            {accuracy.attempts === 0 ? `No answers in the last ${RECENT_DAYS} days` : `${accuracy.attempts} answers, last ${RECENT_DAYS} days`}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Positions learned</span>
          <span className="stat-value tabular">
            {learned} / {allItems.length}
          </span>
          <span className="stat-note">In the lines you have switched on</span>
        </div>
        <div className="stat">
          <span className="stat-label">Lines mastered</span>
          <span className="stat-value tabular">
            {mastered} / {enabledLines.length}
          </span>
          <span className="stat-note">
            <Link className="text-link" to="/repertoire">
              See the repertoire
            </Link>
          </span>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel" aria-labelledby="weak-title">
          <div className="panel-head">
            <h2 id="weak-title">Weakest positions</h2>
            <Link className="text-link small" to="/progress">
              All progress
            </Link>
          </div>
          {weak.length === 0 ? (
            <p className="muted">Positions you miss or need hints for will show up here.</p>
          ) : (
            <ul className="list">
              {weak.map((progress) => {
                const item = itemByKey.get(progress.key);
                if (!item) {
                  return null;
                }
                return (
                  <li key={progress.key} className="row-between">
                    <PositionLabel item={item} progress={progress} />
                    <Link className="button button-small" to={`/practice/next-move?pos=${encodeURIComponent(item.key)}`} aria-label={`Practise the position ${formatLine(item.pathSans)}`}>
                      Practise
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="mistakes-title">
          <div className="panel-head">
            <h2 id="mistakes-title">Recent mistakes</h2>
          </div>
          {mistakes.length === 0 ? (
            <p className="muted">{firstRun ? "Nothing yet. Your first session starts with the main lines." : "No recent mistakes."}</p>
          ) : (
            <ul className="list">
              {mistakes.map((attempt) => {
                const item = attempt.posKey ? itemByKey.get(attempt.posKey) : undefined;
                const wrong = attempt.tries.find((entry) => entry.verdict !== "book" && entry.verdict !== "alternative");
                const ply = item ? item.pathSans.length + 1 : null;
                return (
                  <li key={attempt.id ?? attempt.at} className="row-between">
                    <span className="stack-tight">
                      <span>
                        {wrong && ply ? (
                          <>
                            You played <span className="san">{moveLabel(ply, wrong.san)}</span>; your move is{" "}
                            <span className="san">{attempt.expected.map((san) => moveLabel(ply, san)).join(" or ")}</span>
                          </>
                        ) : attempt.revealed ? (
                          <>Needed the answer{ply ? <> (<span className="san">{attempt.expected.map((san) => moveLabel(ply, san)).join(" or ")}</span>)</> : null}</>
                        ) : (
                          <>Needed a hint{ply ? <> (<span className="san">{attempt.expected.map((san) => moveLabel(ply, san)).join(" or ")}</span>)</> : null}</>
                        )}
                      </span>
                      <span className="small muted">
                        {item ? `after ${formatLine(item.pathSans) || "the start"}` : "a position no longer in your repertoire"} · {formatAgo(attempt.at, now)}
                      </span>
                    </span>
                    {item ? (
                      <Link className="button button-small" to={`/practice/next-move?pos=${encodeURIComponent(item.key)}`}>
                        Practise
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="openings-title">
        <div className="panel-head">
          <h2 id="openings-title">Accuracy by opening</h2>
          <Link className="text-link small" to="/progress">
            Details
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        {chapters.length === 0 ? (
          <p className="muted">Once you have practised, each chapter of your repertoire shows how often you find the move on the first try.</p>
        ) : (
          <ul className="list">
            {chapters.slice(0, 6).map((group) => (
              <li key={group.id} className="accuracy-row">
                <span className="accuracy-name">
                  {group.label}
                  <span className="small muted"> · {group.side === "white" ? "White" : "Black"}</span>
                </span>
                <span className="meter" aria-hidden="true">
                  <span style={{ width: `${(group.accuracy ?? 0) * 100}%` }} />
                </span>
                <span className="tabular small">
                  {group.accuracy === null ? "–" : pct(group.accuracy)} of {group.attempts}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatUpcoming(at: number, now: number): string {
  const hours = Math.round((at - now) / 3_600_000);
  if (hours < 1) {
    return "within the hour";
  }
  if (hours < 24) {
    return `in ${hours} h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
