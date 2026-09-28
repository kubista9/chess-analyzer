import fs from "node:fs";
import type { BackfillProgress } from "../../shared/types.js";

// One backfill at a time across processes (the server and `npm run backfill`): a lock file
// created with O_EXCL that holds the owner's pid and its latest progress. The holder
// refreshes it at least every HEARTBEAT_MS; a lock whose pid is gone, or whose heartbeat is
// older than STALE_MS, is stale and may be taken over. The other process reads the progress
// from it, so Home shows a CLI run's progress too.

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 2 * 60_000;

export interface LockInfo {
  pid: number;
  source: "cli" | "server";
  startedAt: number;
  updatedAt: number;
  progress: BackfillProgress | null;
}

export class BackfillLockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      holder.source === "cli"
        ? `The engine check is already running in a terminal (npm run backfill, pid ${holder.pid}).`
        : `The engine check is already running in the server (pid ${holder.pid}).`
    );
    this.name = "BackfillLockedError";
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readInfo(file: string): { info: LockInfo | null; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(file);
    try {
      return { info: JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo, mtimeMs: stat.mtimeMs };
    } catch {
      // Created but not written yet, or garbage.
      return { info: null, mtimeMs: stat.mtimeMs };
    }
  } catch {
    return null;
  }
}

function isStale(entry: { info: LockInfo | null; mtimeMs: number }, now: number): boolean {
  if (!entry.info) {
    return now - entry.mtimeMs > STALE_MS;
  }
  return !isPidAlive(entry.info.pid) || now - entry.info.updatedAt > STALE_MS;
}

/** The live lock's contents, or null when there is no lock or it is stale. */
export function readBackfillLock(file: string, now = Date.now()): LockInfo | null {
  const entry = readInfo(file);
  return entry?.info && !isStale(entry, now) ? entry.info : null;
}

export class BackfillLock {
  private info: LockInfo;
  private released = false;
  private readonly timer: NodeJS.Timeout;
  private readonly onExit = () => this.releaseSync();

  private constructor(
    private readonly file: string,
    info: LockInfo
  ) {
    this.info = info;
    this.timer = setInterval(() => this.write(), HEARTBEAT_MS);
    this.timer.unref();
    process.once("exit", this.onExit);
  }

  /** Takes the lock, replacing a stale one; throws BackfillLockedError while another process holds it. */
  static acquire(file: string, source: LockInfo["source"], now = Date.now()): BackfillLock {
    const info: LockInfo = { pid: process.pid, source, startedAt: now, updatedAt: now, progress: null };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(file, "wx");
        try {
          fs.writeSync(fd, JSON.stringify(info));
        } finally {
          fs.closeSync(fd);
        }
        return new BackfillLock(file, info);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const entry = readInfo(file);
        if (entry && !isStale(entry, now)) {
          throw new BackfillLockedError(entry.info ?? { ...info, pid: -1 });
        }
        fs.rmSync(file, { force: true });
      }
    }
    throw new Error(`Could not take the backfill lock ${file}`);
  }

  /** Records the latest progress (and refreshes the heartbeat). */
  update(progress: BackfillProgress): void {
    this.info = { ...this.info, progress };
    this.write();
  }

  releaseSync(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    clearInterval(this.timer);
    process.removeListener("exit", this.onExit);
    // Only remove the file if it is still ours (a stale-lock takeover may have replaced it).
    if (readInfo(this.file)?.info?.pid === process.pid) {
      fs.rmSync(this.file, { force: true });
    }
  }

  private write(): void {
    if (this.released) {
      return;
    }
    this.info = { ...this.info, updatedAt: Date.now() };
    const current = readInfo(this.file);
    if (current?.info && current.info.pid !== process.pid) {
      // Someone took the lock over (we were considered stale); never overwrite theirs.
      return;
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.info));
    fs.renameSync(temp, this.file);
  }
}
