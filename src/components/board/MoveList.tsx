import { useEffect, useRef } from "react";
import { moveNumber } from "../../core/chess/format";
import type { Verdict } from "../../core/training/types";

export interface MoveListEntry {
  san: string;
  /** A label shown next to the move (book, alternative…). */
  verdict?: Verdict | null;
}

export interface MoveListProps {
  moves: readonly MoveListEntry[];
  /** Plies shown on the board (0 = start); highlights the move that led there. */
  current: number;
  /** Ply number of the first move (1 = White's first move). */
  firstPly?: number;
  /** Jump to the position after this many moves of the list; omit for a read-only list. */
  onSelect?: (ply: number) => void;
  /** A ply where the repertoire ends: a divider is drawn after it. */
  bookEnd?: number | null;
  label?: string;
}

const VERDICT_SHORT: Record<Verdict, string> = {
  book: "Book",
  alternative: "Alt",
  inaccuracy: "?!",
  mistake: "?",
  unverified: "Off"
};

/** The moves in SAN, two per row with move numbers, as buttons when `onSelect` is given. */
export function MoveList({ moves, current, firstPly = 1, onSelect, bookEnd = null, label = "Moves" }: MoveListProps) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[aria-current='step']");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  if (moves.length === 0) {
    return <p className="move-list-empty muted small">No moves yet.</p>;
  }

  const rows: { number: number; cells: { ply: number; entry: MoveListEntry | null }[] }[] = [];
  moves.forEach((entry, index) => {
    const ply = firstPly + index;
    const number = moveNumber(ply);
    let row = rows[rows.length - 1];
    if (!row || row.number !== number) {
      row = { number, cells: [] };
      rows.push(row);
      if (ply % 2 === 0) {
        row.cells.push({ ply: ply - 1, entry: null });
      }
    }
    row.cells.push({ ply, entry });
  });

  return (
    <ol className="move-list" ref={listRef} aria-label={label}>
      {rows.map((row) => (
        <li key={row.number} className={`move-row${bookEnd !== null && row.cells.some((cell) => cell.ply === bookEnd) ? " move-row-book-end" : ""}`}>
          <span className="move-number">{row.number}.</span>
          {row.cells.map((cell) =>
            cell.entry === null ? (
              <span key={cell.ply} className="move-cell move-cell-empty">
                …
              </span>
            ) : (
              <MoveCell key={cell.ply} ply={cell.ply} entry={cell.entry} active={cell.ply - firstPly + 1 === current} onSelect={onSelect} firstPly={firstPly} />
            )
          )}
        </li>
      ))}
    </ol>
  );
}

function MoveCell({ ply, entry, active, onSelect, firstPly }: { ply: number; entry: MoveListEntry; active: boolean; onSelect?: (ply: number) => void; firstPly: number }) {
  const verdict = entry.verdict ?? null;
  const content = (
    <>
      <span className="san">{entry.san}</span>
      {verdict ? (
        <span className={`move-verdict move-verdict-${verdict}`} aria-hidden="true">
          {VERDICT_SHORT[verdict]}
        </span>
      ) : null}
    </>
  );
  const name = `${moveNumber(ply)}${ply % 2 === 1 ? "." : "..."}${entry.san}${verdict ? `, ${verdict === "unverified" ? "not in your repertoire" : verdict}` : ""}`;
  if (!onSelect) {
    return (
      <span className={`move-cell${active ? " move-cell-active" : ""}`} aria-current={active ? "step" : undefined} aria-label={name}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`move-cell${active ? " move-cell-active" : ""}`}
      aria-current={active ? "step" : undefined}
      aria-label={name}
      onClick={() => onSelect(ply - firstPly + 1)}
    >
      {content}
    </button>
  );
}
