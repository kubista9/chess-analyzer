import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import type { BackfillProgress, EngineTier, PlayerColor, PowerState } from "../../shared/types.js";
import { windowBounds } from "../../shared/window.js";
import { insertBackfillRun, lastMeasuredRun, updateBackfillRun } from "../db/backfillRuns.js";
import type { Db } from "../db/connection.js";
import { listAnalysisQueue } from "../db/gameAnalysis.js";
import { listOpeningMoves } from "../db/games.js";
import { averageNodes, getPositionEval } from "../db/positions.js";
import { currentEngineConfig } from "../engine/engineConfig.js";
import { EnginePoolClosedError, type EnginePool } from "../engine/pool.js";
import { DEFAULT_NPS, PRIOR_NODES, ThroughputMeter } from "./backfillMeter.js";
import {
  evaluateOpening,
  isAnswered,
  openingPositions,
  positionKey,
  recordOpeningFromStore,
  type OpeningItem,
  type OpeningPosition
} from "./openingPass.js";

// The one-time engine backfill over the window, and the incremental runs after each sync.
// - The work queue is the INCREMENTAL RULE's: window games without a game_analysis row for
//   the current engine config, newest first (optionally the first `limit`).
// - Each (tier, EPD) is searched once per run, with every move ever played from it in a
//   window game scored at the same root, so a later game reaching the EPD finds its move
//   already scored. The cache is looked up before each search and each result is stored as
//   it arrives.
// - Pass A searches the owner-to-move positions of all queued games, then pass B the
//   opponent-to-move ones. A game's row is written as soon as all its positions are answered.
// - Pause (the abort signal) stops handing out games and lets the ones in progress finish.
//   Anything unfinished simply stays queued: the next run starts where this one stopped.

export const PASSES: readonly EngineTier[] = ["owner", "opponent"];

export interface PlannedGame {
  id: string;
  color: PlayerColor;
  endTime: number;
  positions: OpeningPosition[];
}

/** One game's share of a pass: its positions of that tier that no earlier game already covers. */
export interface PlannedGroup {
  gameId: string;
  items: (OpeningItem & { key: string })[];
}

export interface BackfillPlan {
  configId: number;
  games: PlannedGame[];
  passes: Record<EngineTier, PlannedGroup[]>;
  positions: {
    /** Unique (tier, EPD) positions in the queued games. */
    total: number;
    /** Answered by the cache already. */
    cached: number;
    /** To search per tier; `partial` of them already have a row and only need follow-ups. */
    toSearch: Record<EngineTier, number>;
    partial: number;
  };
}

export interface PlanQuery {
  owner: string;
  configId: number;
  /** Unix seconds; the window's start. */
  windowStart: number;
  limit?: number;
  openingPlies?: number;
}

/** The work for the queued games: which positions each pass searches, in newest-game order. */
export function planBackfill(db: Db, query: PlanQuery): BackfillPlan {
  const openingPlies = query.openingPlies ?? OPENING_PLY_LIMIT;
  const queue = listAnalysisQueue(db, {
    username: query.owner,
    configId: query.configId,
    windowStart: query.windowStart,
    openingPlies,
    limit: query.limit
  });

  // Every move played from each (tier, EPD) in the window, so one search scores them all.
  const windowMoves = listOpeningMoves(db, query.owner, query.windowStart, openingPlies);
  const playedAt = new Map<string, Set<string>>();
  for (const game of windowMoves.values()) {
    for (const position of openingPositions(game.plies, game.color, openingPlies)) {
      const key = positionKey(position);
      let played = playedAt.get(key);
      if (!played) {
        played = new Set();
        playedAt.set(key, played);
      }
      played.add(position.played);
    }
  }

  const plan: BackfillPlan = {
    configId: query.configId,
    games: [],
    passes: { owner: [], opponent: [] },
    positions: { total: 0, cached: 0, toSearch: { owner: 0, opponent: 0 }, partial: 0 }
  };
  const seen = new Set<string>();
  for (const queued of queue) {
    const moves = windowMoves.get(queued.id);
    const positions = moves ? openingPositions(moves.plies, queued.color, openingPlies) : [];
    plan.games.push({ id: queued.id, color: queued.color, endTime: queued.endTime, positions });
    const groups: Record<EngineTier, PlannedGroup> = { owner: { gameId: queued.id, items: [] }, opponent: { gameId: queued.id, items: [] } };
    for (const position of positions) {
      const key = positionKey(position);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      plan.positions.total += 1;
      const played = [...(playedAt.get(key) ?? [position.played])];
      const stored = getPositionEval(db, query.configId, position.epd, position.tier);
      if (isAnswered(stored, played)) {
        plan.positions.cached += 1;
        continue;
      }
      if (stored) {
        plan.positions.partial += 1;
      }
      plan.positions.toSearch[position.tier] += 1;
      groups[position.tier].items.push({ key, position, played });
    }
    for (const tier of PASSES) {
      if (groups[tier].items.length) {
        plan.passes[tier].push(groups[tier]);
      }
    }
  }
  return plan;
}

