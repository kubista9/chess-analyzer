import { describeMove, guessIdea, pieceName, type MoveFeatures, type Region } from "../chess/features";
import { moveLabel } from "../chess/format";
import type { AppliedMove } from "../chess/position";
import { developmentState } from "../chess/principles";
import type { Idea } from "../content/schema";
import type { CompiledNote } from "../content/types";
import type { HintSet, LadderState, Outcome, Result } from "./types";

// The hint ladder of one exercise. A wrong try shows the next hint (try 1: the idea, try 2: the
// piece or area); the solution comes only when the user asks for it or after
// max(revealAfter, MIN_REVEAL_AFTER) wrong tries. The user may ask for the next hint at any time.
// Alternatives are not wrong tries: the caller simply does not call onWrongTry for them.

/** The solution is never shown on its own before this many wrong tries (tries). */
export const MIN_REVEAL_AFTER = 3;

/** The highest hint level before the solution (level 1 the idea, level 2 the piece or area). */
export const MAX_HINT_LEVEL = 2;

/** The ladder level of the solution. */
export const SOLUTION_LEVEL = 3;

/**
 * Generic first hints, one per idea. They name the idea only: no square, no move, no piece's
 * destination, and the king-safety hint does not mention castling (that would give a castling
 * move away).
 */
export const IDEA_HINTS: Record<Idea, string> = {
  centre: "Think about the centre: which pawn or piece can claim more of the middle of the board?",
  development: "Think about development: which knight or bishop still has no good square?",
  "king-safety": "Think about king safety: where will your king be safe once the position opens up?",
  prevention: "Think about prevention: what does your opponent want to do next, and how can you stop it?",
  space: "Think about space: how can you gain ground and take squares away from the opponent's pieces?",
  structure: "Think about the pawn structure: which choice leaves your pawns in the best shape?",
  recapture: "Think about material: can you win back what was just taken?",
  tempo: "Think about tempo: can you improve a piece and attack something at the same time?",
  flank: "Think about the wings: which pawn advance on the side of the board supports your plan?",
  activity: "Think about activity: which of your pieces does the least, and where would it work better?"
};

/** Score of each result for mastery (0..1). */
export const RESULT_SCORES: Record<Result, number> = { clean: 1, hinted: 0.6, retried: 0.4, revealed: 0 };

/** A fresh ladder: no tries, no hints. */
export function newLadder(): LadderState {
  return { wrongTries: 0, level: 0, hintsRequested: 0, revealed: false, solutionRequested: false };
}

function asLevel(level: number): LadderState["level"] {
  return Math.min(Math.max(Math.trunc(level), 0), SOLUTION_LEVEL) as LadderState["level"];
}

/** Wrong tries after which the solution is shown without asking (at least MIN_REVEAL_AFTER). */
export function revealThreshold(revealAfter: number): number {
  return Number.isFinite(revealAfter) ? Math.max(Math.ceil(revealAfter), MIN_REVEAL_AFTER) : MIN_REVEAL_AFTER;
}

/** One more wrong try: try 1 shows the idea, try 2 the piece or area, try `revealAfter` the solution. */
export function onWrongTry(state: LadderState, revealAfter: number): LadderState {
  const wrongTries = state.wrongTries + 1;
  if (wrongTries >= revealThreshold(revealAfter)) {
    return { ...state, wrongTries, level: SOLUTION_LEVEL, revealed: true };
  }
  return { ...state, wrongTries, level: asLevel(Math.max(state.level, Math.min(wrongTries, MAX_HINT_LEVEL))) };
}

/** The user asks for the next hint (up to level 2; past that only the solution is left: no change). */
export function requestHint(state: LadderState): LadderState {
  if (state.level >= MAX_HINT_LEVEL) {
    return state;
  }
  return { ...state, level: asLevel(state.level + 1), hintsRequested: state.hintsRequested + 1 };
}

/** The user asks for the solution (no change once it is already shown). */
export function requestSolution(state: LadderState): LadderState {
  if (state.revealed) {
    return state;
  }
  return { ...state, level: SOLUTION_LEVEL, revealed: true, solutionRequested: true };
}

/** Hints shown so far (the solution is not a hint). */
export function hintsShown(state: LadderState): 0 | 1 | 2 {
  return Math.min(state.level, MAX_HINT_LEVEL) as 0 | 1 | 2;
}

/** How the exercise went: revealed, else retried (a wrong try), else hinted, else clean. */
export function resultOf(state: LadderState): Result {
  if (state.revealed) {
    return "revealed";
  }
  if (state.wrongTries > 0) {
    return "retried";
  }
  if (state.level >= 1) {
    return "hinted";
  }
  return "clean";
}

