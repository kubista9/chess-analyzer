import type { LineStatus } from "../core/training/types";

export const LINE_STATUS_LABELS: Record<LineStatus, string> = {
  learning: "Learning",
  reviewing: "Reviewing",
  mastered: "Mastered"
};

/** A line's status: learning, reviewing or mastered. */
export function LineStatusBadge({ status }: { status: LineStatus }) {
  return <span className={`chip status-${status}`}>{LINE_STATUS_LABELS[status]}</span>;
}
