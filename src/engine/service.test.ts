import { afterEach, describe, expect, it, vi } from "vitest";
import { START_FEN, fenAfter } from "../core/chess/position";
import { scoreWinPercent } from "../core/engine/score";
import { EngineCrashedError, EngineDisabledError, EngineTimeoutError, isAbortError } from "./errors";
import { DEFAULT_DEPTH, DEFAULT_MOVETIME_MS, EngineService, SCORE_MULTI_PV, getEngineService, toAnalysedLine, type EngineStatus } from "./service";
import { TRANSCRIPTS, fakeTransports, type FakeTransportOptions } from "./testing/fakeTransport";
import { STOP_GRACE_MS, WATCHDOG_EXTRA_MS } from "./uciEngine";

const QF6 = fenAfter(["c4", "e5", "Nc3", "Bc5", "g3", "Qf6"]);
const FOOLS_MATE = fenAfter(["f3", "e5", "g4", "Qh4#"]);
const STALEMATE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

function service(options: FakeTransportOptions | ((index: number) => FakeTransportOptions) = {}) {
  const fakes = fakeTransports(options);
  const engine = new EngineService(fakes.create);
  const statuses: EngineStatus[] = [];
  engine.subscribe((snapshot) => statuses.push(snapshot.status));
  return { engine, fakes, statuses };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EngineService start-up", () => {
  it("creates no worker until the first request, then runs the handshake once", async () => {
    const { engine, fakes, statuses } = service();
    expect(fakes.made).toHaveLength(0);
    expect(engine.status).toBe("off");
    expect(engine.enabled).toBe(true);
    await Promise.all([engine.analyse(START_FEN), engine.analyse(fenAfter(["e4"]))]);
    expect(fakes.made).toHaveLength(1);
    expect(fakes.made[0].commands.filter((command) => command === "uci")).toHaveLength(1);
    expect(engine.snapshot()).toEqual({ status: "ready", enabled: true, error: null, name: "Stockfish 19 Lite WASM" });
    expect(statuses).toEqual(["loading", "busy", "ready"]);
  });

  it("warmUp starts the engine without a request", async () => {
    const { engine, fakes } = service();
    engine.warmUp();
    expect(engine.status).toBe("loading");
    await settle();
    expect(fakes.made).toHaveLength(1);
    expect(engine.status).toBe("ready");
  });

  it("keeps a stable snapshot object until something changes", async () => {
    const { engine } = service();
    const before = engine.snapshot();
    engine.setDefaults({ movetimeMs: 500 });
    expect(engine.snapshot()).toBe(before);
    await engine.analyse(START_FEN);
    expect(engine.snapshot()).not.toBe(before);
  });

  it("makes a failed start stick until retry()", async () => {
    const { engine, fakes } = service((index) => ({ handshake: index === 0 ? "crash" : "answer" }));
    await expect(engine.analyse(START_FEN)).rejects.toThrow(EngineCrashedError);
    expect(engine.status).toBe("error");
    expect(engine.error).toMatch(/WebAssembly/);
    await expect(engine.analyse(START_FEN)).rejects.toThrow(EngineCrashedError);
    expect(fakes.made).toHaveLength(1);
    engine.retry();
    expect(engine.snapshot()).toMatchObject({ status: "off", error: null });
    await expect(engine.analyse(START_FEN)).resolves.toMatchObject({ terminal: null });
    expect(fakes.made).toHaveLength(2);
    expect(engine.status).toBe("ready");
  });

  it("reports a worker that cannot be created", async () => {
    const engine = new EngineService(() => {
      throw new Error("Worker is not defined");
    });
    await expect(engine.analyse(START_FEN)).rejects.toThrow(/could not be started: Worker is not defined/);
    expect(engine.snapshot()).toMatchObject({ status: "error", error: "The engine could not be started: Worker is not defined" });
  });
});

