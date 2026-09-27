import express from "express";
import { z } from "zod";
import { IMPORTED_TIME_CLASSES, OPENING_PLY_LIMIT } from "../shared/constants.js";
import type {
  AnalysisStatus,
  FixListResponse,
  GameResponse,
  PlayerColor,
  PowerState,
  RepertoireScope,
  SnapshotResponse,
  QueryWindow,
  ReviewSummary,
  TreeBreadcrumb,
  SyncJobResult,
  TreeGamesResponse,
  TreeResponse
} from "../shared/types.js";
import { START_EPD } from "../shared/epd.js";
import type { OpeningBook } from "../shared/openingBook.js";
import {
  EARLY_LOSS_PLY,
  FIX_FDR_Q,
  FIX_MIN_ESS,
  FIX_MIN_N,
  FIX_MIN_POINTS,
  FIX_MIN_Z,
  buildFixList,
  type FixSelection
} from "../shared/fixList.js";
import { nodeView, walkMoves, type OpeningTree, type TreeNode } from "../shared/openingTree.js";
import { buildSnapshot } from "../shared/repertoireSnapshot.js";
import { GAME_WINDOWS, parseGameWindow, windowBounds } from "../shared/window.js";
import { config } from "./config.js";
import { getDb, type Db } from "./db/connection.js";
import { getGame, listMoveGames } from "./db/games.js";
import { jobStore as defaultJobStore, type JobStore } from "./store/jobStore.js";
import { syncArchives } from "./services/archiveImport.js";
import { buildImportStatus } from "./services/importStatus.js";
import { getOpeningBook } from "./services/openingBook.js";
import { cachedGameReview, runGameReview } from "./services/reviewAnalysis.js";
import { BackfillService, BackfillStartError } from "./services/backfillService.js";
import { readPowerState } from "./services/power.js";
import type { EngineConfig } from "./db/engineConfigs.js";
import { resolveEngineConfig } from "./engine/engineConfig.js";
import type { EnginePool } from "./engine/pool.js";
import { getEnginePool } from "./engine/sharedPool.js";
import {
  DEFAULT_HALF_LIFE_BY_WINDOW,
  createTreeService,
  type BuiltTree,
  type TreeFilters,
  type TreeService
} from "./services/treeService.js";

const reviewSchema = z.object({
  gameId: z.string().min(1)
});

const syncSchema = z.object({
  full: z.boolean().optional()
});

const backfillSchema = z.object({
  allowBattery: z.boolean().optional(),
  limit: z.number().int().min(1).optional()
});

const gamesQuerySchema = z.object({
  window: z.string().optional(),
  tc: z.enum(IMPORTED_TIME_CLASSES).optional(),
  color: z.enum(["white", "black"]).optional()
});

// A position key as the tree stores it: the first four FEN fields.
const EPD_PATTERN = /^[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36])$/;

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

// Half-life in days, or "off" / 0 for unweighted; omitted = the window's default.
const halfLifeSchema = z.union([z.literal("off"), z.coerce.number().min(0).max(3650)]).optional();

// Filters for answers over both colours' trees (fix list, snapshot).
const repertoireQuerySchema = z.object({
  window: z.string().optional(),
  tc: z.enum(IMPORTED_TIME_CLASSES).optional(),
  hl: halfLifeSchema
});

const treeQuerySchema = z.object({
  color: z.enum(["white", "black"]),
  epd: z.string().regex(EPD_PATTERN, "an EPD: the first four FEN fields").optional(),
  // The node by its move path: comma-separated UCI moves from the start ("" = the start).
  moves: z
    .string()
    .transform((value) => (value ? value.split(",") : []))
    .pipe(z.array(z.string().regex(UCI_PATTERN, "UCI moves, comma-separated")).max(OPENING_PLY_LIMIT))
    .optional(),
  window: z.string().optional(),
  tc: z.enum(IMPORTED_TIME_CLASSES).optional(),
  hl: halfLifeSchema
});

const treeGamesQuerySchema = treeQuerySchema.extend({
  uci: z.string().regex(UCI_PATTERN, "a UCI move"),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional()
});

