import type { CHESS_PHASES, MOVE_CATEGORIES, SUPPORTED_TIME_CLASSES } from "./constants.js";

export type MoveCategory = (typeof MOVE_CATEGORIES)[number];
export type ChessPhase = (typeof CHESS_PHASES)[number];
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
  moves: number;
  timeClass: TimeClass;
  timeControl?: string;
  accuracy: number | null;
  avgCentipawnLoss: number | null;
  categories: Record<MoveCategory, number>;
  firstMajorErrorPly: number | null;
}

export interface OpeningReportItem {
  openingFamily: string;
  games: number;
  winRate: number;
  avgAccuracy: number | null;
  avgBlunders: number;
  avgFirstErrorPly: number | null;
  recommendation: string;
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

export interface EngineLine {
  move: string;
  scoreCp: number;
  mate: number | null;
  pv: string[];
}

export interface AnnotatedMove {
  ply: number;
  moveNumber: number;
  san: string;
  uci: string;
  color: PlayerColor;
  phase: ChessPhase;
  category: MoveCategory;
  scoreBeforeCp: number;
  scoreAfterCp: number;
  lossCp: number;
  bestLine: EngineLine;
  fenBefore: string;
  fenAfter: string;
  note: string;
  isPlayerMove: boolean;
}

export interface ReviewSummary {
  game: HistoryGameSummary;
  moves: AnnotatedMove[];
}
