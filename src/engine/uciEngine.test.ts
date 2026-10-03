import { afterEach, describe, expect, it, vi } from "vitest";
import { START_FEN, fenAfter } from "../core/chess/position";
import { EngineCrashedError, EngineTimeoutError, isAbortError } from "./errors";
import { FakeTransport, TRANSCRIPTS, type FakeTransportOptions } from "./testing/fakeTransport";
import { HASH_MB, STOP_GRACE_MS, UciEngine, WATCHDOG_EXTRA_MS, type UciEngineOptions } from "./uciEngine";

const QF6 = fenAfter(["c4", "e5", "Nc3", "Bc5", "g3", "Qf6"]);
const QF6_POSITION = "position fen rnb1k1nr/pppp1ppp/5q2/2b1p3/2P5/2N3P1/PP1PPP1P/R1BQKBNR w KQkq - 1 4";

async function started(options: FakeTransportOptions = {}, engineOptions: UciEngineOptions = {}) {
  const transport = new FakeTransport(options);
  const engine = new UciEngine(transport, engineOptions);
  await engine.init();
  return { transport, engine };
}

/** Lets the fake's microtask-delivered output arrive. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UciEngine handshake", () => {
  it("sends uci, the hash size and isready, and reads the engine name", async () => {
    const { transport, engine } = await started({ id: "Stockfish 19 Lite WASM" });
    expect(engine.name).toBe("Stockfish 19 Lite WASM");
    expect(engine.alive).toBe(true);
    expect(transport.commands).toEqual(["uci", `setoption name Hash value ${HASH_MB}`, "isready"]);
  });

  it("returns the same promise when init is called twice", async () => {
    const transport = new FakeTransport();
    const engine = new UciEngine(transport);
    const first = engine.init();
    expect(engine.init()).toBe(first);
    await expect(first).resolves.toEqual({ name: "Stockfish 19 Lite WASM" });
    expect(transport.commands.filter((command) => command === "uci")).toHaveLength(1);
  });

  it("rejects with EngineCrashedError when the worker fails to load", async () => {
    const transport = new FakeTransport({ handshake: "crash" });
    const onFailure = vi.fn();
    const engine = new UciEngine(transport, { onFailure });
    await expect(engine.init()).rejects.toThrow(EngineCrashedError);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(engine.alive).toBe(false);
    expect(transport.terminated).toBe(true);
  });

  it("times out a handshake that never answers", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport({ handshake: "hang" });
    const engine = new UciEngine(transport, { handshakeTimeoutMs: 5000 });
    const init = engine.init();
    const assertion = expect(init).rejects.toThrow(EngineTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(transport.terminated).toBe(true);
  });

  it("refuses to analyse before init", async () => {
    const engine = new UciEngine(new FakeTransport());
    await expect(engine.analyse(START_FEN, { depth: 5 })).rejects.toThrow(/init\(\)/);
  });
});

describe("UciEngine searches", () => {
  it("sends MultiPV, position and go, and returns the deepest complete iteration", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.c4QueenF6Mpv3] });
    const result = await engine.analyse(QF6, { multiPv: 3, depth: 18, movetimeMs: 800 });
    expect(result.depth).toBe(12);
    expect(result.complete).toBe(true);
    expect(result.lines.map((line) => [line.uci, line.cp])).toEqual([
      ["e2e3", 91],
      ["g1f3", 87],
      ["f2f4", 60]
    ]);
    expect(transport.searchCommands).toEqual(["setoption name MultiPV value 3", QF6_POSITION, "go depth 18 movetime 800"]);
  });

  it("sends MultiPV only when it changes and never sends ucinewgame on its own", async () => {
    const { transport, engine } = await started();
    await engine.analyse(START_FEN, { multiPv: 2, depth: 5 });
    await engine.analyse(START_FEN, { multiPv: 2, depth: 5 });
    await engine.analyse(START_FEN, { depth: 5 });
    expect(transport.searchCommands).toEqual([
      "setoption name MultiPV value 2",
      "position startpos",
      "go depth 5",
      "position startpos",
      "go depth 5",
      "setoption name MultiPV value 1",
      "position startpos",
      "go depth 5"
    ]);
    expect(transport.commands).not.toContain("ucinewgame");
  });

  it("sends ucinewgame through newGame and waits for readyok", async () => {
    const { transport, engine } = await started();
    await engine.newGame();
    expect(transport.commands.slice(-2)).toEqual(["ucinewgame", "isready"]);
  });

  it("restricts the root with searchmoves and expects one rank per searched move", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.c4BishopG2Searchmoves] });
    const result = await engine.analyse(QF6, { depth: 12, searchMoves: ["f1g2"] });
    expect(result).toMatchObject({ depth: 12, complete: true, lines: [{ uci: "f1g2", mate: -1, pv: ["f1g2", "f6f2"] }] });
    expect(transport.commands.at(-1)).toBe("go depth 12 searchmoves f1g2");
  });

  it("expects no more ranks than the position has legal moves", async () => {
    // Black king on h8 in check from the rook on h1: only Kg7 and Kg8.
    const fen = "7k/8/8/8/8/8/8/K6R b - - 0 1";
    const { engine } = await started();
    const result = await engine.analyse(fen, { multiPv: 3, depth: 4 });
    expect(result.complete).toBe(true);
    expect(result.lines.map((line) => line.uci)).toEqual(["h8g7", "h8g8"]);
  });

  it("returns no lines for bestmove (none)", async () => {
    const { engine } = await started({ searches: ["info depth 0 score mate 0\nbestmove (none)"] });
    await expect(engine.analyse(START_FEN, { depth: 5 })).resolves.toEqual({ lines: [], depth: 0, complete: false });
  });

  it("rejects a malformed request without sending anything", async () => {
    const { transport, engine } = await started();
    const before = transport.commands.length;
    await expect(engine.analyse("not a fen", { depth: 5 })).rejects.toThrow(/Not a valid position/);
    await expect(engine.analyse(START_FEN, { depth: 5, searchMoves: ["e2e5"] })).rejects.toThrow(/not a legal move/);
    await expect(engine.analyse(START_FEN, {})).rejects.toThrow(/depth or a movetime/);
    await expect(engine.analyse(START_FEN, { depth: 5, multiPv: 0 })).rejects.toThrow(/MultiPV/);
    expect(transport.commands.length).toBe(before);
  });

  it("queues searches first in, first out and never sends a command during a search", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop, TRANSCRIPTS.startposStoppedMpv2] });
    const order: string[] = [];
    const first = engine.analyse(START_FEN, { depth: 30 }).then((result) => {
      order.push("first");
      return result;
    });
    const second = engine.analyse(START_FEN, { multiPv: 2, depth: 15 }).then((result) => {
      order.push("second");
      return result;
    });
    const third = engine.analyse(fenAfter(["e4"]), { depth: 3 }).then((result) => {
      order.push("third");
      return result;
    });
    await settle();
    expect(transport.searches).toBe(1);
    expect(engine.busy).toBe(true);
    engine.stop();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    expect(a.lines[0]).toMatchObject({ uci: "e2e4", depth: 2 });
    expect(b).toMatchObject({ depth: 14, complete: true });
    expect(c.lines).toHaveLength(1);
    expect(transport.violations).toEqual([]);
    expect(engine.busy).toBe(false);
  });

  it("relies on a fake that does notice commands sent during a search", async () => {
    const transport = new FakeTransport({ searches: [TRANSCRIPTS.waitStop] });
    transport.send("go depth 30");
    await settle();
    transport.send("position startpos");
    transport.send("go depth 5");
    expect(transport.violations).toEqual(["position startpos (sent during a search)", "go depth 5 (sent during a search)"]);
  });

  it("stop() ends the running search with the lines found so far", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop] });
    const search = engine.analyse(START_FEN, { depth: 40, movetimeMs: 60_000 });
    await settle();
    engine.stop();
    await expect(search).resolves.toMatchObject({ lines: [{ uci: "e2e4", cp: 22 }], depth: 2 });
    expect(transport.commands.filter((command) => command === "stop")).toHaveLength(1);
  });
});

describe("UciEngine abort", () => {
  it("rejects at once when the signal is already aborted", async () => {
    const { transport, engine } = await started();
    const controller = new AbortController();
    controller.abort();
    const error = await engine.analyse(START_FEN, { depth: 5, signal: controller.signal }).catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(transport.searches).toBe(0);
  });

  it("stops a running search, waits for its bestmove, then rejects with AbortError", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop, TRANSCRIPTS.c4QueenF6Mpv3] });
    const controller = new AbortController();
    const running = engine.analyse(START_FEN, { depth: 30, signal: controller.signal });
    const next = engine.analyse(QF6, { multiPv: 3, depth: 12 });
    await settle();
    controller.abort();
    const error = await running.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(error).toBeInstanceOf(DOMException);
    expect(transport.commands).toContain("stop");
    // The next search only starts after the aborted one's bestmove.
    await expect(next).resolves.toMatchObject({ depth: 12, complete: true });
    expect(transport.violations).toEqual([]);
    expect(engine.alive).toBe(true);
  });

  it("rejects with AbortError when the signal aborts after a stop was already sent", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop] });
    const controller = new AbortController();
    const running = engine.analyse(START_FEN, { depth: 30, signal: controller.signal });
    await settle();
    engine.stop();
    controller.abort();
    const error = await running.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    expect(transport.commands.filter((command) => command === "stop")).toHaveLength(1);
  });

  it("removes a queued search without sending anything for it", async () => {
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop] });
    const running = engine.analyse(START_FEN, { depth: 30 });
    const controller = new AbortController();
    const queued = engine.analyse(fenAfter(["d4"]), { depth: 30, signal: controller.signal });
    await settle();
    controller.abort();
    const error = await queued.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
    engine.stop();
    await running;
    expect(transport.searches).toBe(1);
    expect(transport.commands.some((command) => command.includes("3P4"))).toBe(false);
  });

  it("shuts down an engine that ignores stop after an abort", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.hang] }, { onFailure });
    const controller = new AbortController();
    const running = engine.analyse(START_FEN, { depth: 30, signal: controller.signal });
    const outcome = running.catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(isAbortError(await outcome)).toBe(true);
    expect(engine.alive).toBe(false);
    expect(transport.terminated).toBe(true);
    expect(onFailure.mock.calls[0][0]).toBeInstanceOf(EngineTimeoutError);
  });
});

describe("UciEngine watchdog", () => {
  it("sends stop after movetime plus the margin and rejects with EngineTimeoutError; the engine stays usable", async () => {
    vi.useFakeTimers();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop, TRANSCRIPTS.c4QueenF6Mpv3] });
    const search = engine.analyse(START_FEN, { depth: 18, movetimeMs: 800 });
    const outcome = search.catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(800 + WATCHDOG_EXTRA_MS - 1);
    expect(transport.commands).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.commands.at(-1)).toBe("stop");
    const error = await outcome;
    expect(error).toBeInstanceOf(EngineTimeoutError);
    expect(engine.alive).toBe(true);
    await expect(engine.analyse(QF6, { multiPv: 3, depth: 12, movetimeMs: 800 })).resolves.toMatchObject({ depth: 12 });
  });

  it("uses the depth-only watchdog when there is no movetime", async () => {
    vi.useFakeTimers();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop] }, { depthOnlyWatchdogMs: 10_000 });
    const outcome = engine.analyse(START_FEN, { depth: 18 }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(transport.commands).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(EngineTimeoutError);
  });

  it("shuts down an engine that ignores stop, rejecting the search and everything queued", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.hang] }, { onFailure });
    const first = engine.analyse(START_FEN, { depth: 18, movetimeMs: 500 }).catch((reason: unknown) => reason);
    const queued = engine.analyse(START_FEN, { depth: 18, movetimeMs: 500 }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(500 + WATCHDOG_EXTRA_MS + STOP_GRACE_MS);
    expect(await first).toBeInstanceOf(EngineTimeoutError);
    expect(await queued).toBeInstanceOf(EngineTimeoutError);
    expect(String(await first)).toMatch(/ignored "stop"/);
    expect(engine.alive).toBe(false);
    expect(transport.terminated).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    await expect(engine.analyse(START_FEN, { depth: 5 })).rejects.toThrow(EngineTimeoutError);
  });
});

describe("UciEngine crash and dispose", () => {
  it("rejects the running and queued searches with EngineCrashedError and fails fast afterwards", async () => {
    const onFailure = vi.fn();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.crash] }, { onFailure });
    const running = engine.analyse(START_FEN, { depth: 18 }).catch((reason: unknown) => reason);
    const queued = engine.analyse(START_FEN, { depth: 18 }).catch((reason: unknown) => reason);
    const runningError = await running;
    expect(runningError).toBeInstanceOf(EngineCrashedError);
    expect(String(runningError)).toMatch(/memory access out of bounds/);
    expect(await queued).toBe(runningError);
    expect(onFailure).toHaveBeenCalledWith(runningError);
    expect(transport.terminated).toBe(true);
    await expect(engine.analyse(START_FEN, { depth: 5 })).rejects.toBe(runningError);
    await expect(engine.newGame()).rejects.toBe(runningError);
  });

  it("treats a worker error while idle as a crash", async () => {
    const onFailure = vi.fn();
    const { transport, engine } = await started({}, { onFailure });
    transport.crash("out of memory");
    expect(engine.alive).toBe(false);
    expect(onFailure.mock.calls[0][0]).toBeInstanceOf(EngineCrashedError);
  });

  it("dispose sends quit, terminates and rejects pending work, without reporting a failure", async () => {
    const onFailure = vi.fn();
    const { transport, engine } = await started({ searches: [TRANSCRIPTS.waitStop] }, { onFailure });
    const running = engine.analyse(START_FEN, { depth: 30 }).catch((reason: unknown) => reason);
    const queued = engine.analyse(START_FEN, { depth: 30 }).catch((reason: unknown) => reason);
    await settle();
    engine.dispose();
    expect(isAbortError(await running)).toBe(true);
    expect(isAbortError(await queued)).toBe(true);
    expect(transport.commands.at(-1)).toBe("quit");
    expect(transport.terminated).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
    await expect(engine.analyse(START_FEN, { depth: 5 })).rejects.toThrow(/shut down/);
    engine.dispose();
  });

  it("dispose during the handshake rejects init with the given reason", async () => {
    const transport = new FakeTransport({ handshake: "hang" });
    const engine = new UciEngine(transport);
    const init = engine.init();
    engine.dispose(new Error("switched off"));
    await expect(init).rejects.toThrow("switched off");
  });
});
