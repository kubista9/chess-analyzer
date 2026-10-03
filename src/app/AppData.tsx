import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Color } from "../core/chess/position";
import { buildCatalog } from "../core/content/catalog";
import { builtinContent } from "../core/content/builtin";
import { buildTree, positionItems } from "../core/content/tree";
import type { Catalog, Line, PositionItem, RepertoireTree } from "../core/content/types";
import { applyLineRun, applyPositionResult, applyRecallAnswer, effectiveStatus, lineMastery, newLineProgress, newPositionProgress, suggestedStatus } from "../core/training/mastery";
import { resultOf, hintsShown } from "../core/training/hints";
import type {
  AttemptRecord,
  AttemptTry,
  CustomLineRecord,
  LadderState,
  LineProgress,
  LineState,
  LineStatus,
  Mode,
  PositionProgress,
  Settings
} from "../core/training/types";
import { DEFAULT_SETTINGS } from "../core/training/types";
import { dayKey } from "../core/util/time";
import type { BackupFile, ImportSummary } from "../storage/backup";
import { openTrainerStore, type TrainerStore } from "../storage/store";

// The app's single source of truth. On start it opens the IndexedDB store, compiles the
// repertoire content (built-in chapters plus the user's own lines) and keeps progress in memory;
// every change is written through to the store. Pages read it with useAppData().

export interface LineView {
  line: Line;
  enabled: boolean;
  status: LineStatus;
  /** True when the user set the status by hand. */
  statusManual: boolean;
  mastery: number;
  seen: number;
  total: number;
  progress: LineProgress | null;
}

export interface PositionAttemptInput {
  item: PositionItem;
  mode: Mode;
  lineId: string | null;
  ladder: LadderState;
  tries: AttemptTry[];
  startedAt: number;
}

export interface AppActions {
  updateSettings(update: (settings: Settings) => Settings): void;
  setLinesEnabled(lineIds: readonly string[], enabled: boolean): void;
  /** null returns the line to the computed status. */
  setLineStatus(lineId: string, status: LineStatus | null): void;
  recordPositionAttempt(input: PositionAttemptInput): void;
  recordLineRun(input: { line: Line; ladders: readonly LadderState[] }): void;
  recordRecall(input: { line: Line; correct: boolean; expected: string; chosen: string; startedAt: number }): void;
  saveCustomLine(record: CustomLineRecord): Promise<void>;
  deleteCustomLine(id: string): Promise<void>;
  exportBackup(): Promise<BackupFile>;
  importBackup(backup: unknown, mode: "replace" | "merge"): Promise<ImportSummary>;
  resetProgress(): Promise<void>;
  resetAll(): Promise<void>;
}

export interface AppDataValue {
  catalog: Catalog;
  settings: Settings;
  lineStates: ReadonlyMap<string, LineState>;
  positions: ReadonlyMap<string, PositionProgress>;
  lineProgress: ReadonlyMap<string, LineProgress>;
  attempts: readonly AttemptRecord[];
  practiceDays: readonly string[];
  customLines: readonly CustomLineRecord[];
  trees: Record<Color, RepertoireTree>;
  items: Record<Color, PositionItem[]>;
  isEnabled(lineId: string): boolean;
  lineView(lineId: string): LineView | null;
  /** A write to the browser store failed; the message says what to do. */
  saveError: string | null;
  persisted: boolean | null;
  actions: AppActions;
}

const AppDataContext = createContext<AppDataValue | null>(null);

interface State {
  settings: Settings;
  lineStates: Map<string, LineState>;
  positions: Map<string, PositionProgress>;
  lineProgress: Map<string, LineProgress>;
  attempts: AttemptRecord[];
  practiceDays: string[];
  customLines: CustomLineRecord[];
}

/** Attempts kept in memory for the dashboard and Progress (older ones stay in the store). */
const ATTEMPTS_IN_MEMORY = 2000;

function toMap<T, K extends keyof T>(records: readonly T[], key: K): Map<T[K] & string, T> {
  return new Map(records.map((record) => [record[key] as T[K] & string, record]));
}