describe("EngineService analyse", () => {
  it("uses the default depth cap and movetime, and adds SAN", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3] });
    const analysis = await engine.analyse(QF6, { multiPv: 3 });
    expect(fakes.made[0].commands.at(-1)).toBe(`go depth ${DEFAULT_DEPTH} movetime ${DEFAULT_MOVETIME_MS}`);
    expect(analysis).toMatchObject({ fen: QF6, depth: 12, complete: true, terminal: null });
    expect(analysis.lines.map((line) => line.san)).toEqual(["e3", "Nf3", "f4"]);
    expect(analysis.lines[0].pvSan.slice(0, 4)).toEqual(["e3", "Ne7", "Bg2", "O-O"]);
    expect(analysis.lines[0].winPct).toBeCloseTo(scoreWinPercent({ cp: 91, mate: null }), 10);
  });

  it("applies setDefaults and lets options override them", async () => {
    const { engine, fakes } = service();
    engine.setDefaults({ movetimeMs: 1500, depth: 12 });
    await engine.analyse(START_FEN);
    expect(fakes.made[0].commands.at(-1)).toBe("go depth 12 movetime 1500");
    await engine.analyse(START_FEN, { depth: 20, movetimeMs: 300 });
    expect(fakes.made[0].commands.at(-1)).toBe("go depth 20 movetime 300");
    expect(() => engine.setDefaults({ movetimeMs: 0 })).toThrow(/positive/);
    expect(() => engine.setDefaults({ depth: 1.5 })).toThrow(/positive integer/);
  });

  it("answers checkmate and stalemate from the rules, without starting the engine", async () => {
    const { engine, fakes } = service();
    await expect(engine.analyse(FOOLS_MATE)).resolves.toEqual({ fen: FOOLS_MATE, depth: 0, lines: [], complete: true, terminal: "checkmate" });
    await expect(engine.analyse(STALEMATE)).resolves.toMatchObject({ lines: [], terminal: "stalemate" });
    engine.setEnabled(false);
    await expect(engine.analyse(FOOLS_MATE)).resolves.toMatchObject({ terminal: "checkmate" });
    expect(fakes.made).toHaveLength(0);
  });

  it("rejects an invalid FEN before starting anything", async () => {
    const { engine, fakes } = service();
    await expect(engine.analyse("8/8/8/8 w - - 0 1")).rejects.toThrow(/Not a valid position/);
    expect(fakes.made).toHaveLength(0);
  });

  it("drops the illegal tail of a pv and a line whose first move is illegal", () => {
    const line = { uci: "e2e4", cp: 20, mate: null, winPct: 51.8, depth: 10, pv: ["e2e4", "e7e5", "e5e4", "g1f3"] };
    expect(toAnalysedLine(START_FEN, line)).toMatchObject({ san: "e4", pv: ["e2e4", "e7e5"], pvSan: ["e4", "e5"] });
    expect(toAnalysedLine(START_FEN, { ...line, uci: "e2e5", pv: ["e2e5"] })).toBeNull();
  });

  it("runs concurrent requests one at a time, in order", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.waitStop, TRANSCRIPTS.c4QueenF6Mpv3] });
    const done: string[] = [];
    const first = engine.analyse(START_FEN).then(() => done.push("first"));
    const second = engine.analyse(QF6, { multiPv: 3 }).then(() => done.push("second"));
    await settle();
    expect(engine.status).toBe("busy");
    expect(fakes.made[0].searches).toBe(1);
    engine.stop();
    await Promise.all([first, second]);
    expect(done).toEqual(["first", "second"]);
    expect(fakes.made[0].violations).toEqual([]);
    expect(engine.status).toBe("ready");
  });
});

