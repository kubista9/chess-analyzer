// npm run backfill [-- --limit N] [-- --dry-run] [-- --allow-battery] [-- --line <uci,...> --color white|black]
// The engine check: analyses the openings of kubista9's window games that have no analysis
// under the current engine config yet (newest first), owner-to-move positions first. It runs
// outside `tsx watch`, so code edits do not restart it, and it resumes where it stopped:
// every position is stored as soon as it is searched.
//   --limit N         only the N newest queued games
//   --dry-run         print the queue, the positions to search and the estimated time; search nothing
//   --allow-battery   do not ask before running on battery
//   --line e2e4,e7e5,g1f3,f8c5 --color black
//                     a targeted check of one line instead: every position along it (and the one it
//                     reaches) with every move the colour's window games played there; no game is
//                     marked analysed, so the full backfill still runs later and finds them cached
// Ctrl-C pauses (the games in progress finish); a second Ctrl-C stops at once.
import readline from "node:readline/promises";
import { OPENING_PLY_LIMIT } from "../shared/constants.js";
import type { BackfillProgress } from "../shared/types.js";
import { windowBounds } from "../shared/window.js";
import { config } from "../server/config.js";
import { closeDb, getDb } from "../server/db/connection.js";
import { lastMeasuredRun } from "../server/db/backfillRuns.js";
import { currentEngineConfig } from "../server/engine/engineConfig.js";
import { EnginePool } from "../server/engine/pool.js";
import { engineOptions } from "../server/engine/sharedPool.js";
import { UciEngine } from "../server/engine/uci.js";
import { estimateSearch, planBackfill, runBackfill } from "../server/services/backfill.js";
import { analyseLine } from "../server/services/lineAnalysis.js";
import { sanOf } from "../shared/openingAnalysis.js";
import { BackfillLock, BackfillLockedError } from "../server/services/backfillLock.js";
import { describePower, readPowerState } from "../server/services/power.js";
import { argValue } from "./verify/_lib.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const allowBattery = args.has("--allow-battery");
const limitArg = argValue("limit");
const limit = limitArg === undefined ? undefined : Number(limitArg);
const lineArg = argValue("line");
const lineColor = argValue("color");
if (lineArg !== undefined && lineColor !== "white" && lineColor !== "black") {
  console.error("--line needs --color white or --color black (the owner's colour in those games)");
  process.exit(2);
}
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`--limit needs a positive whole number, got "${limitArg}"`);
  process.exit(2);
}