/** Games per page in GET /api/tree/games by default. */
export const TREE_GAMES_PAGE_SIZE = 20;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A machine-readable reason the client can act on (e.g. "on-battery"). */
    readonly code?: string
  ) {
    super(message);
  }
}

/** The query window for `?window=` (6m by default, or 3m), ending now. */
function queryWindow(value: unknown, nowMs: number): QueryWindow {
  const key = parseGameWindow(value);
  if (!key) {
    throw new HttpError(400, `Unknown window "${String(value)}"; use 6m or 3m.`);
  }
  const days = GAME_WINDOWS[key];
  return { key, days, ...windowBounds(Math.floor(nowMs / 1000), days) };
}

type TreeQuery = z.infer<typeof treeQuerySchema>;
type RepertoireQuery = z.infer<typeof repertoireQuerySchema>;

/** The tree filters of a query, less the colour: window (6m default), time class and half-life. */
function queryFilters(query: RepertoireQuery): Omit<TreeFilters, "color"> {
  const window = parseGameWindow(query.window);
  if (!window) {
    throw new HttpError(400, `Unknown window "${String(query.window)}"; use 6m or 3m.`);
  }
  const halfLifeDays =
    query.hl === undefined ? DEFAULT_HALF_LIFE_BY_WINDOW[window] : query.hl === "off" || query.hl === 0 ? null : query.hl;
  return { window, timeClass: query.tc ?? null, halfLifeDays };
}

/** The memoised tree for the query's filters and the node it asks for (moves=, epd= or the start). */
function findTreeNode(trees: TreeService, query: TreeQuery, nowMs: number): { built: BuiltTree; node: TreeNode; path: TreeBreadcrumb[] } {
  const filters = queryFilters(query);
  if (query.moves && query.epd) {
    throw new HttpError(400, "Pass either moves= or epd=, not both.");
  }
  const built = trees.getTree({ color: query.color, ...filters }, nowMs);

  if (query.moves) {
    const walk = walkMoves(built.tree, query.moves);
    if (!walk.node) {
      const at = walk.missingAt ?? 0;
      throw new HttpError(404, `The ${query.color} games in this window never played ${query.moves[at]} after ${at} moves.`);
    }
    return { built, node: walk.node, path: walk.path };
  }

  const epd = query.epd ?? START_EPD;
  const node = built.tree.nodes.get(epd);
  if (!node) {
    throw new HttpError(404, `The ${query.color} games in this window never reached ${epd}.`);
  }
  return { built, node, path: [] };
}

export interface ApiDeps {
  db: () => Db;
  jobs: JobStore;
  owner: string;
  now: () => number;
  /** The archive sync (injectable for tests). */
  sync: typeof syncArchives;
  /** The opening book (built once on first use). */
  book: () => OpeningBook;
  /** The engine backfill (start / pause / status). */
  backfill: BackfillService;
  /** The engine pool reviews run on, and the current engine config. */
  pool: () => Pick<EnginePool, "analyseGame">;
  engineConfig: (db: Db) => Promise<EngineConfig>;
}

