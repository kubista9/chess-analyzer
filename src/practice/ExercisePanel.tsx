import { Lightbulb, LoaderCircle, Eye, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { VerdictBadge } from "../components/VerdictBadge";
import type { ExerciseState } from "./useExercise";

export interface ExercisePanelProps {
  state: ExerciseState;
  prompt: ReactNode;
  onHint: () => void;
  onShowSolution: () => void;
  onPlaySolution: () => void;
  /** Shown when the exercise is solved (e.g. a Next button). */
  after?: ReactNode;
}

/**
 * The text side of an exercise: the task, the feedback on the last try, the hints shown so far
 * and, once revealed, the solution with what it achieves, why it fits and what it avoids.
 */
export function ExercisePanel({ state, prompt, onHint, onShowSolution, onPlaySolution, after }: ExercisePanelProps) {
  const { phase, ladder, feedback, hints } = state;
  const level = ladder.level;
  const solved = phase === "solved";
  const revealed = phase === "revealed" || (solved && ladder.revealed);

  return (
    <div className="exercise">
      <div className="exercise-prompt">{prompt}</div>

      <div className="exercise-feedback" aria-live="polite">
        {feedback ? (
          <div className={`feedback feedback-${feedback.tone}`} role={feedback.tone === "bad" ? "alert" : "status"}>
            <div className="feedback-head">
              {phase === "checking" ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
              {feedback.judgement ? <VerdictBadge verdict={feedback.judgement.verdict} /> : <strong>{feedback.title}</strong>}
            </div>
            <p>{feedback.text}</p>
            {feedback.explanation ? (
              <div className="feedback-explanation">
                <p>{feedback.explanation.headline}</p>
                {feedback.explanation.details.length > 0 ? (
                  <ul>
                    {feedback.explanation.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {!solved && !revealed && level >= 1 ? (
        <div className="hint-list" aria-live="polite">
          <p className="hint">
            <span className="hint-label">Hint 1</span>
            {hints.idea}
          </p>
          {level >= 2 ? (
            <p className="hint">
              <span className="hint-label">Hint 2</span>
              {hints.narrow}
            </p>
          ) : null}
        </div>
      ) : null}

      {revealed ? (
        <div className="solution" aria-live="polite">
          <p className="solution-move">
            <span className="hint-label">{solved ? "Repertoire move" : "The move"}</span>
            <span className="san">{hints.solution.label}</span>
          </p>
          <p>{hints.solution.why}</p>
          {hints.solution.fits ? (
            <p>
              <strong>Why it fits: </strong>
              {hints.solution.fits}
            </p>
          ) : null}
          {hints.solution.avoids ? (
            <p>
              <strong>What it avoids: </strong>
              {hints.solution.avoids}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="exercise-actions">
        {phase === "awaiting" ? (
          <>
            <button type="button" className="button" onClick={onHint} disabled={level >= 2}>
              <Lightbulb size={16} aria-hidden="true" />
              {level === 0 ? "Hint" : level === 1 ? "Another hint" : "No more hints"}
              <kbd aria-hidden="true">H</kbd>
            </button>
            <button type="button" className="button button-ghost" onClick={onShowSolution}>
              <Eye size={16} aria-hidden="true" />
              Show the move
            </button>
          </>
        ) : null}
        {phase === "revealed" ? (
          <button type="button" className="button button-primary" onClick={onPlaySolution} autoFocus>
            Play it and continue
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        ) : null}
        {solved ? after : null}
      </div>
      {phase === "revealed" ? <p className="small muted">Play the move on the board yourself, or let the trainer play it.</p> : null}
    </div>
  );
}
