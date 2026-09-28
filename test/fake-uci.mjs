#!/usr/bin/env node
// A fake UCI engine for tests. It answers the handshake and, for each `go`, prints the next
// transcript file given on the command line (the last one repeats).
//
//   node test/fake-uci.mjs [--id "Stockfish 18"] [--log <file>] <transcript.txt>...
//
// Transcript lines are printed as they are, except:
//   # text       a comment (hash + space), skipped
//   #sleep <ms>  wait before the next line
//   #wait-stop   pause until the engine receives `stop`, then continue
//   #crash <n>   exit with code n at once (a crash mid-search)
//   #hang        stop answering anything, `stop` and `isready` included
// --log appends every command received, one per line, so tests can check the protocol.
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
let id = "Stockfish 18";
let log = null;
const transcripts = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--id") {
    id = args[++index];
  } else if (args[index] === "--log") {
    log = args[++index];
  } else {
    transcripts.push(fs.readFileSync(args[index], "utf8").split("\n"));
  }
}

let goCount = 0;
let hung = false;
let stopWaiter = null;
let pendingStop = false;
const out = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function play(lines) {
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("# ")) continue;
    const [directive, value] = line.split(/\s+/);
    if (directive === "#sleep") {
      await sleep(Number(value));
    } else if (directive === "#wait-stop") {
      if (!pendingStop) await new Promise((resolve) => (stopWaiter = resolve));
      pendingStop = false;
    } else if (directive === "#crash") {
      process.exit(Number(value ?? 1));
    } else if (directive === "#hang") {
      hung = true;
      return;
    } else {
      out(line);
    }
  }
}

let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (command) => {
  if (log) fs.appendFileSync(log, `${command}\n`);
  if (hung) return;
  if (command === "stop") {
    if (stopWaiter) {
      const resolve = stopWaiter;
      stopWaiter = null;
      resolve();
    } else {
      pendingStop = true;
    }
    return;
  }
  queue = queue.then(async () => {
    if (hung) return;
    if (command === "uci") {
      out(`id name ${id}`);
      out("id author fake");
      out("uciok");
    } else if (command === "isready") {
      out("readyok");
    } else if (command === "quit") {
      process.exit(0);
    } else if (command.startsWith("go")) {
      const lines = transcripts[Math.min(goCount, transcripts.length - 1)] ?? ["bestmove (none)"];
      goCount += 1;
      pendingStop = false;
      await play(lines);
    }
  });
}).on("close", () => process.exit(0));
