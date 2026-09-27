import type { IMPORTED_TIME_CLASSES, MOVE_CATEGORIES, SUPPORTED_TIME_CLASSES } from "./constants.js";

export type MoveCategory = (typeof MOVE_CATEGORIES)[number];
export type TimeClass = (typeof SUPPORTED_TIME_CLASSES)[number];
export type PlayerColor = "white" | "black";
export type GameResult = "win" | "loss" | "draw";

export interface PlayerSnapshot {
  username: string;
  rating: number;
  result: string;
}

export interface ArchiveGame {
  id: string;
  url: string;
  pgn: string;
  endTime: number;
  timeClass: TimeClass;
  timeControl: string;
  rated: boolean;
  openingName: string;
  openingUrl: string | null;
  openingFamily: string;
  white: PlayerSnapshot;
  black: PlayerSnapshot;
}

/** A results-only game summary, built from the raw games cache (no engine). */
export interface HistoryGameSummary {
  id: string;
  url: string;
  opponent: string;
  opponentRating: number;
  playerRating: number;
  color: PlayerColor;
  result: GameResult;
  openingName: string;
  openingFamily: string;
  endTime: number;
  /** Half-moves in the game. The UI shows full moves (ceil(plies / 2)). */
  plies: number;
  timeClass: TimeClass;
  timeControl?: string;
}

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

export interface OpeningsSnapshot {
  username: string;
  analyzedAt: string;
  limit: number;
  games: HistoryGameSummary[];
  topOpenings: OpeningReportItem[];
}

export interface JobState<T> {
  id: string;
  type: "bulk-analysis" | "game-review";
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  result?: T;
  error?: string;
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

export type ImportedTimeClass = (typeof IMPORTED_TIME_CLASSES)[number];

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
  timeClass: ImportedTimeClass;
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
