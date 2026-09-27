import type { IMPORTED_TIME_CLASSES, MOVE_CATEGORIES, SKIP_REASONS } from "./constants.js";
import type { FixItem } from "./fixList.js";
import type { TreeEdge, TreeNode } from "./openingTree.js";
import type { ColorSnapshot } from "./repertoireSnapshot.js";
import type { GameWindow } from "./window.js";

export type MoveCategory = (typeof MOVE_CATEGORIES)[number];
/** The standard time classes the importer keeps. */
export type TimeClass = (typeof IMPORTED_TIME_CLASSES)[number];
export type PlayerColor = "white" | "black";
export type GameResult = "win" | "loss" | "draw";

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

/** Which analysis a position gets: the owner to move (MultiPV 3) or the opponent to move (MultiPV 1). */
export type EngineTier = "owner" | "opponent";

/**
 * One engine line, as Stockfish reports it: UCI moves, score from the side to move (exactly
 * one of cp / mate is set; mate <= 0 means the side to move is mated). winPct is the side to
 * move's lichess win% for the score.
 */
export interface EngineLine {
  uci: string;
  cp: number | null;
  mate: number | null;
  winPct: number;
  depth: number;
  /** The principal variation, starting with `uci`, at most 10 moves. */
  pv: string[];
}

/** The engine's verdict on one position under one engine config and tier. */
export interface PositionEval {
  epd: string;
  tier: EngineTier;
  /** Depth of the MultiPV iteration the lines come from (0 for a terminal position). */
  depth: number;
  /** Nodes searched for this position (main search plus searchmoves follow-ups). */
  nodes: number;
  /** The MultiPV lines, best first, one per move, all from one completed iteration. */
  lines: EngineLine[];
  /**
   * Moves played from this position that are not in `lines`, scored at the same root with a
   * depth-matched `go depth <depth> searchmoves ...` follow-up.
   */
  scored: EngineLine[];
  terminal: "checkmate" | "stalemate" | null;
  /** lines[0].uci, or null for a terminal position. */
  bestUci: string | null;
  /** The position's score from the side to move: lines[0], mate 0 for checkmate, cp 0 for stalemate. */
  score: { cp: number | null; mate: number | null };
}

/** One move of a game's opening, judged at its own root (best line vs the played move). */
export interface OpeningMoveVerdict {
  ply: number;
  san: string;
  uci: string;
  /** The mover's win% loss against the best line, rounded to 0.01. */
  lossWinPct: number;
  category: MoveCategory;
}

/** One side's moves in a game's opening window. */
export interface OpeningSideSummary {
  moves: number;
  categories: Record<MoveCategory, number>;
  /** Mean win% loss per move. */
  avgLoss: number;
  /** Mean lichess per-move accuracy, 0-100. */
  accuracy: number;
  /** The first move classed mistake or worse ("opening error"), or null. */
  firstError: OpeningMoveVerdict | null;
  /** The move with the largest loss, or null when the side made no move. */
  worst: OpeningMoveVerdict | null;
}

/** An eval from the owner's side: cp clamped to +/-1000, mate > 0 when the owner mates. */
export interface OwnerViewEval {
  /** The eval after this ply: the played move's score at the ply's root. */
  ply: number;
  cp: number;
  mate: number | null;
  /** The owner's (engine) win chance, 0-100. */
  winPct: number;
}

/** game_analysis.summary_json: a game's opening under one engine config. */
export interface GameOpeningSummary {
  version: 1;
  color: PlayerColor;
  /** Plies covered: min(OPENING_PLY_LIMIT, the game's length). */
  plies: number;
  owner: OpeningSideSummary;
  opponent: OpeningSideSummary;
  /** Evals after plies 12, 16 and 20 (those the game reached). */
  evalAfter: OwnerViewEval[];
}

/** A backfill pass: the owner-to-move positions first, then the opponent-to-move ones. */
export type BackfillPass = EngineTier | "done";

export interface BackfillProgress {
  pass: BackfillPass;
  games: { total: number; done: number; failed: number };
  positions: {
    /** Unique (tier, EPD) positions in the queued games. */
    total: number;
    /** Positions the cache already answered when the run started. */
    cached: number;
    /** Positions to search, per pass. */
    owner: { done: number; total: number };
    opponent: { done: number; total: number };
  };
  nodes: number;
  /** Pool-wide nodes per second over the last searches, or null before the first ones. */
  nps: number | null;
  etaSec: number | null;
  startedAt: number;
  updatedAt: number;
}

export type BackfillRunStatus = "running" | "completed" | "paused" | "failed";

/** A row of backfill_runs. */
export interface BackfillRun {
  id: number;
  source: "cli" | "server";
  configId: number;
  workers: number;
  onBattery: boolean | null;
  startedAt: number;
  finishedAt: number | null;
  status: BackfillRunStatus;
  gamesQueued: number;
  gamesDone: number;
  gamesFailed: number;
  positionsSearched: number;
  nodes: number;
  searchMs: number;
  error: string | null;
}

export interface PowerState {
  onBattery: boolean;
  /** Battery charge, 0-100, when there is a battery. */
  percent: number | null;
  lowPowerMode: boolean | null;
}

/** "idle": nothing running (the queue may still hold games); "paused": stopped by the owner. */
export type BackfillState = "idle" | "running" | "pausing" | "paused" | "failed";

/** GET /api/analysis/status. */
export interface AnalysisStatus {
  engine: { idName: string; configId: number } | null;
  engineError: string | null;
  state: BackfillState;
  /** Who runs the backfill right now: this server, or `npm run backfill` in a terminal. */
  runner: { source: "server" | "cli"; pid: number; startedAt: number } | null;
  progress: BackfillProgress | null;
  error: string | null;
  lastRun: BackfillRun | null;
  window: { start: number; days: number };
  games: {
    total: number;
    analysed: number;
    queued: number;
    byColor: Record<PlayerColor, { total: number; analysed: number }>;
  };
  positions: { total: number; cached: number; byTier: Record<EngineTier, { total: number; cached: number }> };
  /** The time the queue would take, from this machine's last measured speed when there is one. */
  estimate: { minutes: number; nps: number; measured: boolean } | null;
  power: PowerState | null;
  autoBackfill: boolean;
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

/** GET /api/games/:id. */
export interface GameResponse {
  game: GameRecord;
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

/** The filters a whole-repertoire answer (fix list, snapshot) was computed for. */
export interface RepertoireScope {
  window: QueryWindow;
  /** null = blitz and rapid together. */
  timeClass: TimeClass | null;
  /** Recency half-life in days; null = unweighted. */
  halfLifeDays: number | null;
  maxPly: number;
  games: Record<PlayerColor, number>;
}

/** GET /api/fixlist: results-only leaks over both colours' trees. */
export interface FixListResponse extends RepertoireScope {
  /** Owner moves with enough games that were tested (one Benjamini-Hochberg family). */
  tested: number;
  significant: number;
  items: FixItem[];
  /** Nominally significant lines that do not survive the multiple-comparison control. */
  watch: FixItem[];
  thresholds: { minN: number; minEss: number; minZ: number; fdrQ: number; minPoints: number; earlyLossPly: number };
}

/** GET /api/snapshot: the main opponent moves and the owner's answers, per colour. */
export interface SnapshotResponse extends RepertoireScope {
  white: ColorSnapshot;
  black: ColorSnapshot;
}
