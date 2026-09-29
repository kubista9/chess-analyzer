import express from "express";
import { z } from "zod";
import { IMPORTED_TIME_CLASSES, OPENING_PLY_LIMIT } from "../shared/constants.js";
import type {
  AnalysisStatus,
  ColorEngineSummary,
  EngineCoverage,
  FixListResponse,
  GameResponse,
  PlayerColor,
  PowerState,
  RepertoireScope,
  SnapshotResponse,
  QueryWindow,
  RepertoireCoverageResponse,
  RepertoireResponse,
  SeedResponse,
  TreeBreadcrumb,
  SyncJobResult,
  TreeGamesResponse,
  TreeResponse
} from "../shared/types.js";
import { START_EPD } from "../shared/epd.js";
import type { OpeningBook } from "../shared/openingBook.js";
import {
  EARLY_LOSS_PLY,
  ENGINE_HOLE_MIN_LOSS,
  ENGINE_HOLE_MIN_N,
  ENGINE_HOLE_REPLY_CP,
  ENGINE_HOLE_REPLY_LOSS,
  FIX_FDR_Q,
  FIX_LIST_CAP,
  FIX_MIN_ESS,
  FIX_MIN_N,
  FIX_MIN_POINTS,
  FIX_MIN_Z,
  buildFixList,
  type FixList
} from "../shared/fixList.js";
import { ENGINE_MIN_COVERAGE, ENGINE_MIN_GAMES, coverageOk, firstErrorShares } from "../shared/openingAnalysis.js";
import { nodeView, principalPaths, walkMoves, type OpeningTree, type TreeNode } from "../shared/openingTree.js";
import type { AlternativesResponse } from "../shared/alternatives.js";
import { seedFlags } from "../shared/repertoireSeed.js";
import { alternativesState, completeAlternatives, type AltSource } from "./services/alternatives.js";
import { edgeEngine, nodeEngine } from "../shared/treeEngine.js";
import { buildSnapshot } from "../shared/repertoireSnapshot.js";
import { REPERTOIRE_MAX_PLY, legalMove, repertoireStats, walkRepertoire } from "../shared/repertoire.js";
import { repertoireStamp, deleteRepEntry, getRepEntry } from "./db/repertoire.js";
import { RepertoireInputError, colorView, editEntry, loadRepertoire, repertoirePgn, seedRepertoire } from "./services/repertoireService.js";
import { GAME_WINDOWS, parseGameWindow, windowBounds } from "../shared/window.js";
import { config } from "./config.js";
import { getDb, type Db } from "./db/connection.js";
import { getGame, getGamePlies, listMoveGames } from "./db/games.js";
import { jobStore as defaultJobStore, type JobStore } from "./store/jobStore.js";
import { syncArchives } from "./services/archiveImport.js";
import { buildImportStatus } from "./services/importStatus.js";
import { getOpeningBook } from "./services/openingBook.js";
import { createAnalysisIndex, type EngineView } from "./services/analysisIndex.js";
import { ReviewInputError, completeReview, retryMove, reviewFromStore } from "./services/review.js";
import { DrillInputError, createDrillService } from "./services/drillService.js";
import type { DrillAnswerResponse, DrillSessionResponse, DrillStats } from "../shared/training/api.js";
import type { GameAnalysisResponse, OpeningReview, RetryResult } from "../shared/review.js";
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

const retrySchema = z.object({
  ply: z.number().int().min(1).max(OPENING_PLY_LIMIT),
  uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, "a UCI move")
});

// A position key as the tree stores it: the first four FEN fields.
const EPD_PATTERN = /^[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36])$/;

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const colorSchema = z.enum(["white", "black"]);
const epdSchema = z.string().regex(EPD_PATTERN, "an EPD: the first four FEN fields");

