import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { useAppData, type LineView } from "../app/AppData";
import type { Color } from "../core/chess/position";
import { formatLine } from "../core/chess/format";
import { chaptersForSide } from "../core/content/catalog";
import type { Chapter } from "../core/content/types";
import type { LineStatus } from "../core/training/types";
import { AddLineDialog } from "../components/AddLineDialog";
import { LINE_STATUS_LABELS } from "../components/LineStatusBadge";
import { PageHeader } from "../components/PageHeader";
import { pct } from "../utils/formatters";

const PRIORITY_LABELS = { main: "Main line", secondary: "Secondary", sideline: "Sideline" } as const;

/** Repertoire: the White and Black chapters, each line's status and whether it is switched on. */
export function RepertoirePage() {
  const { catalog } = useAppData();
  const [params, setParams] = useSearchParams();
  const side: Color = params.get("side") === "black" ? "black" : "white";
  const [adding, setAdding] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const errors = catalog.issues.filter((issue) => issue.level === "error");

  const setSide = (next: Color) => setParams(next === "white" ? {} : { side: next }, { replace: true });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next: Color = side === "white" ? "black" : "white";
      setSide(next);
      tabs.current[next === "white" ? 0 : 1]?.focus();
    }
  };

  const chapters = chaptersForSide(catalog, side);
  const groups = useMemo(() => {
    const byGroup = new Map<string, Chapter[]>();
    for (const chapter of chapters) {
      byGroup.set(chapter.group, [...(byGroup.get(chapter.group) ?? []), chapter]);
    }
    return [...byGroup.entries()];
  }, [chapters]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Repertoire"
        title="Repertoire"
        actions={
          <button type="button" className="button" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" />
            Add a line
          </button>
        }
      >
        Your openings, main lines first. Switch lines on or off to shape what you practise, and mark how well you know each one.
      </PageHeader>

      {errors.length > 0 ? (
        <p className="notice">
          {errors.length} line{errors.length === 1 ? "" : "s"} or note{errors.length === 1 ? "" : "s"} could not be loaded and {errors.length === 1 ? "is" : "are"} left out:{" "}
          {errors
            .slice(0, 3)
            .map((issue) => issue.message)
            .join(" · ")}
          {errors.length > 3 ? " …" : ""}
        </p>
      ) : null}

      <div className="segmented repertoire-tabs" role="tablist" aria-label="Side">
        {(["white", "black"] as const).map((value, index) => (
          <button
            key={value}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={side === value}
            aria-controls="repertoire-panel"
            tabIndex={side === value ? 0 : -1}
            onClick={() => setSide(value)}
            onKeyDown={onTabKey}
          >
            {value === "white" ? "White" : "Black"}
          </button>
        ))}
      </div>

      <div id="repertoire-panel" role="tabpanel" aria-labelledby={`tab-${side}`} className="stack repertoire-panel">
        {side === "white" ? (
          <p className="muted">As White you open 1.c4, the English, and build with Nc3, g3 and Bg2. Each chapter answers one of Black&rsquo;s first replies.</p>
        ) : (
          <p className="muted">
            As Black you answer each of White&rsquo;s main first moves. Optional chapters, such as a second defence against 1.e4, stay off until you switch
            them on.
          </p>
        )}
        {groups.length === 0 ? (
          <div className="empty">
            <h3>No {side} lines yet</h3>
            <p>Add a line, or add a chapter file to the content folder.</p>
          </div>
        ) : (
          groups.map(([group, groupChapters]) => (
            <section key={group} className="section" aria-labelledby={`group-${slug(group)}`}>
              <h2 id={`group-${slug(group)}`}>{group}</h2>
              {groupChapters.map((chapter) => (
                <ChapterCard key={chapter.id} chapter={chapter} />
              ))}
            </section>
          ))
        )}
      </div>

      {adding ? <AddLineDialog defaultSide={side} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function ChapterCard({ chapter }: { chapter: Chapter }) {
  const { lineView, actions } = useAppData();
  const views = chapter.lineIds.map((id) => lineView(id)).filter((view): view is LineView => view !== null);
  const enabledCount = views.filter((view) => view.enabled).length;
  const allOn = enabledCount === views.length;

  return (
    <article className="panel chapter" aria-labelledby={`chapter-${chapter.id}`}>
      <div className="chapter-head">
        <div className="stack-tight">
          <span className="eyebrow">{chapter.family}</span>
          <h3 id={`chapter-${chapter.id}`}>{chapter.chapter}</h3>
          <p className="muted">{chapter.summary}</p>
        </div>
        <div className="chapter-meta">
          <span className="small muted tabular">
            {enabledCount} of {views.length} lines on
          </span>
          <button type="button" className="button button-small" onClick={() => actions.setLinesEnabled(chapter.lineIds, !allOn)}>
            {allOn ? "Switch all off" : "Switch all on"}
          </button>
        </div>
      </div>
      {chapter.ideas.length > 0 ? (
        <details className="chapter-ideas">
          <summary>Key ideas</summary>
          <ul>
            {chapter.ideas.map((idea) => (
              <li key={idea}>{idea}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {chapter.review.status === "draft" ? (
        <p className="small faint">
          Draft content · {chapter.review.confidence} confidence{chapter.review.checkedWith.length > 0 ? ` · checked with ${chapter.review.checkedWith.join(", ")}` : ""}
        </p>
      ) : null}
      <ul className="line-rows">
        {views.map((view) => (
          <LineRow key={view.line.id} view={view} />
        ))}
      </ul>
    </article>
  );
}

function LineRow({ view }: { view: LineView }) {
  const { actions } = useAppData();
  const { line } = view;
  const moves = Math.ceil(line.sans.length / 2);
  const statusValue = view.statusManual ? view.status : "auto";

  return (
    <li className={`line-row${view.enabled ? "" : " line-row-off"}`}>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={view.enabled}
        aria-label={`${line.name}: ${view.enabled ? "on" : "off"}`}
        onClick={() => actions.setLinesEnabled([line.id], !view.enabled)}
      />
      <div className="line-row-text">
        <span className="row">
          <Link className="line-name" to={`/repertoire/line/${encodeURIComponent(line.id)}`}>
            {line.name}
          </Link>
          {line.eco ? <span className="eco">{line.eco}</span> : null}
          <span className={`chip priority-${line.priority}`}>{PRIORITY_LABELS[line.priority]}</span>
        </span>
        <span className="line-moves">{formatLine(line.sans)}</span>
        <span className="small muted">{line.description}</span>
      </div>
      <div className="line-row-meta">
        <span className="small muted tabular">{moves} moves deep</span>
        <span className="mastery-cell" title={`${view.seen} of ${view.total} positions practised`}>
          <span className={`meter meter-${view.status}`} aria-hidden="true">
            <span style={{ width: `${view.mastery * 100}%` }} />
          </span>
          <span className="tabular small">{pct(view.mastery)}</span>
        </span>
        <label className="visually-hidden" htmlFor={`status-${line.id}`}>
          Status of {line.name}
        </label>
        <select
          id={`status-${line.id}`}
          className="select status-select"
          value={statusValue}
          onChange={(event) => actions.setLineStatus(line.id, event.target.value === "auto" ? null : (event.target.value as LineStatus))}
        >
          <option value="auto">Automatic: {LINE_STATUS_LABELS[view.status].toLowerCase()}</option>
          <option value="learning">Learning</option>
          <option value="reviewing">Reviewing</option>
          <option value="mastered">Mastered</option>
        </select>
        <Link className="icon-button" to={`/repertoire/line/${encodeURIComponent(line.id)}`} aria-label={`Open ${line.name}`}>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </li>
  );
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
