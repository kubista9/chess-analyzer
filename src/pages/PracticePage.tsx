import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Crosshair, ListOrdered, ScanEye, Swords } from "lucide-react";
import { useAppData } from "../app/AppData";
import { dueCount, dueLines, newIntroducedToday, remainingNewToday } from "../core/training/queue";
import { useNow } from "../hooks/useNow";
import { PageHeader } from "../components/PageHeader";

/** The four practice modes, with what is due in each. */
export function PracticePage() {
  const { items, positions, catalog, isEnabled, lineProgress, settings } = useAppData();
  const now = useNow(60_000);
  const allItems = useMemo(() => [...items.white, ...items.black], [items]);
  const due = dueCount(allItems, positions, now);
  const fresh = Math.min(
    remainingNewToday(settings.practice.newPerDay, newIntroducedToday(positions.values(), now)),
    allItems.filter((item) => !positions.has(item.key)).length
  );
  const enabledLines = catalog.lines.filter((line) => isEnabled(line.id));
  const linesDue = dueLines(enabledLines, lineProgress, now).length;
  const nothing = allItems.length === 0;

  return (
    <div className="page">
      <PageHeader eyebrow="Practice" title="Practice">
        Four ways to train the same repertoire. Every answer feeds the review schedule, so the positions you miss come back sooner.
      </PageHeader>

      {nothing ? (
        <div className="empty">
          <h3>No lines are switched on</h3>
          <p>Practice uses the lines you switch on in your repertoire.</p>
          <Link className="button" to="/repertoire">
            Open the repertoire
          </Link>
        </div>
      ) : null}

      <div className="mode-grid">
        <article className="mode-card">
          <h2>
            <Crosshair size={20} aria-hidden="true" />
            Next move
          </h2>
          <p>A position from your lines: find your move. Wrong tries get a hint (the idea, then the piece or area), never the answer straight away.</p>
          <p className="small tabular">
            {due > 0 ? `${due} due` : "Nothing due"} · {fresh} new today
          </p>
          <div className="row">
            <Link className="button button-primary" to="/practice/next-move" aria-disabled={nothing}>
              {due > 0 ? "Review due positions" : "Start a session"}
            </Link>
            <Link className="button button-small" to="/practice/next-move?side=white">
              White only
            </Link>
            <Link className="button button-small" to="/practice/next-move?side=black">
              Black only
            </Link>
          </div>
        </article>

        <article className="mode-card">
          <h2>
            <ListOrdered size={20} aria-hidden="true" />
            Play the line
          </h2>
          <p>Start from the first move and play a whole variation. The trainer plays the opponent&rsquo;s moves and explains what they intend.</p>
          <p className="small tabular">
            {linesDue > 0 ? `${linesDue} line${linesDue === 1 ? "" : "s"} due` : "No line due"} · {enabledLines.length} switched on
          </p>
          <div className="row">
            <Link className="button button-primary" to="/practice/play-line">
              Choose a line
            </Link>
          </div>
        </article>

        <article className="mode-card">
          <h2>
            <ScanEye size={20} aria-hidden="true" />
            Position recall
          </h2>
          <p>See a position from your repertoire and name the line it comes from, or pick the plan that fits it. Good for knowing where you are when you get there by another move order.</p>
          <div className="row">
            <Link className="button button-primary" to="/practice/recall">
              Start recall
            </Link>
          </div>
        </article>

        <article className="mode-card">
          <h2>
            <Swords size={20} aria-hidden="true" />
            Sparring
          </h2>
          <p>
            Play a game from move one. The trainer answers with the replies your lines prepare for; if you or it leave the lines, it carries on with known
            opening moves{settings.engine.enabled ? " or the engine" : ""}, and your moves are labelled as you go.
          </p>
          <div className="row">
            <Link className="button button-primary" to="/practice/sparring?side=white">
              Play as White
            </Link>
            <Link className="button" to="/practice/sparring?side=black">
              Play as Black
            </Link>
          </div>
        </article>
      </div>
    </div>
  );
}