// The EPD travels in the body or the query, never in a path segment (it holds '/' and spaces).
const repEntrySchema = z.object({
  color: colorSchema,
  epd: epdSchema,
  uci: z.string().regex(UCI_PATTERN, "a UCI move").optional(),
  san: z.string().min(1).max(10).optional(),
  locked: z.boolean().optional(),
  status: z.enum(["active", "needs-review"]).optional(),
  note: z.string().max(500).nullable().optional(),
  ply: z.number().int().min(1).max(REPERTOIRE_MAX_PLY).optional(),
  replaces: z
    .object({
      uci: z.string().regex(UCI_PATTERN, "a UCI move"),
      loss: z.number().min(0).max(100).nullable().optional(),
      reason: z.string().max(300).optional()
    })
    .optional()
});

const repEntryKeySchema = z.object({ color: colorSchema, epd: epdSchema });

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

const alternativesQuerySchema = treeQuerySchema.extend({
  // The move to question (an Explorer row, a fix card); default: the repertoire's, else the most played.
  uci: z.string().regex(UCI_PATTERN, "a UCI move").optional()
});

const seedSchema = z.object({
  apply: z.boolean().optional(),
  window: z.string().optional(),
  tc: z.enum(IMPORTED_TIME_CLASSES).optional(),
  hl: halfLifeSchema
});

const exportQuerySchema = repertoireQuerySchema.extend({ color: colorSchema });

const treeGamesQuerySchema = treeQuerySchema.extend({
  uci: z.string().regex(UCI_PATTERN, "a UCI move"),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional()
});

const drillQuerySchema = z.object({
  kind: z.enum(["all", "repertoire-line", "own-mistake"]).optional(),
  // A card to put first: its id, or a (colour, position) by moves= or epd=.
  focus: z.string().max(200).optional(),
  color: colorSchema.optional(),
  epd: epdSchema.optional(),
  moves: z
    .string()
    .transform((value) => (value ? value.split(",") : []))
    .pipe(z.array(z.string().regex(UCI_PATTERN, "UCI moves, comma-separated")).max(OPENING_PLY_LIMIT))
    .optional()
});

