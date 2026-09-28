import type { CSSProperties } from "react";
import { whiteWinPercent, type WhiteEval } from "../../shared/eval";
import type { PlayerColor } from "../../shared/types";

/** A short White-view label: "+0.8", "-1.2", "M3" (White mates), "-M3", "1-0" / "0-1" when mated. */
export function evalLabel(evaluation: WhiteEval): string {
  if (evaluation.mate !== null) {
    if (evaluation.mate === 0) {
      return evaluation.cp > 0 ? "1-0" : "0-1";
    }
    return evaluation.mate > 0 ? `M${evaluation.mate}` : `-M${-evaluation.mate}`;
  }
  const value = evaluation.cp / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

/**
 * The eval bar: White's share is White's win%, so it is above half whenever White is better,
 * whoever is to move. It stands beside the board with White's end towards White's side of the
 * board (so it flips with the orientation); below 760px it becomes a thin strip above the board.
 */
export function EvalBar({ evaluation, orientation }: { evaluation: WhiteEval | null; orientation: PlayerColor }) {
  const white = evaluation ? whiteWinPercent(evaluation) : 50;
  const label = evaluation ? evalLabel(evaluation) : "…";
  const leader = white >= 50 ? "white" : "black";
  return (
    <div
      className={`eval-bar eval-bar-oriented-${orientation}`}
      role="img"
      aria-label={evaluation ? `Engine eval ${label} from White's side (White ${Math.round(white)}% win chance)` : "Engine eval pending"}
      style={{ "--white-share": `${white}%` } as CSSProperties}
    >
      <div className="eval-bar-fill" />
      <span className={`eval-bar-label eval-bar-label-${leader}`} aria-hidden="true">
        {label}
      </span>
    </div>
  );
}
