import { Link } from "react-router-dom";
import { GraduationCap } from "lucide-react";
import type { DrillStats } from "../../shared/training/api";

/** "Due today: 12 line moves · 6 positions from your games". */
export function dueText(stats: Pick<DrillStats, "due">): string {
  const lines = stats.due["repertoire-line"];
  const games = stats.due["own-mistake"];
  return `Due today: ${lines} line move${lines === 1 ? "" : "s"} · ${games} position${games === 1 ? "" : "s"} from your games`;
}

/** Home's drill line: "Train: N due", with both kinds counted apart. */
export function TrainCard({ data, error }: { data: DrillStats | null; error: string | null }) {
  if (error || !data) {
    return null;
  }
  const due = data.due["repertoire-line"] + data.due["own-mistake"];
  return (
    <p className="panel home-train">
      <GraduationCap size={17} aria-hidden="true" />
      <Link to="/train" className="home-train-link">
        <strong>Train: {due} due</strong>
      </Link>{" "}
      · {dueText(data)}
      {!data.repertoireEntries ? (
        <>
          {" "}
          · <Link to="/repertoire">seed your repertoire</Link> for line drills
        </>
      ) : null}
    </p>
  );
}
