import { describe, expect, it } from "vitest";
import { contentJsonPaths, folderSideIssues, loadBookTexts, loadContentFiles, readContentEntries } from "../../test/content";
import { loadBookFromTsv } from "../openingDb/book";
import { builtinContent, builtinContentNames } from "./builtin";
import { buildCatalog } from "./catalog";
import { lintAgainstBook, lintCatalog } from "./lint";
import type { Catalog, ContentIssue } from "./types";

// The real repertoire in content/: it must compile and lint without errors (warnings are for
// `npm run content:check` to show). Skipped while content/ has no chapter files yet.

const entries = readContentEntries();
const hasContent = entries.length > 0;

/** One issue per row, so a failing expectation shows every problem at once. */
const listed = (issues: readonly ContentIssue[]) =>
  issues
    .filter((issue) => issue.level === "error")
    .map((issue) => [issue.fileId, issue.lineId, issue.message].filter(Boolean).join(" · "))
    .join("\n");

let cached: Catalog | null = null;
function catalog(): Catalog {
  cached ??= buildCatalog(
    entries.map((entry) => entry.json),
    [],
    { fileNames: entries.map((entry) => entry.path) }
  );
  return cached;
}

describe("the bundled content loader", () => {
  it("bundles the same files the tests read from disk, in the same order", () => {
    expect(builtinContentNames()).toEqual(contentJsonPaths());
    if (entries.every((entry) => entry.error === null)) {
      expect(builtinContent()).toEqual(loadContentFiles());
    }
  });
});

describe.skipIf(!hasContent)(
  hasContent ? `the repertoire in content/ (${entries.length} files)` : "the repertoire in content/ (skipped: content/ has no chapter JSON files yet)",
  () => {
    it("is valid JSON, each file in the folder of its side", () => {
      expect(entries.filter((entry) => entry.error !== null).map((entry) => `${entry.path}: ${entry.error}`)).toEqual([]);
      expect(listed(folderSideIssues(entries))).toBe("");
    });

    it("compiles without errors", () => {
      expect(listed(catalog().issues)).toBe("");
      expect(catalog().lines.length).toBeGreaterThan(0);
    });

    it("passes the catalog lint without errors", () => {
      expect(listed(lintCatalog(catalog()))).toBe("");
    });

    it("can be checked against the opening book", () => {
      const issues = lintAgainstBook(catalog(), loadBookFromTsv(loadBookTexts()));
      expect(issues.every((issue) => issue.level === "warning")).toBe(true);
    });
  }
);
