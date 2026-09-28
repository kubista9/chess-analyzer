import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MultiPvCollector, parseInfoLine } from "./multipv.js";
import { EngineCrashedError, EngineTimeoutError, UciEngine, goCommand, parseEngineId, positionCommand } from "./uci.js";

const root = path.resolve(import.meta.dirname, "../..");
const transcriptDir = path.join(root, "test/fixtures/uci-transcripts");
const fakeUci = path.join(root, "test/fake-uci.mjs");

function transcript(name: string): string {
  return path.join(transcriptDir, name);
}

/** Feeds a transcript's engine output (not its directives or bestmove) into a collector. */
function collect(name: string, expectedRanks: number) {
  const collector = new MultiPvCollector(expectedRanks);
  for (const line of fs.readFileSync(transcript(name), "utf8").split("\n")) {
    if (line.startsWith("info")) {
      collector.push(line);
    }
  }
  return collector.result();
}

const engines: UciEngine[] = [];
let tmpDir: string | null = null;

async function startFake(transcripts: string[], extra: string[] = [], options: { stopGraceMs?: number } = {}) {
  const engine = await UciEngine.start({
    path: process.execPath,
    args: [fakeUci, ...extra, ...transcripts.map(transcript)],
    threads: 1,
    hashMb: 64,
    stopGraceMs: options.stopGraceMs ?? 300
  });
  engines.push(engine);
  return engine;
}

