import { Chess } from "chess.js";
import { fenOf } from "../core/chess/position";
import type { AnalyseOptions, EngineLine } from "../core/engine/types";
import { MultiPvCollector, goCommand, parseBestMove, parseIdName, positionCommand, setOptionCommand } from "../core/engine/uci";
import { EngineCrashedError, EngineTimeoutError, abortError } from "./errors";
import type { EngineTransport } from "./transport";

// A UCI session with one Stockfish worker.
// - init(): "uci" → "uciok" (reading "id name"), "setoption name Hash", "isready" → "readyok".
// - One search at a time, FIFO. Stockfish queues "go" and "setoption" while it searches but runs
//   "position" at once, so nothing is sent for the next search before the current one's bestmove.
// - MultiPV is sent only when it changes; "ucinewgame" only through newGame(), so the hash stays
//   warm across the positions of one game or session.
// - Each search has a watchdog (movetime + WATCHDOG_EXTRA_MS): it sends "stop", waits
//   STOP_GRACE_MS for bestmove and rejects with EngineTimeoutError. A cut-short search is never
//   returned as if it were complete. An engine that ignores "stop" is shut down.
// - An AbortSignal removes a queued search, or stops a running one, waits for its bestmove (so the
//   next search starts clean) and rejects with an AbortError.
// - A worker error rejects the running and queued work with EngineCrashedError; every later call
//   fails fast with the same error.

/** Hash table size set after the handshake (MB); small, because the lite build runs inside a tab. */
export const HASH_MB = 16;

/** How long "uci" → "uciok" and "isready" → "readyok" may take, loading the WASM included (ms). */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** The watchdog fires this long after a search's movetime (ms). */
export const WATCHDOG_EXTRA_MS = 3_000;

/** The watchdog of a search that has a depth but no movetime limit (ms). */
export const DEPTH_ONLY_WATCHDOG_MS = 60_000;

/** After "stop", bestmove must arrive within this, or the engine counts as hung (ms). */
export const STOP_GRACE_MS = 1_000;

export interface UciEngineOptions {
  /** MB; default HASH_MB. */
  hashMb?: number;
  /** ms; default HANDSHAKE_TIMEOUT_MS. */
  handshakeTimeoutMs?: number;
  /** ms; default WATCHDOG_EXTRA_MS. */
  watchdogExtraMs?: number;
  /** ms; default DEPTH_ONLY_WATCHDOG_MS. */
  depthOnlyWatchdogMs?: number;
  /** ms; default STOP_GRACE_MS. */
  stopGraceMs?: number;
  /** Called once when the engine dies (crash, hang, failed start). Not called by dispose(). */
  onFailure?: (error: Error) => void;
}

/** The trusted lines of one search (see MultiPvCollector). */
export interface EngineSearchResult {
  lines: EngineLine[];
  /** Depth of the iteration the lines come from (0 when there are none). */
  depth: number;
  /** True when every expected rank finished that iteration with distinct moves. */
  complete: boolean;
}

type Phase = "new" | "starting" | "ready" | "failed" | "disposed";
type Timer = ReturnType<typeof setTimeout>;

/** The handler of whatever the engine is doing now (handshake, search or newGame). */
interface Active {
  onLine(line: string): void;
  /** The engine died or was disposed: settle with this error. */
  fail(error: Error): void;
  /** Ends a running search early (stop()); absent for the handshake and newGame. */
  stop?(): void;
}

interface Job {
  run(): void;
  reject(error: Error): void;
  /** Removes the queued-abort listener once the job leaves the queue. */
  detach(): void;
}

interface SearchRequest {
  position: string;
  go: string;
  multiPv: number;
  expectedRanks: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

function legalUci(fen: string): string[] {
  let chess: Chess;
  try {
    chess = new Chess(fenOf(fen));
  } catch {
    throw new Error(`Not a valid position: "${fen}"`);
  }
  return chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
}

/** A UCI client for one engine transport. */
export class UciEngine {
  private phase: Phase = "new";
  private failure: Error | null = null;
  private active: Active | null = null;
  private readonly queue: Job[] = [];
  private initPromise: Promise<{ name: string }> | null = null;
  private multiPv: number | null = null;
  private engineName = "";
  private readonly unsubscribe: (() => void)[];
  private readonly hashMb: number;
  private readonly handshakeTimeoutMs: number;
  private readonly watchdogExtraMs: number;
  private readonly depthOnlyWatchdogMs: number;
  private readonly stopGraceMs: number;

