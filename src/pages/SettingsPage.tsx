import { useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Download, Upload, Volume2 } from "lucide-react";
import { useAppData } from "../app/AppData";
import { ENGINE_STATUS_LABELS, useEngineStatus } from "../app/engine";
import { playSound } from "../app/sounds";
import type { BoardTheme, Settings, SparringLevel } from "../core/training/types";
import { backupFileName } from "../storage/backup";
import { BOARD_THEMES } from "../components/board/boardTheme";
import { TrainerBoard } from "../components/board/TrainerBoard";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";

const SPARRING_LEVELS: { value: SparringLevel; label: string; help: string }[] = [
  { value: "relaxed", label: "Relaxed", help: "Often picks a decent second-best move once out of book." },
  { value: "club", label: "Club", help: "Sound moves with some variety." },
  { value: "strong", label: "Strong", help: "Close to the engine's first choice." },
  { value: "best", label: "Best", help: "Always the engine's first choice." }
];

const PREVIEW_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2P5/2N3P1/PP1PPP1P/R1BQKBNR w KQkq - 2 4";

/** Settings: board, sound, engine, practice and the local data (export, import, reset). */
export function SettingsPage() {
  const { settings, actions, persisted } = useAppData();
  const engineStatus = useEngineStatus();
  const update = (change: (current: Settings) => Settings) => actions.updateSettings(change);

  return (
    <div className="page settings">
      <PageHeader eyebrow="Settings" title="Settings">
        Everything here is stored in this browser together with your progress.
      </PageHeader>

      <section className="panel settings-section" aria-labelledby="board-settings">
        <h2 id="board-settings">Board</h2>
        <div className="settings-board">
          <div className="stack">
            <fieldset className="field">
              <legend className="field-label">Colours</legend>
              <div className="theme-swatches">
                {(Object.keys(BOARD_THEMES) as BoardTheme[]).map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    className="theme-swatch"
                    aria-pressed={settings.board.theme === theme}
                    onClick={() => update((current) => ({ ...current, board: { ...current.board, theme } }))}
                  >
                    <span className="theme-swatch-squares" aria-hidden="true">
                      <span style={{ background: BOARD_THEMES[theme].light }} />
                      <span style={{ background: BOARD_THEMES[theme].dark }} />
                    </span>
                    {BOARD_THEMES[theme].label}
                  </button>
                ))}
              </div>
            </fieldset>
            <Toggle
              label="Coordinates"
              help="Files and ranks along the board edge."
              checked={settings.board.coordinates}
              onChange={(coordinates) => update((current) => ({ ...current, board: { ...current.board, coordinates } }))}
            />
            <Toggle
              label="Show legal moves"
              help="Dots on the squares a picked piece can move to."
              checked={settings.board.legalMoveDots}
              onChange={(legalMoveDots) => update((current) => ({ ...current, board: { ...current.board, legalMoveDots } }))}
            />
            <Toggle
              label="Highlight the last move"
              checked={settings.board.highlightLastMove}
              onChange={(highlightLastMove) => update((current) => ({ ...current, board: { ...current.board, highlightLastMove } }))}
            />
            <Range
              label="Piece animation"
              value={settings.board.animationMs}
              min={0}
              max={600}
              step={50}
              format={(value) => (value === 0 ? "Off" : `${value} ms`)}
              onChange={(animationMs) => update((current) => ({ ...current, board: { ...current.board, animationMs } }))}
            />
          </div>
          <div className="settings-preview">
            <TrainerBoard id="settings-preview" fen={PREVIEW_FEN} orientation="white" movable={null} maxWidth={280} lastMove={{ from: "b8", to: "c6" }} label="Board preview" />
          </div>
        </div>
      </section>

      <section className="panel settings-section" aria-labelledby="sound-settings">
        <h2 id="sound-settings">Sound</h2>
        <Toggle
          label="Move sounds"
          help="A short sound for moves, captures, checks and castling."
          checked={settings.sound.enabled}
          onChange={(enabled) => update((current) => ({ ...current, sound: { ...current.sound, enabled } }))}
        />
        <div className="row">
          <Range
            label="Volume"
            value={Math.round(settings.sound.volume * 100)}
            min={0}
            max={100}
            step={5}
            format={(value) => `${value}%`}
            disabled={!settings.sound.enabled}
            onChange={(value) => update((current) => ({ ...current, sound: { ...current.sound, volume: value / 100 } }))}
          />
          <button type="button" className="button button-small" onClick={() => playSound("capture", settings.sound.volume)} disabled={!settings.sound.enabled}>
            <Volume2 size={16} aria-hidden="true" />
            Test
          </button>
        </div>
      </section>

      <section className="panel settings-section" aria-labelledby="engine-settings">
        <h2 id="engine-settings">Engine</h2>
        <p className="muted small">
          Stockfish 19 (lite, WebAssembly) runs inside this browser; nothing is sent anywhere. It checks moves outside your repertoire, explains them in plain
          words and plays the sparring partner&rsquo;s moves once your lines run out. Everything else works without it. Status: {ENGINE_STATUS_LABELS[engineStatus]}.
        </p>
        <Toggle
          label="Use the engine"
          checked={settings.engine.enabled}
          onChange={(enabled) => update((current) => ({ ...current, engine: { ...current.engine, enabled } }))}
        />
        <Range
          label="Thinking time per check"
          help="Longer is more reliable; shorter keeps answers quick on slow devices."
          value={settings.engine.analysisMs}
          min={300}
          max={3000}
          step={100}
          format={(value) => `${(value / 1000).toFixed(1)} s`}
          disabled={!settings.engine.enabled}
          onChange={(analysisMs) => update((current) => ({ ...current, engine: { ...current.engine, analysisMs } }))}
        />
        <fieldset className="field" disabled={!settings.engine.enabled}>
          <legend className="field-label">Sparring partner, once out of book</legend>
          <div className="segmented">
            {SPARRING_LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                aria-pressed={settings.engine.sparringLevel === level.value}
                onClick={() => update((current) => ({ ...current, engine: { ...current.engine, sparringLevel: level.value } }))}
              >
                {level.label}
              </button>
            ))}
          </div>
          <span className="field-help">{SPARRING_LEVELS.find((level) => level.value === settings.engine.sparringLevel)?.help}</span>
        </fieldset>
      </section>

      <section className="panel settings-section" aria-labelledby="practice-settings">
        <h2 id="practice-settings">Practice</h2>
        <Range
          label="New positions per day"
          help="How many positions you have never seen join the review each day."
          value={settings.practice.newPerDay}
          min={0}
          max={50}
          step={1}
          format={(value) => String(value)}
          onChange={(newPerDay) => update((current) => ({ ...current, practice: { ...current.practice, newPerDay } }))}
        />
        <Range
          label="Show the move after"
          help="Wrong tries before the trainer shows the move without being asked (two hints come first)."
          value={settings.practice.revealAfter}
          min={3}
          max={8}
          step={1}
          format={(value) => `${value} wrong tries`}
          onChange={(revealAfter) => update((current) => ({ ...current, practice: { ...current.practice, revealAfter } }))}
        />
        <Range
          label="Opponent reply delay"
          value={settings.practice.replyDelayMs}
          min={0}
          max={2000}
          step={50}
          format={(value) => `${value} ms`}
          onChange={(replyDelayMs) => update((current) => ({ ...current, practice: { ...current.practice, replyDelayMs } }))}
        />
      </section>

      <DataSection persisted={persisted} />

      <section className="panel settings-section" aria-labelledby="about-settings">
        <h2 id="about-settings">About the content</h2>
        <p className="muted small">
          The repertoire lines and explanations were written for this trainer and checked move by move with chess.js and Stockfish. They are a practical
          starting repertoire, not complete theory, and are marked as drafts until you have reviewed them. The opening principles follow the ideas of
          &ldquo;Chess Opening Fundamentals&rdquo; by GM Igor Smirnov; no text from the book is reproduced. Opening names come from the lichess opening list
          (CC0). Add or edit lines in the content folder (see content/README.md) or with Add a line on the Repertoire page.
        </p>
      </section>
    </div>
  );
}

