import { ExternalLink } from "lucide-react";
import { OPPONENT_ERROR_LOSS } from "../../shared/openingAnalysis";
import type { ReviewPly } from "../../shared/review";
import type { MoveCategory } from "../../shared/types";

/** Class names and the move marks used for them. */
export const CLASS_LABELS: Record<MoveCategory, { label: string; mark: string }> = {
  best: { label: "Best", mark: "" },
  good: { label: "Good", mark: "" },
  inaccuracy: { label: "Inaccuracy", mark: "?!" },
  mistake: { label: "Mistake", mark: "?" },
  blunder: { label: "Blunder", mark: "??" }
};

export interface MoveListProps {
  plies: readonly ReviewPly[];
  selectedPly: number;
  onSelect: (ply: number) => void;
  /** The book divider: shown after the move pair holding `afterPly`. */
  divider: { afterPly: number; text: string } | null;
  /** Moves after the reviewed window, greyed. */
  later: readonly { ply: number; san: string }[];
  gameUrl: string | null;
}

function MoveCell({ ply, selected, onSelect }: { ply: ReviewPly; selected: boolean; onSelect: (ply: number) => void }) {
  // The owner's moves carry their class; the opponent's (approximate) only an error mark.
  const cls = ply.owner ? ply.cls : ply.loss !== null && ply.loss >= OPPONENT_ERROR_LOSS ? "mistake" : null;
  const mark = cls ? CLASS_LABELS[cls].mark : "";
  const title = ply.owner
    ? ply.cls
      ? `${CLASS_LABELS[ply.cls].label}${ply.loss !== null && ply.cls !== "best" ? `, ${ply.loss.toFixed(1)}% win chance lost` : ""}`
      : "Engine data pending"
    : ply.loss !== null
      ? `Your opponent's move (about ${ply.loss.toFixed(1)}% win chance lost)`
      : "Your opponent's move";
  return (
    <button
      type="button"
      className={`move-cell${ply.owner ? " move-cell-owner" : ""}${cls ? ` move-cell-${cls}` : ""}${selected ? " move-cell-active" : ""}`}
      aria-current={selected ? "step" : undefined}
      aria-label={`${ply.moveNumber}${ply.color === "black" ? "..." : "."}${ply.san}. ${title}${ply.inBook ? ", book" : ""}`}
      title={title}
      onClick={() => onSelect(ply.ply)}
    >
      {ply.owner && ply.cls ? <span className={`class-dot class-dot-${ply.cls}`} aria-hidden="true" /> : null}
      <span className="move-cell-san">
        {ply.san}
        {mark}
      </span>
      {ply.inBook ? <span className="move-cell-book">Book</span> : null}
    </button>
  );
}

/** The reviewed moves in pairs, coloured by class, with Book tags, the out-of-book divider and the greyed rest. */
export function MoveList({ plies, selectedPly, onSelect, divider, later, gameUrl }: MoveListProps) {
  const rows: { number: number; white?: ReviewPly; black?: ReviewPly }[] = [];
  for (const ply of plies) {
    const row = rows[ply.moveNumber - 1] ?? (rows[ply.moveNumber - 1] = { number: ply.moveNumber });
    row[ply.color] = ply;
  }
  const dividerRow = divider ? Math.ceil(Math.max(divider.afterPly, 1) / 2) : null;

  return (
    <div className="move-list" aria-label="Moves">
      <ol className="move-list-rows">
        {rows.map((row) => (
          <li key={row.number} className="move-list-item">
            <div className="move-list-row">
              <span className="move-list-number">{row.number}.</span>
              {row.white ? <MoveCell ply={row.white} selected={row.white.ply === selectedPly} onSelect={onSelect} /> : <span />}
              {row.black ? <MoveCell ply={row.black} selected={row.black.ply === selectedPly} onSelect={onSelect} /> : <span />}
            </div>
            {divider && dividerRow === row.number ? (
              <div className="move-list-divider" role="separator">
                <span>{divider.text}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {later.length || gameUrl ? (
        <p className="move-list-later">
          {later.length ? (
            <span className="move-list-later-moves" aria-label="Later moves, not reviewed">
              {later.map((move) => `${move.ply % 2 === 1 ? `${Math.ceil(move.ply / 2)}.` : ""}${move.san}`).join(" ")}
              {" …"}
            </span>
          ) : null}
          {gameUrl ? (
            <a className="text-link move-list-link" href={gameUrl} target="_blank" rel="noreferrer">
              Full game on Chess.com <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