export interface BackfillEstimate {
  nodes: number;
  nps: number;
  seconds: number;
  /** True when nps comes from a previous run on this machine, false for the default. */
  measured: boolean;
  meanNodes: Record<EngineTier, number>;
}

/** Mean nodes per position from the store (once it has enough rows), else the prior. */
export function meanNodesPerTier(db: Db, configId: number): Record<EngineTier, number> {
  const stored = averageNodes(db, configId);
  return {
    owner: stored.owner.n >= 20 ? stored.owner.mean : PRIOR_NODES.owner,
    opponent: stored.opponent.n >= 20 ? stored.opponent.mean : PRIOR_NODES.opponent
  };
}

/** Pool-wide nps measured by the last real run, or the default. */
export function measuredNps(db: Db): { nps: number; measured: boolean } {
  const run = lastMeasuredRun(db);
  return run ? { nps: (run.nodes / run.searchMs) * 1000, measured: true } : { nps: DEFAULT_NPS, measured: false };
}

export function estimateSearch(db: Db, configId: number, toSearch: Record<EngineTier, number>): BackfillEstimate {
  const meanNodes = meanNodesPerTier(db, configId);
  const { nps, measured } = measuredNps(db);
  const nodes = toSearch.owner * meanNodes.owner + toSearch.opponent * meanNodes.opponent;
  return { nodes, nps, seconds: nodes / nps, measured, meanNodes };
}

export type BackfillPool = Pick<EnginePool, "analyseGame" | "engineIdName" | "stats">;

export interface BackfillDeps {
  db: Db;
  pool: BackfillPool;
  owner: string;
  source: "cli" | "server";
  now?: () => number;
  power?: PowerState | null;
}

export interface BackfillOptions {
  limit?: number;
  /** Unix seconds; defaults to the 6-month window ending now. */
  windowStart?: number;
  /** Aborting pauses: no new game is started, the ones in progress finish. */
  signal?: AbortSignal;
  onProgress?: (progress: BackfillProgress) => void;
  /** Called once the plan is known, before any search. */
  onPlan?: (plan: BackfillPlan) => void;
}

export interface BackfillResult {
  runId: number;
  configId: number;
  status: "completed" | "paused" | "failed";
  progress: BackfillProgress;
  gamesAnalysed: number;
  gamesFailed: number;
  positionsSearched: number;
  nodes: number;
  /** Wall time from the first search to the last. */
  searchMs: number;
  errors: string[];
}

