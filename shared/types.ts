import type { MOVE_CATEGORIES, SUPPORTED_TIME_CLASSES } from "./constants.js";

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
