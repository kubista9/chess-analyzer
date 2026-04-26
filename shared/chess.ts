import { CHESS_PHASES, MOVE_CATEGORIES } from "./constants.js";
import type {
  ChessPhase,
  GameResult,
  MoveCategory,
  PlayerColor
} from "./types.js";

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
};

export function emptyCategoryCounts(): Record<MoveCategory, number> {
  return Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, 0])) as Record<
    MoveCategory,
    number
  >;
}

export function emptyPhaseMap<T>(value: T): Record<ChessPhase, T> {
  return Object.fromEntries(CHESS_PHASES.map((phase) => [phase, value])) as Record<
    ChessPhase,
    T
  >;
}

export function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number");
  if (!filtered.length) {
    return null;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatPercentage(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  return `${value.toFixed(digits)}%`;
}

export function calculateAccuracy(avgCentipawnLoss: number | null): number {
  if (avgCentipawnLoss === null) {
    return 0;
  }

  const score = 103 * Math.exp(-avgCentipawnLoss / 450) - 3;
  return clamp(Number(score.toFixed(1)), 0, 100);
}

export function classifyPhase(fen: string, ply: number): ChessPhase {
  const pieces = fen.split(" ")[0];
  let nonPawnMaterial = 0;
  let queens = 0;

  for (const char of pieces) {
    const lower = char.toLowerCase();
    if (!(lower in PIECE_VALUES)) {
      continue;
    }

    if (lower === "q") {
      queens += 1;
    }

    if (lower !== "p" && lower !== "k") {
      nonPawnMaterial += PIECE_VALUES[lower];
    }
  }

  if (ply <= 16 && queens === 2 && nonPawnMaterial >= 20) {
    return "opening";
  }

  if (nonPawnMaterial <= 12 || queens <= 1) {
    return "endgame";
  }

  return "middlegame";
}

export function signalFromAccuracy(accuracy: number | null): "strong" | "solid" | "needs-work" {
  if (accuracy === null) {
    return "needs-work";
  }

  if (accuracy >= 86) {
    return "strong";
  }

  if (accuracy >= 76) {
    return "solid";
  }

  return "needs-work";
}

export function normalizeResult(playerColor: PlayerColor, whiteResult: string, blackResult: string): GameResult {
  const playerResult = playerColor === "white" ? whiteResult : blackResult;

  if (playerResult === "win") {
    return "win";
  }

  const drawTokens = new Set([
    "agreed",
    "repetition",
    "stalemate",
    "insufficient",
    "50move",
    "timevsinsufficient"
  ]);

  if (drawTokens.has(playerResult)) {
    return "draw";
  }

  return "loss";
}

export function categorizeMove(input: {
  lossCp: number;
  bestGapCp: number | null;
  isOnlyMove: boolean;
  isSacrificeLike: boolean;
  resultingScoreCp: number;
  preScoreCp: number;
}): MoveCategory {
  const { lossCp, bestGapCp, isOnlyMove, isSacrificeLike, resultingScoreCp, preScoreCp } = input;

  if (lossCp >= 260 || (preScoreCp > -60 && resultingScoreCp <= -260)) {
    return "blunder";
  }

  if (lossCp >= 120) {
    if (preScoreCp >= 120 && resultingScoreCp < 40) {
      return "miss";
    }

    return "mistake";
  }

  if (lossCp <= 20) {
    if (isSacrificeLike && resultingScoreCp >= 120 && (bestGapCp ?? 0) >= 140) {
      return "brilliant";
    }

    if (isOnlyMove || ((bestGapCp ?? 0) >= 110 && preScoreCp <= 40 && resultingScoreCp >= preScoreCp)) {
      return "great";
    }

    return "best";
  }

  if (lossCp <= 85) {
    return "good";
  }

  return "mistake";
}

export function familyFromOpening(openingName: string): string {
  if (!openingName) {
    return "Unknown";
  }

  const cleaned = openingName.replace(/(?:Opening|Defense|Attack|Game|System|Variation).*$/i, "").trim();
  return cleaned || openingName;
}

export function scoreToWinProbability(scoreCp: number): number {
  return 1 / (1 + Math.exp(-scoreCp / 180));
}