const fmt = (value: number) => Math.round(value).toLocaleString("en-US");
const minutes = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} min`);
const mnps = (nps: number) => `${(nps / 1e6).toFixed(2)} Mnps`;

const db = getDb();
const pool = new EnginePool({ size: config.engineWorkers, spawn: () => UciEngine.start(engineOptions()) });
let lock: BackfillLock | null = null;

async function confirmBattery(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(`${message}\nNot a terminal: pass --allow-battery to run anyway.`);
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${message}\nRun on battery anyway? [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

function progressLine(progress: BackfillProgress): string {
  const { owner, opponent } = progress.positions;
  const pass =
    progress.pass === "owner"
      ? `your positions ${fmt(owner.done)} / ${fmt(owner.total)}, then ${fmt(opponent.total)} opponent positions`
      : progress.pass === "opponent"
        ? `opponent positions ${fmt(opponent.done)} / ${fmt(opponent.total)}`
        : "done";
  const games = `${fmt(progress.games.done)} / ${fmt(progress.games.total)} games`;
  const speed = progress.nps ? ` · ${mnps(progress.nps)}` : "";
  const eta = progress.pass !== "done" && progress.etaSec !== null ? ` · ~${minutes(progress.etaSec)} left` : "";
  return `Engine check: ${pass} · ${games}${speed}${eta}`;
}

try {
  const idName = await pool.engineIdName();
  const engineConfig = currentEngineConfig(db, idName);
  console.log(
    `Engine: ${idName} · config #${engineConfig.id} · ${config.engineWorkers} worker(s) · ${OPENING_PLY_LIMIT} plies · ${config.dbPath}`
  );

  const windowStart = windowBounds(Math.floor(Date.now() / 1000)).start;
  const power = readPowerState();

  if (dryRun) {
    const plan = planBackfill(db, { owner: config.owner, configId: engineConfig.id, windowStart, limit });
    const estimate = estimateSearch(db, engineConfig.id, plan.positions.toSearch);
    const measured = lastMeasuredRun(db);
    console.log(`Queue: ${fmt(plan.games.length)} game(s) without an analysis under config #${engineConfig.id}, newest first.`);
    console.log(
      `Positions: ${fmt(plan.positions.total)} unique in those games; ${fmt(plan.positions.cached)} already cached; ` +
        `to search ${fmt(plan.positions.toSearch.owner)} owner-to-move + ${fmt(plan.positions.toSearch.opponent)} opponent-to-move` +
        (plan.positions.partial ? ` (${fmt(plan.positions.partial)} of them only need new moves scored)` : "") +
        "."
    );
    console.log(
      `Estimate: ~${(estimate.nodes / 1e9).toFixed(2)}G nodes (${fmt(estimate.meanNodes.owner)} / ${fmt(estimate.meanNodes.opponent)} per owner / opponent position) ` +
        `at ${mnps(estimate.nps)} = ~${minutes(estimate.seconds)}.`
    );
    console.log(
      measured
        ? `  Speed measured by run #${measured.id} (${new Date(measured.startedAt).toISOString().slice(0, 16)}Z, ${measured.workers} workers, ` +
            `${measured.onBattery === null ? "power unknown" : measured.onBattery ? "on battery" : "on mains"}).`
        : "  Speed: the default for 3 workers on the M1 on battery; the first real run measures this machine."
    );
    if (power) {
      console.log(`Power: ${describePower(power)}.${power.onBattery ? " Mains power is roughly twice as fast." : ""}`);
    }
  } else {
    if (power?.onBattery && !allowBattery) {
      const ok = await confirmBattery(
        `The Mac is ${describePower(power)}. The engine check keeps ${config.engineWorkers} cores busy until it is done.`
      );
      if (!ok) {
        process.exitCode = 1;
        throw new Error("Not started (on battery).");
      }
    }

    if (lineArg !== undefined) {
      const started = Date.now();
      const result = await analyseLine(
        { db, pool, configId: engineConfig.id },
        { owner: config.owner, color: lineColor as "white" | "black", moves: lineArg.split(","), windowStart }
      );
      for (const { position, evaluation, searched } of result.positions) {
        const best = evaluation.lines[0];
        const score = best ? (best.mate !== null ? `M${best.mate}` : `${best.cp} cp`) : evaluation.terminal;
        console.log(
          `ply ${position.index}: ${position.tier} · best ${best ? sanOf(position.epd, best.uci) : "-"} (${score}, side to move) · ` +
            `${evaluation.lines.length + evaluation.scored.length} moves scored · ${searched ? "searched" : "cached"}`
        );
      }
      console.log(`Line checked: ${result.searched} position(s) searched in ${minutes((Date.now() - started) / 1000)}.`);
      process.exitCode = 0;
    } else {
      try {
        lock = BackfillLock.acquire(config.backfillLockPath, "cli");
      } catch (error) {
        if (error instanceof BackfillLockedError) {
          process.exitCode = 1;
          throw new Error(`${error.message} Pause it there first.`);
        }
        throw error;
      }

      const controller = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        interrupts += 1;
        if (interrupts === 1) {
          console.log("\nPausing: the games in progress finish first (Ctrl-C again to stop now).");
          controller.abort();
        } else {
          console.log("\nStopping now. Positions already searched are stored; unfinished games stay queued.");
          pool.killAll();
          lock?.releaseSync();
          process.exit(130);
        }
      });

      const tty = process.stdout.isTTY;
      let lastPrint = 0;
      let lastLock = 0;
      const started = Date.now();
      const result = await runBackfill(
        { db, pool, owner: config.owner, source: "cli", power },
        {
          limit,
          windowStart,
          signal: controller.signal,
          onPlan: (plan) => {
            const estimate = estimateSearch(db, engineConfig.id, plan.positions.toSearch);
            console.log(
              `Queue: ${fmt(plan.games.length)} game(s); ${fmt(plan.positions.total)} positions, ${fmt(plan.positions.cached)} cached, ` +
                `${fmt(plan.positions.toSearch.owner)} + ${fmt(plan.positions.toSearch.opponent)} to search (~${minutes(estimate.seconds)} at ${mnps(estimate.nps)}).`
            );
          },
          onProgress: (progress) => {
            const now = Date.now();
            if (now - lastLock >= 2_000) {
              lastLock = now;
              lock?.update(progress);
            }
            if (now - lastPrint >= (tty ? 500 : 10_000) || progress.pass === "done") {
              lastPrint = now;
              const text = progressLine(progress);
              if (tty) {
                process.stdout.write(`\r\x1b[2K${text}`);
              } else {
                console.log(text);
              }
            }
          }
        }
      );
      if (tty) {
        process.stdout.write("\n");
      }

      const wallSec = (Date.now() - started) / 1000;
      const perGame = result.gamesAnalysed ? wallSec / result.gamesAnalysed : null;
      console.log(
        `${result.status === "paused" ? "Paused" : result.status === "failed" ? "Finished with failures" : "Done"}: ` +
          `${fmt(result.gamesAnalysed)} game(s) analysed in ${minutes(wallSec)}` +
          (perGame !== null ? ` (${perGame.toFixed(1)} s per game)` : "") +
          ` · ${fmt(result.positionsSearched)} positions searched · ${(result.nodes / 1e6).toFixed(0)}M nodes` +
          (result.searchMs ? ` · ${mnps((result.nodes / result.searchMs) * 1000)}` : "") +
          ` · run #${result.runId}.`
      );
      for (const error of result.errors.slice(0, 10)) {
        console.warn(`WARNING: ${error}`);
      }
      if (result.status === "paused") {
        console.log("Run npm run backfill again to resume.");
      }
      process.exitCode = result.status === "failed" ? 1 : 0;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
} finally {
  await pool.close();
  lock?.releaseSync();
  closeDb();
}
