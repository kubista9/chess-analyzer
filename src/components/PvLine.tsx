import type { ReviewLine } from "../../shared/types";
import { evalLabel } from "./EvalBar";

export interface PvLineProps {
  line: ReviewLine;
  /** The ply of the line's first move (sets the move numbers). */
  firstPly: number;
  /** The move shown on the board (0 = the first), or null when the board shows the game. */
  activeIndex: number | null;
  onStep: (index: number | null) => void;
  label: string;
}

/** An engine line as clickable SAN chips: each shows the board after that move of the line. */
export function PvLine({ line, firstPly, activeIndex, onStep, label }: PvLineProps) {
  return (
    <div className="pv-line">
      <div className="pv-line-head">
        <strong>{label}</strong>
        <span className="pv-line-eval">{evalLabel({ cp: line.whiteCp, mate: line.mate })}</span>
      </div>
      <div className="pv-line-moves" role="group" aria-label={`${label}: step through the line`}>
        {line.pvSan.map((san, index) => {
          const ply = firstPly + index;
          const number = ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : index === 0 ? `${Math.ceil(ply / 2)}...` : "";
          const active = activeIndex === index;
          return (
            <button
              key={`${index}-${san}`}
              type="button"
              className={`pv-chip${active ? " pv-chip-active" : ""}`}
              aria-pressed={active}
              onClick={() => onStep(active ? null : index)}
            >
              {number}
              {san}
            </button>
          );
        })}
      </div>
    </div>
  );
}
