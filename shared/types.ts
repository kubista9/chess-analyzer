import type { IMPORTED_TIME_CLASSES, MOVE_CATEGORIES, SKIP_REASONS } from "./constants.js";
import type { TreeEdge, TreeNode } from "./openingTree.js";
import type { GameWindow } from "./window.js";

export type MoveCategory = (typeof MOVE_CATEGORIES)[number];
/** The standard time classes the importer keeps. */
export type TimeClass = (typeof IMPORTED_TIME_CLASSES)[number];
export type PlayerColor = "white" | "black";
export type GameResult = "win" | "loss" | "draw";

/** Results for one opening family, played with one colour. */
export interface OpeningReportItem {
  color: PlayerColor;
  openingFamily: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** (wins + 0.5 * draws) / games, as a percentage. */
  scorePct: number;
}

export type JobType = "sync" | "game-review";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobState<T> {
  id: string;
  /** Dedupe key: "sync" or "review:<gameId>". A second start with a running key joins that job. */
  key: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  message: string;
  result?: T;
  error?: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  updatedAt: number;
}

/** A raw engine line, as Stockfish reports it: UCI moves, score from the side to move. */
export interface EngineLine {
  move: string;
  scoreCp: number;
  mate: number | null;
  pv: string[];
}

/** An engine line prepared for display: SAN moves, White-view eval. */
export interface ReviewLine {
  uci: string;
  san: string;
  /** The principal variation in SAN, starting with `san`. */
  pvSan: string[];
  whiteCp: number;
  mate: number | null;
}

export interface AnnotatedMove {
  ply: number;
  moveNumber: number;
  san: string;
  uci: string;
  color: PlayerColor;
  category: MoveCategory;
  /** Evals from White's point of view (cp clamped to +/-1000; mate kept separately, + = White mates). */
  whiteCpBefore: number;
  whiteCpAfter: number;
  mateBefore: number | null;
  mateAfter: number | null;
  /** Win% the mover gave away (lichess formula), never negative. */
  lossWinPct: number;
  bestLine: ReviewLine;
  fenBefore: string;
  fenAfter: string;
  note: string;
  isPlayerMove: boolean;
}

/** A small header for the review page, derived from the archive game (no engine fields). */
export interface ReviewGameHeader {
  url: string;
  endTime: number;
  timeClass: TimeClass;
  openingName: string;
  result: GameResult;
  white: { username: string; rating: number };
  black: { username: string; rating: number };
}

export interface ReviewSummary {
  gameId: string;
  /** The owner's colour. */
  color: PlayerColor;
  header: ReviewGameHeader;
  /** At most OPENING_PLY_LIMIT moves. */
  moves: AnnotatedMove[];
}

/** One ply of a game's opening, as stored in game_plies (the first DERIVE_PLY_LIMIT plies). */
export interface OpeningPly {
  /** 1-based half-move number. */
  ply: number;
  san: string;
  uci: string;
  epdBefore: string;
  epdAfter: string;
  /** The mover's clock after the move (%clk), in ms. */
  clockMs: number | null;
  /** Time the move took: previous own clock - clock + increment, floored at 0, in ms. */
  spentMs: number | null;
}

/**
 * A standard blitz/rapid game of the owner, derived once from the raw archive month.
 * Ratings are Chess.com's post-game ratings (the ~8-point difference to the pre-game
 * rating is ignored).
 */
export interface GameRecord {
  id: string;
  uuid: string | null;
  url: string;
  /** The archive month the game came from, "YYYY-MM". */
  month: string;
  /** Unix seconds, UTC. */
  endTime: number;
  timeClass: TimeClass;
  timeControl: string;
  tc: { base: number; inc: number } | null;
  rated: boolean;
  color: PlayerColor;
  result: GameResult;
  /** The owner's Chess.com result code, e.g. "win", "resigned", "agreed". */
  resultCode: string;
  score: 1 | 0.5 | 0;
  myRating: number;
  oppRating: number;
  oppName: string;
  eco: string | null;
  ecoUrl: string | null;
  /** The name from Chess.com's ECOUrl slug. */
  openingName: string;
  termination: string | null;
  plyCount: number;
  deriveVersion: number;
}

export type SkipReason = (typeof SKIP_REASONS)[number];
export type SkipCounts = Record<SkipReason, number>;

export interface GameCounts {
  total: number;
  byTimeClass: Record<TimeClass, number>;
  byColor: Record<PlayerColor, number>;
  /** e.g. { "blitz|white": 612 } */
  byTimeClassColor: Record<string, number>;
  firstEndTime: number | null;
  lastEndTime: number | null;
}

