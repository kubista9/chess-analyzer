import { useEffect, useSyncExternalStore } from "react";
import type { EngineClient } from "../core/engine/types";
import { getEngineService, type EngineStatus } from "../engine/service";
import { useAppData } from "./AppData";

// React access to the in-browser Stockfish. The worker starts lazily on the first request, and
// only while the engine is enabled in Settings; every caller treats the engine as optional.

/** Keeps the engine service in step with Settings (call once, in the shell). */
export function useEngineSettingsSync(): void {
  const { settings } = useAppData();
  const { enabled, analysisMs } = settings.engine;
  useEffect(() => {
    const service = getEngineService();
    service.setEnabled(enabled);
    service.setDefaults({ movetimeMs: analysisMs });
  }, [enabled, analysisMs]);
}

/** The engine's status, re-rendering on change. */
export function useEngineStatus(): EngineStatus {
  const service = getEngineService();
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.status,
    () => service.status
  );
}

/** The engine when it is enabled in Settings, else null. */
export function useEngine(): EngineClient | null {
  const { settings } = useAppData();
  return settings.engine.enabled ? getEngineService() : null;
}

export const ENGINE_STATUS_LABELS: Record<EngineStatus, string> = {
  off: "Engine off",
  loading: "Engine starting…",
  ready: "Engine ready",
  busy: "Engine thinking…",
  error: "Engine unavailable"
};
