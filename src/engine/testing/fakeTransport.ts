import { Chess } from "chess.js";
import { START_FEN, fenOf } from "../../core/chess/position";
import type { EngineTransport } from "../transport";

// A scripted stand-in for the Stockfish worker, for tests (port of the old test/fake-uci.mjs).
// It answers the handshake, records every command, and plays one script per "go": the scripts
// given in order (the last one repeats), or a generated default that returns the position's
// legal moves in sorted order. Output is delivered asynchronously (microtasks), like worker
// messages.
//
// Script lines are emitted as they are, except:
//   # text        a comment, skipped
//   #sleep <ms>   wait before the next line (a real timer, so fake timers can drive it)
//   #wait-stop    pause until the client sends "stop" (at once if it already did)
//   #crash [msg]  report a worker error and go silent
//   #hang         stop answering anything, "stop" and "isready" included
//
// Like Stockfish, it would accept "position" during a search; the fake records that (and a "go"
// or "setoption" sent while searching) in `violations`, so tests can prove the client never does it.

/** What a script function gets for one "go". */
export interface FakeGoContext {
  go: string;
  /** The FEN of the last "position" command. */
  fen: string;
  multiPv: number;
  /** 0-based count of "go" commands so far. */
  index: number;
}

export type FakeScript = string | readonly string[] | ((context: FakeGoContext) => string | readonly string[]);

export interface FakeTransportOptions {
  /** The "id name" (default "Stockfish 19 Lite WASM"). */
  id?: string;
  /** One script per "go", in order; the last repeats. Default: defaultSearch(). */
  searches?: readonly FakeScript[];
  /** How the handshake goes (default "answer"). */
  handshake?: "answer" | "hang" | "crash";
}

