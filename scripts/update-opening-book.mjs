// Re-vendors the lichess-org/chess-openings source TSVs (CC0-1.0) into data/chess-openings/.
// Run by hand only; the app never downloads the book at runtime.
//
//   node scripts/update-opening-book.mjs [--commit <sha>]
//
// After a run, record the new commit and the printed checksums in data/chess-openings/SOURCE.md
// and re-run `npm run check` (the book tests pin a few names and counts).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_COMMIT = "c67912be58";
const FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv", "COPYING.txt"];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(rootDir, "data", "chess-openings");

function commitArg(argv) {
  const index = argv.indexOf("--commit");
  if (index === -1) {
    return PINNED_COMMIT;
  }
  const value = argv[index + 1];
  if (!value || !/^[0-9a-f]{7,40}$/.test(value)) {
    throw new Error("--commit needs a hex commit sha");
  }
  return value;
}

const commit = commitArg(process.argv.slice(2));
await fs.mkdir(targetDir, { recursive: true });

let rows = 0;
for (const name of FILES) {
  const url = `https://raw.githubusercontent.com/lichess-org/chess-openings/${commit}/${name}`;
  const response = await fetch(url, { headers: { "User-Agent": "chess-analyst-local/0.1" } });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (name.endsWith(".tsv")) {
    const lines = body.toString("utf8").trimEnd().split("\n");
    if (lines[0] !== "eco\tname\tpgn") {
      throw new Error(`${name}: unexpected header "${lines[0]}"`);
    }
    rows += lines.length - 1;
  }
  await fs.writeFile(path.join(targetDir, name), body);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  console.log(`${name.padEnd(12)} ${String(body.length).padStart(7)} bytes  sha256 ${sha256}`);
}

console.log(`\nlichess-org/chess-openings@${commit}: ${rows} rows written to ${path.relative(rootDir, targetDir)}/`);