function logFile(): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "fake-uci-"));
  return path.join(tmpDir, `log-${engines.length}.txt`);
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("parseInfoLine", () => {
  it("reads depth, rank, score, bound, nodes and pv", () => {
    expect(
      parseInfoLine("info depth 16 seldepth 22 multipv 2 score cp -74 nodes 402000 nps 581000 time 692 pv d5d8 d2d4")
    ).toEqual({ depth: 16, multipv: 2, cp: -74, mate: null, bound: null, nodes: 402000, pv: ["d5d8", "d2d4"] });
    expect(parseInfoLine("info depth 13 multipv 1 score cp 95 lowerbound nodes 1 pv d4e5")?.bound).toBe("lower");
    expect(parseInfoLine("info depth 13 multipv 3 score cp 10 upperbound nodes 1 pv c4d5")?.bound).toBe("upper");
    expect(parseInfoLine("info depth 3 score mate -2 pv e1e2")).toMatchObject({ multipv: 1, cp: null, mate: -2 });
  });

  it("ignores lines without a pv or a score", () => {
    expect(parseInfoLine("info depth 0 score mate 0")).toBeNull();
    expect(parseInfoLine("info string NNUE evaluation using nn.nnue")).toBeNull();
    expect(parseInfoLine("info depth 12 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("bestmove e2e4")).toBeNull();
  });
});

describe("MultiPvCollector (recorded transcripts)", () => {
  it("returns the last iteration where all ranks completed, not the stop-print leftovers", () => {
    const result = collect("multidepth-mpv3.txt", 3);
    expect(result.complete).toBe(true);
    expect(result.depth).toBe(16);
    expect(result.lines.map((line) => [line.uci, line.cp, line.depth])).toEqual([
      ["d5d6", -70, 16],
      ["d5d8", -74, 16],
      ["d5a5", -81, 16]
    ]);
    expect(result.nodes).toBe(500000);
  });

  it("skips lowerbound and upperbound lines", () => {
    const result = collect("bounds-mpv3.txt", 3);
    expect(result).toMatchObject({ depth: 13, complete: true });
    expect(result.lines.map((line) => [line.uci, line.cp])).toEqual([
      ["d4e5", 81],
      ["b1c3", 44],
      ["c4d5", 38]
    ]);
  });

  it("never reports one move on two ranks", () => {
    const result = collect("duplicate-ranks.txt", 3);
    expect(result).toMatchObject({ depth: 14, complete: true });
    expect(result.lines.map((line) => line.uci)).toEqual(["c7c5", "e7e6", "c8f5"]);
  });

  it("keeps mates separate from cp", () => {
    const result = collect("mate-in-1.txt", 1);
    expect(result.lines).toEqual([{ uci: "d8h4", cp: null, mate: 1, winPct: expect.any(Number), depth: 245, pv: ["d8h4"] }]);
    expect(result.lines[0].winPct).toBeCloseTo(97.54, 2);
  });

  it("completes with fewer ranks when the position has fewer legal moves than MultiPV", () => {
    const result = collect("two-legal-moves.txt", 2);
    expect(result).toMatchObject({ depth: 10, complete: true });
    expect(result.lines.map((line) => line.uci)).toEqual(["e8f8", "e8e7"]);
  });

  it("falls back to the deepest partial iteration, deduped, when none completed", () => {
    const collector = new MultiPvCollector(3);
    collector.push("info depth 5 multipv 1 score cp 10 nodes 100 pv e2e4 e7e5");
    collector.push("info depth 5 multipv 2 score cp 10 nodes 100 pv e2e4 c7c5");
    expect(collector.result()).toMatchObject({ depth: 5, complete: false, lines: [{ uci: "e2e4" }] });
  });

  it("returns no lines for bestmove (none)", () => {
    expect(collect("bestmove-none.txt", 1)).toEqual({ lines: [], depth: 0, complete: false, nodes: 0 });
  });

  it("truncates the pv to 10 moves", () => {
    const collector = new MultiPvCollector(1);
    collector.push(`info depth 20 multipv 1 score cp 5 nodes 1 pv ${Array.from({ length: 14 }, () => "e2e4").join(" ")}`);
    expect(collector.result().lines[0].pv).toHaveLength(10);
  });
});

describe("command helpers", () => {
  it("builds go and position commands", () => {
    expect(goCommand({ depth: 15, nodes: 3000000 })).toBe("go depth 15 nodes 3000000");
    expect(goCommand({ depth: 15, nodes: 3000000, searchmoves: ["f8c5", "d7d5"] })).toBe(
      "go depth 15 nodes 3000000 searchmoves f8c5 d7d5"
    );
    expect(() => goCommand({})).toThrow();
    expect(positionCommand([])).toBe("position startpos");
    expect(positionCommand(["e2e4", "e7e5"])).toBe("position startpos moves e2e4 e7e5");
  });

  it("splits the id name into name and version", () => {
    expect(parseEngineId("Stockfish 18")).toEqual({ name: "Stockfish", version: "18" });
    expect(parseEngineId("Stockfish dev-20260901-abcdef")).toEqual({ name: "Stockfish", version: "dev-20260901-abcdef" });
    expect(parseEngineId("Fake")).toEqual({ name: "Fake", version: "unknown" });
  });
});

describe("UciEngine with the fake engine", () => {
  it("reads id name and sends the protocol: Threads 1, Hash 64, MultiPV only on change, game history", async () => {
    const log = logFile();
    const engine = await startFake(["e4e5nf3-mpv3-d15.txt", "e4e5nf3-mpv3-d15.txt", "searchmoves-bc5-d15.txt"], ["--log", log]);
    expect(engine.idName).toBe("Stockfish 18");
    expect(engine.alive).toBe(true);

    await engine.newGame();
    const moves = ["e2e4", "e7e5", "g1f3"];
    const first = await engine.search({ moves, multipv: 3, depth: 15, nodes: 3_000_000, timeoutMs: 5000 });
    expect(first).toMatchObject({ depth: 15, complete: true, bestmove: "b8c6", nodes: 351234 });
    await engine.search({ moves, multipv: 3, depth: 15, nodes: 3_000_000, timeoutMs: 5000 });
    const follow = await engine.search({ moves, multipv: 1, depth: 15, nodes: 3_000_000, searchmoves: ["f8c5"], timeoutMs: 5000 });
    expect(follow.lines).toMatchObject([{ uci: "f8c5", cp: -166, depth: 15 }]);

    const commands = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(commands).toEqual([
      "uci",
      "setoption name Threads value 1",
      "setoption name Hash value 64",
      "isready",
      "ucinewgame",
      "isready",
      "setoption name MultiPV value 3",
      "position startpos moves e2e4 e7e5 g1f3",
      "go depth 15 nodes 3000000",
      "position startpos moves e2e4 e7e5 g1f3",
      "go depth 15 nodes 3000000",
      "setoption name MultiPV value 1",
      "position startpos moves e2e4 e7e5 g1f3",
      "go depth 15 nodes 3000000 searchmoves f8c5"
    ]);
    expect(commands.filter((command) => command === "ucinewgame")).toHaveLength(1);
  });

  it("returns no lines and a null bestmove for bestmove (none)", async () => {
    const engine = await startFake(["bestmove-none.txt"]);
    const result = await engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 5000 });
    expect(result).toMatchObject({ lines: [], bestmove: null });
    expect(engine.alive).toBe(true);
  });

  it("rejects a search when the engine crashes mid-search, and fails fast afterwards", async () => {
    const engine = await startFake(["crash-mid-search.txt"]);
    await expect(engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 5000 })).rejects.toThrow(EngineCrashedError);
    await expect(engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 5000 })).rejects.toThrow(/exited unexpectedly \(code 9\)/);
    expect(engine.alive).toBe(false);
  });

  it("times out: sends stop, and rejects even when bestmove arrives (the engine stays usable)", async () => {
    const log = logFile();
    const engine = await startFake(["wait-stop.txt", "startpos-d15.txt"], ["--log", log]);
    const started = Date.now();
    await expect(engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 150 })).rejects.toThrow(EngineTimeoutError);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(engine.alive).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("\nstop\n");
    const next = await engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 5000 });
    expect(next.lines[0]).toMatchObject({ uci: "e2e4", cp: 25 });
  });

  it("kills an engine that ignores stop within the watchdog plus the grace period", async () => {
    const engine = await startFake(["hang.txt"], [], { stopGraceMs: 200 });
    const started = Date.now();
    await expect(engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 150 })).rejects.toThrow(/ignored stop; it was killed/);
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.alive).toBe(false);
  });

  it("rejects start when the binary is missing or the engine exits before uciok", async () => {
    await expect(UciEngine.start({ path: "/nonexistent/stockfish", threads: 1, hashMb: 64 })).rejects.toThrow();
    await expect(
      UciEngine.start({ path: process.execPath, args: ["-e", "setTimeout(() => process.exit(1), 20)"], threads: 1, hashMb: 64 })
    ).rejects.toThrow(/exited unexpectedly \(code 1\)/);
  });

  it("refuses a second command while a search runs", async () => {
    const engine = await startFake(["wait-stop.txt"]);
    const running = engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 200 });
    await expect(engine.search({ moves: [], multipv: 1, depth: 15, timeoutMs: 200 })).rejects.toThrow(/busy/);
    await expect(running).rejects.toThrow(EngineTimeoutError);
  });
});