  constructor(
    private readonly transport: EngineTransport,
    private readonly options: UciEngineOptions = {}
  ) {
    this.hashMb = options.hashMb ?? HASH_MB;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.watchdogExtraMs = options.watchdogExtraMs ?? WATCHDOG_EXTRA_MS;
    this.depthOnlyWatchdogMs = options.depthOnlyWatchdogMs ?? DEPTH_ONLY_WATCHDOG_MS;
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
    this.unsubscribe = [
      transport.onLine((line) => this.active?.onLine(line)),
      transport.onError((error) => this.fail(new EngineCrashedError(`The engine stopped working: ${error.message}`)))
    ];
  }

  /** The "id name" the engine reported ("" before init). */
  get name(): string {
    return this.engineName;
  }

  /** False once the engine failed or was disposed. */
  get alive(): boolean {
    return this.phase === "new" || this.phase === "starting" || this.phase === "ready";
  }

  /** True while a search, the handshake or newGame is running, or work is queued. */
  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  /** Runs the UCI handshake once; later calls return the same promise. */
  init(): Promise<{ name: string }> {
    if (this.initPromise) {
      return this.initPromise;
    }
    if (!this.alive) {
      return Promise.reject(this.failure);
    }
    this.phase = "starting";
    this.initPromise = new Promise<{ name: string }>((resolve, reject) => {
      let stage: "uciok" | "readyok" = "uciok";
      const timer = setTimeout(
        () => this.fail(new EngineTimeoutError(`The engine did not start within ${Math.round(this.handshakeTimeoutMs / 1000)} s`)),
        this.handshakeTimeoutMs
      );
      this.active = {
        onLine: (line) => {
          const name = parseIdName(line);
          if (name !== null) {
            this.engineName = name;
          }
          const text = line.trim();
          if (stage === "uciok" && text === "uciok") {
            stage = "readyok";
            this.send(setOptionCommand("Hash", this.hashMb));
            this.send("isready");
          } else if (stage === "readyok" && text === "readyok") {
            clearTimeout(timer);
            this.active = null;
            this.phase = "ready";
            resolve({ name: this.engineName });
            this.pump();
          }
        },
        fail: (error) => {
          clearTimeout(timer);
          this.active = null;
          reject(error);
        }
      };
      this.send("uci");
    });
    return this.initPromise;
  }

