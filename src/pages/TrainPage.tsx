import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import type { DrillFilter, DrillSessionResponse, DrillStats, SessionItem } from "../../shared/training/api";
import type { DrillKind } from "../../shared/training/scheduler";
import type { JobState } from "../../shared/types";
import { fetchDrillSession, fetchDrillStats, type DrillFocus } from "../api/client";
import { DRILL_KIND_UI, DrillBadge, LineDrill, MistakeDrill, type DrillOutcome } from "../components/DrillCard";
import { useJobPolling } from "../hooks/useJobPolling";
import { useStoreQuery } from "../hooks/useStoreQuery";
import { useWorkspace } from "../hooks/useWorkspace";
import { dueText } from "../components/TrainCard";
import "../styles/review.css";
import "../styles/trainer.css";

const TABS: { key: DrillFilter; param: string; label: string }[] = [
  { key: "all", param: "all", label: "All" },
  { key: "repertoire-line", param: "lines", label: "Repertoire lines" },
  { key: "own-mistake", param: "games", label: "From my games" }
];

/** A wrong position from your games comes back this many items later in the session. */
const REQUEUE_AFTER = 3;

function useBoardWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const measure = () => {
      const column = ref.current?.getBoundingClientRect().width ?? 0;
      const wide = window.innerWidth >= 900;
      const byWidth = wide ? column * 0.58 : column - 34; // the card's padding and border
      const byHeight = window.innerHeight - (wide ? 230 : 280);
      setWidth(Math.round(Math.max(160, Math.min(560, byWidth, Math.max(260, byHeight)))));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (ref.current) {
      observer?.observe(ref.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return width;
}

interface Session {
  queue: SessionItem[];
  index: number;
  outcomes: DrillOutcome[];
  tries: Map<string, number>;
  job: JobState<DrillStats> | null;
  focusNote: string | null;
}

export function TrainPage() {
  const [params, setParams] = useSearchParams();
  const { dataVersion } = useWorkspace();
  const tab = TABS.find((candidate) => candidate.param === params.get("kind")) ?? TABS[0];
  const focus = useMemo<DrillFocus | null>(() => {
    const id = params.get("focus");
    const color = params.get("color");
    const moves = params.get("moves");
    if (id) {
      return { id };
    }
    if ((color === "white" || color === "black") && moves !== null) {
      return { color, moves: moves ? moves.split(",") : [] };
    }
    return null;
  }, [params]);
  const [statsVersion, setStatsVersion] = useState(0);
  const stats = useStoreQuery((signal) => fetchDrillStats(signal), [dataVersion, statsVersion]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<JobState<DrillStats> | null>(null);
  const [finished, setFinished] = useState<Session | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const width = useBoardWidth(columnRef);

  const start = useCallback(
    async (kind: DrillFilter, withFocus: DrillFocus | null) => {
      setLoading(true);
      setError(null);
      setFinished(null);
      try {
        const response: DrillSessionResponse = await fetchDrillSession(kind, withFocus);
        const active = response.job && (response.job.status === "queued" || response.job.status === "running") ? response.job : null;
        if (!response.items.length && active) {
          // Today's new positions are still being checked: wait for the job, then start.
          setChecking(active);
          setSession(null);
          return;
        }
        setChecking(null);
        setSession({ queue: response.items, index: 0, outcomes: [], tries: new Map(), job: active, focusNote: response.focusNote });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The session could not be loaded.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // A Train link with a focus (a fix card's "Drill this") starts at once.
  const focusKey = focus ? JSON.stringify(focus) : null;
  useEffect(() => {
    if (focusKey) {
      void start(tab.key, JSON.parse(focusKey) as DrillFocus);
    }
  }, [focusKey, start, tab.key]);

  useJobPolling(checking, (job) => {
    if (job.status === "completed" || job.status === "failed") {
      setChecking(null);
      setStatsVersion((version) => version + 1);
      void start(tab.key, focus);
    } else {
      setChecking(job);
    }
  });

  const end = useCallback((current: Session) => {
    setFinished(current);
    setSession(null);
    setStatsVersion((version) => version + 1);
  }, []);

  const next = (outcomes: DrillOutcome[], requeue: SessionItem | null) => {
    if (!session) {
      return;
    }
    const queue = [...session.queue];
    const tries = new Map(session.tries);
    for (const outcome of outcomes) {
      tries.set(outcome.cardId, (tries.get(outcome.cardId) ?? 0) + 1);
    }
    if (requeue) {
      queue.splice(Math.min(queue.length, session.index + 1 + REQUEUE_AFTER), 0, { ...requeue, key: `${requeue.key}#again${tries.get(outcomes[0]?.cardId) ?? 1}` });
    }
    const updated: Session = { ...session, queue, tries, index: session.index + 1, outcomes: [...session.outcomes, ...outcomes] };
    if (updated.index >= queue.length) {
      end(updated);
    } else {
      setSession(updated);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (event.key === "Escape" && session) {
        end(session);
      } else if (event.key === "Enter" && !session && !loading && !checking && target?.tagName !== "BUTTON" && target?.tagName !== "A") {
        void start(tab.key, focus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, loading, checking, start, end, tab.key, focus]);

  const data = stats.data;
  const current = session?.queue[session.index] ?? null;
  const currentKey = current?.key ?? null;
  useEffect(() => {
    if (currentKey) {
      columnRef.current?.scrollIntoView({ block: "start" });
    }
  }, [currentKey]);
  const noRepertoire = data !== null && data.repertoireEntries === 0;
  const noMistakes = data !== null && (!data.engine || (data.analysedGames === 0 && data.total["own-mistake"] === 0 && data.unchecked === 0));
  const dueHere =
    data === null ? 0 : tab.key === "all" ? data.due["repertoire-line"] + data.due["own-mistake"] : data.due[tab.key];

  return (
    <div className="page-content train-page">
      <section className="page-header">
        <div>
          <span className="eyebrow">Spaced repetition</span>
          <h1>Train</h1>
          <p>
            Two kinds of drill. <strong className="train-kind-line">Your repertoire line</strong> plays your lines from move 1 against
            your opponents' usual replies. <strong className="train-kind-mistake">Position from your game</strong> puts you back where
            one of your games went wrong.
          </p>
        </div>
      </section>

      <div className="panel train-summary">
        <p className="train-due" aria-live="polite">
          {data ? dueText(data) : stats.error ? `Could not load the drills: ${stats.error}` : "Loading the drills…"}
        </p>
        {data ? (
          <p className="train-counts">
            {data.total["repertoire-line"]} line cards · {data.total["own-mistake"]} positions from your games
            {data.unchecked ? ` · ${data.unchecked} waiting for the engine check` : ""}
            {data.retired ? ` · ${data.retired} learned` : ""}
          </p>
        ) : null}
        <div className="train-tabs" role="group" aria-label="Drill kind">
          {TABS.map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              className={`train-tab${candidate.key === tab.key ? " train-tab-active" : ""}`}
              aria-pressed={candidate.key === tab.key}
              disabled={session !== null}
              onClick={() =>
                setParams((current) => {
                  const updated = new URLSearchParams(current);
                  updated.set("kind", candidate.param);
                  updated.delete("focus");
                  updated.delete("color");
                  updated.delete("moves");
                  return updated;
                })
              }
            >
              {candidate.key !== "all" ? <DrillBadgeIcon kind={candidate.key} /> : null}
              {candidate.label}
            </button>
          ))}
        </div>
        {!session ? (
          <button type="button" className="primary-button train-start" disabled={loading || checking !== null} onClick={() => void start(tab.key, focus)}>
            {loading ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
            {dueHere ? `Start session (${dueHere})` : "Start session"} <kbd>Enter</kbd>
          </button>
        ) : (
          <div className="train-progress" aria-label={`Drill ${session.index + 1} of ${session.queue.length}`}>
            <span>
              {session.index + 1} / {session.queue.length}
            </span>
            <div className="train-progress-bar">
              <div style={{ width: `${(session.index / session.queue.length) * 100}%` }} />
            </div>
            <button type="button" className="secondary-button" onClick={() => end(session)}>
              End session <kbd>Esc</kbd>
            </button>
          </div>
        )}
      </div>

      {error ? (
        <p className="panel train-empty" role="alert">
          {error}
        </p>
      ) : null}

      {checking ? (
        <p className="panel train-empty" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" /> {checking.message || "Checking today's new positions from your games with the engine"}
          {checking.progress ? ` · ${checking.progress}%` : ""}
        </p>
      ) : null}

      {session?.focusNote && session.index === 0 ? <p className="panel train-note">{session.focusNote}</p> : null}
      {session?.job ? <p className="train-note">More positions from your games are being checked; they join your next session.</p> : null}

      <div ref={columnRef} className="train-stage">
        {current ? (
          current.type === "line-run" ? (
            <LineDrill key={current.key} item={current} width={width} onFinish={(outcomes) => next(outcomes, null)} />
          ) : (
            <MistakeDrill
              key={current.key}
              item={current}
              width={width}
              priorTries={session?.tries.get(current.card.id) ?? 0}
              onFinish={(outcome, requeue) => next([outcome], requeue ? current : null)}
            />
          )
        ) : null}
      </div>

      {!session && !checking && finished ? <SessionSummary session={finished} stats={data} /> : null}

      {!session && !checking && !finished && data && !dueHere ? (
        <div className="train-empties">
          {tab.key !== "own-mistake" && noRepertoire ? (
            <p className="panel train-empty train-empty-line">
              <DrillBadge kind="repertoire-line" /> No repertoire yet, so there are no lines to drill.{" "}
              <Link to="/repertoire">Seed your repertoire from your games</Link>.
            </p>
          ) : null}
          {tab.key !== "repertoire-line" && noMistakes ? (
            <p className="panel train-empty train-empty-mistake">
              <DrillBadge kind="own-mistake" /> No analysed mistakes yet: positions from your games need the engine check of your
              games. <Link to="/">Run the engine check on Home</Link>.
            </p>
          ) : null}
          {!(tab.key !== "own-mistake" && noRepertoire) && !(tab.key !== "repertoire-line" && noMistakes) ? (
            <p className="panel train-empty">
              Nothing due right now.{data.nextDueAt ? ` The next drill is due ${new Date(data.nextDueAt).toLocaleString()}.` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DrillBadgeIcon({ kind }: { kind: DrillKind }) {
  const { Icon } = DRILL_KIND_UI[kind];
  return <Icon size={15} aria-hidden="true" className={`train-tab-icon ${DRILL_KIND_UI[kind].className}-icon`} />;
}

function SessionSummary({ session, stats }: { session: Session; stats: DrillStats | null }) {
  const kinds = (["repertoire-line", "own-mistake"] as const).filter((kind) => session.outcomes.some((outcome) => outcome.kind === kind));
  const rows = kinds.map((kind) => {
    const outcomes = session.outcomes.filter((outcome) => outcome.kind === kind);
    return {
      kind,
      right: outcomes.filter((outcome) => outcome.correct === true).length,
      wrong: outcomes.filter((outcome) => outcome.correct === false).length,
      practice: outcomes.filter((outcome) => outcome.correct === null).length
    };
  });
  return (
    <section className="panel train-summary-card" aria-label="Session summary">
      <h2>Session done</h2>
      {!rows.length ? <p className="train-counts">No drill answered.</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.kind} className={DRILL_KIND_UI[row.kind].className}>
            <DrillBadge kind={row.kind} />{" "}
            {row.kind === "repertoire-line"
              ? `${row.right} line move${row.right === 1 ? "" : "s"} from memory, ${row.wrong} to relearn`
              : `${row.right} position${row.right === 1 ? "" : "s"} solved, ${row.wrong} missed`}
            {row.practice ? ` · ${row.practice} practice` : ""}
          </li>
        ))}
      </ul>
      <p className="train-counts">
        Missed cards are due again tomorrow.
        {stats ? ` ${dueText(stats)}.` : ""}
      </p>
    </section>
  );
}
