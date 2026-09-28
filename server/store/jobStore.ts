import crypto from "node:crypto";
import type { JobState, JobType } from "../../shared/types.js";

// In-memory background jobs. Each job has a dedupe key ("sync", "review:<gameId>"): starting
// a key that is still queued or running joins that job instead of starting a second one
// (double clicks, two tabs, StrictMode). Finished jobs are kept for FINISHED_TTL_MS so a
// poller can read the result, then evicted. A server restart loses every job; the client
// sees a 404 for its job id and says so.

export const FINISHED_TTL_MS = 30 * 60 * 1000;

export interface JobReporter {
  progress(progress: number, message: string): void;
}

export interface StartResult<T> {
  job: JobState<T>;
  /** True when the key was already running and this call joined it. */
  reused: boolean;
}

export interface JobStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

function isActive(job: JobState<unknown>): boolean {
  return job.status === "queued" || job.status === "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JobStore {
  private jobs = new Map<string, JobState<unknown>>();
  /** key -> id of the queued or running job for that key. */
  private inFlight = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: JobStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? FINISHED_TTL_MS;
  }

  /**
   * Joins the running job for `key`, or starts `run` as a new one. `run` reports progress
   * through the reporter; its resolved value becomes the result, a rejection the error.
   */
  startOrReuse<T>(
    key: string,
    type: JobType,
    message: string,
    run: (reporter: JobReporter) => Promise<T>
  ): StartResult<T> {
    this.sweep();
    const runningId = this.inFlight.get(key);
    const running = runningId ? this.jobs.get(runningId) : undefined;
    if (running && isActive(running)) {
      return { job: running as JobState<T>, reused: true };
    }

    const job = this.insert<T>({ key, type, status: "queued", progress: 0, message });
    this.inFlight.set(key, job.id);

    const reporter: JobReporter = {
      progress: (progress, progressMessage) => {
        this.update(job.id, { status: "running", progress: Math.max(0, Math.min(99, Math.round(progress))), message: progressMessage });
      }
    };

    // Deferred, so the caller always receives the job before `run` can finish or throw.
    void Promise.resolve()
      .then(() => {
        this.update(job.id, { status: "running" });
        return run(reporter);
      })
      .then(
        (result) => this.finish<T>(job.id, key, { status: "completed", progress: 100, result }),
        (error: unknown) =>
          this.finish<T>(job.id, key, { status: "failed", progress: 100, message: `${message} failed`, error: errorMessage(error) })
      );

    return { job: { ...job }, reused: false };
  }

  /** Records an already-finished job (e.g. a review served from the disk cache). */
  completed<T>(key: string, type: JobType, message: string, result: T): JobState<T> {
    this.sweep();
    return { ...this.insert<T>({ key, type, status: "completed", progress: 100, message, result }) };
  }

  /** The job, or undefined when it is unknown (never created, evicted, or lost in a restart). */
  get<T>(id: string): JobState<T> | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    return job ? ({ ...job } as JobState<T>) : undefined;
  }

  /** Queued and running jobs, oldest first (lets a reloaded client resume polling). */
  active(): JobState<unknown>[] {
    this.sweep();
    return [...this.jobs.values()].filter(isActive).map((job) => ({ ...job }));
  }

  private insert<T>(fields: Omit<JobState<T>, "id" | "createdAt" | "updatedAt">): JobState<T> {
    const at = this.now();
    const job: JobState<T> = { id: crypto.randomUUID(), createdAt: at, updatedAt: at, ...fields };
    this.jobs.set(job.id, job as JobState<unknown>);
    return job;
  }

  private update<T>(id: string, patch: Partial<JobState<T>>): void {
    const current = this.jobs.get(id);
    if (current && isActive(current)) {
      this.jobs.set(id, { ...current, ...patch, updatedAt: this.now() });
    }
  }

  private finish<T>(id: string, key: string, patch: Partial<JobState<T>>): void {
    this.update(id, patch);
    if (this.inFlight.get(key) === id) {
      this.inFlight.delete(key);
    }
  }

  /** Evicts finished jobs older than the TTL. Running jobs are never evicted. */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (!isActive(job) && job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

export const jobStore = new JobStore();
