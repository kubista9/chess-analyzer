import express from "express";
import { z } from "zod";
import { IMPORTED_TIME_CLASSES, OPENING_PLY_LIMIT } from "../shared/constants.js";
import type {
  GameResponse,
  GamesResponse,
  OpeningReportResponse,
  QueryWindow,
  ReviewSummary,
  TreeBreadcrumb,
  SyncJobResult,
  TreeGamesResponse,
  TreeResponse
} from "../shared/types.js";
import { START_EPD } from "../shared/epd.js";
import type { OpeningBook } from "../shared/openingBook.js";
import { nodeView, walkMoves, type TreeNode } from "../shared/openingTree.js";
import { GAME_WINDOWS, parseGameWindow, windowBounds } from "../shared/window.js";
import { config } from "./config.js";
import { getDb, type Db } from "./db/connection.js";
import { getGame, listGames, listMoveGames } from "./db/games.js";
import { jobStore as defaultJobStore, type JobStore } from "./store/jobStore.js";
import { syncArchives } from "./services/archiveImport.js";
import { buildImportStatus } from "./services/importStatus.js";
import { getOpeningBook } from "./services/openingBook.js";
import { buildOpeningReport } from "./services/openingReport.js";
import { readCachedGameReview, runGameReview } from "./services/reviewAnalysis.js";
import { DEFAULT_HALF_LIFE_BY_WINDOW, createTreeService, type BuiltTree, type TreeService } from "./services/treeService.js";

const reviewSchema = z.object({
  gameId: z.string().min(1)
});

const syncSchema = z.object({
  full: z.boolean().optional()
});

const gamesQuerySchema = z.object({
  window: z.string().optional(),
  tc: z.enum(IMPORTED_TIME_CLASSES).optional(),
  color: z.enum(["white", "black"]).optional()
});

// A position key as the tree stores it: the first four FEN fields.
const EPD_PATTERN = /^[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] (?:-|[KQkq]{1,4}) (?:-|[a-h][36])$/;

const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

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
  // Half-life in days, or "off" / 0 for unweighted; omitted = the window's default.
  hl: z
    .union([z.literal("off"), z.coerce.number().min(0).max(3650)])
    .optional()
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
    message: string
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

/** The memoised tree for the query's filters and the node it asks for (moves=, epd= or the start). */
function findTreeNode(trees: TreeService, query: TreeQuery, nowMs: number): { built: BuiltTree; node: TreeNode; path: TreeBreadcrumb[] } {
  const window = parseGameWindow(query.window);
  if (!window) {
    throw new HttpError(400, `Unknown window "${String(query.window)}"; use 6m or 3m.`);
  }
  if (query.moves && query.epd) {
    throw new HttpError(400, "Pass either moves= or epd=, not both.");
  }
  const halfLifeDays =
    query.hl === undefined ? DEFAULT_HALF_LIFE_BY_WINDOW[window] : query.hl === "off" || query.hl === 0 ? null : query.hl;
  const built = trees.getTree({ color: query.color, window, timeClass: query.tc ?? null, halfLifeDays }, nowMs);

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
}

export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  const trees = createTreeService({ db: deps.db, owner: deps.owner, book: deps.book });

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
      return { summary, status: buildImportStatus(deps.db(), deps.owner, deps.now()) };
    });
    response.status(202).json(job);
  });

  // Every stored game in the window, newest first, with no count cap.
  router.get("/games", (request, response) => {
    const query = gamesQuerySchema.parse(request.query);
    const window = queryWindow(query.window, deps.now());
    const games = listGames(deps.db(), deps.owner, window, { timeClass: query.tc, color: query.color });
    response.json({ window, games } satisfies GamesResponse);
  });

  router.get("/games/:id", (request, response) => {
    const game = getGame(deps.db(), request.params.id);
    if (!game) {
      throw new HttpError(404, `Game ${request.params.id} is not in the game store.`);
    }
    response.json({ game } satisfies GameResponse);
  });

  // Results-only report over the stored games in the window.
  router.get("/openings/report", (request, response) => {
    const query = gamesQuerySchema.parse(request.query);
    const window = queryWindow(query.window, deps.now());
    const games = listGames(deps.db(), deps.owner, window, { timeClass: query.tc });
    const totals = { white: 0, black: 0 };
    for (const game of games) {
      totals[game.color] += 1;
    }
    response.json({ window, totals, items: buildOpeningReport(games) } satisfies OpeningReportResponse);
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

  // Starts (or joins) the opening review of one stored game, keyed "review:<gameId>".
  router.post("/game-review", async (request, response) => {
    const { gameId } = reviewSchema.parse(request.body);
    if (!getGame(deps.db(), gameId)) {
      throw new HttpError(404, `Game ${gameId} is not in the game store. Sync from Home first.`);
    }

    const key = `review:${gameId}`;
    const cached = await readCachedGameReview(gameId);
    if (cached) {
      response.json(deps.jobs.completed<ReviewSummary>(key, "game-review", "Opening review ready", cached));
      return;
    }

    const { job } = deps.jobs.startOrReuse<ReviewSummary>(key, "game-review", "Opening review", async (reporter) => {
      reporter.progress(5, "Starting Stockfish");
      const review = await runGameReview(deps.db(), gameId, (done, total) =>
        reporter.progress(5 + (done / total) * 90, `Stockfish: position ${done + 1} of ${total}`)
      );
      return review;
    });
    response.status(202).json(job);
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

export const apiRouter = createApiRouter({
  db: getDb,
  jobs: defaultJobStore,
  owner: config.owner,
  now: Date.now,
  sync: syncArchives,
  book: getOpeningBook
});
