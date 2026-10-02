import { bareSan } from "../chess/format";
import type { AppliedMove } from "../chess/position";
import type { CompiledNote, TreeEdge } from "../content/types";
import type { Explanation, MoveScore } from "../engine/types";
import type { MoveJudgement, Verdict } from "./types";

// Judging a played move against the repertoire. A legal move is never called bad just because it
// is off-book: "inaccuracy" and "mistake" need evidence (a mistake listed in the content, or the
// engine's loss). Without evidence a non-repertoire move is "unverified", which says nothing about
// its quality; the caller may then ask the engine (needsEngine) and refine it with withEngine.

/** Below this mover's win% loss the engine calls a non-repertoire move an acceptable alternative (win%; lichess "good"). */
export const SOUND_LOSS = 5;

/** From this mover's win% loss on the engine calls a move a mistake; from SOUND_LOSS up to here, an inaccuracy (win%). */
export const MISTAKE_LOSS = 10;

export interface JudgeInput {
  move: AppliedMove;
  /** The moves this exercise accepts as book. */
  expected: readonly { uci: string; san: string }[];
  /** All enabled user moves at this node (another line's move is an alternative, source other-line). */
  siblings: readonly TreeEdge[];
  /** The note of the expected move (its alternatives and known mistakes). */
  note: CompiledNote | null;
}

/** The labels shown for each verdict. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  book: "Book move",
  alternative: "Acceptable alternative",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  unverified: "Not in your repertoire"
};

function makeJudgement(move: AppliedMove, fields: Pick<MoveJudgement, "verdict" | "source"> & Partial<MoveJudgement>): MoveJudgement {
  return { san: move.san, uci: move.uci, note: null, otherLineIds: [], loss: null, explanation: null, ...fields };
}

/**
 * book (an expected move) > alternative from another enabled line > alternative listed in the
 * content > mistake or inaccuracy listed in the content > unverified. A note written for another
 * position is ignored.
 */
export function judgeMove(input: JudgeInput): MoveJudgement {
  const { move } = input;
  if (input.expected.some((expected) => expected.uci === move.uci)) {
    return makeJudgement(move, { verdict: "book", source: "repertoire" });
  }
  const sibling = input.siblings.find((edge) => edge.mover === "user" && edge.uci === move.uci);
  if (sibling) {
    return makeJudgement(move, { verdict: "alternative", source: "other-line", otherLineIds: [...sibling.lineIds] });
  }
  const note = input.note !== null && input.note.epdBefore === move.epdBefore ? input.note : null;
  const san = bareSan(move.san);
  const alternative = note?.alternatives.find((entry) => bareSan(entry.san) === san);
  if (alternative) {
    return makeJudgement(move, { verdict: "alternative", source: "content", note: alternative.note });
  }
  const mistake = note?.mistakes.find((entry) => bareSan(entry.san) === san);
  if (mistake) {
    return makeJudgement(move, { verdict: mistake.severity === "inaccuracy" ? "inaccuracy" : "mistake", source: "content", note: mistake.note });
  }
  return makeJudgement(move, { verdict: "unverified", source: "none" });
}

/** True when only the engine can say more about the move. */
export function needsEngine(judgement: MoveJudgement): boolean {
  return judgement.verdict === "unverified";
}

/**
 * Refines an unverified judgement with the engine's score: loss < SOUND_LOSS is an alternative,
 * < MISTAKE_LOSS an inaccuracy, anything more a mistake. Other judgements are returned unchanged
 * (the repertoire and the content come first), and so is a score for a different move (a stale
 * result) or one without a usable loss.
 */
export function withEngine(judgement: MoveJudgement, score: MoveScore, explanation: Explanation | null): MoveJudgement {
  if (!needsEngine(judgement) || score.uci !== judgement.uci || !Number.isFinite(score.loss)) {
    return judgement;
  }
  const loss = Math.max(0, score.loss);
  const verdict: Verdict = loss < SOUND_LOSS ? "alternative" : loss < MISTAKE_LOSS ? "inaccuracy" : "mistake";
  return { ...judgement, verdict, source: "engine", loss, explanation };
}

/** Verdicts that count as a wrong try on the hint ladder (alternatives and book moves do not). */
export function isWrongTry(verdict: Verdict): boolean {
  return verdict === "inaccuracy" || verdict === "mistake" || verdict === "unverified";
}

function verdictSentence(judgement: MoveJudgement): string {
  switch (judgement.verdict) {
    case "book":
      return "Correct: that is your repertoire move.";
    case "alternative":
      if (judgement.source === "other-line") {
        return "That move belongs to another of your lines; this one asks for a different move.";
      }
      if (judgement.source === "engine") {
        return "The engine rates that move as sound, but it is not your repertoire move.";
      }
      return "That is a sound alternative, but it is not your repertoire move.";
    case "inaccuracy":
      return judgement.source === "engine" ? "The engine rates that move as an inaccuracy." : "That move is a known inaccuracy here.";
    case "mistake":
      return judgement.source === "engine" ? "The engine rates that move as a mistake." : "That move is a known mistake here.";
    case "unverified":
      return "That is not your repertoire move; nothing is said about its quality.";
  }
}

/**
 * The feedback line: what the move is and what to do next. The expected move is named only when
 * it has been revealed (expectedLabel such as "3.Nc3"; null while it is still hidden).
 */
export function feedbackSentence(judgement: MoveJudgement, expectedLabel: string | null): string {
  const sentence = verdictSentence(judgement);
  if (judgement.verdict === "book") {
    return sentence;
  }
  const next = expectedLabel === null ? "Try again." : `Your repertoire move here is ${expectedLabel}: play it to continue.`;
  return `${sentence} ${next}`;
}