export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  const trees = createTreeService({ db: deps.db, owner: deps.owner, book: deps.book });

  /** Both colours' memoised trees for a query, and the scope fields every such answer carries. */
  const bothTrees = (query: RepertoireQuery) => {
    const filters = queryFilters(query);
    const nowMs = deps.now();
    const built = { white: trees.getTree({ color: "white", ...filters }, nowMs), black: trees.getTree({ color: "black", ...filters }, nowMs) };
    const scope: RepertoireScope = {
      window: built.white.window,
      timeClass: filters.timeClass,
      halfLifeDays: filters.halfLifeDays,
      maxPly: built.white.tree.maxPly,
      games: { white: built.white.tree.games, black: built.black.tree.games }
    };
    return { built, scope };
  };

  // The fix list is recomputed only when either memoised tree was rebuilt.
  const fixMemo = new Map<string, { trees: Record<PlayerColor, OpeningTree>; selection: FixSelection }>();
  const fixList = (built: Record<PlayerColor, BuiltTree>): FixSelection => {
    const { window, timeClass, halfLifeDays } = built.white.filters;
    const key = `${window}|${timeClass ?? "all"}|${halfLifeDays ?? "off"}`;
    const hit = fixMemo.get(key);
    if (hit && hit.trees.white === built.white.tree && hit.trees.black === built.black.tree) {
      return hit.selection;
    }
    const selection = buildFixList([built.white, built.black]);
    fixMemo.delete(key);
    fixMemo.set(key, { trees: { white: built.white.tree, black: built.black.tree }, selection });
    if (fixMemo.size > 16) {
      fixMemo.delete(fixMemo.keys().next().value!);
    }
    return selection;
  };

  router.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  router.get("/status", (_request, response) => {
    response.json(buildImportStatus(deps.db(), deps.owner, deps.now()));
  });

  // Starts the archive sync as a job keyed "sync"; a second request while it runs joins it.
  // {full: true} also revalidates closed months.
  router.post("/sync", (request, response) => {
    const payload = syncSchema.parse(request.body ?? {});
    const { job } = deps.jobs.startOrReuse<SyncJobResult>("sync", "sync", "Sync", async (reporter) => {
      reporter.progress(2, "Listing Chess.com archives");
      const summary = await deps.sync(deps.db(), deps.owner, {
        full: payload.full,
        onProgress: ({ done, total, message }) => reporter.progress(5 + (total ? (done / total) * 90 : 90), message)
      });
      // AUTO_BACKFILL: analyse the new games right away (Home offers the button otherwise).
      deps.backfill.autoStart();
      return { summary, status: buildImportStatus(deps.db(), deps.owner, deps.now()) };
    });
    response.status(202).json(job);
  });

  router.get("/games/:id", (request, response) => {
    const game = getGame(deps.db(), request.params.id);
    if (!game) {
      throw new HttpError(404, `Game ${request.params.id} is not in the game store.`);
    }
    response.json({ game } satisfies GameResponse);
  });

  // One node of the per-colour opening tree (by `moves=`, `epd=`, or the start position) with
  // its move rows and breadcrumbs, over the stored games in the window. Trees are memoised
  // per filter set.
  router.get("/tree", (request, response) => {
    const query = treeQuerySchema.parse(request.query);
    const { built, node, path } = findTreeNode(trees, query, deps.now());
    response.json({
      window: built.window,
      color: query.color,
      timeClass: built.filters.timeClass,
      halfLifeDays: built.filters.halfLifeDays,
      maxPly: built.tree.maxPly,
      games: built.tree.games,
      node: nodeView(node),
      path
    } satisfies TreeResponse);
  });

  // Fix list v0: the owner's moves that lose points against his Elo expectation, over both
  // colours (one multiple-comparison family), with blame attribution. Results only.
  router.get("/fixlist", (request, response) => {
    const { built, scope } = bothTrees(repertoireQuerySchema.parse(request.query));
    const selection = fixList(built);
    response.json({
      ...scope,
      tested: selection.tested,
      significant: selection.significant,
      items: selection.items,
      watch: selection.watch,
      thresholds: {
        minN: FIX_MIN_N,
        minEss: FIX_MIN_ESS,
        minZ: FIX_MIN_Z,
        fdrQ: FIX_FDR_Q,
        minPoints: FIX_MIN_POINTS,
        earlyLossPly: EARLY_LOSS_PLY
      }
    } satisfies FixListResponse);
  });

  // Home's repertoire snapshot: the opponent's main moves and the owner's answers, per colour.
  router.get("/snapshot", (request, response) => {
    const { built, scope } = bothTrees(repertoireQuerySchema.parse(request.query));
    response.json({ ...scope, white: buildSnapshot(built.white.tree), black: buildSnapshot(built.black.tree) } satisfies SnapshotResponse);
  });

  // One page of the games behind the move `uci` from a node, newest first, with the ply the
  // move was played at (the Explorer's games drawer links each to its review).
  router.get("/tree/games", (request, response) => {
    const query = treeGamesQuerySchema.parse(request.query);
    const { node } = findTreeNode(trees, query, deps.now());
    const edge = node.edges.find((candidate) => candidate.uci === query.uci);
    if (!edge) {
      throw new HttpError(404, `No ${query.color} game in this window played ${query.uci} from ${node.epd}.`);
    }
    const pageSize = query.size ?? TREE_GAMES_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(edge.gameIds.length / pageSize));
    const page = Math.min(query.page ?? 1, pages);
    const ids = edge.gameIds.slice((page - 1) * pageSize, page * pageSize);
    response.json({
      color: query.color,
      epd: node.epd,
      uci: edge.uci,
      san: edge.san,
      total: edge.gameIds.length,
      page,
      pageSize,
      pages,
      games: listMoveGames(deps.db(), ids, node.epd, edge.uci)
    } satisfies TreeGamesResponse);
  });

  // Starts (or joins) the opening review of one stored game, keyed "review:<gameId>". A game
  // whose positions are all in the position cache (e.g. backfilled) is answered at once.
  router.post("/game-review", async (request, response) => {
    const { gameId } = reviewSchema.parse(request.body);
    const db = deps.db();
    if (!getGame(db, gameId)) {
      throw new HttpError(404, `Game ${gameId} is not in the game store. Sync from Home first.`);
    }

    const key = `review:${gameId}`;
    const engineConfig = await deps.engineConfig(db);
    const cached = cachedGameReview(db, gameId, engineConfig.id);
    if (cached) {
      response.json(deps.jobs.completed<ReviewSummary>(key, "game-review", "Opening review ready", cached));
      return;
    }

    const { job } = deps.jobs.startOrReuse<ReviewSummary>(key, "game-review", "Opening review", async (reporter) => {
      reporter.progress(5, "Starting Stockfish");
      return runGameReview(deps.db(), deps.pool(), engineConfig.id, gameId, (done, total) =>
        reporter.progress(5 + (done / total) * 90, `Stockfish: ${done} of ${total} positions`)
      );
    });
    response.status(202).json(job);
  });

  // The engine check: coverage of the window, the queue, and the running backfill (in this
  // server or in `npm run backfill`), with progress and an ETA.
  router.get("/analysis/status", async (_request, response) => {
    response.json((await deps.backfill.status()) satisfies AnalysisStatus);
  });

  // Starts or resumes the backfill over the queue (newest games first). 409 "on-battery" unless
  // {allowBattery: true}; 409 "locked" while another process runs it.
  router.post("/analysis/backfill", async (request, response) => {
    const payload = backfillSchema.parse(request.body ?? {});
    try {
      deps.backfill.start(payload);
    } catch (error) {
      if (error instanceof BackfillStartError) {
        throw new HttpError(409, error.message, error.code);
      }
      throw error;
    }
    response.status(202).json(await deps.backfill.status());
  });

  // Pauses the backfill: the games in progress finish, the rest stays queued.
  router.post("/analysis/pause", async (_request, response) => {
    deps.backfill.pause();
    response.json(await deps.backfill.status());
  });

  // Before /jobs/:jobId, which would otherwise match "active".
  router.get("/jobs/active", (_request, response) => {
    response.json(deps.jobs.active());
  });

  router.get("/jobs/:jobId", (request, response) => {
    const job = deps.jobs.get(request.params.jobId);
    if (!job) {
      throw new HttpError(404, "Unknown job (the server may have restarted). Run it again.");
    }
    response.json(job);
  });

  return router;
}

// The Mac's power state changes rarely; read pmset at most every 30 s.
let power: { at: number; state: PowerState | null } | null = null;
function cachedPowerState(): PowerState | null {
  if (!power || Date.now() - power.at > 30_000) {
    power = { at: Date.now(), state: readPowerState() };
  }
  return power.state;
}

export const backfillService = new BackfillService({
  db: getDb,
  pool: getEnginePool,
  owner: config.owner,
  lockPath: config.backfillLockPath,
  engineConfig: resolveEngineConfig,
  power: cachedPowerState,
  autoBackfill: config.autoBackfill,
  log: (message) => console.log(message)
});

export const apiRouter = createApiRouter({
  db: getDb,
  jobs: defaultJobStore,
  owner: config.owner,
  now: Date.now,
  sync: syncArchives,
  book: getOpeningBook,
  backfill: backfillService,
  pool: getEnginePool,
  engineConfig: resolveEngineConfig
});
