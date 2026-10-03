// The pipe between the UCI client and Stockfish. In the app it is a classic Web Worker running the
// vendored Stockfish WASM build (public/stockfish/); tests use testing/fakeTransport.ts. The worker
// takes one UCI command per postMessage and posts its output as strings, usually one line per
// message but sometimes several joined by newlines, so the transport splits them.

export interface EngineTransport {
  /** Sends one UCI command (without a newline). A no-op after terminate(). */
  send(command: string): void;
  /** Subscribes to engine output, one line per call (never empty). Returns the unsubscribe function. */
  onLine(listener: (line: string) => void): () => void;
  /** Subscribes to worker failures (load errors, uncaught errors, unreadable messages). */
  onError(listener: (error: Error) => void): () => void;
  /** Stops the worker at once. No line or error is delivered afterwards. */
  terminate(): void;
}

/** The vendored engine script, served from public/ (and so offline-cached with the app). */
export const STOCKFISH_PATH = "stockfish/stockfish-19-lite-single.js";

/** The non-empty lines of a worker message; anything that is not a string (progress objects) gives none. */
export function splitEngineOutput(data: unknown): string[] {
  if (typeof data !== "string") {
    return [];
  }
  return data
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

/** A small listener set whose emit survives a listener that throws or unsubscribes while emitting. */
function listenerSet<T>(): { add(listener: (value: T) => void): () => void; emit(value: T): void; clear(): void } {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          // One faulty listener must not stop the others from seeing engine output.
          console.error(error);
        }
      }
    },
    clear() {
      listeners.clear();
    }
  };
}

/** Starts Stockfish as a classic Web Worker. Throws when workers are unavailable (the caller reports it). */
export function createWorkerTransport(url = `${import.meta.env.BASE_URL}${STOCKFISH_PATH}`): EngineTransport {
  const worker = new Worker(url);
  const lines = listenerSet<string>();
  const errors = listenerSet<Error>();
  let terminated = false;

  worker.onmessage = (event: MessageEvent) => {
    if (terminated) {
      return;
    }
    for (const line of splitEngineOutput(event.data)) {
      lines.emit(line);
    }
  };
  worker.onerror = (event: ErrorEvent) => {
    // Handled here: keep it out of the page's console as an "uncaught" error.
    event.preventDefault();
    if (!terminated) {
      errors.emit(new Error(event.message ? `The engine worker failed: ${event.message}` : "The engine worker failed to load or run"));
    }
  };
  worker.onmessageerror = () => {
    if (!terminated) {
      errors.emit(new Error("The engine worker sent a message that could not be read"));
    }
  };

  return {
    send(command) {
      if (!terminated) {
        worker.postMessage(command);
      }
    },
    onLine: (listener) => lines.add(listener),
    onError: (listener) => errors.add(listener),
    terminate() {
      if (terminated) {
        return;
      }
      terminated = true;
      worker.terminate();
      lines.clear();
      errors.clear();
    }
  };
}