function DataSection({ persisted }: { persisted: boolean | null }) {
  const { actions } = useAppData();
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<"progress" | "all" | null>(null);

  const exportData = async () => {
    try {
      const backup = await actions.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFileName(Date.now());
      link.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "info", text: "Backup downloaded." });
    } catch (error) {
      setMessage({ tone: "danger", text: `The backup could not be made: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    try {
      setPendingImport(JSON.parse(await file.text()));
    } catch {
      setMessage({ tone: "danger", text: "That file is not a backup from this trainer (it is not valid JSON)." });
    }
  };

  const runImport = async (mode: "replace" | "merge") => {
    const backup = pendingImport;
    setPendingImport(null);
    try {
      const summary = await actions.importBackup(backup, mode);
      setMessage({
        tone: "info",
        text: `Imported ${summary.positions} positions, ${summary.lines} lines, ${summary.attempts} answers and ${summary.customLines} lines of your own${mode === "merge" ? " (merged with what was here)" : ""}.`
      });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const runReset = async () => {
    const kind = confirm;
    setConfirm(null);
    try {
      if (kind === "progress") {
        await actions.resetProgress();
        setMessage({ tone: "info", text: "Progress reset. Your settings, line choices and own lines are kept." });
      } else if (kind === "all") {
        await actions.resetAll();
        setMessage({ tone: "info", text: "Everything was reset to a fresh start." });
      }
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section className="panel settings-section" aria-labelledby="data-settings">
      <h2 id="data-settings">Your data</h2>
      <p className="muted small">
        Progress, settings and your own lines are stored only in this browser (IndexedDB). Clearing site data or a private window removes them, so export a
        backup now and then.{" "}
        {persisted === true
          ? "The browser has agreed to keep this storage."
          : persisted === false
            ? "The browser may clear this storage when space runs low."
            : ""}
      </p>
      <div className="row">
        <button type="button" className="button" onClick={exportData}>
          <Download size={16} aria-hidden="true" />
          Export a backup
        </button>
        <button type="button" className="button" onClick={() => fileRef.current?.click()}>
          <Upload size={16} aria-hidden="true" />
          Import a backup
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="visually-hidden" onChange={onFile} tabIndex={-1} aria-hidden="true" />
      </div>
      {pendingImport !== null ? (
        <div className="notice notice-info stack-tight" role="group" aria-label="Import options">
          <p>How should the backup be imported?</p>
          <div className="row">
            <button type="button" className="button button-small" onClick={() => runImport("merge")}>
              Merge with this browser
            </button>
            <button type="button" className="button button-small button-danger" onClick={() => runImport("replace")}>
              Replace everything here
            </button>
            <button type="button" className="button button-small button-ghost" onClick={() => setPendingImport(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="row danger-zone">
        <button type="button" className="button button-danger" onClick={() => setConfirm("progress")}>
          Reset progress
        </button>
        <button type="button" className="button button-danger" onClick={() => setConfirm("all")}>
          Reset everything
        </button>
      </div>
      {message ? (
        <p className={`notice ${message.tone === "danger" ? "notice-danger" : "notice-info"}`} role={message.tone === "danger" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "all" ? "Reset everything?" : "Reset your progress?"}
        confirmLabel={confirm === "all" ? "Reset everything" : "Reset progress"}
        onConfirm={runReset}
        onCancel={() => setConfirm(null)}
      >
        {confirm === "all"
          ? "This deletes your progress, review schedule, settings, line choices and your own lines from this browser. Export a backup first if you might want them back."
          : "This deletes every answer, the review schedule and all mastery from this browser. Settings, line choices and your own lines stay. Export a backup first if you might want it back."}
      </ConfirmDialog>
    </section>
  );
}

function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return (
    <div className="setting-row">
      <div className="stack-tight">
        <span className="field-label" id={`${id}-label`}>
          {label}
        </span>
        {help ? (
          <span className="field-help" id={`${id}-help`}>
            {help}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={help ? `${id}-help` : undefined}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function Range({
  label,
  help,
  value,
  min,
  max,
  step,
  format,
  disabled = false,
  onChange
}: {
  label: string;
  help?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field setting-range">
      <span className="row-between">
        <span className="field-label">{label}</span>
        <span className="tabular small muted">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} aria-valuetext={format(value)} />
      {help ? <span className="field-help">{help}</span> : null}
    </label>
  );
}
