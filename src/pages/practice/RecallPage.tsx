import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, X } from "lucide-react";
import { useAppData } from "../../app/AppData";
import { opposite, type Color } from "../../core/chess/position";
import type { Line } from "../../core/content/types";
import { buildRecallQuestion, recallCandidates, type RecallKind, type RecallQuestion } from "../../core/training/recall";
import { hash32, seededRng } from "../../core/util/random";
import { BoardToolbar } from "../../components/board/BoardToolbar";
import { TrainerBoard } from "../../components/board/TrainerBoard";
import { PageHeader } from "../../components/PageHeader";
import { useHotkeys } from "../../hooks/useHotkeys";
import { SessionProgress } from "../../practice/session";

/** Questions per recall session. */
export const RECALL_SESSION_SIZE = 8;

interface Answer {
  chosenId: string;
  correct: boolean;
}

/** Position Recall: see a position, name the line it comes from or the plan that fits it. */
export function RecallPage() {
  const { catalog, isEnabled, lineProgress, actions } = useAppData();
  const [params] = useSearchParams();
  const sideParam = params.get("side");
  const side: Color | null = sideParam === "white" || sideParam === "black" ? sideParam : null;
  const [round, setRound] = useState(0);

  const questions = useMemo(() => {
    const rng = seededRng(hash32(`recall:${round}:${Date.now()}`));
    const enabled = catalog.lines.filter((line) => isEnabled(line.id) && (!side || line.side === side));
    const candidates = recallCandidates(enabled);
    // Lines asked least (and missed most) come first; the rest in random order.
    const ranked = [...candidates]
      .map((line) => {
        const progress = lineProgress.get(line.id);
        const asked = progress?.recallAttempts ?? 0;
        const missed = asked - (progress?.recallCorrect ?? 0);
        return { line, key: asked - missed * 2 + rng() };
      })
      .sort((left, right) => left.key - right.key)
      .map((entry) => entry.line);
    const list: RecallQuestion[] = [];
    for (const line of ranked) {
      if (list.length >= RECALL_SESSION_SIZE) {
        break;
      }
      const pool = enabled.filter((other) => other.side === line.side);
      const kind: RecallKind = list.length % 2 === 0 ? "opening" : "plan";
      const question = buildRecallQuestion({ line, pool, kind, rng }) ?? buildRecallQuestion({ line, pool, kind: kind === "plan" ? "opening" : "plan", rng });
      if (question) {
        list.push(question);
      }
    }
    return list;
    // A new round draws new questions; progress changes during a round do not.
  }, [round, side]);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [askedAt, setAskedAt] = useState(() => Date.now());
  const [flipped, setFlipped] = useState(false);
  const question = questions[index] ?? null;
  const answer = answers[index] ?? null;
  const line = question ? catalog.lineById.get(question.lineId) : undefined;

  const choose = useCallback(
    (optionId: string) => {
      if (!question || !line || answers[index]) {
        return;
      }
      const correct = optionId === question.correctId;
      const chosen = question.options.find((option) => option.id === optionId)?.label ?? optionId;
      const expected = question.options.find((option) => option.id === question.correctId)?.label ?? "";
      actions.recordRecall({ line, correct, expected, chosen, startedAt: askedAt });
      setAnswers((current) => {
        const next = [...current];
        next[index] = { chosenId: optionId, correct };
        return next;
      });
    },
    [question, line, answers, index, actions, askedAt]
  );

  const next = useCallback(() => {
    setIndex((value) => value + 1);
    setAskedAt(Date.now());
    setFlipped(false);
  }, []);

  const restart = () => {
    setRound((value) => value + 1);
    setIndex(0);
    setAnswers([]);
    setAskedAt(Date.now());
  };

  const optionKeys: Record<string, (() => void) | undefined> = {};
  question?.options.forEach((option, optionIndex) => {
    optionKeys[String(optionIndex + 1)] = answer ? undefined : () => choose(option.id);
  });
  useHotkeys({ ...optionKeys, f: () => setFlipped((value) => !value), Enter: answer ? next : undefined });

  const header = (
    <PageHeader eyebrow="Practice · Position recall" title="Position recall">
      A position from one of your lines: name the line, or pick the plan that belongs to it.
    </PageHeader>
  );

  if (questions.length === 0) {
    return (
      <div className="page">
        {header}
        <div className="empty">
          <h3>Not enough lines for recall questions</h3>
          <p>Recall needs at least two switched-on lines with different positions. Switch on more lines on the Repertoire page.</p>
          <Link className="button" to="/repertoire">
            Open the repertoire
          </Link>
        </div>
      </div>
    );
  }

  if (!question || !line) {
    const correct = answers.filter((entry) => entry?.correct).length;
    return (
      <div className="page">
        {header}
        <section className="panel summary" aria-labelledby="recall-done">
          <h2 id="recall-done">Round done</h2>
          <p>
            {correct} of {questions.length} answered correctly.
          </p>
          <ul className="list summary-list">
            {questions.map((entry, questionIndex) => {
              const asked = catalog.lineById.get(entry.lineId);
              return (
                <li key={entry.id}>
                  <span>{asked ? asked.name : entry.lineId}</span>
                  <span className={answers[questionIndex]?.correct ? "result-clean" : "result-revealed"}>{answers[questionIndex]?.correct ? "Right" : "Missed"}</span>
                </li>
              );
            })}
          </ul>
          <div className="row">
            <button type="button" className="button button-primary" onClick={restart} autoFocus>
              Another round
            </button>
            <Link className="button" to="/practice">
              Other modes
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const orientation = flipped ? opposite(question.orientation) : question.orientation;
  return (
    <div className="page">
      {header}
      <SessionProgress title="Recall" done={index} total={questions.length} />
      <div className="stage">
        <div className="stage-board">
          <TrainerBoard id="recall-board" fen={question.fen} orientation={orientation} movable={null} lastMove={lastMoveOf(line)} label="Position to recognise" />
          <BoardToolbar onFlip={() => setFlipped((value) => !value)} />
        </div>
        <div className="stage-side">
          <section className="panel stack" aria-labelledby="recall-question">
            <div className="exercise-prompt">
              <span className="eyebrow">{question.kind === "opening" ? "Which line?" : "Which plan?"}</span>
              <h2 id="recall-question">{question.prompt}</h2>
              <p className="exercise-context">{line.side === "white" ? "You have the white pieces." : "You have the black pieces."}</p>
            </div>
            <ol className="recall-options">
              {question.options.map((option, optionIndex) => {
                const isCorrect = option.id === question.correctId;
                const chosen = answer?.chosenId === option.id;
                const tone = answer ? (isCorrect ? " recall-option-correct" : chosen ? " recall-option-wrong" : "") : "";
                return (
                  <li key={option.id}>
                    <button type="button" className={`recall-option${tone}`} onClick={() => choose(option.id)} disabled={answer !== null} aria-pressed={chosen}>
                      <kbd aria-hidden="true">{optionIndex + 1}</kbd>
                      <span>{option.label}</span>
                      {answer && isCorrect ? <Check size={16} aria-label="Correct answer" /> : null}
                      {answer && chosen && !isCorrect ? <X size={16} aria-label="Your answer" /> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            {answer ? (
              <div className={`feedback ${answer.correct ? "feedback-good" : "feedback-bad"}`} role="status">
                <strong>{answer.correct ? "Right." : "Not this one."}</strong>
                <p>{question.explanation}</p>
              </div>
            ) : null}
            {answer ? (
              <div className="row">
                <button type="button" className="button button-primary" onClick={next} autoFocus>
                  {index + 1 < questions.length ? "Next question" : "See the round"}
                  <ArrowRight size={16} aria-hidden="true" />
                  <kbd aria-hidden="true">Enter</kbd>
                </button>
                <Link className="button button-ghost" to={`/repertoire/line/${encodeURIComponent(line.id)}`}>
                  Open the line
                </Link>
              </div>
            ) : (
              <p className="small muted">Choose with the mouse or the number keys.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function lastMoveOf(line: Line) {
  return line.moves[line.recallPly - 1] ?? null;
}
