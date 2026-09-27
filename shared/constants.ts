// The one Chess.com account this app analyses. The server reads it through config.owner
// (CHESS_OWNER overrides it, for tests only); the client uses this constant directly.
export const OWNER_USERNAME = "kubista9";

export const BULK_ANALYSIS_LIMITS = [1, 5, 10, 25] as const;
export type BulkAnalysisLimit = (typeof BULK_ANALYSIS_LIMITS)[number];
export const DEFAULT_BULK_ANALYSIS_LIMIT: BulkAnalysisLimit = 10;

// Review covers the opening only: the first 20 plies (10 moves each). Shared by the server
// and the client, so the two cannot drift; there is deliberately no env override.
export const OPENING_PLY_LIMIT = 20;

// Centipawn evals are clamped to +/-CP_CLAMP before any win% maths. Mates are kept in a
// separate field and count as a clamped eval of the mating side.
export const CP_CLAMP = 1000;

// Ordered from best to worst. Thresholds (lichess win% loss) live in shared/eval.ts.
export const MOVE_CATEGORIES = ["best", "good", "inaccuracy", "mistake", "blunder"] as const;

export const SUPPORTED_TIME_CLASSES = ["bullet", "blitz", "rapid", "daily"] as const;