export type MonthOutcome = "fetched" | "not-modified" | "cached-closed" | "error";

export interface MonthSyncResult {
  month: string;
  outcome: MonthOutcome;
  status?: number;
  games?: number;
  message?: string;
}

export interface SyncSummary {
  owner: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** False when any warning was raised. */
  ok: boolean;
  /** The archive list could not be fetched. */
  offline: boolean;
  full: boolean;
  requests: number;
  /** Every month Chess.com lists, "YYYY-MM". */
  listedMonths: string[];
  /** The listed months that intersect the window at sync time. */
  windowMonths: string[];
  months: MonthSyncResult[];
  derivedMonths: string[];
  seededMonths: string[];
  warnings: string[];
}

export interface ImportStatusMonth {
  month: string;
  /** Raw archive length. */
  archiveGames: number;
  kept: number | null;
  skipped: SkipCounts | null;
  /** Stored games by time class. */
  stored: Record<string, number>;
  lastStatus: number;
  fetchedAt: number;
  checkedAt: number;
  deriveVersion: number | null;
}

/** GET /api/status. */
export interface ImportStatus {
  owner: string;
  window: { days: number; start: number; end: number };
  /** Games in the window. */
  counts: GameCounts;
  /** Every stored game, window or not. */
  storedTotal: number;
  lastSync: {
    at: number;
    ok: boolean;
    offline: boolean;
    requests: number;
    durationMs: number;
    warnings: string[];
    months: MonthSyncResult[];
  } | null;
  lastSuccessfulSyncAt: number | null;
  stale: boolean;
  /** Months only present as offline seed rows (no archive data yet). */
  seededMonths: string[];
  months: ImportStatusMonth[];
}

/** The result of a completed sync job. */
export interface SyncJobResult {
  summary: SyncSummary;
  status: ImportStatus;
}

/** The window a store query covered: `key` days back from `end`, both bounds inclusive (Unix seconds). */
export interface QueryWindow {
  key: GameWindow;
  days: number;
  start: number;
  end: number;
}

/** GET /api/games. Newest first, no cap. */
export interface GamesResponse {
  window: QueryWindow;
  games: GameRecord[];
}

/** GET /api/games/:id. */
export interface GameResponse {
  game: GameRecord;
}

/** GET /api/openings/report. */
export interface OpeningReportResponse {
  window: QueryWindow;
  /** Games per colour in the window; each colour's items add up to its total. */
  totals: Record<PlayerColor, number>;
  items: OpeningReportItem[];
}

/** A move row as the API sends it: the tree edge without its game ids (GET /api/tree/games pages them). */
export type TreeEdgeView = Omit<TreeEdge, "gameIds">;

export interface TreeNodeView extends Omit<TreeNode, "edges"> {
  edges: TreeEdgeView[];
}

/** One step of the move path from the start position (a breadcrumb). */
export interface TreeBreadcrumb {
  /** 1-based ply of the move. */
  ply: number;
  san: string;
  uci: string;
  /** The position after the move. */
  epd: string;
  /** Games that played the path up to and including this move. */
  n: number;
  name: string | null;
  eco: string | null;
  nameExact: boolean;
}

/** GET /api/tree: one node of the owner's per-colour opening tree, with its move rows. */
export interface TreeResponse {
  window: QueryWindow;
  color: PlayerColor;
  /** null = blitz and rapid together. */
  timeClass: TimeClass | null;
  /** Recency half-life in days; null = unweighted. */
  halfLifeDays: number | null;
  /** Plies per game in the tree (OPENING_PLY_LIMIT). */
  maxPly: number;
  /** Games of this colour in the tree. */
  games: number;
  node: TreeNodeView;
  /** The moves from the start when the node was asked for by `moves=`; empty for `epd=`. */
  path: TreeBreadcrumb[];
}

/** A game that played one move of the tree, for the Explorer's games drawer. */
export interface TreeGameRow {
  id: string;
  url: string;
  /** Unix seconds. */
  endTime: number;
  timeClass: TimeClass;
  timeControl: string;
  result: GameResult;
  myRating: number;
  oppName: string;
  oppRating: number;
  /** The ply at which this game played the move (for /review/:id?ply=N), null if not found. */
  ply: number | null;
}

/** GET /api/tree/games: one page of the games behind a move row, newest first. */
export interface TreeGamesResponse {
  color: PlayerColor;
  /** The position the move is played from, and the move. */
  epd: string;
  uci: string;
  san: string;
  /** Games behind the move in this filter set. */
  total: number;
  /** 1-based. */
  page: number;
  pageSize: number;
  pages: number;
  games: TreeGameRow[];
}
