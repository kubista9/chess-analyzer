import type { JobState } from "./types.js";

// The client's job polling loop, kept free of React so it can be unit-tested.
// - One request at a time: the next poll is scheduled only after the previous one settled.
// - It stops when the job completes or fails, when the server answers 404 (the job is gone,
//   e.g. after a server restart), after MAX_POLL_FAILURES consecutive errors, or on abort.

export const POLL_INTERVAL_MS = 1400;
export const MAX_POLL_FAILURES = 5;
export const JOB_LOST_MESSAGE = "Job lost (the server restarted), run again.";

export type PollEnd<T> =
  | { kind: "finished"; job: JobState<T> }
  | { kind: "lost" }
  | { kind: "unreachable"; error: string }
  | { kind: "aborted" };

export interface PollOptions<T> {
  jobId: string;
  fetchJob: (jobId: string, signal: AbortSignal) => Promise<JobState<T>>;
  onUpdate: (job: JobState<T>) => void;
  signal: AbortSignal;
  intervalMs?: number;
  maxFailures?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function isJobActive(job: Pick<JobState<unknown>, "status"> | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}

/** True for an error carrying an HTTP 404 status (the client's ApiError). */
export function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export async function pollJob<T>(options: PollOptions<T>): Promise<PollEnd<T>> {
  const { jobId, fetchJob, onUpdate, signal } = options;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxFailures = options.maxFailures ?? MAX_POLL_FAILURES;
  const sleep = options.sleep ?? abortableSleep;
  let failures = 0;

  for (;;) {
    await sleep(intervalMs, signal);
    if (signal.aborted) {
      return { kind: "aborted" };
    }

    try {
      const job = await fetchJob(jobId, signal);
      if (signal.aborted) {
        return { kind: "aborted" };
      }
      failures = 0;
      onUpdate(job);
      if (!isJobActive(job)) {
        return { kind: "finished", job };
      }
    } catch (error) {
      if (signal.aborted) {
        return { kind: "aborted" };
      }
      if (isNotFoundError(error)) {
        return { kind: "lost" };
      }
      failures += 1;
      if (failures >= maxFailures) {
        return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
}

/** The job as the UI should show it after polling ended without a result: failed, with why. */
export function endedJobState<T>(job: JobState<T>, end: PollEnd<T>): JobState<T> | null {
  if (end.kind === "lost") {
    return { ...job, status: "failed", error: JOB_LOST_MESSAGE };
  }
  if (end.kind === "unreachable") {
    return { ...job, status: "failed", error: `Lost contact with the server (${end.error}). Run it again.` };
  }
  return null;
}
