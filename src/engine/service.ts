import { Chess } from "chess.js";
import { applyMove, fenOf, gameState, isValidFen } from "../core/chess/position";
import { rootMoveLoss } from "../core/engine/score";
import type { AnalyseOptions, AnalysedLine, Analysis, EngineClient, EngineLine, MoveScore } from "../core/engine/types";
import { DEFAULT_SETTINGS } from "../core/training/types";
import { EngineCrashedError, EngineDisabledError, abortError } from "./errors";
import { createWorkerTransport, type EngineTransport } from "./transport";
import { UciEngine, type UciEngineOptions } from "./uciEngine";

// The app's engine: one lazily started Stockfish worker behind the EngineClient interface.
// - Nothing loads until the first analyse/scoreMove (or warmUp()). Checkmate and stalemate are
//   answered from the rules alone, without the engine, even when it is switched off.
// - Switched off (setEnabled(false)), the worker is terminated, pending requests reject with
//   EngineDisabledError, and new ones reject with it at once.
// - If the engine fails to start, the error sticks (status "error") until retry() or switching it
//   off and on: the WASM build will not load on the next try either. If a running engine crashes
//   or hangs, the next request starts a fresh worker.
// - Requests run one at a time in arrival order (UciEngine's queue); status is "busy" meanwhile.

export type EngineStatus = "off" | "loading" | "ready" | "busy" | "error";

/** Default search depth limit (plies); with the default movetime, the time usually ends the search first. */
export const DEFAULT_DEPTH = 18;

/** Default thinking time per search (ms), the settings' default. */
export const DEFAULT_MOVETIME_MS = DEFAULT_SETTINGS.engine.analysisMs;

/** Lines searched when a move is scored (MultiPV); a move outside them gets a searchmoves follow-up. */
export const SCORE_MULTI_PV = 3;

/** A stable view of the service state (a new object only when something changed), for useSyncExternalStore. */
export interface EngineSnapshot {
  /** "off": switched off, or not started yet (check `enabled`). */
  status: EngineStatus;
  enabled: boolean;
  /** A readable message when status is "error" (or after a crash, until the next start). */
  error: string | null;
  /** The engine's "id name" once it has started. */
  name: string | null;
}

