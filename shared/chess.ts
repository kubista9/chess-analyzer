import type { GameResult, PlayerColor } from "./types.js";

/**
 * The owner's colour in a game, comparing trimmed, case-insensitive usernames.
 * Returns null when the owner played neither side. Callers skip or report such a game;
 * they never fall back to a default colour.
 */
export function resolvePlayerColor(owner: string, whiteUsername: string, blackUsername: string): PlayerColor | null {
  const needle = owner.trim().toLowerCase();
  if (!needle) {
    return null;
  }

  if (whiteUsername.trim().toLowerCase() === needle) {
    return "white";
  }

  if (blackUsername.trim().toLowerCase() === needle) {
    return "black";
  }

  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

export function familyFromOpening(openingName: string): string {
  if (!openingName) {
    return "Unknown";
  }

  const cleaned = openingName.replace(/(?:Opening|Defense|Attack|Game|System|Variation).*$/i, "").trim();
  return cleaned || openingName;
}
