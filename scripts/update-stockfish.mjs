// Re-vendors the Stockfish WASM build the trainer runs in a Web Worker into public/stockfish/.
// Run by hand only; the app never downloads the engine at runtime and works offline.
//
//   node scripts/update-stockfish.mjs [--check]
//
// The files come from the stockfish.js release on GitHub (nmrugg/stockfish.js, GPL-3.0) and
// are verified against the pinned sha256 checksums below. --check only verifies the files
// already in public/stockfish/. After changing the pin, update public/stockfish/SOURCE.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "v19.0.0";
// The lite single-threaded build: 1.8 MB, NNUE built in, no SharedArrayBuffer (so no
// cross-origin isolation headers are needed).
const FILES = {
  "stockfish-19-lite-single.js": "d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6",
  "stockfish-19-lite-single.wasm": "57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387"
};
const LICENCE_URL = `https://raw.githubusercontent.com/nmrugg/stockfish.js/${RELEASE}/Copying.txt`;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(rootDir, "public", "stockfish");
const checkOnly = process.argv.includes("--check");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "opening-trainer-vendor-script" } });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

await fs.mkdir(targetDir, { recursive: true });
let failures = 0;

for (const [name, expected] of Object.entries(FILES)) {
  const target = path.join(targetDir, name);
  const body = checkOnly
    ? await fs.readFile(target)
    : await download(`https://github.com/nmrugg/stockfish.js/releases/download/${RELEASE}/${name}`);
  const actual = sha256(body);
  if (actual !== expected) {
    failures += 1;
    console.error(`${name}: sha256 ${actual} does not match the pinned ${expected}`);
    continue;
  }
  if (!checkOnly) {
    await fs.writeFile(target, body);
  }
  console.log(`${name.padEnd(32)} ${String(body.length).padStart(9)} bytes  ok`);
}

if (!checkOnly) {
  await fs.writeFile(path.join(targetDir, "Copying.txt"), await download(LICENCE_URL));
  console.log("Copying.txt (GPL-3.0) written");
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`\nStockfish.js ${RELEASE} lite single-threaded build ${checkOnly ? "verified" : "written to public/stockfish/"}`);
}
