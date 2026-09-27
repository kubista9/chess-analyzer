import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { AnalysisStatus, BackfillProgress, BackfillState, PowerState } from "../../shared/types.js";
import { WINDOW_DAYS, windowBounds } from "../../shared/window.js";
import { lastBackfillRun } from "../db/backfillRuns.js";
import type { Db } from "../db/connection.js";
import { analysisCoverage } from "../db/gameAnalysis.js";
import { windowPositionCoverage } from "../db/positions.js";
import type { EngineConfig } from "../db/engineConfigs.js";
import { runBackfill, estimateSearch, type BackfillPool } from "./backfill.js";
import { BackfillLock, BackfillLockedError, readBackfillLock } from "./backfillLock.js";
import { describePower } from "./power.js";

// The server's side of the backfill: start (or resume), pause and status for the Home engine
// card. It runs the same runBackfill as `npm run backfill`, on the server's engine pool at
// backfill priority (so reviews still go first), under the same cross-process lock.

export type BackfillStartCode = "locked" | "on-battery";

export class BackfillStartError extends Error {
  constructor(
    readonly code: BackfillStartCode,
    message: string
  ) {
    super(message);
    this.name = "BackfillStartError";
  }
}

export interface BackfillServiceDeps {
  db: () => Db;
  pool: () => BackfillPool;
  owner: string;
  lockPath: string;
  /** The current engine config (detects the installed engine once). */
  engineConfig: (db: Db) => Promise<EngineConfig>;
  power: () => PowerState | null;
  autoBackfill: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export interface StartOptions {
  allowBattery?: boolean;
  limit?: number;
}

/** How often the lock file gets the latest progress (the heartbeat covers idle stretches). */
const LOCK_PROGRESS_MS = 2_000;

export class BackfillService {
  private state: BackfillState = "idle";
  private progress: BackfillProgress | null = null;
  private error: string | null = null;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private startedAt: number | null = null;

  constructor(private readonly deps: BackfillServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Starts (or resumes) the backfill. Joins a run already going in this server. */
  start(options: StartOptions = {}): { started: boolean } {
    if (this.running) {
      if (this.state === "pausing") {
        throw new BackfillStartError("locked", "The engine check is pausing; resume once the games in progress are done.");
      }
      return { started: false };
    }
    const power = this.deps.power();
    if (power?.onBattery && !options.allowBattery) {
      throw new BackfillStartError(
        "on-battery",
        `The Mac is ${describePower(power)}. The engine check keeps ${this.deps.pool().stats().size} cores busy; plug in, or start it anyway.`
      );
    }
    let lock: BackfillLock;
    try {
      lock = BackfillLock.acquire(this.deps.lockPath, "server", this.now());
    } catch (error) {
      if (error instanceof BackfillLockedError) {
        throw new BackfillStartError("locked", error.message);
      }
      throw error;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.state = "running";
    this.error = null;
    this.progress = null;
    this.startedAt = this.now();
    let lastLockWrite = 0;
    this.running = runBackfill(
      { db: this.deps.db(), pool: this.deps.pool(), owner: this.deps.owner, source: "server", now: this.deps.now, power },
      {
        limit: options.limit,
        signal: controller.signal,
        onProgress: (progress) => {
          this.progress = progress;
          if (progress.updatedAt - lastLockWrite >= LOCK_PROGRESS_MS) {
            lastLockWrite = progress.updatedAt;
            lock.update(progress);
          }
        }
      }
    )
      .then((result) => {
        this.progress = result.progress;
        // "paused" without a pause request means the engine pool closed (server shutdown).
        this.state = result.status === "failed" ? "failed" : result.status === "paused" && controller.signal.aborted ? "paused" : "idle";
        this.error = result.errors.length ? `${result.gamesFailed} game(s) failed: ${result.errors[0]}` : null;
        this.deps.log?.(
          `Engine check ${result.status}: ${result.gamesAnalysed} games analysed, ${result.positionsSearched} positions searched, ` +
            `${(result.nodes / 1e6).toFixed(0)}M nodes in ${(result.searchMs / 1000).toFixed(0)} s`
        );
      })
      .catch((error: unknown) => {
        this.state = "failed";
        this.error = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`Engine check failed: ${this.error}`);
      })
      .finally(() => {
        lock.releaseSync();
        this.running = null;
        this.controller = null;
      });
    return { started: true };
  }

  /** Pauses: the games in progress finish, nothing new starts. Resume with start(). */
  pause(): void {
    if (this.controller && this.state === "running") {
      this.state = "pausing";
      this.controller.abort();
    }
  }

  /** After a sync: analyse the new games if AUTO_BACKFILL is on, nothing is running or paused, and on mains power. */
  autoStart(): boolean {
    if (!this.deps.autoBackfill || this.running || this.state === "paused" || this.deps.power()?.onBattery) {
      return false;
    }
    try {
      return this.start().started;
    } catch {
      return false;
    }
  }

  /** Waits for a run in progress (tests, shutdown). */
  async idle(): Promise<void> {
    await this.running;
  }

  async status(): Promise<AnalysisStatus> {
    const db = this.deps.db();
    const nowMs = this.now();
    const bounds = windowBounds(Math.floor(nowMs / 1000));
    let config: EngineConfig | null = null;
    let engineError: string | null = null;
    try {
      config = await this.deps.engineConfig(db);
    } catch (error) {
      engineError = `Stockfish could not start (${error instanceof Error ? error.message : String(error)}). Run npm run setup:engine.`;
    }

    // A run in another process (the CLI) is visible through its lock file.
    const lock = this.running ? null : readBackfillLock(this.deps.lockPath, nowMs);
    const state: BackfillState = lock ? "running" : this.state;
    const runner = this.running
      ? { source: "server" as const, pid: process.pid, startedAt: this.startedAt ?? nowMs }
      : lock
        ? { source: lock.source, pid: lock.pid, startedAt: lock.startedAt }
        : null;
    const progress = lock ? lock.progress : this.progress;

    const query = { username: this.deps.owner, configId: config?.id ?? -1, windowStart: bounds.start, openingPlies: OPENING_PLY_LIMIT };
    const byColor = analysisCoverage(db, query);
    const byTier = windowPositionCoverage(db, query);
    const total = byColor.white.total + byColor.black.total;
    const analysed = byColor.white.analysed + byColor.black.analysed;
    const estimate = config
      ? estimateSearch(db, config.id, {
          owner: byTier.owner.total - byTier.owner.cached,
          opponent: byTier.opponent.total - byTier.opponent.cached
        })
      : null;
    return {
      engine: config ? { idName: `${config.engineName} ${config.engineVersion}`, configId: config.id } : null,
      engineError,
      state,
      runner,
      progress,
      error: lock ? null : this.error,
      lastRun: lastBackfillRun(db) ?? null,
      window: { start: bounds.start, days: WINDOW_DAYS },
      games: { total, analysed, queued: total - analysed, byColor },
      positions: {
        total: byTier.owner.total + byTier.opponent.total,
        cached: byTier.owner.cached + byTier.opponent.cached,
        byTier
      },
      estimate: estimate ? { minutes: estimate.seconds / 60, nps: estimate.nps, measured: estimate.measured } : null,
      power: this.deps.power(),
      autoBackfill: this.deps.autoBackfill
    };
  }
}