describe("EngineService scoreMove", () => {
  it("scores a move found among the MultiPV lines without a follow-up search", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3] });
    const score = await engine.scoreMove(QF6, "g1f3");
    expect(fakes.made[0].searches).toBe(1);
    expect(fakes.made[0].commands).toContain(`setoption name MultiPV value ${SCORE_MULTI_PV}`);
    expect(score).toMatchObject({ fen: QF6, uci: "g1f3", depth: 12, best: { san: "e3", cp: 91 }, played: { san: "Nf3", cp: 87 } });
    expect(score.loss).toBeCloseTo(scoreWinPercent({ cp: 91, mate: null }) - scoreWinPercent({ cp: 87, mate: null }), 10);
  });

  it("gives the best move a loss of 0", async () => {
    const { engine } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3] });
    const score = await engine.scoreMove(QF6, "e2e3");
    expect(score.loss).toBe(0);
    expect(score.played).toBe(score.best);
  });

  it("scores a move outside the lines with a searchmoves follow-up at the same depth (4.Bg2?? allows mate)", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3, TRANSCRIPTS.c4BishopG2Searchmoves] });
    const score = await engine.scoreMove(QF6, "f1g2", { movetimeMs: 1000 });
    expect(fakes.made[0].searchCommands).toEqual([
      "setoption name MultiPV value 3",
      expect.stringMatching(/^position fen /),
      `go depth ${DEFAULT_DEPTH} movetime 1000`,
      "setoption name MultiPV value 1",
      expect.stringMatching(/^position fen /),
      "go depth 12 movetime 1000 searchmoves f1g2"
    ]);
    expect(score.played).toMatchObject({ uci: "f1g2", san: "Bg2", mate: -1, pvSan: ["Bg2", "Qxf2#"] });
    expect(score.best.san).toBe("e3");
    expect(score.loss).toBeCloseTo(scoreWinPercent({ cp: 91, mate: null }) - scoreWinPercent({ cp: null, mate: -1 }), 10);
    expect(score.loss).toBeGreaterThan(50);
    expect(engine.status).toBe("ready");
  });

  it("stays busy between the two searches", async () => {
    const { engine, statuses } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3, TRANSCRIPTS.c4BishopG2Searchmoves] });
    await engine.scoreMove(QF6, "f1g2");
    expect(statuses).toEqual(["loading", "busy", "ready"]);
  });

  it("rejects an illegal move and a follow-up that does not score the move", async () => {
    const { engine } = service({ searches: [TRANSCRIPTS.c4QueenF6Mpv3, "bestmove (none)"] });
    await expect(engine.scoreMove(QF6, "e1e3")).rejects.toThrow(/not a legal move/);
    await expect(engine.scoreMove(QF6, "f1g2")).rejects.toThrow(/did not score Bg2/);
  });
});

describe("EngineService switched off", () => {
  it("rejects with a clear EngineDisabledError and starts nothing", async () => {
    const { engine, fakes } = service();
    engine.setEnabled(false);
    expect(engine.snapshot()).toMatchObject({ status: "off", enabled: false });
    const error = await engine.analyse(START_FEN).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(EngineDisabledError);
    expect(String(error)).toMatch(/switched off/);
    await expect(engine.scoreMove(START_FEN, "e2e4")).rejects.toThrow(EngineDisabledError);
    engine.warmUp();
    expect(fakes.made).toHaveLength(0);
  });

  it("terminates the worker and rejects pending requests when switched off, and starts a new one when switched on", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.waitStop] });
    const pending = engine.analyse(START_FEN).catch((reason: unknown) => reason);
    await settle();
    engine.setEnabled(false);
    expect(await pending).toBeInstanceOf(EngineDisabledError);
    expect(fakes.made[0].terminated).toBe(true);
    expect(fakes.made[0].commands.at(-1)).toBe("quit");
    engine.setEnabled(true);
    expect(engine.status).toBe("off");
    const next = engine.analyse(START_FEN);
    await settle();
    fakes.made[1].send("stop");
    await expect(next).resolves.toMatchObject({ terminal: null });
    expect(fakes.made).toHaveLength(2);
  });

  it("switching off during the handshake rejects the waiting request", async () => {
    const { engine } = service({ handshake: "hang" });
    const pending = engine.analyse(START_FEN).catch((reason: unknown) => reason);
    await settle();
    expect(engine.status).toBe("loading");
    engine.setEnabled(false);
    expect(await pending).toBeInstanceOf(EngineDisabledError);
    expect(engine.snapshot()).toMatchObject({ status: "off", error: null });
  });
});

