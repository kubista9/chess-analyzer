import path from "node:path";
import { safeKey } from "./fileStore.js";

// Versioned cache locations. The legacy storage/cache/reviews and storage/cache/scans
// directories are never read, written or deleted by the app; the owner cleans them up
// (P9's owner-run cleanup command).

/** Bump when the stored ReviewSummary shape or its semantics change; old files become misses. */
export const REVIEW_SCHEMA_VERSION = 3;
export const REVIEWS_DIR = "reviews-v3";

export function reviewCachePath(cacheDir: string, owner: string, gameId: string): string {
  return path.join(cacheDir, REVIEWS_DIR, safeKey(owner), `${safeKey(gameId)}.json`);
}
