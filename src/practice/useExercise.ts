import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppliedMove } from "../core/chess/position";
import type { CompiledNote, TreeEdge } from "../core/content/types";
import { explainMoveScore } from "../core/engine/explain";
import type { EngineClient, Explanation } from "../core/engine/types";
import { buildHintSet, newLadder, onWrongTry, requestHint as ladderHint, requestSolution as ladderSolution } from "../core/training/hints";
import { feedbackSentence, isWrongTry, judgeMove, needsEngine, withEngine, VERDICT_LABELS } from "../core/training/judge";
import type { AttemptTry, HintSet, LadderState, MoveJudgement } from "../core/training/types";

// One "find your repertoire move" exercise: the position, the move(s) it accepts, and the hint
// ladder. Used by Next Move (one position) and Play the Line (one per user move). A wrong move
// never reveals the answer: the piece goes back, the feedback says what kind of move it was, and
// hints escalate (idea → piece or area → solution) until the move is found or shown.

export interface ExerciseSpec {
  /** Changes for every presentation (resets the exercise). */
  key: string;
  fen: string;
  /** 1-based ply of the move to find. */
  ply: number;
  /** The moves that led to `fen`. */
  history: readonly AppliedMove[];
  /** The moves this exercise accepts as the book move. */
  expected: readonly { uci: string; san: string }[];
  /** The move hints and the solution point to (one of `expected`). */
  primary: AppliedMove;
  /** Every enabled repertoire move of the user here (other lines' moves count as alternatives). */
  siblings: readonly TreeEdge[];
  /** The content note for the primary move. */
  note: CompiledNote | null;
}

export type ExercisePhase = "awaiting" | "checking" | "revealed" | "solved";

export type FeedbackTone = "good" | "info" | "warning" | "bad" | "neutral";

export interface Feedback {
  tone: FeedbackTone;
  title: string;
  text: string;
  judgement: MoveJudgement | null;
  explanation: Explanation | null;
}

export interface ExerciseOutcome {
  ladder: LadderState;
  tries: AttemptTry[];
  /** The move that ended the exercise. */
  move: AppliedMove;
}

export interface ExerciseState {
  phase: ExercisePhase;
  ladder: LadderState;
  tries: AttemptTry[];
  hints: HintSet;
  feedback: Feedback | null;
  /** The move the exercise ended with, once solved. */
  solvedWith: AppliedMove | null;
}

export interface UseExerciseOptions {
  engine: EngineClient | null;
  revealAfter: number;
  onComplete: (outcome: ExerciseOutcome) => void;
}

const TONE_BY_VERDICT = {
  book: "good",
  alternative: "info",
  inaccuracy: "warning",
  mistake: "bad",
  unverified: "neutral"
} as const;

export function useExercise(spec: ExerciseSpec | null, { engine, revealAfter, onComplete }: UseExerciseOptions) {
  const hints = useMemo(
    () => (spec ? buildHintSet({ move: spec.primary, history: spec.history, note: spec.note, ply: spec.ply }) : null),
    [spec]
  );
  const [state, setState] = useState<Omit<ExerciseState, "hints">>(() => initial());
  const abortRef = useRef<AbortController | null>(null);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  const stateRef = useRef(state);
  stateRef.current = state;

  // A new exercise starts fresh; a pending engine check of the old one is cancelled.
  const specKey = spec?.key ?? null;
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(initial());
  }, [specKey]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const finish = useCallback((ladder: LadderState, tries: AttemptTry[], move: AppliedMove, feedback: Feedback) => {
    setState({ phase: "solved", ladder, tries, feedback, solvedWith: move });
    completeRef.current({ ladder, tries, move });
  }, []);

  const applyJudgement = useCallback(
    (judgement: MoveJudgement, move: AppliedMove, current: Omit<ExerciseState, "hints">): Omit<ExerciseState, "hints"> => {
      const tries = [...current.tries, { san: move.san, verdict: judgement.verdict }];
      const wrong = isWrongTry(judgement.verdict);
      const ladder = wrong ? onWrongTry(current.ladder, revealAfter) : current.ladder;
      const expectedLabel = ladder.revealed && hints ? hints.solution.label : null;
      const feedback: Feedback = {
        tone: TONE_BY_VERDICT[judgement.verdict],
        title: VERDICT_LABELS[judgement.verdict],
        text: feedbackSentence(judgement, expectedLabel),
        judgement,
        explanation: judgement.explanation
      };
      return { phase: ladder.revealed ? "revealed" : "awaiting", ladder, tries, feedback, solvedWith: null };
    },
    [hints, revealAfter]
  );

  /** Judges a move made on the board. Returns true when the board should keep it (the book move). */
  const playMove = useCallback(
    (move: AppliedMove): boolean => {
      const current = stateRef.current;
      if (!spec || !hints || current.phase === "solved" || current.phase === "checking") {
        return false;
      }
      const judgement = judgeMove({ move, expected: spec.expected, siblings: spec.siblings, note: spec.note });

      if (judgement.verdict === "book") {
        const tries = [...current.tries, { san: move.san, verdict: judgement.verdict }];
        const why = spec.note?.why ?? hints.solution.why;
        finish(current.ladder, tries, move, {
          tone: "good",
          title: current.ladder.revealed ? "That is the move" : VERDICT_LABELS.book,
          text: feedbackSentence(judgement, null) + (why ? ` ${why}` : ""),
          judgement,
          explanation: null
        });
        return true;
      }

      if (needsEngine(judgement) && engine) {
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        setState({
          ...current,
          phase: "checking",
          feedback: { tone: "neutral", title: "Checking…", text: `${move.san} is not your repertoire move. Checking it with the engine…`, judgement: null, explanation: null }
        });
        engine
          .scoreMove(spec.fen, move.uci, { signal: controller.signal })
          .then((score) => {
            if (controller.signal.aborted) {
              return;
            }
            const explanation = explainMoveScore({ score, move, history: spec.history });
            setState((latest) => applyJudgement(withEngine(judgement, score, explanation), move, { ...latest, phase: "awaiting" }));
          })
          .catch(() => {
            if (controller.signal.aborted) {
              return;
            }
            // The engine failed: fall back to the honest "not in your repertoire".
            setState((latest) => applyJudgement(judgement, move, { ...latest, phase: "awaiting" }));
          });
        return false;
      }

      setState(applyJudgement(judgement, move, current));
      return false;
    },
    [spec, hints, engine, finish, applyJudgement]
  );

  const requestHint = useCallback(() => {
    setState((current) => (current.phase === "awaiting" ? { ...current, ladder: ladderHint(current.ladder) } : current));
  }, []);

  const showSolution = useCallback(() => {
    setState((current) =>
      current.phase === "awaiting" || current.phase === "checking"
        ? { ...current, phase: "revealed", ladder: ladderSolution(current.ladder) }
        : current
    );
  }, []);

  /** After a reveal: plays the shown move for the user and moves on. */
  const playSolution = useCallback(() => {
    const current = stateRef.current;
    if (!spec || current.phase !== "revealed") {
      return;
    }
    playMove(spec.primary);
  }, [spec, playMove]);

  const full: ExerciseState | null = hints ? { ...state, hints } : null;
  return { state: full, playMove, requestHint, showSolution, playSolution };
}

function initial(): Omit<ExerciseState, "hints"> {
  return { phase: "awaiting", ladder: newLadder(), tries: [], feedback: null, solvedWith: null };
}
