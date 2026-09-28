import { useEffect, useRef, useState } from "react";

export interface StoreQuery<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Loads data from the game store API and reloads when `deps` change (e.g. the window or the
 * data version after a sync). A superseded request is aborted, so an older answer never wins.
 */
export function useStoreQuery<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): StoreQuery<T> {
  const [state, setState] = useState<StoreQuery<T>>({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ data, error: null, loading: false });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Request failed",
            loading: false
          }));
        }
      });
    return () => controller.abort();
    // The caller lists what the query depends on (load itself is read through a ref).
  }, deps);

  return state;
}
