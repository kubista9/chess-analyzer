// Errors of the browser Stockfish client. Callers tell them apart by class (or by `name`, which
// survives structured cloning): a timeout or a crash means "no engine verdict this time", a
// disabled engine means the user switched it off, and an AbortError means the caller cancelled.

/** A search or the handshake took too long (the watchdog fired). */
export class EngineTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTimeoutError";
  }
}

/** The engine worker failed (it could not load, threw, or stopped responding) or was shut down. */
export class EngineCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineCrashedError";
  }
}

/** The engine is switched off in Settings, so nothing was analysed. */
export class EngineDisabledError extends Error {
  constructor(message = "The engine is switched off. Turn it on in Settings to check moves with Stockfish.") {
    super(message);
    this.name = "EngineDisabledError";
  }
}

/** A DOMException named "AbortError", the same error fetch() rejects with when its signal aborts. */
export function abortError(message = "The engine request was cancelled."): DOMException {
  return new DOMException(message, "AbortError");
}

/** True for an AbortError (from abortError(), fetch, or any other abortable API). */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
