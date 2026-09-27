// The one Chess.com account this app analyses. The server reads it through config.owner
// (CHESS_OWNER overrides it, for tests only); the client uses this constant directly.
export const OWNER_USERNAME = "kubista9";

// Review covers the opening only: the first 20 plies (10 moves each). Shared by the server
// and the client, so the two cannot drift; there is deliberately no env override.
export const OPENING_PLY_LIMIT = 20;

// Centipawn evals are clamped to +/-CP_CLAMP before any win% maths. Mates are kept in a
// separate field and count as a clamped eval of the mating side.
export const CP_CLAMP = 1000;

// Ordered from best to worst. Thresholds (the mover's win% loss at one root) live in shared/eval.ts.
export const MOVE_CATEGORIES = ["best", "good", "inaccuracy", "mistake", "blunder"] as const;

// The importer keeps only these standard time classes; bullet and daily are never stored.
export const IMPORTED_TIME_CLASSES = ["blitz", "rapid"] as const;

// Why the importer skipped an archive entry. Per month, kept + the sum of these = archive length.
export const SKIP_REASONS = ["variant", "custom-start", "time-class", "not-owner", "duplicate", "malformed"] as const;
