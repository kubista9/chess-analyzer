// Real-engine smoke test for the P4a engine core (opt-in; needs the installed Stockfish).
//   npx tsx scripts/verify/engine-smoke.ts [--store]
// Analyses a handful of opening positions under the fixed-depth protocol, checks the evals
// against the planning measurements, records timings, runs the same work through the pool,
// and kills an engine mid-search to check that the search rejects instead of hanging.
// With --store it also opens storage/chess.db (applying migrations), gets or creates the
// current engine config and prints the size of the analysis work queue. It never runs the
// backfill. Every Stockfish process it starts is closed before it exits.
import { execFileSync } from "node:child_process";
import { OPENING_PLY_LIMIT } from "../../shared/constants.js";
import { classifyLoss, formatEval, toWhiteEval } from "../../shared/eval.js";
import type { PositionEval } from "../../shared/types.js";
import { windowBounds } from "../../shared/window.js";
import { config } from "../../server/config.js";
import { openDatabase } from "../../server/db/connection.js";
import { countAnalysisQueue } from "../../server/db/gameAnalysis.js";
import { analysePosition, playedLoss, type PositionRequest } from "../../server/engine/analysePosition.js";
import { currentEngineConfig } from "../../server/engine/engineConfig.js";
import { EnginePool } from "../../server/engine/pool.js";
import { ENGINE_PROTOCOL, canonicalJson } from "../../server/engine/protocol.js";
import { engineOptions } from "../../server/engine/sharedPool.js";
import { EngineCrashedError, UciEngine, detectEngineId } from "../../server/engine/uci.js";

interface Case {
  name: string;
  request: PositionRequest;
  check: (evaluation: PositionEval) => string | null;
}

const failures: string[] = [];
const white = (evaluation: PositionEval) => toWhiteEval(evaluation.score, evaluation.epd.split(" ")[1] === "w" ? "white" : "black");

const CASES: Case[] = [
  {
    name: "start position",
    request: { moves: [], tier: "owner" },
    check: (evaluation) => (white(evaluation).cp >= -50 && white(evaluation).cp <= 80 ? null : "White should be within [-50, +80] cp")
  },
  {
    name: "1.e4 e5 2.Nf3 Bc5 (White to move)",
    request: { moves: ["e2e4", "e7e5", "g1f3", "f8c5"], tier: "owner" },
    check: (evaluation) =>
      evaluation.bestUci !== "f3e5"
        ? `best should be Nxe5 (f3e5), got ${evaluation.bestUci}`
        : white(evaluation).cp < 100
          ? "White should be +1.00 or more"
          : null
  },
  {
    name: "1.e4 e5 2.Nf3, played 2...Bc5",
    request: { moves: ["e2e4", "e7e5", "g1f3"], tier: "owner", played: ["f8c5"] },
    check: (evaluation) => {
      const loss = playedLoss(evaluation, "f8c5");
      return loss === undefined ? "2...Bc5 was not scored" : loss < 8 || loss > 15 ? `2...Bc5 should lose about 10-12 win%, got ${loss.toFixed(1)}` : null;
    }
  },
  {
    name: "1.d4 d5 2.c4 e5 (Albin, White to move)",
    request: { moves: ["d2d4", "d7d5", "c2c4", "e7e5"], tier: "opponent" },
    check: (evaluation) => (white(evaluation).cp >= 50 ? null : "White should be +0.50 or more")
  },
  {
    name: "1.d4 d5 2.c4, played 2...e5 (Albin)",
    request: { moves: ["d2d4", "d7d5", "c2c4"], tier: "owner", played: ["e7e5"] },
    check: (evaluation) => {
      const loss = playedLoss(evaluation, "e7e5");
      return loss === undefined ? "2...e5 was not scored" : loss > 10 ? `2...e5 should lose a few win%, got ${loss.toFixed(1)}` : null;
    }
  },
  {
    name: "1.c4 d5 2.cxd5 Qxd5 3.Nc3, played 3...Qa5",
    request: { moves: ["c2c4", "d7d5", "c4d5", "d8d5", "b1c3"], tier: "owner", played: ["d5a5"] },
    check: (evaluation) => {
      const loss = playedLoss(evaluation, "d5a5");
      // White is better here (the queen is hit with tempo): Stockfish reports about -0.70 to
      // -0.85 from Black's side, i.e. +0.70 to +0.85 for White.
      if (white(evaluation).cp < 40 || white(evaluation).cp > 130) {
        return "White should be about +0.70";
      }
      return loss === undefined ? "3...Qa5 was not scored" : loss >= 5 ? `3...Qa5 should be best or good, lost ${loss.toFixed(1)}` : null;
    }
  },
  {
    name: "1.f3 e5 2.g4 (mate in 1)",
    request: { moves: ["f2f3", "e7e5", "g2g4"], tier: "owner" },
    check: (evaluation) =>
      evaluation.score.mate === 1 && evaluation.score.cp === null && evaluation.bestUci === "d8h4" ? null : "should be mate 1 by Qh4#"
  },
  {
    name: "1.f3 e5 2.g4 Qh4# (checkmate)",
    request: { moves: ["f2f3", "e7e5", "g2g4", "d8h4"], tier: "owner" },
    check: (evaluation) => (evaluation.terminal === "checkmate" && evaluation.nodes === 0 ? null : "should be terminal without a search")
  }
];