  /**
   * Searches `fen` and returns the lines of the deepest iteration in which every expected rank
   * completed. Queued behind the running search. Needs init() first (analyse may be called while
   * init is still running). Defaults: multiPv 1; a depth or movetime limit is required.
   */
  analyse(fen: string, options: AnalyseOptions = {}): Promise<EngineSearchResult> {
    if (!this.alive) {
      return Promise.reject(this.failure);
    }
    if (this.phase === "new") {
      return Promise.reject(new Error("Start the engine with init() before analysing"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError());
    }
    let request: SearchRequest;
    try {
      request = this.prepare(fen, options);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<EngineSearchResult>((resolve, reject) => {
      this.enqueue(
        () => this.runSearch(request, resolve, reject),
        reject,
        request.signal
      );
    });
  }

  /** Starts a new game: "ucinewgame" clears the hash. Call once per game or session, never per position. */
  newGame(): Promise<void> {
    if (!this.alive) {
      return Promise.reject(this.failure);
    }
    if (this.phase === "new") {
      return Promise.reject(new Error("Start the engine with init() before starting a game"));
    }
    return new Promise<void>((resolve, reject) => {
      this.enqueue(
        () => {
          const timer = setTimeout(
            () => this.fail(new EngineTimeoutError("The engine did not answer isready after ucinewgame")),
            this.handshakeTimeoutMs
          );
          this.active = {
            onLine: (line) => {
              if (line.trim() === "readyok") {
                clearTimeout(timer);
                this.active = null;
                resolve();
                this.pump();
              }
            },
            fail: (error) => {
              clearTimeout(timer);
              this.active = null;
              reject(error);
            }
          };
          this.send("ucinewgame");
          this.send("isready");
        },
        reject
      );
    });
  }

  /** Ends the running search early; it resolves with the lines found so far. Queued searches still run. */
  stop(): void {
    this.active?.stop?.();
  }

  /**
   * Sends "quit" and terminates the worker. Running and queued work rejects with `reason` (an
   * AbortError by default); later calls reject with EngineCrashedError.
   */
  dispose(reason: Error = abortError("The engine was shut down.")): void {
    if (this.phase === "disposed") {
      return;
    }
    const wasAlive = this.alive;
    this.phase = "disposed";
    this.failure = new EngineCrashedError("The engine has been shut down.");
    if (wasAlive) {
      try {
        this.transport.send("quit");
      } catch {
        // Terminated below either way.
      }
    }
    this.shutdown(reason);
  }

  private prepare(fen: string, options: AnalyseOptions): SearchRequest {
    const multiPv = options.multiPv ?? 1;
    if (!Number.isInteger(multiPv) || multiPv < 1) {
      throw new Error(`MultiPV must be a positive integer, got ${multiPv}`);
    }
    const legal = legalUci(fen);
    let rootMoves = legal.length;
    let searchMoves: string[] | undefined;
    if (options.searchMoves && options.searchMoves.length > 0) {
      const allowed = new Set(legal);
      const illegal = options.searchMoves.find((move) => !allowed.has(move));
      if (illegal !== undefined) {
        throw new Error(`${illegal} is not a legal move in "${fen}"`);
      }
      searchMoves = [...new Set(options.searchMoves)];
      rootMoves = searchMoves.length;
    }
    const go = goCommand({ depth: options.depth, movetimeMs: options.movetimeMs, searchMoves });
    return {
      position: positionCommand(fen),
      go,
      multiPv,
      expectedRanks: Math.max(1, Math.min(multiPv, rootMoves)),
      timeoutMs: options.movetimeMs !== undefined ? options.movetimeMs + this.watchdogExtraMs : this.depthOnlyWatchdogMs,
      signal: options.signal
    };
  }

  private enqueue(run: () => void, reject: (error: Error) => void, signal?: AbortSignal): void {
    const onQueuedAbort = () => {
      const index = this.queue.indexOf(job);
      if (index !== -1) {
        this.queue.splice(index, 1);
        reject(abortError());
      }
    };
    const job: Job = {
      run,
      reject,
      detach: () => signal?.removeEventListener("abort", onQueuedAbort)
    };
    signal?.addEventListener("abort", onQueuedAbort, { once: true });
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.phase !== "ready" || this.active !== null) {
      return;
    }
    const job = this.queue.shift();
    if (job) {
      job.detach();
      job.run();
    }
  }

  private runSearch(request: SearchRequest, resolve: (result: EngineSearchResult) => void, reject: (error: Error) => void): void {
    const { signal } = request;
    if (signal?.aborted) {
      reject(abortError());
      this.pump();
      return;
    }
    const collector = new MultiPvCollector(request.expectedRanks);
    let stopReason: "timeout" | "abort" | "stop" | null = null;
    // An abort always ends in an AbortError, even when a stop or the watchdog came first.
    let aborted = false;
    let grace: Timer | null = null;

    const settle = () => {
      clearTimeout(watchdog);
      if (grace !== null) {
        clearTimeout(grace);
      }
      signal?.removeEventListener("abort", onAbort);
      this.active = null;
    };
    const requestStop = (reason: "timeout" | "abort" | "stop") => {
      if (stopReason !== null) {
        return;
      }
      stopReason = reason;
      clearTimeout(watchdog);
      this.send("stop");
      grace = setTimeout(() => {
        settle();
        const error = new EngineTimeoutError(`The engine ignored "stop" for ${this.stopGraceMs} ms and was shut down`);
        reject(aborted || reason === "abort" ? abortError() : error);
        this.fail(error);
      }, this.stopGraceMs);
    };
    const onAbort = () => {
      aborted = true;
      requestStop("abort");
    };
    const watchdog = setTimeout(() => requestStop("timeout"), request.timeoutMs);

    this.active = {
      onLine: (line) => {
        if (parseBestMove(line) === null) {
          collector.push(line);
          return;
        }
        settle();
        if (aborted || stopReason === "abort") {
          reject(abortError());
        } else if (stopReason === "timeout") {
          reject(new EngineTimeoutError(`The search took longer than ${request.timeoutMs} ms`));
        } else {
          const { lines, depth, complete } = collector.result();
          resolve({ lines, depth, complete });
        }
        this.pump();
      },
      fail: (error) => {
        settle();
        reject(error);
      },
      stop: () => requestStop("stop")
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    if (this.multiPv !== request.multiPv) {
      this.send(setOptionCommand("MultiPV", request.multiPv));
      this.multiPv = request.multiPv;
    }
    this.send(request.position);
    this.send(request.go);
  }

  private send(command: string): void {
    if (!this.alive) {
      return;
    }
    try {
      this.transport.send(command);
    } catch (error) {
      this.fail(new EngineCrashedError(`The engine could not be reached: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private fail(error: Error): void {
    if (!this.alive) {
      return;
    }
    this.phase = "failed";
    this.failure = error;
    this.shutdown(error);
    this.options.onFailure?.(error);
  }

  /** Settles the running and queued work with `error`, unsubscribes and terminates the transport. */
  private shutdown(error: Error): void {
    const active = this.active;
    this.active = null;
    const queued = this.queue.splice(0);
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }
    this.transport.terminate();
    active?.fail(error);
    for (const job of queued) {
      job.detach();
      job.reject(error);
    }
  }
}
