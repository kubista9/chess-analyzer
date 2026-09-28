import { useRef, useState } from "react";
import { OPENING_PLY_LIMIT } from "../../shared/constants";
import type { AnalysisStatus, BackfillProgress } from "../../shared/types";
import { ApiError } from "../api/client";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatCount } from "../utils/formatters";
import "../styles/engine.css";

/** "~43 min", "~2 h 5 min", "under a minute". */
export function formatMinutes(minutes: number): string {
  if (minutes < 1) {
    return "under a minute";
  }
  const rounded = Math.round(minutes);
  return rounded < 90 ? `~${rounded} min` : `~${Math.floor(rounded / 60)} h ${rounded % 60} min`;
}

/** Share of this run's searches that are done, 0-100. */
export function searchedPercent(progress: BackfillProgress): number {
  const { owner, opponent } = progress.positions;
  const total = owner.total + opponent.total;
  return total ? Math.round(((owner.done + opponent.done) / total) * 100) : 100;
}

/** The running line: "Engine check: 6,120 / 8,246 of your positions · then opponent positions · ~14 min left". */
export function progressHeadline(progress: BackfillProgress): string {
  const { owner, opponent } = progress.positions;
  const eta = progress.etaSec !== null ? ` · ${formatMinutes(progress.etaSec / 60)} left` : "";
  if (progress.pass === "owner") {
    return `Engine check: ${formatCount(owner.done)} / ${formatCount(owner.total)} of your positions${opponent.total ? " · then opponent positions" : ""}${eta}`;
  }
  if (progress.pass === "opponent") {
    return `Engine check: ${formatCount(opponent.done)} / ${formatCount(opponent.total)} opponent positions${eta}`;
  }
  return "Engine check: finishing";
}

function powerNote(status: AnalysisStatus): string | null {
  const power = status.power;
  if (!power?.onBattery) {
    return null;
  }
  return `On battery${power.percent === null ? "" : ` (${power.percent}%)`}${power.lowPowerMode ? ", Low Power Mode" : ""}: plugging in roughly halves the time.`;
}

function idleCopy(status: AnalysisStatus): { title: string; action: string } {
  const queued = formatCount(status.games.queued);
  const eta = status.estimate ? ` (${formatMinutes(status.estimate.minutes)})` : "";
  if (status.state === "paused") {
    return { title: `Paused · ${queued} games still to check`, action: `Resume${eta}` };
  }
  // Most of the window still unchecked: the one-time check, not a handful of new games.
  if (status.games.queued > status.games.analysed) {
    return {
      title: `${queued} of ${formatCount(status.games.total)} games not engine-checked yet`,
      action: `Start engine check${eta}`
    };
  }
  return {
    title: `${queued} new game${status.games.queued === 1 ? "" : "s"} to analyse`,
    action: `Analyse ${queued} new game${status.games.queued === 1 ? "" : "s"}${eta}`
  };
}

/** Home: Stockfish's opening check of the window's games (backfill progress, pause, coverage). */
export function EngineCard() {
  const { analysis: status, analysisError, startBackfill, pauseBackfill } = useWorkspace();
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false);

  const act = async (action: () => Promise<void>) => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Request failed");
    } finally {
      busy.current = false;
    }
  };

  const start = () =>
    act(async () => {
      try {
        await startBackfill();
      } catch (error) {
        if (error instanceof ApiError && error.code === "on-battery") {
          if (window.confirm(`${error.message}\n\nStart the engine check on battery?`)) {
            await startBackfill(true);
          }
          return;
        }
        throw error;
      }
    });

  const running = status?.state === "running" || status?.state === "pausing";
  const progress = running ? status?.progress : null;
  const byColor = status?.games.byColor;

  return (
    <section className="panel home-card engine-card" aria-label="Engine check">
      <div className="home-card-head">
        <div>
          <span className="eyebrow">
            {status?.engine ? `${status.engine.idName} · first ${OPENING_PLY_LIMIT / 2} moves · config #${status.engine.configId}` : "Stockfish"}
          </span>
          <h2>Engine check</h2>
        </div>
        {byColor ? (
          <p className="engine-coverage">
            As White {formatCount(byColor.white.analysed)} / {formatCount(byColor.white.total)} · As Black{" "}
            {formatCount(byColor.black.analysed)} / {formatCount(byColor.black.total)} games
          </p>
        ) : null}
      </div>

      {!status ? (
        <p className={analysisError ? "error-text" : "home-empty"}>{analysisError ? `Could not read the engine status: ${analysisError}` : "Loading…"}</p>
      ) : status.engineError ? (
        <p className="error-text">{status.engineError}</p>
      ) : running ? (
        <div className="engine-running" role="status">
          <div className="engine-line">
            <strong>{progress ? progressHeadline(progress) : "Engine check: planning"}</strong>
            {status.runner?.source === "server" ? (
              <button className="secondary-button" type="button" disabled={status.state === "pausing"} onClick={() => void act(pauseBackfill)}>
                {status.state === "pausing" ? "Pausing…" : "Pause"}
              </button>
            ) : null}
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress ? searchedPercent(progress) : 0}%` }} />
          </div>
          <p className="home-card-foot">
            {progress
              ? `${formatCount(progress.games.done)} / ${formatCount(progress.games.total)} games done` +
                (progress.positions.cached ? ` · ${formatCount(progress.positions.cached)} positions were already cached` : "") +
                (progress.nps ? ` · ${(progress.nps / 1e6).toFixed(2)}M nodes/s` : "")
              : "Working out which positions still need the engine."}
            {status.state === "pausing" ? " · Pausing: the games in progress finish first." : ""}
          </p>
          {status.runner?.source === "cli" ? (
            <p className="home-card-foot">
              Running in a terminal (<code>npm run backfill</code>, pid {status.runner.pid}). Press Ctrl-C there to pause.
            </p>
          ) : null}
        </div>
      ) : status.games.queued ? (
        <div className="engine-line">
          <div>
            <strong>{idleCopy(status).title}</strong>
            <p className="home-card-foot">
              Your moves are checked first (3 best lines each), then the opponent's. Every result is stored, so the check
              can be paused and resumed, and reviews of checked games open at once.
            </p>
            {powerNote(status) ? <p className="engine-power">{powerNote(status)}</p> : null}
          </div>
          <button className="primary-button" type="button" onClick={() => void start()}>
            {status.state === "failed" ? "Retry" : idleCopy(status).action}
          </button>
        </div>
      ) : (
        <p className="home-empty">
          All {formatCount(status.games.total)} games are engine-checked · {formatCount(status.positions.cached)} positions stored.
          {status.lastRun && status.lastRun.gamesDone
            ? ` Last run: ${formatCount(status.lastRun.gamesDone)} games${status.lastRun.searchMs ? ` at ${((status.lastRun.nodes / status.lastRun.searchMs) / 1000).toFixed(2)}M nodes/s` : ""}.`
            : ""}
        </p>
      )}

      {status?.state === "failed" && status.error ? <p className="error-text">Last run: {status.error}</p> : null}
      {actionError ? <p className="error-text">{actionError}</p> : null}
    </section>
  );
}
