import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import readline from "node:readline";
import type { EngineLine } from "../../shared/types.js";
import { MultiPvCollector } from "./multipv.js";

// A crash-safe UCI session around one engine process.
// - Startup: fs.access on the binary, `uci` -> `id name` + `uciok`, Threads/Hash, `isready`.
// - Any process 'error' / 'exit' or stdin 'error' rejects the pending wait with
//   EngineCrashedError and marks the engine dead; every later call fails fast.
// - Each search has a watchdog: on expiry it sends `stop`, waits a grace period for
//   `bestmove`, and kills the process if none comes. Either way the search rejects with
//   EngineTimeoutError (a cut-short search is not the requested depth, so it is never used).
// - MultiPV is sent only when it changes; `ucinewgame` only through newGame(), which the
//   caller calls once per game, so the hash stays warm across a game's positions.

export class EngineCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineCrashedError";
  }
}

export class EngineTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTimeoutError";
  }
}

export interface UciEngineOptions {
  path: string;
  /** Extra process arguments (the tests' fake engine takes its transcripts here). */
  args?: string[];
  threads: number;
  hashMb: number;
  /** How long `uci` / `isready` / `ucinewgame` may take. */
  handshakeTimeoutMs?: number;
  /** Wait for `bestmove` after `stop` before killing the process. */
  stopGraceMs?: number;
}

export interface SearchRequest {
  /** UCI moves from the start position (or from `fen`). */
  moves: readonly string[];
  fen?: string;
  multipv: number;
  /** How many ranks a completed iteration has: min(multipv, root moves). Defaults to multipv. */
  expectedRanks?: number;
  depth?: number;
  nodes?: number;
  searchmoves?: readonly string[];
  timeoutMs: number;
}

export interface SearchResult {
  lines: EngineLine[];
  depth: number;
  complete: boolean;
  nodes: number;
  /** The engine's bestmove token (informational only; null for "(none)"). */
  bestmove: string | null;
  ms: number;
}

/** Splits a UCI `id name` value into a name and a version: "Stockfish 18" -> Stockfish / 18. */
export function parseEngineId(idName: string): { name: string; version: string } {
  const trimmed = idName.trim();
  const space = trimmed.indexOf(" ");
  if (space === -1) {
    return { name: trimmed || "unknown", version: "unknown" };
  }
  return { name: trimmed.slice(0, space), version: trimmed.slice(space + 1).trim() };
}

/** The UCI `go` command for a request. */
export function goCommand(request: Pick<SearchRequest, "depth" | "nodes" | "searchmoves">): string {
  const parts = ["go"];
  if (request.depth !== undefined) {
    parts.push("depth", String(request.depth));
  }
  if (request.nodes !== undefined) {
    parts.push("nodes", String(request.nodes));
  }
  if (parts.length === 1) {
    throw new Error("A search needs a depth or a node limit");
  }
  if (request.searchmoves?.length) {
    parts.push("searchmoves", ...request.searchmoves);
  }
  return parts.join(" ");
}

/** The UCI `position` command: the game history from the start (or a FEN), so the engine sees it. */
export function positionCommand(moves: readonly string[], fen?: string): string {
  const base = fen ? `position fen ${fen}` : "position startpos";
  return moves.length ? `${base} moves ${moves.join(" ")}` : base;
}

type Waiter = {
  onLine: (line: string) => void;
  reject: (error: Error) => void;
};

export class UciEngine {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private waiter: Waiter | null = null;
  private failure: Error | null = null;
  private closing = false;
  private multipv: number | null = null;
  private busy = false;
  private readonly handshakeTimeoutMs: number;
  private readonly stopGraceMs: number;
  /** The `id name` value, e.g. "Stockfish 18". */
  idName = "";