/** Rejects with an AbortError as soon as `signal` aborts; `promise` keeps running for other callers. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** An engine line with SAN, its pv cut at the first move that is not legal (never expected from Stockfish). */
export function toAnalysedLine(fen: string, line: EngineLine): AnalysedLine | null {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    return null;
  }
  const pvSan: string[] = [];
  for (const uci of line.pv) {
    try {
      pvSan.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  if (pvSan.length === 0) {
    return null;
  }
  return { ...line, pv: line.pv.slice(0, pvSan.length), san: pvSan[0], pvSan };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The browser engine client. Use getEngineService() in the app; tests pass a fake transport factory. */
export class EngineService implements EngineClient {
  private enabledFlag = true;
  private disposed = false;
  /** The engine being started or running. */
  private engine: UciEngine | null = null;
  /** True once `engine` finished its handshake. */
  private engineReady = false;
  private starting: Promise<UciEngine> | null = null;
  /** A failed start: no automatic retry. */
  private startFailure: Error | null = null;
  /** The last failure (start or crash), shown until the next successful start. */
  private lastFailure: Error | null = null;
  private inFlight = 0;
  private defaults = { movetimeMs: DEFAULT_MOVETIME_MS, depth: DEFAULT_DEPTH };
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private current: EngineSnapshot = { status: "off", enabled: true, error: null, name: null };

  constructor(
    private readonly createTransport: () => EngineTransport = createWorkerTransport,
    private readonly engineOptions: Omit<UciEngineOptions, "onFailure"> = {}
  ) {}

  get status(): EngineStatus {
    return this.current.status;
  }

  get error(): string | null {
    return this.current.error;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** The current state; the same object until something changes. */
  snapshot(): EngineSnapshot {
    return this.current;
  }

  /** Calls `listener` with the new snapshot whenever it changes. Returns the unsubscribe function. */
  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Switches the engine on or off. Off terminates the worker and rejects pending requests with EngineDisabledError. */
  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabledFlag) {
      return;
    }
    this.enabledFlag = enabled;
    if (!enabled) {
      this.discard(new EngineDisabledError("The engine was switched off before it finished."));
      this.startFailure = null;
      this.lastFailure = null;
    }
    this.notify();
  }

  /** Default limits for searches that do not set their own (movetime in ms, depth in plies). */
  setDefaults(defaults: { movetimeMs?: number; depth?: number }): void {
    if (defaults.movetimeMs !== undefined) {
      if (!Number.isFinite(defaults.movetimeMs) || defaults.movetimeMs <= 0) {
        throw new Error(`The engine's thinking time must be a positive number of ms, got ${defaults.movetimeMs}`);
      }
      this.defaults.movetimeMs = defaults.movetimeMs;
    }
    if (defaults.depth !== undefined) {
      if (!Number.isInteger(defaults.depth) || defaults.depth < 1) {
        throw new Error(`The engine's depth must be a positive integer, got ${defaults.depth}`);
      }
      this.defaults.depth = defaults.depth;
    }
  }

  /** Clears a failed start so the next request tries again. */
  retry(): void {
    if (this.startFailure === null && (this.lastFailure === null || this.engine !== null)) {
      return;
    }
    this.startFailure = null;
    this.lastFailure = null;
    this.notify();
  }

  /** Starts the engine in the background (when switched on), so the first check does not wait for the download. */
  warmUp(): void {
    if (this.enabledFlag && !this.disposed && this.startFailure === null) {
      this.ensureEngine().catch(() => undefined);
    }
  }

  /** Analyses a position. Lines are best first, with SAN; a checkmate or stalemate needs no engine. */
  async analyse(fen: string, options: AnalyseOptions = {}): Promise<Analysis> {
    if (!isValidFen(fen)) {
      throw new Error(`Not a valid position: "${fen}"`);
    }
    const state = gameState(fen);
    if (state === "checkmate" || state === "stalemate") {
      return { fen, depth: 0, lines: [], complete: true, terminal: state };
    }
    if (options.signal?.aborted) {
      throw abortError();
    }
    this.track(1);
    try {
      const engine = await raceAbort(this.ensureEngine(), options.signal);
      const result = await engine.analyse(fen, {
        multiPv: options.multiPv ?? 1,
        depth: options.depth ?? this.defaults.depth,
        movetimeMs: options.movetimeMs ?? this.defaults.movetimeMs,
        searchMoves: options.searchMoves,
        signal: options.signal
      });
      const lines = result.lines.map((line) => toAnalysedLine(fen, line)).filter((line): line is AnalysedLine => line !== null);
      return { fen, depth: result.depth, lines, complete: result.complete, terminal: null };
    } finally {
      this.track(-1);
    }
  }

  /**
   * Scores `uci` against the engine's best move at one root: a MultiPV search (SCORE_MULTI_PV
   * lines unless options.multiPv says otherwise) and, when the move is not among the lines, a
   * searchmoves follow-up at the depth the first search reached.
   */
  async scoreMove(fen: string, uci: string, options: AnalyseOptions = {}): Promise<MoveScore> {
    const move = applyMove(fen, uci);
    if (!move) {
      throw new Error(`${uci} is not a legal move in "${fen}"`);
    }
    this.track(1);
    try {
      const main = await this.analyse(fen, { ...options, multiPv: options.multiPv ?? SCORE_MULTI_PV, searchMoves: undefined });
      const best = main.lines[0];
      if (!best) {
        throw new Error(`The engine returned no line for "${fen}"`);
      }
      let played = main.lines.find((line) => line.uci === move.uci);
      if (!played) {
        const follow = await this.analyse(fen, { ...options, multiPv: 1, depth: Math.max(1, main.depth), searchMoves: [move.uci] });
        played = follow.lines.find((line) => line.uci === move.uci);
        if (!played) {
          throw new Error(`The engine did not score ${move.san} in "${fen}"`);
        }
      }
      const loss = played.uci === best.uci ? 0 : rootMoveLoss(best, played);
      return { fen, uci: move.uci, best, played, loss, depth: main.depth };
    } finally {
      this.track(-1);
    }
  }

  /** Tells a running engine that a new game starts (clears its hash). A no-op when it is not running. */
  async newGame(): Promise<void> {
    if (this.engine && this.engineReady && this.engine.alive) {
      await this.engine.newGame();
    }
  }

  /** Ends the running search early (it resolves with what it has). */
  stop(): void {
    this.engine?.stop();
  }

  /** Shuts the engine down for good; pending requests reject with an AbortError. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.discard(abortError("The engine was shut down."));
    this.disposed = true;
    this.enabledFlag = false;
    this.startFailure = null;
    this.lastFailure = null;
    this.notify();
    this.listeners.clear();
  }

  private ensureEngine(): Promise<UciEngine> {
    if (this.disposed) {
      return Promise.reject(new EngineCrashedError("The engine has been shut down."));
    }
    if (!this.enabledFlag) {
      return Promise.reject(new EngineDisabledError());
    }
    if (this.startFailure) {
      return Promise.reject(this.startFailure);
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.engine) {
      return Promise.resolve(this.engine);
    }

    let engine: UciEngine;
    try {
      const transport = this.createTransport();
      engine = new UciEngine(transport, { ...this.engineOptions, onFailure: (error) => this.onEngineFailure(engine, error) });
    } catch (error) {
      const failure = new EngineCrashedError(`The engine could not be started: ${errorMessage(error)}`);
      this.startFailure = failure;
      this.lastFailure = failure;
      this.notify();
      return Promise.reject(failure);
    }
    this.engine = engine;
    this.engineReady = false;
    const starting = engine.init().then(
      () => {
        if (this.engine === engine) {
          this.engineReady = true;
          this.starting = null;
          this.lastFailure = null;
          this.notify();
        }
        return engine;
      },
      (error: unknown) => {
        if (this.engine === engine) {
          this.engine = null;
          this.starting = null;
          this.startFailure = error instanceof Error ? error : new EngineCrashedError(errorMessage(error));
          this.lastFailure = this.startFailure;
          this.notify();
        }
        throw error;
      }
    );
    this.starting = starting;
    this.notify();
    return starting;
  }

  private onEngineFailure(engine: UciEngine, error: Error): void {
    if (this.engine !== engine) {
      return;
    }
    if (!this.engineReady) {
      // A failed start: the init rejection handler records it (and makes it stick).
      return;
    }
    this.engine = null;
    this.engineReady = false;
    this.lastFailure = error;
    this.notify();
  }

  private discard(reason: Error): void {
    const engine = this.engine;
    this.engine = null;
    this.engineReady = false;
    this.starting = null;
    engine?.dispose(reason);
  }

  private track(delta: number): void {
    this.inFlight = Math.max(0, this.inFlight + delta);
    this.notify();
  }

  private computeStatus(): EngineStatus {
    if (!this.enabledFlag) {
      return "off";
    }
    if (this.starting) {
      return "loading";
    }
    if (this.engine) {
      return this.inFlight > 0 ? "busy" : "ready";
    }
    return this.lastFailure ? "error" : "off";
  }

  private notify(): void {
    const next: EngineSnapshot = {
      status: this.computeStatus(),
      enabled: this.enabledFlag,
      error: this.enabledFlag && this.lastFailure ? this.lastFailure.message : null,
      name: this.engine && this.engineReady ? this.engine.name || null : null
    };
    const previous = this.current;
    if (previous.status === next.status && previous.enabled === next.enabled && previous.error === next.error && previous.name === next.name) {
      return;
    }
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
  }
}

let shared: EngineService | null = null;

/** The app's single engine service (created on first use; nothing loads until it is asked to analyse). */
export function getEngineService(): EngineService {
  shared ??= new EngineService();
  return shared;
}