export function AppDataProvider({ children, storeName }: { children: ReactNode; storeName?: string }) {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const storeRef = useRef<TrainerStore | null>(null);
  const stateRef = useRef<State | null>(null);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    let opened: TrainerStore | null = null;
    openTrainerStore(storeName)
      .then(async (store) => {
        opened = store;
        const snapshot = await store.load();
        if (cancelled) {
          store.close();
          return;
        }
        storeRef.current = store;
        setState({
          settings: snapshot.settings,
          lineStates: toMap(snapshot.lineStates, "lineId"),
          positions: toMap(snapshot.positionProgress, "key"),
          lineProgress: toMap(snapshot.lineProgress, "lineId"),
          attempts: snapshot.recentAttempts.slice(0, ATTEMPTS_IN_MEMORY),
          practiceDays: snapshot.practiceDays,
          customLines: snapshot.customLines
        });
        store.persist().then(setPersisted, () => setPersisted(false));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      opened?.close();
      storeRef.current = null;
    };
  }, [storeName]);

  /** Runs a store write; a failure is shown as a banner instead of being lost silently. */
  const persist = useCallback((write: (store: TrainerStore) => Promise<unknown>) => {
    const store = storeRef.current;
    if (!store) {
      return Promise.resolve();
    }
    return write(store).then(
      () => setSaveError(null),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setSaveError(`Your last change could not be saved in this browser (${message}). Export a backup from Settings to be safe.`);
      }
    );
  }, []);

  const customLines = state?.customLines;
  const catalog = useMemo(() => buildCatalog(builtinContent(), customLines ?? []), [customLines]);

  const lineStates = state?.lineStates;
  const isEnabled = useCallback(
    (lineId: string) => {
      const saved = lineStates?.get(lineId);
      if (saved) {
        return saved.enabled;
      }
      return catalog.lineById.get(lineId)?.defaultEnabled ?? false;
    },
    [catalog, lineStates]
  );

  const trees = useMemo(
    () => ({ white: buildTree(catalog, "white", isEnabled), black: buildTree(catalog, "black", isEnabled) }),
    [catalog, isEnabled]
  );
  const items = useMemo(
    () => ({ white: positionItems(trees.white, catalog), black: positionItems(trees.black, catalog) }),
    [trees, catalog]
  );

  const positions = state?.positions;
  const lineProgressMap = state?.lineProgress;
  const lineView = useCallback(
    (lineId: string): LineView | null => {
      const line = catalog.lineById.get(lineId);
      if (!line || !positions) {
        return null;
      }
      const { mastery, seen, total } = lineMastery(line, positions);
      const saved = lineStates?.get(lineId);
      const status = effectiveStatus(saved, suggestedStatus(mastery, seen, total));
      return {
        line,
        enabled: isEnabled(lineId),
        status,
        statusManual: saved?.statusSetAt != null,
        mastery,
        seen,
        total,
        progress: lineProgressMap?.get(lineId) ?? null
      };
    },
    [catalog, positions, lineStates, lineProgressMap, isEnabled]
  );

  const actions = useMemo<AppActions>(() => {
    const appendAttempt = (current: State, attempt: AttemptRecord): Pick<State, "attempts" | "practiceDays"> => ({
      attempts: [attempt, ...current.attempts].slice(0, ATTEMPTS_IN_MEMORY),
      practiceDays: current.practiceDays.includes(attempt.day) ? current.practiceDays : [...current.practiceDays, attempt.day].sort()
    });

    return {
      updateSettings(update) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const settings = update(current.settings);
        setState((previous) => (previous ? { ...previous, settings } : previous));
        void persist((store) => store.saveSettings(settings));
      },

      setLinesEnabled(lineIds, enabled) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const now = Date.now();
        const changed: LineState[] = lineIds.map((lineId) => {
          const saved = current.lineStates.get(lineId);
          return saved
            ? { ...saved, enabled, updatedAt: now }
            : { lineId, enabled, status: "learning", statusSetAt: null, updatedAt: now };
        });
        setState((previous) => {
          if (!previous) {
            return previous;
          }
          const next = new Map(previous.lineStates);
          for (const record of changed) {
            next.set(record.lineId, record);
          }
          return { ...previous, lineStates: next };
        });
        void persist((store) => store.putLineStates(changed));
      },

      setLineStatus(lineId, status) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const now = Date.now();
        const saved = current.lineStates.get(lineId);
        const line = catalog.lineById.get(lineId);
        const record: LineState = {
          lineId,
          enabled: saved?.enabled ?? line?.defaultEnabled ?? true,
          status: status ?? saved?.status ?? "learning",
          statusSetAt: status === null ? null : now,
          updatedAt: now
        };
        setState((previous) => (previous ? { ...previous, lineStates: new Map(previous.lineStates).set(lineId, record) } : previous));
        void persist((store) => store.putLineStates([record]));
      },

      recordPositionAttempt({ item, mode, lineId, ladder, tries, startedAt }) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const now = Date.now();
        const wrongSans = tries.filter((entry) => entry.verdict !== "book" && entry.verdict !== "alternative").map((entry) => entry.san);
        const before = current.positions.get(item.key) ?? newPositionProgress(item.side, item.epd);
        const progress = applyPositionResult(before, { ladder, wrongSans, now });
        const attempt: AttemptRecord = {
          at: now,
          day: dayKey(now),
          mode,
          side: item.side,
          lineId: lineId ?? item.lineIds[0] ?? null,
          posKey: item.key,
          epd: item.epd,
          expected: item.expected.map((edge) => edge.san),
          tries,
          hintsShown: hintsShown(ladder),
          revealed: ladder.revealed,
          result: resultOf(ladder),
          durationMs: Math.max(0, now - startedAt)
        };
        setState((previous) =>
          previous ? { ...previous, positions: new Map(previous.positions).set(item.key, progress), ...appendAttempt(previous, attempt) } : previous
        );
        void persist((store) => store.record({ attempt, positions: [progress] }));
      },

      recordLineRun({ line, ladders }) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const now = Date.now();
        const progress = applyLineRun(current.lineProgress.get(line.id) ?? newLineProgress(line.id), { ladders, now });
        setState((previous) => (previous ? { ...previous, lineProgress: new Map(previous.lineProgress).set(line.id, progress) } : previous));
        void persist((store) => store.record({ lines: [progress] }));
      },

      recordRecall({ line, correct, expected, chosen, startedAt }) {
        const current = stateRef.current;
        if (!current) {
          return;
        }
        const now = Date.now();
        const progress = applyRecallAnswer(current.lineProgress.get(line.id) ?? newLineProgress(line.id), { correct, now });
        const attempt: AttemptRecord = {
          at: now,
          day: dayKey(now),
          mode: "recall",
          side: line.side,
          lineId: line.id,
          posKey: null,
          epd: line.epds[line.recallPly] ?? null,
          expected: [expected],
          tries: [{ san: chosen, verdict: correct ? "book" : "unverified" }],
          hintsShown: 0,
          revealed: !correct,
          result: correct ? "clean" : "revealed",
          durationMs: Math.max(0, now - startedAt)
        };
        setState((previous) =>
          previous ? { ...previous, lineProgress: new Map(previous.lineProgress).set(line.id, progress), ...appendAttempt(previous, attempt) } : previous
        );
        void persist((store) => store.record({ attempt, lines: [progress] }));
      },

      async saveCustomLine(record) {
        const store = storeRef.current;
        if (!store) {
          return;
        }
        await store.putCustomLine(record);
        setState((previous) =>
          previous ? { ...previous, customLines: [...previous.customLines.filter((entry) => entry.id !== record.id), record] } : previous
        );
      },

      async deleteCustomLine(id) {
        const store = storeRef.current;
        if (!store) {
          return;
        }
        await store.deleteCustomLine(id);
        setState((previous) => (previous ? { ...previous, customLines: previous.customLines.filter((entry) => entry.id !== id) } : previous));
      },

      async exportBackup() {
        const store = storeRef.current;
        if (!store) {
          throw new Error("The store is not open yet.");
        }
        return store.exportBackup(Date.now());
      },

      async importBackup(backup, mode) {
        const store = storeRef.current;
        if (!store) {
          throw new Error("The store is not open yet.");
        }
        const summary = await store.importBackup(backup, { mode });
        await reload(store);
        return summary;
      },

      async resetProgress() {
        const store = storeRef.current;
        if (!store) {
          return;
        }
        await store.resetProgress();
        await reload(store);
      },

      async resetAll() {
        const store = storeRef.current;
        if (!store) {
          return;
        }
        await store.resetAll();
        await reload(store);
      }
    };

    async function reload(store: TrainerStore) {
      const snapshot = await store.load();
      setState({
        settings: snapshot.settings,
        lineStates: toMap(snapshot.lineStates, "lineId"),
        positions: toMap(snapshot.positionProgress, "key"),
        lineProgress: toMap(snapshot.lineProgress, "lineId"),
        attempts: snapshot.recentAttempts.slice(0, ATTEMPTS_IN_MEMORY),
        practiceDays: snapshot.practiceDays,
        customLines: snapshot.customLines
      });
    }
  }, [catalog, persist]);

  const value = useMemo<AppDataValue | null>(() => {
    if (!state) {
      return null;
    }
    return {
      catalog,
      settings: state.settings,
      lineStates: state.lineStates,
      positions: state.positions,
      lineProgress: state.lineProgress,
      attempts: state.attempts,
      practiceDays: state.practiceDays,
      customLines: state.customLines,
      trees,
      items,
      isEnabled,
      lineView,
      saveError,
      persisted,
      actions
    };
  }, [state, catalog, trees, items, isEnabled, lineView, saveError, persisted, actions]);

  if (loadError) {
    return <StartupError message={loadError} />;
  }
  if (!value) {
    return (
      <div className="startup" role="status" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">
          ♞
        </span>
        <span>Loading your repertoire…</span>
      </div>
    );
  }
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

function StartupError({ message }: { message: string }) {
  return (
    <div className="startup startup-error" role="alert">
      <h1>The trainer could not open its storage</h1>
      <p className="muted">
        Your progress is kept in this browser&rsquo;s storage (IndexedDB). It may be blocked by a private window or by site settings. Allow site data for
        this page and reload.
      </p>
      <p className="error-text">{message}</p>
      <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
        Reload the page
      </button>
    </div>
  );
}

export function useAppData(): AppDataValue {
  const value = useContext(AppDataContext);
  if (!value) {
    throw new Error("useAppData must be used inside AppDataProvider");
  }
  return value;
}

export { DEFAULT_SETTINGS };
