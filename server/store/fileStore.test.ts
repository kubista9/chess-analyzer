import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_SCHEMA_VERSION, reviewCachePath } from "./cachePaths.js";
import { readVersionedJson, writeJsonFile, writeVersionedJson } from "./fileStore.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chess-filestore-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("versioned JSON", () => {
  it("round-trips the same schema version", async () => {
    const file = path.join(dir, "a", "review.json");
    await writeVersionedJson(file, 2, { moves: [1, 2] });
    expect(await readVersionedJson(file, 2)).toEqual({ moves: [1, 2] });
  });

  it("treats another schema version as a cache miss", async () => {
    const file = path.join(dir, "review.json");
    await writeVersionedJson(file, 1, { moves: [] });
    expect(await readVersionedJson(file, 2)).toBeNull();
  });

  it("treats an unversioned legacy payload and a missing file as misses", async () => {
    const file = path.join(dir, "legacy.json");
    await writeJsonFile(file, { game: {}, moves: [] });
    expect(await readVersionedJson(file, 2)).toBeNull();
    expect(await readVersionedJson(path.join(dir, "missing.json"), 2)).toBeNull();
  });

  it("writes atomically, leaving no temp file behind", async () => {
    const file = path.join(dir, "review.json");
    await writeVersionedJson(file, 2, { a: 1 });
    await writeVersionedJson(file, 2, { a: 2 });
    expect(await fs.readdir(dir)).toEqual(["review.json"]);
    expect(await readVersionedJson(file, 2)).toEqual({ a: 2 });
  });
});

describe("reviewCachePath", () => {
  it("points into reviews-v3 (fixed-depth protocol), never an older reviews directory", () => {
    const file = reviewCachePath("/cache", "kubista9", "184405952510");
    expect(file).toBe(path.join("/cache", "reviews-v3", "kubista9", "184405952510.json"));
    expect(REVIEW_SCHEMA_VERSION).toBe(3);
  });
});
