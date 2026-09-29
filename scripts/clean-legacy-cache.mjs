// Owner-run cleanup of legacy caches and leftovers from before the SQLite store.
//
//   npm run cleanup                  dry run: lists what would be removed, with sizes
//   npm run cleanup -- --yes         deletes the listed items
//   npm run cleanup -- --include-raw also lists storage/cache/raw-games (the offline seed fallback)
//
// Only the explicit allow-list below is ever touched. storage/chess.db, storage/engines and
// (without --include-raw) storage/cache/raw-games are never removed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Relative paths (or `dir/prefix*` patterns) this tool may remove, with a note for each. */
const ALLOW_LIST = [
  { pattern: "storage/tmp", note: "leftover Stockfish installer files" },
  { pattern: "storage/cache/scans", note: "legacy engine scans (replaced by storage/chess.db)" },
  { pattern: "storage/cache/scans-v*", note: "legacy engine scans (replaced by storage/chess.db)" },
  { pattern: "storage/cache/reviews", note: "legacy review cache (replaced by the positions table)" },
  { pattern: "storage/cache/reviews-v*", note: "legacy review cache (replaced by the positions table)" },
  { pattern: "storage/cache/snapshots", note: "legacy opening snapshots" },
  { pattern: "dist/storage", note: "stray copy of a raw-games cache inside the build output" },
  { pattern: "dist/server", note: "build output, may hold stale modules (rebuild: npm run build)" },
  { pattern: "dist/shared", note: "build output, may hold stale modules (rebuild: npm run build)" },
  { pattern: "dist/web", note: "build output (rebuild: npm run build)" },
  { pattern: ".DS_Store", note: "macOS Finder metadata" },
  { pattern: "public", note: "empty directory", onlyIfEmpty: true }
];
const RAW_GAMES = { pattern: "storage/cache/raw-games", note: "offline seed fallback for `npm run sync -- --offline`" };

/** Never removed, whatever the allow-list says (a guard against editing mistakes). */
const PROTECTED = ["storage/chess.db", "storage/engines", "storage/backfill.lock", "storage/.gitkeep", "data", "server", "shared", "src", "scripts"];

function isProtected(relative) {
  return PROTECTED.some((entry) => relative === entry || relative.startsWith(`${entry}/`) || relative.startsWith(`${entry}-`) || entry.startsWith(`${relative}/`));
}

function expand(pattern) {
  if (!pattern.endsWith("*")) {
    return fs.existsSync(path.join(rootDir, pattern)) ? [pattern] : [];
  }
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern).slice(0, -1);
  const absoluteDir = path.join(rootDir, dir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }
  return fs
    .readdirSync(absoluteDir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => `${dir}/${name}`);
}

/** Bytes and file count under `absolute`, without following symlinks. */
function measure(absolute) {
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory()) {
    return { bytes: stat.size, files: 1 };
  }
  let bytes = 0;
  let files = 0;
  for (const name of fs.readdirSync(absolute)) {
    const child = measure(path.join(absolute, name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function main(argv) {
  const known = new Set(["--yes", "--include-raw", "--help", "-h"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (argv.includes("--help") || argv.includes("-h") || unknown.length) {
    if (unknown.length) {
      console.error(`Unknown option(s): ${unknown.join(" ")}`);
    }
    console.log("Usage: npm run cleanup [-- --yes] [-- --include-raw]");
    process.exitCode = unknown.length ? 1 : 0;
    return;
  }
  const apply = argv.includes("--yes");
  const includeRaw = argv.includes("--include-raw");
  const entries = includeRaw ? [...ALLOW_LIST, RAW_GAMES] : ALLOW_LIST;

  const items = [];
  for (const entry of entries) {
    for (const relative of expand(entry.pattern)) {
      if (isProtected(relative)) {
        throw new Error(`Refusing to touch protected path ${relative}`);
      }
      const absolute = path.join(rootDir, relative);
      if (entry.onlyIfEmpty && (!fs.lstatSync(absolute).isDirectory() || fs.readdirSync(absolute).length > 0)) {
        continue;
      }
      items.push({ relative, absolute, note: entry.note, ...measure(absolute) });
    }
  }

  console.log(apply ? "Legacy cleanup (deleting):" : "Legacy cleanup (dry run, nothing is deleted):");
  if (!items.length) {
    console.log("  Nothing to remove.");
  }
  const width = Math.max(0, ...items.map((item) => item.relative.length));
  for (const item of items) {
    const files = `${item.files} file${item.files === 1 ? "" : "s"}`;
    console.log(`  ${item.relative.padEnd(width)}  ${formatBytes(item.bytes).padStart(9)}  ${files.padStart(11)}  ${item.note}`);
  }
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  console.log(`  Total: ${formatBytes(total)} in ${items.length} item${items.length === 1 ? "" : "s"}.`);
  console.log(
    includeRaw
      ? "  storage/cache/raw-games is included: without it, `npm run sync -- --offline` has nothing to seed from."
      : "  Kept: storage/cache/raw-games (offline seed; add --include-raw to remove it), storage/chess.db, storage/engines."
  );

  if (!apply) {
    if (items.length) {
      console.log(`Re-run with \`npm run cleanup -- ${includeRaw ? "--include-raw " : ""}--yes\` to delete these.`);
    }
    if (items.some((item) => item.relative.startsWith("dist/"))) {
      console.log("After deleting dist/, run `npm run build` before `npm start` (`npm run dev` does not need it).");
    }
    return;
  }

  for (const item of items) {
    fs.rmSync(item.absolute, { recursive: true, force: true });
    console.log(`  removed ${item.relative}`);
  }
  const distDir = path.join(rootDir, "dist");
  if (fs.existsSync(distDir) && fs.readdirSync(distDir).length === 0) {
    fs.rmdirSync(distDir);
  }
  console.log(`Freed ${formatBytes(total)}.`);
  if (items.some((item) => item.relative.startsWith("dist/"))) {
    console.log("dist/ was removed: run `npm run build` before `npm start`.");
  }
}

main(process.argv.slice(2));
