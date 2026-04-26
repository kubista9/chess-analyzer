export const BULK_ANALYSIS_LIMITS = [50, 100, 150] as const;

export const MOVE_CATEGORIES = [
  "brilliant",
  "great",
  "best",
  "good",
  "mistake",
  "miss",
  "blunder"
] as const;

export const SUPPORTED_TIME_CLASSES = ["bullet", "blitz", "rapid"] as const;

export const CHESS_PHASES = ["opening", "middlegame", "endgame"] as const;

export const CATEGORY_COLORS: Record<(typeof MOVE_CATEGORIES)[number], string> = {
  brilliant: "#14d1b1",
  great: "#63a2ff",
  best: "#9dd94e",
  good: "#f5f7fa",
  mistake: "#ffaf54",
  miss: "#ff6b6b",
  blunder: "#ff3c5c"
};
