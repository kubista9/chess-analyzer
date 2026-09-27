import { describe, expect, it } from "vitest";
import { StockfishSession } from "./stockfish.js";

// Fake engines: small Node programs on stdin/stdout, so no real Stockfish is needed.
const node = process.execPath;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function fakeEngine(script: string): StockfishSession {
  return new StockfishSession({ path: node, args: ["-e", script] });
}

// Answers isready, then dies on the first "go" without printing bestmove.
const DIES_ON_GO = `
  require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
    if (line === "isready") console.log("readyok");
    if (line.startsWith("go")) process.exit(3);
  });`;

// A well-behaved engine with one fixed line.
const ANSWERS = `
  require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
    if (line === "isready") console.log("readyok");
    if (line.startsWith("go")) {
      console.log("info depth 10 multipv 1 score cp 31 pv e2e4 e7e5");
      console.log("bestmove e2e4");
    }
  });`;

describe("StockfishSession failure handling", () => {
  it("rejects a running search when the engine exits, instead of hanging", async () => {
    const session = fakeEngine(DIES_ON_GO);
    await session.initialize();
    await expect(session.analyzePosition({ fen: START_FEN, multiPv: 1, moveTimeMs: 10 })).rejects.toThrow(
      /exited unexpectedly \(code 3\)/
    );
    // Later calls fail fast too.
    await expect(session.analyzePosition({ fen: START_FEN, multiPv: 1, moveTimeMs: 10 })).rejects.toThrow(/exited/);
    session.close();
  });

  it("rejects initialize when the engine exits before readyok", async () => {
    const session = fakeEngine("setTimeout(() => process.exit(1), 20)");
    await expect(session.initialize()).rejects.toThrow(/exited unexpectedly \(code 1\)/);
    session.close();
  });

  it("rejects initialize when the binary does not exist", async () => {
    const session = new StockfishSession({ path: "/nonexistent/stockfish" });
    await expect(session.initialize()).rejects.toThrow();
    session.close();
  });

  it("still returns lines from a working engine", async () => {
    const session = fakeEngine(ANSWERS);
    await session.initialize();
    const lines = await session.analyzePosition({ fen: START_FEN, multiPv: 1, moveTimeMs: 10 });
    expect(lines).toEqual([{ move: "e2e4", scoreCp: 31, mate: null, pv: ["e2e4", "e7e5"] }]);
    session.close();
  });
});