function describeEval(evaluation: PositionEval): string {
  const lines = evaluation.lines.map((line) => `${line.uci} ${line.mate !== null ? `M${line.mate}` : line.cp}`).join(", ");
  const scored = evaluation.scored.map((line) => {
    const loss = playedLoss(evaluation, line.uci)!;
    return `${line.uci} ${line.cp ?? `M${line.mate}`} (loss ${loss.toFixed(1)}, ${classifyLoss(loss)})`;
  });
  return `${formatEval(white(evaluation))} White | d${evaluation.depth} | ${lines || "terminal"}${scored.length ? ` | scored ${scored.join(", ")}` : ""}`;
}

function powerSource(): string {
  try {
    return execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).split("\n")[0].replace(/^Now drawing from /, "");
  } catch {
    return "unknown";
  }
}

async function sequentialRun(): Promise<void> {
  const engine = await UciEngine.start(engineOptions());
  console.log(`Engine: ${engine.idName} (${config.stockfishPath})`);
  console.log(`Protocol: ${canonicalJson(ENGINE_PROTOCOL)}`);
  console.log(`Power: ${powerSource()}\n`);
  try {
    let totalNodes = 0;
    let totalMs = 0;
    for (const testCase of CASES) {
      await engine.newGame();
      const started = performance.now();
      const evaluation = await analysePosition(engine, testCase.request);
      const ms = performance.now() - started;
      totalNodes += evaluation.nodes;
      totalMs += ms;
      const problem = testCase.check(evaluation);
      if (problem) {
        failures.push(`${testCase.name}: ${problem}`);
      }
      console.log(
        `${problem ? "FAIL" : "ok  "} ${testCase.name.padEnd(44)} ${ms.toFixed(0).padStart(5)} ms ${String(Math.round(evaluation.nodes / 1000)).padStart(5)}k nodes  ${describeEval(evaluation)}${problem ? `\n     -> ${problem}` : ""}`
      );
    }
    console.log(`\nSequential, 1 worker, cold hash per position: ${totalMs.toFixed(0)} ms, ${(totalNodes / 1e6).toFixed(2)}M nodes, ${((totalNodes / totalMs) * 1000 / 1e6).toFixed(2)}M nps`);
  } finally {
    await engine.close();
  }
}

async function poolRun(): Promise<void> {
  const pool = new EnginePool({ size: config.engineWorkers, spawn: () => UciEngine.start(engineOptions()) });
  try {
    const started = performance.now();
    const results = await Promise.all(CASES.map((testCase, index) => pool.analyseGame(`smoke:${index}`, [testCase.request], { priority: "backfill" })));
    const ms = performance.now() - started;
    const nodes = results.reduce((sum, [evaluation]) => sum + evaluation.nodes, 0);
    console.log(`Pool, ${config.engineWorkers} workers: ${CASES.length} positions in ${ms.toFixed(0)} ms, ${((nodes / ms) * 1000 / 1e6).toFixed(2)}M nps total`);
    for (const [index, [evaluation]] of results.entries()) {
      const problem = CASES[index].check(evaluation);
      if (problem) {
        failures.push(`pool: ${CASES[index].name}: ${problem}`);
      }
    }
  } finally {
    await pool.close();
  }
}

async function killRun(): Promise<void> {
  const engine = await UciEngine.start(engineOptions());
  const search = engine.search({ moves: [], multipv: 1, depth: 60, timeoutMs: 30_000 });
  setTimeout(() => process.kill(engine.pid!, "SIGKILL"), 300);
  const started = performance.now();
  try {
    await search;
    failures.push("kill: the search resolved after SIGKILL");
  } catch (error) {
    const ms = performance.now() - started;
    const ok = error instanceof EngineCrashedError && ms < 2000;
    if (!ok) {
      failures.push(`kill: expected EngineCrashedError within 2 s, got ${(error as Error).name} after ${ms.toFixed(0)} ms`);
    }
    console.log(`${ok ? "ok  " : "FAIL"} SIGKILL mid-search rejects in ${ms.toFixed(0)} ms: ${(error as Error).message}`);
  } finally {
    await engine.close();
  }
}

function storeRun(idName: string): void {
  const db = openDatabase(config.dbPath);
  try {
    const engineConfig = currentEngineConfig(db, idName);
    const bounds = windowBounds(Math.floor(Date.now() / 1000));
    const queued = countAnalysisQueue(db, {
      username: config.owner,
      configId: engineConfig.id,
      windowStart: bounds.start,
      windowEnd: bounds.end,
      openingPlies: OPENING_PLY_LIMIT
    });
    console.log(`Store: engine config #${engineConfig.id} (${engineConfig.engineName} ${engineConfig.engineVersion}); ${queued} window games queued for analysis`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  await sequentialRun();
  await poolRun();
  await killRun();
  if (process.argv.includes("--store")) {
    storeRun(await detectEngineId(engineOptions()));
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nengine-smoke: OK");
  }
}

await main();
