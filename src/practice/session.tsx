import type { QueueEntry } from "../core/training/queue";
import type { Result } from "../core/training/types";

export const RESULT_LABELS: Record<Result, string> = {
  clean: "First try",
  hinted: "With a hint",
  retried: "After a retry",
  revealed: "Shown"
};

const REASON_LABELS: Record<QueueEntry["reason"], string> = {
  due: "Due for review",
  new: "New position",
  extra: "Extra practice"
};

/** "Review · 4 of 15" with a bar, and why the current item is in the session. */
export function SessionProgress({ title, done, total, reason }: { title: string; done: number; total: number; reason?: QueueEntry["reason"] }) {
  const shown = Math.min(done + 1, total);
  return (
    <div className="session-bar">
      <div className="session-progress">
        <span className="tabular">
          {title} · {shown} of {total}
        </span>
        <div className="meter" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
        </div>
      </div>
      {reason ? <span className="chip">{REASON_LABELS[reason]}</span> : null}
    </div>
  );
}