/** Runs the backfill over the queue. Never throws for a failed game; see `status` and `errors`. */
export async function runBackfill(deps: BackfillDeps, options: BackfillOptions = {}): Promise<BackfillResult> {
  const now = deps.now ?? Date.now;
  const { db, pool } = deps;
  const config = currentEngineConfig(db, await pool.engineIdName());
  const windowStart = options.windowStart ?? windowBounds(Math.floor(now() / 1000)).start;
  const plan = planBackfill(db, { owner: deps.owner, configId: config.id, windowStart, limit: options.limit });
  options.onPlan?.(plan);

  const startedAt = now();
  const workers = pool.stats().size;
  const runId = insertBackfillRun(db, {
    source: deps.source,
    pid: process.pid,
    configId: config.id,
    workers,
    onBattery: deps.power ? deps.power.onBattery : null,
    startedAt,
    gamesQueued: plan.games.length
  });

  const { nps: priorNps } = measuredNps(db);
  const meter = new ThroughputMeter({ nodes: meanNodesPerTier(db, config.id), nps: priorNps });
  const progress: BackfillProgress = {
    pass: plan.passes.owner.length ? "owner" : plan.passes.opponent.length ? "opponent" : "done",
    games: { total: plan.games.length, done: 0, failed: 0 },
    positions: {
      total: plan.positions.total,
      cached: plan.positions.cached,
      owner: { done: 0, total: plan.positions.toSearch.owner },
      opponent: { done: 0, total: plan.positions.toSearch.opponent }
    },
    nodes: 0,
    nps: null,
    etaSec: null,
    startedAt,
    updatedAt: startedAt
  };
  const errors: string[] = [];
  const report = () => {
    progress.nps = meter.nps();
    progress.etaSec = meter.etaSec({
      owner: progress.positions.owner.total - progress.positions.owner.done,
      opponent: progress.positions.opponent.total - progress.positions.opponent.done
    });
    progress.updatedAt = now();
    options.onProgress?.({ ...progress, games: { ...progress.games }, positions: { ...progress.positions } });
  };

  // A game is written once none of its positions is pending in this run.
  const pendingByGame = new Map<string, Set<string>>();
  const gamesByKey = new Map<string, string[]>();
  for (const pass of PASSES) {
    for (const group of plan.passes[pass]) {
      for (const item of group.items) {
        gamesByKey.set(item.key, []);
      }
    }
  }
  const gameById = new Map(plan.games.map((game) => [game.id, game]));
  const finishGame = (game: PlannedGame) => {
    try {
      const summary = recordOpeningFromStore(db, config.id, game.id, game.positions, game.color, now());
      if (summary) {
        progress.games.done += 1;
        return;
      }
      errors.push(`Game ${game.id}: a position was not answered in the store after its search`);
    } catch (error) {
      errors.push(`Game ${game.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    progress.games.failed += 1;
  };
  for (const game of plan.games) {
    const pending = new Set<string>();
    for (const position of game.positions) {
      const key = positionKey(position);
      const waiting = gamesByKey.get(key);
      if (waiting) {
        pending.add(key);
        waiting.push(game.id);
      }
    }
    if (pending.size) {
      pendingByGame.set(game.id, pending);
    } else {
      finishGame(game);
    }
  }
  const resolveKey = (key: string) => {
    for (const gameId of gamesByKey.get(key) ?? []) {
      const pending = pendingByGame.get(gameId);
      if (pending?.delete(key) && !pending.size) {
        pendingByGame.delete(gameId);
        finishGame(gameById.get(gameId)!);
      }
    }
    gamesByKey.delete(key);
  };

  let firstSearchAt: number | null = null;
  let lastSearchAt: number | null = null;
  let searched = 0;
  let closed = false;
  report();

  const runGroup = async (pass: EngineTier, group: PlannedGroup) => {
    try {
      await evaluateOpening({ db, pool, configId: config.id }, `backfill:${pass}:${group.gameId}`, group.items, {
        priority: "backfill",
        onEvaluated: (index, _evaluation, info) => {
          const at = now();
          if (info.searched) {
            searched += 1;
            progress.nodes += info.nodes;
            meter.record(pass, info.nodes, at);
            lastSearchAt = at;
          }
          progress.positions[pass].done += 1;
          resolveKey(group.items[index].key);
          report();
        }
      });
    } catch (error) {
      if (error instanceof EnginePoolClosedError) {
        closed = true;
        return;
      }
      errors.push(`Game ${group.gameId} (${pass} positions): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const pass of PASSES) {
    if (options.signal?.aborted || closed) {
      break;
    }
    progress.pass = pass;
    report();
    const inflight = new Set<Promise<void>>();
    for (const group of plan.passes[pass]) {
      while (inflight.size >= workers) {
        await Promise.race(inflight);
      }
      if (options.signal?.aborted || closed) {
        break;
      }
      firstSearchAt ??= now();
      const running = runGroup(pass, group).finally(() => inflight.delete(running));
      inflight.add(running);
    }
    await Promise.all(inflight);
  }

  // Games whose positions failed (or never ran after a pause) stay queued for the next run.
  const unfinished = pendingByGame.size;
  const paused = Boolean(options.signal?.aborted) || closed;
  const failedGames = paused ? progress.games.failed : progress.games.failed + unfinished;
  progress.games.failed = failedGames;
  progress.pass = paused ? progress.pass : "done";
  report();

  const status: BackfillResult["status"] = paused ? "paused" : failedGames ? "failed" : "completed";
  const searchMs = firstSearchAt !== null && lastSearchAt !== null ? Math.max(0, lastSearchAt - firstSearchAt) : 0;
  updateBackfillRun(db, runId, {
    status,
    finishedAt: now(),
    gamesDone: progress.games.done,
    gamesFailed: failedGames,
    positionsSearched: searched,
    nodes: progress.nodes,
    searchMs,
    error: errors.length ? errors.slice(0, 5).join("\n") : null
  });

  return {
    runId,
    configId: config.id,
    status,
    progress: { ...progress },
    gamesAnalysed: progress.games.done,
    gamesFailed: failedGames,
    positionsSearched: searched,
    nodes: progress.nodes,
    searchMs,
    errors
  };
}
