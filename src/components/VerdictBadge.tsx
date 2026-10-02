import { VERDICT_LABELS } from "../core/training/judge";
import type { Verdict } from "../core/training/types";

/** The label of a move's verdict, each with its own colour: book, alternative, inaccuracy, mistake, not in your repertoire. */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge badge-${verdict}`}>{VERDICT_LABELS[verdict]}</span>;
}
