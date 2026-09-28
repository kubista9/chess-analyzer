import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackfillLock, BackfillLockedError, STALE_MS, isPidAlive, readBackfillLock, type LockInfo } from "./backfillLock.js";

let dir: string;
let file: string;
const held: BackfillLock[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-lock-"));
  file = path.join(dir, "backfill.lock");
});

afterEach(() => {
  held.splice(0).forEach((lock) => lock.releaseSync());
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

function writeLock(info: Partial<LockInfo>): void {
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, source: "cli", startedAt: now, updatedAt: now, progress: null, ...info }));
}

describe("BackfillLock", () => {
  it("lets one holder in, refuses a second, and frees the file on release", () => {
    const lock = BackfillLock.acquire(file, "cli");
    held.push(lock);
    expect(readBackfillLock(file)).toMatchObject({ pid: process.pid, source: "cli", progress: null });
    expect(() => BackfillLock.acquire(file, "server")).toThrow(BackfillLockedError);
    expect(() => BackfillLock.acquire(file, "server")).toThrow(/running in a terminal/);

    lock.releaseSync();
    expect(fs.existsSync(file)).toBe(false);
    expect(readBackfillLock(file)).toBeNull();
    held.push(BackfillLock.acquire(file, "server"));
  });

  it("publishes progress through the file, atomically", () => {
    const lock = BackfillLock.acquire(file, "cli");
    held.push(lock);
    const progress = { pass: "owner", games: { total: 3, done: 1, failed: 0 } } as never;
    lock.update(progress);
    expect(readBackfillLock(file)?.progress).toEqual(progress);
    expect(fs.readdirSync(dir)).toEqual(["backfill.lock"]);
  });

  it("takes over a lock whose process is gone, or whose heartbeat is stale", () => {
    const pid = deadPid();
    expect(isPidAlive(pid)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);

    writeLock({ pid });
    expect(readBackfillLock(file)).toBeNull();
    const lock = BackfillLock.acquire(file, "cli");
    expect(readBackfillLock(file)?.pid).toBe(process.pid);
    lock.releaseSync();

    writeLock({ updatedAt: Date.now() - STALE_MS - 1 });
    expect(readBackfillLock(file)).toBeNull();
    held.push(BackfillLock.acquire(file, "server"));
  });

  it("does not remove a lock another process took over", () => {
    const lock = BackfillLock.acquire(file, "cli");
    writeLock({ pid: 1, source: "server" });
    lock.releaseSync();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(1);
  });
});