// The card id holds the EPD ('/' and spaces), so it travels in the body, never in a path segment.
const drillAnswerSchema = z.object({
  id: z.string().min(1).max(200),
  uci: z.string().regex(UCI_PATTERN, "a UCI move"),
  ms: z.number().int().min(0).max(3_600_000).optional(),
  attempts: z.number().int().min(1).max(50)
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

function legalUci(epd: string, uci: string): boolean {
  return legalMove(epd, { uci }) !== null;
}

/** Runs a review step, turning its input errors into HTTP errors. */
async function withReviewErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof ReviewInputError || error instanceof RepertoireInputError || error instanceof DrillInputError
      ? new HttpError(error.status, error.message)
      : error;
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

  const analysis = createAnalysisIndex({ book: deps.book, maxPly: OPENING_PLY_LIMIT });

  /** The position cache of the current engine config, or null when no engine config resolves (no engine installed). */
  const engineView = async (): Promise<EngineView | null> => {
    const db = deps.db();
    try {
      return analysis.view(db, (await deps.engineConfig(db)).id);
    } catch {
      return null;
    }
  };

  const coverageOf = (engine: EngineView, built: BuiltTree): EngineCoverage => ({
    configId: engine.configId,
    games: built.games.length,
    complete: built.games.filter((game) => engine.analysisOf(game).status === "complete").length
  });

  // The fix list is recomputed only when either memoised tree was rebuilt, the position cache
  // changed or a repertoire entry was written.
  const fixMemo = new Map<string, { trees: Record<PlayerColor, OpeningTree>; generation: string; selection: FixList }>();
  const fixList = (built: Record<PlayerColor, BuiltTree>, engine: EngineView | null): FixList => {
    const { window, timeClass, halfLifeDays } = built.white.filters;
    const key = `${window}|${timeClass ?? "all"}|${halfLifeDays ?? "off"}`;
    const db = deps.db();
    const generation = `${engine?.generation ?? "none"}|${repertoireStamp(db, deps.owner)}`;
    const hit = fixMemo.get(key);
    if (hit && hit.trees.white === built.white.tree && hit.trees.black === built.black.tree && hit.generation === generation) {
      return hit.selection;
    }
    const entries = loadRepertoire(db, deps.owner);
    const unprepared = (colorBuilt: BuiltTree) =>
      repertoireStats(colorBuilt.tree.color, colorBuilt.games, entries[colorBuilt.tree.color], {
        now: colorBuilt.tree.now,
        halfLifeDays: colorBuilt.tree.halfLifeDays
      }).unprepared;
    const selection = buildFixList([built.white, built.black], engine ?? undefined, {
      white: unprepared(built.white),
      black: unprepared(built.black)
    });
    fixMemo.delete(key);
    fixMemo.set(key, { trees: { white: built.white.tree, black: built.black.tree }, generation, selection });
    if (fixMemo.size > 16) {
      fixMemo.delete(fixMemo.keys().next().value!);
    }
    return selection;
  };

  // Drill cards regenerate whenever their inputs changed; the repertoire routes also refresh
  // them right after a write.
  const drills = createDrillService({ db: deps.db, owner: deps.owner, trees, book: deps.book, engineView, pool: deps.pool, jobs: deps.jobs });
  const refreshDrills = () => {
    void drills.regenerate(deps.now()).catch((error: unknown) => console.warn(`Drill regeneration failed: ${String(error)}`));
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
      await drills.regenerate(deps.now());
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
  router.get("/tree", async (request, response) => {
    const query = treeQuerySchema.parse(request.query);
    const { built, node, path } = findTreeNode(trees, query, deps.now());
    const engine = await engineView();
    const view = engine
      ? nodeView(node, {
          node: nodeEngine(node, built.games, engine.analysisOf, engine.lookup, built.tree.maxPly),
          edge: (edge) => edgeEngine(node, edge, engine.lookup)
        })
      : nodeView(node);
    response.json({
      window: built.window,
      color: query.color,
      timeClass: built.filters.timeClass,
      halfLifeDays: built.filters.halfLifeDays,
      maxPly: built.tree.maxPly,
      games: built.tree.games,
      node: view,
      path,
      engine: engine ? coverageOf(engine, built) : null,
      repertoire: node.ownerToMove ? getRepEntry(deps.db(), deps.owner, query.color, node.epd) ?? null : null
    } satisfies TreeResponse);
  });

  // Fix list v0: the owner's moves that lose points against his Elo expectation, over both
  // colours (one multiple-comparison family), with blame attribution. Results only.
  router.get("/fixlist", async (request, response) => {
    const { built, scope } = bothTrees(repertoireQuerySchema.parse(request.query));
    const engine = await engineView();
    const selection = fixList(built, engine);
    const summary = (colorBuilt: BuiltTree): ColorEngineSummary => {
      const analyses = colorBuilt.games.map((game) => engine!.analysisOf(game));
      return {
        ...coverageOf(engine!, colorBuilt),
        firstErrorShares: firstErrorShares(analyses, [10, 16, 20]).map(({ ply, known, errors, rate }) => ({
          ply,
          known,
          errors,
          rate,
          shown: coverageOk(known, analyses.length)
        }))
      };
    };
    response.json({
      ...scope,
      tested: selection.tested,
      significant: selection.significant,
      items: selection.ranked,
      holes: selection.holes.length,
      unprepared: selection.unprepared.length,
      watch: selection.watch,
      engine: engine ? { white: summary(built.white), black: summary(built.black) } : null,
      cap: FIX_LIST_CAP,
      thresholds: {
        minN: FIX_MIN_N,
        minEss: FIX_MIN_ESS,
        minZ: FIX_MIN_Z,
        fdrQ: FIX_FDR_Q,
        minPoints: FIX_MIN_POINTS,
        earlyLossPly: EARLY_LOSS_PLY,
        hole: { minN: ENGINE_HOLE_MIN_N, minLoss: ENGINE_HOLE_MIN_LOSS, replyLoss: ENGINE_HOLE_REPLY_LOSS, replyCp: ENGINE_HOLE_REPLY_CP },
        engine: { minGames: ENGINE_MIN_GAMES, minCoverage: ENGINE_MIN_COVERAGE }
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

  // The opening review of one stored game, from the position cache. A game whose positions are
  // all cached (e.g. backfilled) is answered at once (200). Otherwise the missing positions are
  // queued at interactive priority as one job per game ("review:<gameId>"; opening the review
  // twice joins it), and the partial review is answered with 202 and the job id; the job's
  // result is the complete review.
  router.get("/games/:id/analysis", async (request, response) => {
    const gameId = request.params.id;
    const db = deps.db();
    const book = deps.book();
    let configId: number | null = null;
    let engineError: string | null = null;
    try {
      configId = (await deps.engineConfig(db)).id;
    } catch (error) {
      engineError = `Stockfish is not available: ${error instanceof Error ? error.message : String(error)}`;
    }
    const review = await withReviewErrors(async () => reviewFromStore(db, gameId, configId, book));
    const entries = loadRepertoire(db, deps.owner)[review.color];
    const walk = walkRepertoire({ color: review.color, plies: getGamePlies(db, gameId) }, entries);
    const repertoire = { entries: entries.size, deviation: walk.deviation, unprepared: walk.unprepared, inRepThrough: walk.inRepThrough };
    if (review.status === "complete" || configId === null) {
      response.json({ review, job: null, engineError, repertoire } satisfies GameAnalysisResponse);
      return;
    }
    const engineConfigId = configId;
    const { job } = deps.jobs.startOrReuse<OpeningReview>(`review:${gameId}`, "game-review", "Opening review", async (reporter) => {
      reporter.progress(5, "Starting Stockfish");
      return completeReview({ db: deps.db(), pool: deps.pool(), configId: engineConfigId }, gameId, book, (done, total) =>
        reporter.progress(5 + (done / total) * 90, `Stockfish: ${done} of ${total} positions`)
      );
    });
    response.status(202).json({ review, job, engineError, repertoire } satisfies GameAnalysisResponse);
  });

  // Retry: judges the owner's move {ply, uci} from the position before ply `ply` against the
  // cached best line. A move the cache has not scored is scored now at interactive priority.
  router.post("/games/:id/retry", async (request, response) => {
    const { ply, uci } = retrySchema.parse(request.body);
    const db = deps.db();
    const configId = (await deps.engineConfig(db)).id;
    const result = await withReviewErrors(() => retryMove({ db, pool: deps.pool(), configId }, request.params.id, ply, uci));
    response.json(result satisfies RetryResult);
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

  /** Both colours' repertoire views in the query's filters. */
  const repertoireViews = async (query: RepertoireQuery) => {
    const { built, scope } = bothTrees(query);
    const engine = await engineView();
    const entries = loadRepertoire(deps.db(), deps.owner);
    const view = (colorBuilt: BuiltTree) =>
      colorView(colorBuilt.tree, colorBuilt.games, entries[colorBuilt.tree.color], engine?.lookup ?? null, {
        now: colorBuilt.tree.now,
        halfLifeDays: colorBuilt.tree.halfLifeDays
      });
    return { scope, engine, white: view(built.white), black: view(built.black) };
  };

  // The repertoire: per colour, the lines walked from the start (the entry at the owner's
  // positions, the frequent replies at the opponent's), coverage, deviations and unprepared
  // replies, all computed from the stored entries at read time.
  router.get("/repertoire", async (request, response) => {
    const { scope, engine, white, black } = await repertoireViews(repertoireQuerySchema.parse(request.query));
    response.json({ ...scope, white, black, engine: engine !== null } satisfies RepertoireResponse);
  });

  // Home's coverage line: per colour, the entries and the share of games still in the repertoire.
  router.get("/repertoire/coverage", (request, response) => {
    const { built, scope } = bothTrees(repertoireQuerySchema.parse(request.query));
    const entries = loadRepertoire(deps.db(), deps.owner);
    const side = (colorBuilt: BuiltTree) => {
      const color = colorBuilt.tree.color;
      const stats = repertoireStats(color, colorBuilt.games, entries[color], { now: colorBuilt.tree.now, halfLifeDays: colorBuilt.tree.halfLifeDays });
      const all = [...entries[color].values()];
      return { entries: all.length, needsReview: all.filter((entry) => entry.status === "needs-review").length, coverage: stats.coverage };
    };
    response.json({ ...scope, white: side(built.white), black: side(built.black) } satisfies RepertoireCoverageResponse);
  });

  // Seeds (or re-seeds) the repertoire from the games: a dry-run diff, written with {apply: true}.
  // Locked and edited entries are never changed.
  router.post("/repertoire/seed", async (request, response) => {
    const { apply, ...query } = seedSchema.parse(request.body ?? {});
    const { built } = bothTrees(query);
    const engine = await engineView();
    const fix = fixList(built, engine);
    const flagged = [...fix.items, ...fix.watch];
    const diff = seedRepertoire(
      deps.db(),
      deps.owner,
      { white: { tree: built.white.tree, flagged }, black: { tree: built.black.tree, flagged } },
      engine?.lookup ?? null,
      apply === true,
      deps.now(),
      deps.book()
    );
    if (apply === true) {
      refreshDrills();
    }
    response.json({ applied: apply === true, diff } satisfies SeedResponse);
  });

  // The owner's edit of one entry: {color, epd, uci | san} sets his move (edited, locked);
  // {color, epd, locked | status | note} changes only those. Returns the entry.
  router.put("/repertoire/entry", async (request, response) => {
    const edit = repEntrySchema.parse(request.body);
    const entry = await withReviewErrors(async () => editEntry(deps.db(), deps.owner, edit, deps.now()));
    refreshDrills();
    response.json({ entry });
  });

  router.get("/repertoire/entry", (request, response) => {
    const { color, epd } = repEntryKeySchema.parse(request.query);
    const entry = getRepEntry(deps.db(), deps.owner, color, epd);
    if (!entry) {
      throw new HttpError(404, `No ${color} entry at ${epd}.`);
    }
    response.json({ entry });
  });

  router.delete("/repertoire/entry", (request, response) => {
    const { color, epd } = repEntryKeySchema.parse(request.query);
    if (!deleteRepEntry(deps.db(), deps.owner, color, epd)) {
      throw new HttpError(404, `No ${color} entry at ${epd}.`);
    }
    refreshDrills();
    response.status(204).end();
  });

  // One colour's repertoire lines as a PGN file with variations.
  router.get("/repertoire/export", async (request, response) => {
    const { color, ...query } = exportQuerySchema.parse(request.query);
    const views = await repertoireViews(query);
    const pgn = repertoirePgn(views[color], deps.owner, new Date(deps.now()));
    response.setHeader("Content-Type", "application/x-chess-pgn; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${deps.owner}-repertoire-${color}.pgn"`);
    response.send(pgn);
  });

  // Offline alternatives at an owner-to-move position (by moves= or epd=), with ?uci= the move to
  // question. Answered at once (200) when the deep row and the only-move checks are cached;
  // otherwise 202 with a preliminary ranking on the owner-tier cache and the job
  // ("alternatives:<color>:<epd>:<uci>", interactive priority) whose result is the complete answer.
  router.get("/alternatives", async (request, response) => {
    const query = alternativesQuerySchema.parse(request.query);
    const { built, node, path } = findTreeNode(trees, query, deps.now());
    if (!node.ownerToMove) {
      throw new HttpError(400, "Alternatives are for positions where you are to move.");
    }
    const treePath = query.moves
      ? { moves: path.map((step) => step.uci), sans: path.map((step) => step.san) }
      : principalPaths(built.tree).get(node.epd) ?? { moves: [], sans: [] };
    if (query.uci && !node.edges.some((edge) => edge.uci === query.uci) && !legalUci(node.epd, query.uci)) {
      throw new HttpError(400, `${query.uci} is not a legal move here.`);
    }
    const engine = await engineView();
    const { built: both } = bothTrees(query);
    const fix = fixList(both, engine);
    const db = deps.db();
    const source: AltSource = {
      tree: built.tree,
      games: built.games,
      book: deps.book(),
      epd: node.epd,
      path: treePath,
      lookup: engine?.lookup ?? null,
      flags: seedFlags([...fix.items, ...fix.watch], query.color),
      entries: loadRepertoire(db, deps.owner)[query.color],
      current: query.uci ?? null
    };
    if (!engine) {
      const state = alternativesState(source, null);
      response.json({
        status: "no-engine",
        result: state.ready ? state.result : state.preliminary,
        job: null,
        engineError: "Stockfish is not available, so no move can pass the engine gate.",
        cost: null
      } satisfies AlternativesResponse);
      return;
    }
    const state = alternativesState(source, { db, configId: engine.configId });
    if (state.ready) {
      response.json({ status: "complete", result: state.result, job: null, engineError: null, cost: null } satisfies AlternativesResponse);
      return;
    }
    const configId = engine.configId;
    const { job } = deps.jobs.startOrReuse<AlternativesResponse>(
      `alternatives:${query.color}:${node.epd}:${query.uci ?? ""}`,
      "alternatives",
      "Deep engine check",
      async (reporter) => {
        reporter.progress(3, "Starting Stockfish");
        const { result, cost } = await completeAlternatives(
          { db: deps.db(), pool: deps.pool(), configId },
          source,
          () => analysis.view(deps.db(), configId).lookup,
          (done, total, message) => reporter.progress(5 + (total ? (done / total) * 90 : 0), message)
        );
        return { status: "complete", result, job: null, engineError: null, cost };
      }
    );
    response.status(202).json({ status: "preliminary", result: state.preliminary, job, engineError: null, cost: null } satisfies AlternativesResponse);
  });

  // Drills: today's due counts (introducing the day's new cards within the caps).
  router.get("/drills/stats", async (_request, response) => {
    response.json((await drills.stats(deps.now())) satisfies DrillStats);
  });

  // A session: line runs from move 1 and positions from the owner's games, due first (optionally
  // one kind, or a focused card first). Starts the deep check of today's new mistake cards as the
  // job "drills:check" when they need one.
  router.get("/drills/due", async (request, response) => {
    const query = drillQuerySchema.parse(request.query);
    if (query.moves && query.epd) {
      throw new HttpError(400, "Pass either moves= or epd=, not both.");
    }
    let epd = query.epd;
    if (query.moves) {
      epd = START_EPD;
      for (const uci of query.moves) {
        const move = legalMove(epd, { uci });
        if (!move) {
          throw new HttpError(400, `${uci} is not a legal move after ${query.moves.slice(0, query.moves.indexOf(uci)).join(",") || "the start"}.`);
        }
        epd = move.toEpd;
      }
    }
    if (epd && !query.color) {
      throw new HttpError(400, "A position needs its colour (color=white|black).");
    }
    const result = await drills.session(deps.now(), { kind: query.kind ?? "all", focus: { id: query.focus, color: query.color, epd } });
    response.json(result satisfies DrillSessionResponse);
  });

  // Judges and grades one answer {id, uci, ms, attempts}; only the first graded try changes the schedule.
  router.post("/drills/answer", async (request, response) => {
    const body = drillAnswerSchema.parse(request.body);
    const result = await withReviewErrors(() => drills.answer(deps.now(), body));
    response.json(result satisfies DrillAnswerResponse);
  });

  // Rebuilds the cards now (they also regenerate on their own when the inputs change).
  router.post("/drills/regenerate", async (_request, response) => {
    const result = await drills.regenerate(deps.now(), true);
    response.json({ ...result, stats: await drills.stats(deps.now()) });
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
