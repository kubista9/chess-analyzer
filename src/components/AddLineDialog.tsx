import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAppData } from "../app/AppData";
import type { Color } from "../core/chess/position";
import { formatLine } from "../core/chess/format";
import { chaptersForSide, parsePgnMainLine } from "../core/content/catalog";
import type { CustomLineRecord } from "../core/training/types";
import { hash32 } from "../core/util/random";

export interface AddLineDialogProps {
  defaultSide: Color;
  /** Edit this line instead of adding a new one. */
  existing?: CustomLineRecord;
  onClose: () => void;
}

const MY_LINES = "My lines";

/**
 * Adds (or edits) a line of the user's own: moves typed as "1.c4 e5 2.Nc3" or pasted as PGN,
 * checked with chess.js before saving. The line is stored in this browser and practised like the
 * built-in ones.
 */
export function AddLineDialog({ defaultSide, existing, onClose }: AddLineDialogProps) {
  const { catalog, actions } = useAppData();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [side, setSide] = useState<Color>(existing?.side ?? defaultSide);
  const [chapter, setChapter] = useState(existing?.chapter ?? MY_LINES);
  const [name, setName] = useState(existing?.name ?? "");
  const [moves, setMoves] = useState(existing?.moves ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [plans, setPlans] = useState(existing?.plans.join("\n") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const chapterTitles = useMemo(() => {
    const titles = chaptersForSide(catalog, side)
      .filter((entry) => entry.origin === "builtin")
      .map((entry) => entry.chapter);
    return [MY_LINES, ...titles.filter((title) => title !== MY_LINES)];
  }, [catalog, side]);

  const parsed = useMemo(() => {
    if (!moves.trim()) {
      return null;
    }
    try {
      const result = parsePgnMainLine(moves);
      return result.sans.length === 0 ? { error: "No moves found." } : { sans: result.sans, headers: result.headers };
    } catch (problem) {
      return { error: problem instanceof Error ? problem.message : String(problem) };
    }
  }, [moves]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed || "error" in parsed) {
      setError(parsed?.error ?? "Enter the moves of the line.");
      return;
    }
    const lineName = name.trim() || parsed.headers.Opening || formatLine(parsed.sans.slice(0, 6));
    const builtinChapter = chaptersForSide(catalog, side).find((entry) => entry.chapter === chapter && entry.origin === "builtin");
    const now = Date.now();
    const record: CustomLineRecord = {
      id: existing?.id ?? `custom-${hash32(`${side}:${parsed.sans.join(" ")}:${now}`).toString(36)}`,
      side,
      chapter,
      family: builtinChapter?.family ?? MY_LINES,
      name: lineName,
      eco: parsed.headers.ECO && /^[A-E]\d\d$/.test(parsed.headers.ECO) ? parsed.headers.ECO : null,
      moves: formatLine(parsed.sans),
      description: description.trim() || "A line you added.",
      plans: plans
        .split("\n")
        .map((plan) => plan.trim())
        .filter(Boolean),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (record.plans.length === 0) {
      record.plans = ["Develop the remaining pieces, castle and follow the plans of the chapter."];
    }
    setSaving(true);
    try {
      await actions.saveCustomLine(record);
      ref.current?.close();
      onClose();
      navigate(`/repertoire/line/${encodeURIComponent(record.id)}`);
    } catch (problem) {
      setError(`The line could not be saved: ${problem instanceof Error ? problem.message : String(problem)}`);
      setSaving(false);
    }
  };

  const close = () => {
    ref.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="dialog dialog-wide"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form className="dialog-body" onSubmit={submit}>
        <h2 id={`${id}-title`}>{existing ? "Edit your line" : "Add a line"}</h2>
        <p className="muted small">
          The line is stored in this browser. To add it to the built-in content instead, export it from its page and paste it into a file in the content
          folder.
        </p>
        <fieldset className="field">
          <legend className="field-label">You play</legend>
          <div className="segmented">
            {(["white", "black"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)}>
                {value === "white" ? "White" : "Black"}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Moves or PGN</span>
          <textarea
            className="textarea"
            value={moves}
            onChange={(event) => {
              setMoves(event.target.value);
              setError(null);
            }}
            placeholder="1.c4 e5 2.Nc3 Nf6 3.g3 d5 4.cxd5 Nxd5 5.Bg2"
            spellCheck={false}
            required
          />
          <span className="field-help" aria-live="polite">
            {parsed === null
              ? "From the starting position. Comments and side variations in a PGN are ignored."
              : "error" in parsed
                ? <span className="error-text">{parsed.error}</span>
                : `${parsed.sans.length} plies: ${formatLine(parsed.sans)}`}
          </span>
        </label>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Four Knights with 4...d5" />
        </label>
        <label className="field">
          <span>Chapter</span>
          <select className="select" value={chapter} onChange={(event) => setChapter(event.target.value)}>
            {chapterTitles.map((title) => (
              <option key={title} value={title}>
                {title}
              </option>
            ))}
          </select>
          <span className="field-help">Your lines are listed under &ldquo;My lines&rdquo; on the Repertoire page with this chapter title.</span>
        </label>
        <label className="field">
          <span>Description</span>
          <textarea className="textarea" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
        </label>
        <label className="field">
          <span>Plans, one per line</span>
          <textarea className="textarea" value={plans} onChange={(event) => setPlans(event.target.value)} rows={3} />
        </label>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving || parsed === null || "error" in parsed}>
            {existing ? "Save changes" : "Add the line"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