  private constructor(private readonly options: UciEngineOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.stopGraceMs = options.stopGraceMs ?? 1_000;
    this.process = spawn(options.path, options.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.waiter?.onLine(line));
    this.process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.warn(`[engine] ${text}`);
      }
    });
    this.process.on("error", (error) => this.fail(new EngineCrashedError(`Engine process failed: ${error.message}`)));
    this.process.on("exit", (code, signal) =>
      this.fail(new EngineCrashedError(`Engine exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`))
    );
    // Writes after the process died emit EPIPE here; report it like an exit.
    this.process.stdin.on("error", (error) => this.fail(new EngineCrashedError(`Engine input failed: ${error.message}`)));
  }

  /** Starts an engine and completes the UCI handshake. Rejects (and kills it) on any failure. */
  static async start(options: UciEngineOptions): Promise<UciEngine> {
    await fs.access(options.path, fsConstants.X_OK);
    const engine = new UciEngine(options);
    try {
      await engine.handshake();
      return engine;
    } catch (error) {
      engine.kill();
      throw error;
    }
  }

  get alive(): boolean {
    return this.failure === null;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = this.closing ? new EngineCrashedError("Engine closed") : error;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(this.failure);
  }

  private send(command: string): void {
    if (this.failure) {
      throw this.failure;
    }
    this.process.stdin.write(`${command}\n`);
  }

  /**
   * Sends `command` (if any) and resolves when `done(line)` returns a value. Rejects on
   * engine failure or after `timeoutMs`.
   */
  private waitFor<T>(command: string | null, done: (line: string) => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const timer = setTimeout(() => {
        this.waiter = null;
        this.kill();
        reject(new EngineTimeoutError(`Engine did not answer ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = {
        onLine: (line) => {
          const value = done(line);
          if (value !== undefined) {
            clearTimeout(timer);
            this.waiter = null;
            resolve(value);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      if (command !== null) {
        try {
          this.send(command);
        } catch (error) {
          clearTimeout(timer);
          this.waiter = null;
          reject(error as Error);
        }
      }
    });
  }

  private async handshake(): Promise<void> {
    await this.waitFor(
      "uci",
      (line) => {
        if (line.startsWith("id name ")) {
          this.idName = line.slice("id name ".length).trim();
        }
        return line.trim() === "uciok" ? true : undefined;
      },
      this.handshakeTimeoutMs,
      "uci"
    );
    this.send(`setoption name Threads value ${this.options.threads}`);
    this.send(`setoption name Hash value ${this.options.hashMb}`);
    await this.ready();
  }

  private ready(): Promise<true> {
    return this.waitFor("isready", (line) => (line.trim() === "readyok" ? true : undefined), this.handshakeTimeoutMs, "isready");
  }

  /** Starts a new game: clears the hash. Call once per game, never per position. */
  async newGame(): Promise<void> {
    this.guard();
    this.busy = true;
    try {
      this.send("ucinewgame");
      await this.ready();
    } finally {
      this.busy = false;
    }
  }

  private guard(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.busy || this.waiter) {
      throw new Error("The engine is busy with another command");
    }
  }

  /** Runs one search and returns the lines of its deepest completed MultiPV iteration. */
  async search(request: SearchRequest): Promise<SearchResult> {
    this.guard();
    this.busy = true;
    const started = performance.now();
    try {
      if (this.multipv !== request.multipv) {
        this.send(`setoption name MultiPV value ${request.multipv}`);
        this.multipv = request.multipv;
      }
      this.send(positionCommand(request.moves, request.fen));

      const collector = new MultiPvCollector(request.expectedRanks ?? request.multipv);
      const bestmove = await this.runGo(goCommand(request), collector, request.timeoutMs);
      const collected = collector.result();
      return { ...collected, bestmove, ms: performance.now() - started };
    } finally {
      this.busy = false;
    }
  }

  private runGo(command: string, collector: MultiPvCollector, timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      let timedOut = false;
      let graceTimer: NodeJS.Timeout | null = null;
      const clear = () => {
        clearTimeout(watchdog);
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
        this.waiter = null;
      };
      const watchdog = setTimeout(() => {
        timedOut = true;
        try {
          this.send("stop");
        } catch {
          // The failure handler rejects.
          return;
        }
        graceTimer = setTimeout(() => {
          clear();
          this.kill();
          reject(new EngineTimeoutError(`Search timed out after ${timeoutMs} ms and the engine ignored stop; it was killed`));
        }, this.stopGraceMs);
      }, timeoutMs);

      this.waiter = {
        onLine: (line) => {
          if (line.startsWith("bestmove")) {
            clear();
            if (timedOut) {
              reject(new EngineTimeoutError(`Search timed out after ${timeoutMs} ms`));
              return;
            }
            const token = line.trim().split(/\s+/)[1];
            resolve(token && token !== "(none)" ? token : null);
            return;
          }
          collector.push(line);
        },
        reject: (error) => {
          clear();
          reject(error);
        }
      };

      try {
        this.send(command);
      } catch (error) {
        clear();
        reject(error as Error);
      }
    });
  }

  /** Asks the engine to quit and kills it if it has not exited after `graceMs`. */
  async close(graceMs = 500): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      this.closing = true;
      this.fail(new EngineCrashedError("Engine closed"));
      return;
    }
    this.closing = true;
    const exited = new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
    try {
      if (!this.failure) {
        this.process.stdin.write("quit\n");
      }
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => this.kill(), graceMs);
    await exited;
    clearTimeout(timer);
    this.lines.close();
  }

  /** Kills the process at once (SIGKILL). Pending waits reject through the exit handler. */
  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGKILL");
    }
  }
}

/** Starts an engine only to read its `id name`, then closes it. */
export async function detectEngineId(options: UciEngineOptions): Promise<string> {
  const engine = await UciEngine.start(options);
  try {
    return engine.idName;
  } finally {
    await engine.close();
  }
}
