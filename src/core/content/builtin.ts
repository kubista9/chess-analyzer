// The built-in repertoire: every content/**/*.json file, bundled by Vite at build time. App only:
// tests and scripts read the same files with fs (src/test/content.ts).

const MODULES: Record<string, unknown> = import.meta.glob("../../../content/**/*.json", { eager: true, import: "default" });

const PREFIX = "../../../content/";

/** The paths in a fixed order, so the catalog (and its issue list) is the same on every build. */
const PATHS = Object.keys(MODULES).sort();

/** The parsed chapter files, in path order. Pass them to buildCatalog. */
export function builtinContent(): unknown[] {
  return PATHS.map((path) => MODULES[path]);
}

/** The files' paths relative to content/ (e.g. "white/english-e5.json"), matching builtinContent() by index. */
export function builtinContentNames(): string[] {
  return PATHS.map((path) => (path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path));
}
