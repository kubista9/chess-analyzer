import { Lock } from "lucide-react";
import { repTag, type RepEntry, type RepTag } from "../../shared/repertoire";
import { moveLabel } from "./MoveTable";

/** "from your games", "suggested (replaces your 2...Bc5)" or "edited"; `ply` numbers the replaced move. */
export function tagText(tag: RepTag, ply?: number): string {
  if (tag.kind === "from-games") {
    return "from your games";
  }
  if (tag.kind === "edited") {
    return "edited";
  }
  if (!tag.replaces) {
    return "suggested";
  }
  return `suggested (replaces your ${ply ? moveLabel(ply, tag.replaces) : tag.replaces})`;
}

/** The chips of a repertoire move: where it comes from, needs review, locked. */
export function RepChips({ entry, compact = false }: { entry: RepEntry; compact?: boolean }) {
  const tag = repTag(entry);
  return (
    <span className="rep-chips">
      <span className={`rep-chip rep-chip-${tag.kind}`} title={entry.replaced?.reason ?? entry.reason ?? undefined}>
        {compact && tag.kind === "suggested" ? (tag.replaces ? `suggested · replaces ${moveLabel(entry.ply, tag.replaces)}` : "suggested") : tagText(tag, entry.ply)}
      </span>
      {entry.status === "needs-review" ? <span className="rep-chip rep-chip-review">needs review</span> : null}
      {entry.locked ? (
        <span className="rep-lock" title="Locked: a re-seed never changes it">
          <Lock size={12} aria-label="Locked" />
        </span>
      ) : null}
    </span>
  );
}