/** Default script: every legal move (or searchmoves) at depth 10, sorted, score cp 0. */
export function defaultSearch(context: FakeGoContext): string[] {
  const chess = new Chess(context.fen);
  const tokens = context.go.split(/\s+/);
  const searchIndex = tokens.indexOf("searchmoves");
  const legal = chess
    .moves({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
    .sort();
  const allowed = searchIndex === -1 ? legal : legal.filter((move) => tokens.slice(searchIndex + 1).includes(move));
  if (allowed.length === 0) {
    return [chess.isCheckmate() ? "info depth 0 score mate 0" : "info depth 0 score cp 0", "bestmove (none)"];
  }
  const ranks = allowed.slice(0, context.multiPv);
  return [
    ...ranks.map((move, index) => `info depth 10 seldepth 12 multipv ${index + 1} score cp ${-index * 10} nodes 1000 nps 100000 time 10 pv ${move}`),
    `bestmove ${ranks[0]}`
  ];
}

function scriptLines(script: string | readonly string[]): string[] {
  return typeof script === "string" ? script.split("\n") : [...script];
}

function fenOfPosition(command: string): string {
  const rest = command.slice("position ".length).trim();
  const movesIndex = rest.indexOf(" moves ");
  const base = movesIndex === -1 ? rest : rest.slice(0, movesIndex);
  const fen = base === "startpos" ? START_FEN : fenOf(base.replace(/^fen\s+/, ""));
  if (movesIndex === -1) {
    return fen;
  }
  const chess = new Chess(fen);
  for (const uci of rest.slice(movesIndex + " moves ".length).trim().split(/\s+/)) {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
  return chess.fen();
}

/** The scripted engine. */
export class FakeTransport implements EngineTransport {
  /** Every command received, in order. */
  readonly commands: string[] = [];
  /** Protocol errors of the client (commands Stockfish would mishandle during a search). */
  readonly violations: string[] = [];
  terminated = false;
  /** The FEN of the last "position" command. */
  fen = START_FEN;
  multiPv = 1;

  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private searching = false;
  private hung = false;
  private silent = false;
  private stopRequested = false;
  private stopWaiter: (() => void) | null = null;
  private goCount = 0;

  constructor(private readonly options: FakeTransportOptions = {}) {}

  /** Number of "go" commands received. */
  get searches(): number {
    return this.goCount;
  }

  /** True while a script plays. */
  get isSearching(): boolean {
    return this.searching;
  }

  /** The commands that are not part of the handshake, for compact assertions. */
  get searchCommands(): string[] {
    return this.commands.filter((command) => !["uci", "isready"].includes(command) && !command.startsWith("setoption name Hash"));
  }

  send(command: string): void {
    if (this.terminated) {
      return;
    }
    this.commands.push(command);
    if (this.hung || this.silent) {
      return;
    }
    const word = command.split(" ")[0];
    if (word === "stop") {
      this.stopRequested = true;
      const waiter = this.stopWaiter;
      this.stopWaiter = null;
      waiter?.();
      return;
    }
    if (this.searching && ["go", "position", "setoption", "ucinewgame"].includes(word)) {
      this.violations.push(`${command} (sent during a search)`);
    }
    switch (word) {
      case "uci":
        this.handshake();
        break;
      case "isready":
        this.later(["readyok"]);
        break;
      case "setoption": {
        const match = /^setoption name MultiPV value (\d+)$/.exec(command);
        if (match) {
          this.multiPv = Number(match[1]);
        }
        break;
      }
      case "position":
        this.fen = fenOfPosition(command);
        break;
      case "go":
        void this.play(command);
        break;
      case "quit":
        this.silent = true;
        break;
      default:
        break;
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  terminate(): void {
    this.terminated = true;
    this.searching = false;
    this.stopWaiter = null;
  }

  /** Reports a worker error now (as a failed WASM load or an uncaught error would). */
  crash(message = "RuntimeError: unreachable"): void {
    if (this.terminated) {
      return;
    }
    this.silent = true;
    this.searching = false;
    for (const listener of [...this.errorListeners]) {
      listener(new Error(message));
    }
  }

  /** Emits an output line now. */
  emit(line: string): void {
    if (this.terminated) {
      return;
    }
    for (const listener of [...this.lineListeners]) {
      listener(line);
    }
  }

  private handshake(): void {
    const mode = this.options.handshake ?? "answer";
    if (mode === "hang") {
      this.hung = true;
      return;
    }
    if (mode === "crash") {
      void Promise.resolve().then(() => this.crash("CompileError: WebAssembly.instantiate(): expected magic word"));
      return;
    }
    this.later([
      "Stockfish 19 Lite WASM by the Stockfish developers (see AUTHORS file)",
      `id name ${this.options.id ?? "Stockfish 19 Lite WASM"}`,
      "id author the Stockfish developers (see AUTHORS file)",
      "option name MultiPV type spin default 1 min 1 max 256",
      "uciok"
    ]);
  }

  /** Emits lines one microtask apart, unless the engine went silent meanwhile. */
  private later(lines: readonly string[]): void {
    void (async () => {
      for (const line of lines) {
        await Promise.resolve();
        if (this.terminated || this.hung || this.silent) {
          return;
        }
        this.emit(line);
      }
    })();
  }

  private async play(go: string): Promise<void> {
    const context: FakeGoContext = { go, fen: this.fen, multiPv: this.multiPv, index: this.goCount };
    const scripts = this.options.searches ?? [];
    const script = scripts.length === 0 ? defaultSearch : scripts[Math.min(this.goCount, scripts.length - 1)];
    this.goCount += 1;
    this.searching = true;
    this.stopRequested = false;
    const lines = scriptLines(typeof script === "function" ? script(context) : script);
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith("# ")) {
        continue;
      }
      await Promise.resolve();
      if (this.terminated || this.hung || this.silent) {
        return;
      }
      const [directive, ...rest] = line.split(/\s+/);
      if (directive === "#sleep") {
        await new Promise((resolve) => setTimeout(resolve, Number(rest[0])));
      } else if (directive === "#wait-stop") {
        if (!this.stopRequested) {
          await new Promise<void>((resolve) => {
            this.stopWaiter = resolve;
          });
        }
      } else if (directive === "#crash") {
        this.crash(rest.join(" ") || undefined);
        return;
      } else if (directive === "#hang") {
        this.hung = true;
        return;
      } else {
        if (line.startsWith("bestmove")) {
          this.searching = false;
        }
        this.emit(line);
      }
    }
    this.searching = false;
  }
}

/** A transport factory that remembers every fake it made (one per engine start). */
export function fakeTransports(options: FakeTransportOptions | ((index: number) => FakeTransportOptions) = {}): {
  create: () => FakeTransport;
  made: FakeTransport[];
} {
  const made: FakeTransport[] = [];
  return {
    made,
    create: () => {
      const transport = new FakeTransport(typeof options === "function" ? options(made.length) : options);
      made.push(transport);
      return transport;
    }
  };
}

// Engine output recorded from the vendored Stockfish 19 Lite WASM build (run under Node), with
// the low-depth iterations trimmed, plus directive scripts for failure cases.
export const TRANSCRIPTS = {
  /** 1.c4 e5 2.Nc3 Bc5 3.g3 Qf6, White to move, MultiPV 3, depth 12. */
  c4QueenF6Mpv3: `info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))
info depth 11 seldepth 14 multipv 1 score cp 83 nodes 57899 nps 95700 hashfull 17 time 605 pv g1f3 g8e7 f1g2 d7d6 b2b4 c5b6
info depth 11 seldepth 17 multipv 2 score cp 82 nodes 57899 nps 95700 hashfull 17 time 605 pv e2e3 d7d6 f1g2 b8c6 g1e2
info depth 11 seldepth 21 multipv 3 score cp 52 nodes 57899 nps 95700 hashfull 17 time 605 pv f2f4 d7d6 g1f3 b8c6 f1g2 f6g6 c3d5 c5b6 f4e5 d6e5 d2d4
info depth 12 seldepth 18 multipv 1 score cp 91 nodes 95255 nps 90203 hashfull 36 time 1056 pv e2e3 g8e7 f1g2 e8g8 g1e2 d7d6 d2d4 c5b4 e1g1 c7c6 a2a3 b4c3 e2c3
info depth 12 seldepth 15 multipv 2 score cp 87 nodes 95255 nps 90118 hashfull 36 time 1057 pv g1f3 g8e7 f1g2 d7d6 b2b4 c5b6 e1g1 e8g8 a2a4 a7a5 b4b5 c7c6
info depth 12 seldepth 18 multipv 3 score cp 60 nodes 95255 nps 90033 hashfull 36 time 1058 pv f2f4 d7d6 g1f3 b8c6 f1g2 g8h6 a2a3 a7a5 c3d5 f6d8 f4e5 d6e5 d2d4
bestmove e2e3 ponder g8e7`,
  /** The same position, "go depth 12 searchmoves f1g2": 4.Bg2?? allows 4...Qxf2#. */
  c4BishopG2Searchmoves: `info depth 1 seldepth 8 multipv 1 score mate -1 nodes 11 nps 3666 hashfull 0 time 3 pv f1g2 f6f2
info depth 12 seldepth 3 multipv 1 score mate -1 nodes 33 nps 8250 hashfull 0 time 4 pv f1g2 f6f2
bestmove f1g2 ponder f6f2`,
  /** Start position, MultiPV 2, stopped inside depth 15 (rank 2 only has an upperbound line there). */
  startposStoppedMpv2: `info depth 14 seldepth 21 multipv 1 score cp 34 nodes 62285 nps 514752 hashfull 26 time 121 pv d2d4 d7d5 c2c4 e7e6 g1f3 f8e7
info depth 14 seldepth 21 multipv 2 score cp 32 nodes 62285 nps 514752 hashfull 26 time 121 pv e2e4 c7c5 b1c3 b8c6 g1f3 e7e5
info depth 15 seldepth 25 multipv 1 score cp 29 nodes 160996 nps 506276 hashfull 66 time 318 pv d2d4 d7d5 g1f3 e7e6 c2c4 g8f6
info depth 15 seldepth 25 multipv 2 score cp 28 upperbound nodes 160996 nps 506276 hashfull 66 time 318 pv e2e4 e7e5
bestmove d2d4 ponder d7d5`,
  /** A search that only ends when told to stop. */
  waitStop: `info depth 1 seldepth 1 multipv 1 score cp 20 nodes 30 nps 30000 hashfull 0 tbhits 0 time 1 pv e2e4
#wait-stop
info depth 2 seldepth 2 multipv 1 score cp 22 nodes 90 nps 45000 hashfull 0 tbhits 0 time 2 pv e2e4 e7e5
bestmove e2e4 ponder e7e5`,
  /** A search that never ends and ignores stop. */
  hang: `info depth 1 seldepth 1 multipv 1 score cp 20 nodes 30 nps 30000 hashfull 0 tbhits 0 time 1 pv e2e4
#hang`,
  /** The worker dies in the middle of a search. */
  crash: `info depth 1 seldepth 1 multipv 1 score cp 20 nodes 30 nps 30000 hashfull 0 tbhits 0 time 1 pv e2e4
#crash RuntimeError: memory access out of bounds`
} as const;