/** What the scheduler does: clean is good; a reveal or two hints is again; one hint or one wrong try is hard. */
export function outcomeOf(state: LadderState): Outcome {
  if (state.revealed || state.level >= MAX_HINT_LEVEL) {
    return "again";
  }
  return resultOf(state) === "clean" ? "good" : "hard";
}

/** The mastery score of a result (clean 1, hinted 0.6, retried 0.4, revealed 0). */
export function resultScore(result: Result): number {
  return RESULT_SCORES[result];
}

const AREA_PHRASES: Record<Region, string> = { queenside: "on the queenside", centre: "in the centre", kingside: "on the kingside" };

/** The level-2 hint written from the move: the piece and its square, or the kind of move and its area. */
function generatedNarrow(move: AppliedMove, features: MoveFeatures): string {
  if (move.castle) {
    return `Your king wants to get safe ${AREA_PHRASES[move.castle === "short" ? "kingside" : "queenside"]}.`;
  }
  if (features.isPawnMove) {
    return `The move is a pawn ${features.isCapture ? "capture" : "move"} ${AREA_PHRASES[features.region]}.`;
  }
  return `Look at your ${features.pieceName} on ${move.from}.`;
}

/** Minor pieces a side has (4 = both knights and both bishops). */
const MINOR_PIECES = 4;

/**
 * What the move achieves, written from the move's features and the opening principles it serves
 * (shown once the move is found or revealed).
 */
function generatedWhy(move: AppliedMove, features: MoveFeatures): string {
  const sentences: string[] = [];
  if (move.castle) {
    const area = AREA_PHRASES[move.castle === "short" ? "kingside" : "queenside"];
    sentences.push(`It brings your king to safety ${area} and a rook towards the centre.`);
  } else if (features.isRecapture) {
    sentences.push(`It wins the material back: your ${features.pieceName} recaptures on ${move.to}.`);
  } else if (move.captured) {
    sentences.push(`It takes the ${pieceName(move.captured)} on ${move.to}.`);
  } else if (features.isDevelopingMove) {
    sentences.push(
      features.isFianchetto
        ? `It develops your ${features.pieceName} onto the long diagonal.`
        : `It develops your ${features.pieceName}: another minor piece joins the game.`
    );
  } else if (features.isFianchetto && features.isPawnMove) {
    sentences.push("It prepares to put your bishop on the long diagonal.");
  } else if (features.isFianchetto) {
    sentences.push(`It puts your ${features.pieceName} on the long diagonal.`);
  } else if (features.isCentralPawnMove) {
    sentences.push("It takes a share of the centre and opens lines for your pieces.");
  } else if (features.isPawnMove) {
    sentences.push(`It gains space ${AREA_PHRASES[features.region]}.`);
  } else {
    sentences.push(`It finds a better square for your ${features.pieceName}.`);
  }
  if (!move.castle && !move.captured && features.attacks.length > 0) {
    sentences.push(`It attacks the ${features.attacks.join(" and the ")}, gaining time.`);
  }
  // The principle "develop every knight and bishop": say so when this move completes it.
  if (features.isDevelopingMove && developmentState(move.fenAfter, move.color).minorsDeveloped === MINOR_PIECES) {
    sentences.push("Now all your knights and bishops are developed.");
  }
  if (move.checkmate) {
    sentences.push("It is checkmate.");
  } else if (move.check) {
    sentences.push("It gives check.");
  }
  return sentences.join(" ");
}

/**
 * The hints and the solution of one exercise. Content wins where it has text (note.hint,
 * note.narrow, note.why); otherwise the texts are written from the move. Generated hint texts
 * never contain the move's SAN or its target square.
 */
export function buildHintSet(input: { move: AppliedMove; history: readonly AppliedMove[]; note: CompiledNote | null; ply: number }): HintSet {
  const { move, history, note, ply } = input;
  const features = describeMove(move, history);
  return {
    idea: note?.hint ?? IDEA_HINTS[note?.idea ?? guessIdea(features)],
    narrow: note?.narrow ?? generatedNarrow(move, features),
    narrowSquares: [move.from],
    solution: {
      san: move.san,
      uci: move.uci,
      from: move.from,
      to: move.to,
      label: moveLabel(ply, move.san),
      why: note?.why ?? generatedWhy(move, features),
      fits: note?.fits ?? null,
      avoids: note?.avoids ?? null
    }
  };
}
