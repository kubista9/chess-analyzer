import { OPENING_PLY_LIMIT } from "./constants.js";
import { rootMoveLoss, type EngineScore } from "./eval.js";
import type { WhiteEvalPoint } from "./openingAnalysis.js";
import type { JobState, MoveCategory, PlayerColor, ReviewLine } from "./types.js";

// The opening review as the API sends it (GET /api/games/:id/analysis): the per-game opening
// analysis (shared/openingAnalysis.ts) over the position cache, with every engine line in SAN
// and every eval from White's side. Pure helpers for the page (where it opens, the Retry verdict)
// live here too, so the client and the tests share them.

export type Pending = "pending";

export interface ReviewPly {
  ply: number;
  moveNumber: number;
  color: PlayerColor;
  /** The owner played this move. */
  owner: boolean;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** The position the move reaches is a book position. */
  inBook: boolean;
  /** The eval after the move (the played move's score at its root), from White's side. */
  evalAfter: WhiteEvalPoint | Pending;
  /** The mover's win% loss at the root and its class; null while pending. */
  loss: number | null;
  cls: MoveCategory | null;
  /** Opponent moves are judged from a MultiPV 1, shallower search: approximate. */
  approx: boolean;
  /** The root's engine lines, best first (SAN, White's side); empty while pending. */
  lines: ReviewLine[];
  /** The played move's own line at the root, or null while pending. */
  played: ReviewLine | null;
}

export interface ReviewBookExit {
  /** Plies from the start that stay on book positions (0 = the first move left the book). */
  lastBookPly: number;
  /** Who played the first non-book move; null when the game stayed in the book throughout. */
  exitBy: "owner" | "opponent" | null;
  /** The deepest book name reached by then, e.g. "Scandinavian Defense: Main Line". */
  name: string | null;
  eco: string | null;
}

export type LandingReason = "first-mistake" | "book-exit";

export interface OpeningReview {
  gameId: string;
  /** The owner's colour (the board is oriented to it). */
  color: PlayerColor;
  configId: number | null;
  /** complete: every ply of the window is scored. */
  status: "complete" | "partial";
  coverage: { plies: number; pliesScored: number };
  /** The start position's engine lines (the eval before the first move). */
  start: { fen: string; lines: ReviewLine[] };
  /** At most OPENING_PLY_LIMIT plies. */
  plies: ReviewPly[];
  /** The ply of the owner's first mistake (or worse); null = a clean opening; pending = unknown yet. */
  firstOwnerError: number | null | Pending;
  /** Where the review opens without ?ply=: the first mistake, or else the book exit. */
  landing: { ply: number; reason: LandingReason };
  bookExit: ReviewBookExit | null;
  /** The moves after the window (greyed in the list), as far as they are stored. */
  later: { ply: number; san: string }[];
  /** Half-moves in the whole game. */
  totalPlies: number;
}

export interface GameAnalysisResponse {
  review: OpeningReview;
  /** The engine job filling in the missing positions (keyed "review:<gameId>"; its result is the complete review), or null. */
  job: JobState<OpeningReview> | null;
  /** Why no engine job runs for a partial review (e.g. Stockfish is not installed). */
  engineError: string | null;
}

/** "3.Nc3" for White's move, "3...Qa5" for Black's. */
export function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}.${san}` : `${number}...${san}`;
}

/** The ply a review opens at: `requested` (?ply=, clamped to the window) or the review's landing. */
export function openingPly(review: Pick<OpeningReview, "plies" | "landing">, requested: number | null): number {
  if (!review.plies.length) {
    return 0;
  }
  if (requested !== null && Number.isFinite(requested) && requested >= 1) {
    return Math.min(Math.floor(requested), review.plies.length);
  }
  return review.landing.ply;
}

/** The landing: the owner's first mistake, or (a clean or still unknown opening) the first move out of book. */
export function landingOf(
  plies: number,
  firstOwnerError: number | null | Pending,
  bookExit: Pick<ReviewBookExit, "lastBookPly"> | null
): OpeningReview["landing"] {
  if (typeof firstOwnerError === "number") {
    return { ply: firstOwnerError, reason: "first-mistake" };
  }
  const exit = bookExit ? bookExit.lastBookPly + 1 : 1;
  return { ply: Math.max(1, Math.min(plies, exit)), reason: "book-exit" };
}

/** "Clean opening: no mistakes in the first 10 moves" (fewer for a short game). */
export function cleanOpeningCopy(plies: number): string {
  const moves = Math.ceil(Math.min(plies, OPENING_PLY_LIMIT) / 2);
  return `Clean opening: no mistakes in the first ${moves} move${moves === 1 ? "" : "s"}`;
}

/** The book divider: "Out of book after 3...Qa5 (Scandinavian Defense: Main Line), your opponent left first". */
export function bookExitCopy(exit: ReviewBookExit, plies: readonly Pick<ReviewPly, "ply" | "san">[]): string | null {
  if (!exit.exitBy) {
    return null;
  }
  const who = exit.exitBy === "owner" ? "you left first" : "your opponent left first";
  const last = plies[exit.lastBookPly - 1];
  if (!last) {
    return `Out of book from the first move, ${who}`;
  }
  const name = exit.name ? ` (${exit.name})` : "";
  return `Out of book after ${moveLabel(last.ply, last.san)}${name}, ${who}`;
}

// Retry: the owner's move from the position before a mistake, judged by its loss against the
// best line at that root (the same win% maths as the review's classes).

/** A retry move losing less than this (win%) is correct: as good as the engine's best... */
export const RETRY_CORRECT_LOSS = 1;
/** ...and less than this is playable (good enough); anything else is "try again". */
export const RETRY_PLAYABLE_LOSS = 3;
/** After this many misses the answer is revealed. */
export const RETRY_REVEAL_AFTER = 2;

export type RetryVerdict = "correct" | "playable" | "try-again";

export function retryVerdict(loss: number): RetryVerdict {
  if (loss < RETRY_CORRECT_LOSS) {
    return "correct";
  }
  return loss < RETRY_PLAYABLE_LOSS ? "playable" : "try-again";
}

/** The loss and verdict of `played` against `best`, both scored at the same root (side to move). */
export function judgeRetry(best: EngineScore, played: EngineScore): { loss: number; verdict: RetryVerdict } {
  const loss = Math.round(rootMoveLoss(best, played) * 100) / 100;
  return { loss, verdict: retryVerdict(loss) };
}

export interface RetryRequest {
  ply: number;
  uci: string;
}

export interface RetryResult {
  ply: number;
  uci: string;
  san: string;
  loss: number;
  verdict: RetryVerdict;
  /** The best line and the retried move's line at the root, SAN and White's side. */
  best: ReviewLine;
  played: ReviewLine;
  /** The engine had to score the move now (it was not in the cache). */
  searched: boolean;
}
