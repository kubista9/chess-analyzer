import { formatLine } from "../core/chess/format";
import type { PositionItem } from "../core/content/types";
import type { PositionProgress } from "../core/training/types";
import { pct } from "../utils/formatters";

/** "After 1.c4 e5 2.Nc3 · White to move" with the position's mastery and misses. */
export function PositionLabel({ item, progress }: { item: PositionItem; progress?: PositionProgress | null }) {
  const path = item.pathSans.length === 0 ? "The starting position" : `After ${formatLine(item.pathSans)}`;
  const misses = progress ? progress.incorrect : 0;
  return (
    <span className="stack-tight position-label">
      <span>{path}</span>
      <span className="small muted">
        {item.side === "white" ? "White" : "Black"} to move
        {progress ? ` · mastery ${pct(progress.mastery)}` : ""}
        {misses > 0 ? ` · missed ${misses} time${misses === 1 ? "" : "s"}` : ""}
      </span>
    </span>
  );
}
