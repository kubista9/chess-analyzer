export const BULK_ANALYSIS_LIMITS = [1, 5, 10, 25] as const;
export type BulkAnalysisLimit = (typeof BULK_ANALYSIS_LIMITS)[number];
export const DEFAULT_BULK_ANALYSIS_LIMIT: BulkAnalysisLimit = 10;

export const MOVE_CATEGORIES = [
  "brilliant",
  "great",
  "best",
  "good",
  "mistake",
  "miss",
  "blunder"
] as const;

export const SUPPORTED_TIME_CLASSES = ["bullet", "blitz", "rapid", "daily"] as const;

export const CHESS_PHASES = ["opening", "middlegame", "endgame"] as const;
