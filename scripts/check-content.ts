// `npm run content:check`: replays every content file with chess.js, runs the catalog and
// opening-book lints, prints a summary per side and every issue, and exits with 1 on any error.
//
//   tsx scripts/check-content.ts [--content <dir>] [--book <dir>]
//
// --content and --book default to content/ and data/chess-openings/ in this repository.

import { relative, resolve } from "node:path";
import { buildCatalog, summariseCatalog, type SideSummary } from "../src/core/content/catalog";
import { lintAgainstBook, lintCatalog } from "../src/core/content/lint";
import type { ContentIssue } from "../src/core/content/types";
import { loadBookFromTsv } from "../src/core/openingDb/book";
import { BOOK_DIR, CONTENT_DIR, REPO_ROOT, folderSideIssues, loadBookTexts, readContentEntries } from "../src/test/content";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** A folder relative to the repository when it is inside it, else as given. */
function display(dir: string): string {
  const path = relative(REPO_ROOT, dir);
  return path.startsWith("..") ? dir : path || ".";
}

function table(rows: readonly string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

function summaryRows(summaries: readonly SideSummary[]): string[][] {
  const header = ["Side", "Chapters", "Lines", "On by default", "Plies", "Your moves", "With a note", "Coverage"];
  return [
    header,
    ...summaries.map((summary) => [
      summary.side === "white" ? "White" : "Black",
      String(summary.chapters),
      String(summary.lines),
      String(summary.defaultEnabledLines),
      String(summary.plies),
      String(summary.userMoves),
      String(summary.notedUserMoves),
      summary.coverage === null ? "-" : `${Math.round(summary.coverage * 100)}%`
    ])
  ];
}

function main(): number {
  const contentDir = resolve(option("--content") ?? CONTENT_DIR);
  const bookDir = resolve(option("--book") ?? BOOK_DIR);
  const entries = readContentEntries(contentDir);
  if (entries.length === 0) {
    console.log(`no content yet: ${display(contentDir)}/ has no chapter JSON files`);
    return 0;
  }

  const issues: ContentIssue[] = [];
  for (const entry of entries) {
    if (entry.error !== null) {
      issues.push({ level: "error", fileId: entry.path, message: entry.error });
    }
  }
  issues.push(...folderSideIssues(entries));

  const valid = entries.filter((entry) => entry.error === null);
  const catalog = buildCatalog(
    valid.map((entry) => entry.json),
    [],
    { fileNames: valid.map((entry) => entry.path) }
  );
  issues.push(...catalog.issues, ...lintCatalog(catalog));
  issues.push(...lintAgainstBook(catalog, loadBookFromTsv(loadBookTexts(bookDir))));

  // Issues name the chapter id; show the file it lives in as well.
  const fileOf = new Map<string, string>();
  for (const entry of valid) {
    const id = (entry.json as { id?: unknown } | null)?.id;
    if (typeof id === "string" && !fileOf.has(id)) {
      fileOf.set(id, entry.path);
    }
  }

  console.log(`Content check: ${entries.length} file${entries.length === 1 ? "" : "s"} in ${display(contentDir)}/\n`);
  console.log(table(summaryRows(summariseCatalog(catalog))));

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  console.log(`\n${errors.length} error${errors.length === 1 ? "" : "s"} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
  for (const issue of [...errors, ...warnings]) {
    const where = [issue.fileId ? (fileOf.get(issue.fileId) ?? issue.fileId) : null, issue.lineId ?? null].filter(Boolean).join(" · ");
    console.log(`${issue.level === "error" ? "error  " : "warning"}  ${where ? `${where} · ` : ""}${issue.message}`);
  }
  return errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
