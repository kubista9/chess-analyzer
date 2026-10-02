import type { Color } from "../chess/position";
import type { Explanation } from "../engine/types";

// Shapes of training: how a move is judged, the hint ladder, scheduling state, and the progress
// records the store persists (IndexedDB). Pure data; the logic lives next to this file.

export type Mode = "next-move" | "play-line" | "recall" | "sparring";

/**
 * How a played move relates to the repertoire.
 * - book: the repertoire move this exercise asks for.
 * - alternative: a sound move that is not the one asked for (another enabled line's move, an
 *   alternative listed in the content, or a move the engine rates within SOUND_LOSS of the best).
 * - inaccuracy / mistake: only with evidence (the engine's loss, or a mistake listed in the content).
 * - unverified: not the repertoire move and nothing else is known (engine off or unavailable). It
 *   says nothing about the move's quality.
 */
export type Verdict = "book" | "alternative" | "inaccuracy" | "mistake" | "unverified";

export interface MoveJudgement {
  verdict: Verdict;
  /** Where the verdict comes from. */
  source: "repertoire" | "other-line" | "content" | "engine" | "none";
  san: string;
  uci: string;
  /** A content note (for alternatives and known mistakes). */
  note: string | null;
  /** Enabled lines that play this move here, when it is their repertoire move (source other-line). */
  otherLineIds: string[];
  /** The engine's win% loss, when the engine judged the move. */
  loss: number | null;
  explanation: Explanation | null;
}

/** The hint ladder for one exercise. */
export interface LadderState {
  /** Wrong tries so far (alternatives do not count). */
  wrongTries: number;
  /** 0 none, 1 the idea, 2 the piece or area, 3 the solution. */
  level: 0 | 1 | 2 | 3;
  /** Hints the user asked for (as opposed to hints shown after a wrong try). */
  hintsRequested: number;
  /** The solution was shown (asked for, or after too many wrong tries). */
  revealed: boolean;
  /** The user asked for the solution. */
  solutionRequested: boolean;
}

/** The hint texts of one exercise, built before the first try. */
export interface HintSet {
  /** Level 1: the idea, without the move. */
  idea: string;
  /** Level 2: the piece or area, without the exact move. */
  narrow: string;
  /** Squares to mark with the level-2 hint (the piece's square, or an area). */
  narrowSquares: string[];
  solution: Solution;
}

export interface Solution {
  san: string;
  uci: string;
  from: string;
  to: string;
  /** "3.Nc3" / "3...Qa5". */
  label: string;
  /** What it achieves. */
  why: string;
  /** Why it fits the opening. */
  fits: string | null;
  /** The common mistake it avoids. */
  avoids: string | null;
}

/** How an exercise ended for the user. */
export type Result = "clean" | "hinted" | "retried" | "revealed";

/** What the scheduler does with a result. */
export type Outcome = "good" | "hard" | "again";

/** Leitner-box state of one item (a position or a line). */
export interface SrsState {
  /** 0 = new (never shown), else 1..BOX_DAYS.length. */
  box: number;
  /** ms; null while new. */
  dueAt: number | null;
  introducedAt: number | null;
  lapses: number;
  /** Good results in a row. */
  streak: number;
  reviews: number;
  lastReviewAt: number | null;
}

export interface WeakMove {
  /** A wrong move the user played in this position. */
  san: string;
  count: number;
  lastAt: number;
}

export interface PositionProgress {
  /** posKey(side, epd). */
  key: string;
  side: Color;
  epd: string;
  attempts: number;
  /** Solved on the first try without a hint. */
  clean: number;
  /** Not clean (wrong tries, hints or a reveal). */
  incorrect: number;
  wrongTries: number;
  hintsUsed: number;
  reveals: number;
  firstSeenAt: number | null;
  lastPracticedAt: number | null;
  lastResult: Result | null;
  /** The last results, newest last (at most RECENT_RESULTS). */
  recent: Result[];
  /** 0..1. */
  mastery: number;
  srs: SrsState;
  /** Wrong moves played here, most frequent first (at most WEAK_MOVES_KEPT). */
  weakMoves: WeakMove[];
}

export interface LineProgress {
  lineId: string;
  /** Play the Line runs finished. */
  runs: number;
  /** Runs with every move clean. */
  cleanRuns: number;
  /** User moves played in runs. */
  movesPlayed: number;
  movesClean: number;
  wrongTries: number;
  hintsUsed: number;
  reveals: number;
  recallAttempts: number;
  recallCorrect: number;
  lastPracticedAt: number | null;
  lastResult: Result | null;
  srs: SrsState;
}

export type LineStatus = "learning" | "reviewing" | "mastered";

/** The user's choices for a line. */
export interface LineState {
  lineId: string;
  enabled: boolean;
  status: LineStatus;
  /** When the user last set the status by hand; null while it follows the computed mastery. */
  statusSetAt: number | null;
  updatedAt: number;
}

export interface AttemptTry {
  san: string;
  verdict: Verdict;
}

/** One answered exercise (or one sparring move), kept for the dashboard and Progress. */
export interface AttemptRecord {
  /** Auto-increment key, set by the store. */
  id?: number;
  at: number;
  /** Local day "YYYY-MM-DD". */
  day: string;
  mode: Mode;
  side: Color;
  lineId: string | null;
  /** posKey for position exercises; null for recall questions. */
  posKey: string | null;
  epd: string | null;
  /** The repertoire move(s) asked for, in SAN (for recall: the correct option's label). */
  expected: string[];
  tries: AttemptTry[];
  hintsShown: 0 | 1 | 2;
  revealed: boolean;
  result: Result;
  durationMs: number | null;
}

export type BoardTheme = "green" | "brown" | "blue" | "grey";
export type SparringLevel = "relaxed" | "club" | "strong" | "best";

export interface Settings {
  version: 1;
  board: {
    theme: BoardTheme;
    coordinates: boolean;
    legalMoveDots: boolean;
    highlightLastMove: boolean;
    /** Piece animation in ms (0 = none). */
    animationMs: number;
  };
  sound: {
    enabled: boolean;
    /** 0..1. */
    volume: number;
  };
  engine: {
    enabled: boolean;
    /** Thinking time per check in ms. */
    analysisMs: number;
    /** How closely the sparring partner sticks to the engine's best move once out of book. */
    sparringLevel: SparringLevel;
  };
  practice: {
    /** New positions introduced per day. */
    newPerDay: number;
    /** Wrong tries before the solution is shown without asking (at least 3). */
    revealAfter: number;
    /** Pause before the app plays the opponent's move, in ms. */
    replyDelayMs: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  board: { theme: "green", coordinates: true, legalMoveDots: true, highlightLastMove: true, animationMs: 200 },
  sound: { enabled: true, volume: 0.6 },
  engine: { enabled: true, analysisMs: 800, sparringLevel: "club" },
  practice: { newPerDay: 10, revealAfter: 3, replyDelayMs: 550 }
};

/** A line the user added in the app (stored locally, compiled like built-in content). */
export interface CustomLineRecord {
  id: string;
  side: Color;
  /** The chapter title it is listed under, e.g. "My lines" or "1...e5: the Reversed Sicilian". */
  chapter: string;
  family: string;
  name: string;
  eco: string | null;
  /** Movetext from the start position. */
  moves: string;
  description: string;
  plans: string[];
  createdAt: number;
  updatedAt: number;
}