describe("EngineService abort, timeout and crash", () => {
  it("aborts a running search: stop, bestmove, AbortError; the engine stays ready", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.waitStop, TRANSCRIPTS.c4QueenF6Mpv3] });
    const controller = new AbortController();
    const running = engine.analyse(START_FEN, { signal: controller.signal }).catch((reason: unknown) => reason);
    await settle();
    controller.abort();
    expect(isAbortError(await running)).toBe(true);
    expect(fakes.made[0].commands).toContain("stop");
    expect(engine.status).toBe("ready");
    await expect(engine.analyse(QF6, { multiPv: 3 })).resolves.toMatchObject({ depth: 12 });
  });

  it("aborts a request that is waiting for the engine to start", async () => {
    const { engine } = service({ handshake: "hang" });
    const controller = new AbortController();
    const pending = engine.analyse(START_FEN, { signal: controller.signal }).catch((reason: unknown) => reason);
    await settle();
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
    expect(engine.status).toBe("loading");
  });

  it("rejects a search that outlives its watchdog with EngineTimeoutError and keeps the engine", async () => {
    vi.useFakeTimers();
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.waitStop] });
    const outcome = engine.analyse(START_FEN, { movetimeMs: 500 }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(500 + WATCHDOG_EXTRA_MS);
    expect(await outcome).toBeInstanceOf(EngineTimeoutError);
    expect(engine.status).toBe("ready");
    expect(fakes.made).toHaveLength(1);
  });

  it("replaces an engine that hung: status error, then a fresh worker on the next request", async () => {
    vi.useFakeTimers();
    const { engine, fakes, statuses } = service((index) => ({ searches: index === 0 ? [TRANSCRIPTS.hang] : [] }));
    const outcome = engine.analyse(START_FEN, { movetimeMs: 500 }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(500 + WATCHDOG_EXTRA_MS + STOP_GRACE_MS);
    expect(await outcome).toBeInstanceOf(EngineTimeoutError);
    expect(engine.snapshot()).toMatchObject({ status: "error", error: expect.stringMatching(/ignored "stop"/) });
    expect(fakes.made[0].terminated).toBe(true);
    const next = engine.analyse(START_FEN, { movetimeMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ terminal: null });
    expect(fakes.made).toHaveLength(2);
    expect(engine.snapshot()).toMatchObject({ status: "ready", error: null });
    expect(statuses).toEqual(["loading", "busy", "error", "loading", "busy", "ready"]);
  });

  it("reports a crash mid-search as EngineCrashedError and recovers on the next request", async () => {
    const { engine, fakes } = service((index) => ({ searches: index === 0 ? [TRANSCRIPTS.crash] : [] }));
    const first = engine.analyse(START_FEN).catch((reason: unknown) => reason);
    const queued = engine.analyse(fenAfter(["e4"])).catch((reason: unknown) => reason);
    expect(await first).toBeInstanceOf(EngineCrashedError);
    expect(await queued).toBeInstanceOf(EngineCrashedError);
    expect(engine.snapshot()).toMatchObject({ status: "error", error: expect.stringMatching(/memory access out of bounds/) });
    await expect(engine.analyse(START_FEN)).resolves.toMatchObject({ terminal: null });
    expect(fakes.made).toHaveLength(2);
    expect(engine.status).toBe("ready");
  });

  it("notices a crash while idle", async () => {
    const { engine, fakes } = service();
    await engine.analyse(START_FEN);
    fakes.made[0].crash("worker gone");
    expect(engine.snapshot()).toMatchObject({ status: "error", error: expect.stringMatching(/worker gone/) });
  });
});

describe("EngineService newGame, dispose and the singleton", () => {
  it("passes newGame to a running engine and ignores it otherwise", async () => {
    const { engine, fakes } = service();
    await engine.newGame();
    expect(fakes.made).toHaveLength(0);
    await engine.analyse(START_FEN);
    await engine.newGame();
    expect(fakes.made[0].commands.slice(-2)).toEqual(["ucinewgame", "isready"]);
  });

  it("dispose terminates the worker, rejects pending work and refuses new work", async () => {
    const { engine, fakes } = service({ searches: [TRANSCRIPTS.waitStop] });
    const pending = engine.analyse(START_FEN).catch((reason: unknown) => reason);
    await settle();
    engine.dispose();
    expect(isAbortError(await pending)).toBe(true);
    expect(fakes.made[0].terminated).toBe(true);
    await expect(engine.analyse(START_FEN)).rejects.toThrow(/shut down/);
    engine.setEnabled(true);
    expect(engine.enabled).toBe(false);
  });

  it("getEngineService returns one service and starts nothing", () => {
    expect(getEngineService()).toBe(getEngineService());
    expect(getEngineService().status).toBe("off");
  });
});
