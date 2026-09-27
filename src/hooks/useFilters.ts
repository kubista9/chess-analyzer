import { useCallback, useState } from "react";
import { IMPORTED_TIME_CLASSES } from "../../shared/constants";
import type { TimeClass } from "../../shared/types";
import { DEFAULT_GAME_WINDOW, parseGameWindow, type GameWindow } from "../../shared/window";

/** The Explorer's tree filters, remembered in this browser (colour and moves live in the URL). */
export interface ExplorerFilters {
  window: GameWindow;
  /** null = blitz and rapid together. */
  timeClass: TimeClass | null;
  /** Recent games count more (the window's default half-life); off = unweighted. */
  weighted: boolean;
}

const FILTERS_KEY = "chess-analyst-explorer-filters";
const DEFAULT_FILTERS: ExplorerFilters = { window: DEFAULT_GAME_WINDOW, timeClass: null, weighted: true };

function readFilters(): ExplorerFilters {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? "null") as Partial<ExplorerFilters> | null;
    return {
      window: parseGameWindow(stored?.window) ?? DEFAULT_FILTERS.window,
      timeClass: (IMPORTED_TIME_CLASSES as readonly unknown[]).includes(stored?.timeClass)
        ? (stored!.timeClass as TimeClass)
        : null,
      weighted: typeof stored?.weighted === "boolean" ? stored.weighted : DEFAULT_FILTERS.weighted
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function useFilters(): [ExplorerFilters, (change: Partial<ExplorerFilters>) => void] {
  const [filters, setFilters] = useState(readFilters);
  const update = useCallback((change: Partial<ExplorerFilters>) => {
    setFilters((current) => {
      const next = { ...current, ...change };
      try {
        window.localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      } catch {
        // Without storage the filters simply reset on reload.
      }
      return next;
    });
  }, []);
  return [filters, update];
}
