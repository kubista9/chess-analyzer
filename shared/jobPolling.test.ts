import { describe, expect, it, vi } from "vitest";
import {
  JOB_LOST_MESSAGE,
  MAX_POLL_FAILURES,
  abortableSleep,
  endedJobState,
  isNotFoundError,
  pollJob,
  type PollOptions
} from "./jobPolling.js";
import type { JobState } from "./types.js";

function job(status: JobState<string>["status"], progress = 0): JobState<string> {
  return { id: "j1", key: "sync", type: "sync", status, progress, message: "", createdAt: 0, updatedAt: 0 };
}

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`);
  }
}

/** Runs pollJob with an instant sleep and a scripted fetch. */
function run(script: Array<JobState<string> | Error>, overrides: Partial<PollOptions<string>> = {}) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const updates: JobState<string>[] = [];
  const fetchJob = vi.fn(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const step = script[Math.min(calls, script.length - 1)];
    calls += 1;
    if (step instanceof Error) {
      throw step;
    }
    return step;
  });
  const promise = pollJob<string>({
    jobId: "j1",
    fetchJob,
    onUpdate: (next) => updates.push(next),
    signal: new AbortController().signal,
    sleep: async () => {},
    ...overrides
  });
  return { promise, fetchJob, updates, maxInFlight: () => maxInFlight };
}

describe("pollJob", () => {
  it("polls until the job completes, one request at a time", async () => {
    const polling = run([job("queued"), job("running", 40), job("completed", 100)]);
    const end = await polling.promise;
    expect(end).toEqual({ kind: "finished", job: job("completed", 100) });
    expect(polling.updates.map((update) => update.status)).toEqual(["queued", "running", "completed"]);
    expect(polling.fetchJob).toHaveBeenCalledTimes(3);
    expect(polling.maxInFlight()).toBe(1);
  });

  it("stops on a failed job", async () => {
    const end = await run([job("running"), { ...job("failed"), error: "HTTP 503" }]).promise;
    expect(end).toMatchObject({ kind: "finished", job: { status: "failed", error: "HTTP 503" } });
  });

  it("stops at once on a 404: the job is lost", async () => {
    const polling = run([job("running"), new HttpFailure(404), job("completed")]);
    expect(await polling.promise).toEqual({ kind: "lost" });
    expect(polling.fetchJob).toHaveBeenCalledTimes(2);
  });

  it(`gives up after ${MAX_POLL_FAILURES} consecutive failures`, async () => {
    const polling = run([new TypeError("Failed to fetch")]);
    expect(await polling.promise).toEqual({ kind: "unreachable", error: "Failed to fetch" });
    expect(polling.fetchJob).toHaveBeenCalledTimes(MAX_POLL_FAILURES);
  });

  it("resets the failure count after a successful poll", async () => {
    const blip = new HttpFailure(502);
    const script = [blip, blip, blip, blip, job("running"), blip, blip, blip, blip, job("completed")];
    const polling = run(script);
    expect(await polling.promise).toMatchObject({ kind: "finished" });
    expect(polling.fetchJob).toHaveBeenCalledTimes(10);
  });

  it("stops when aborted, without further updates", async () => {
    const controller = new AbortController();
    const polling = run([job("running")], {
      signal: controller.signal,
      sleep: (_ms, signal) => abortableSleep(5, signal)
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const updatesAtAbort = polling.updates.length;
    expect(await polling.promise).toEqual({ kind: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(polling.updates.length).toBe(updatesAtAbort);
  });

  it("waits the interval before each request", async () => {
    const waits: number[] = [];
    await run([job("running"), job("completed")], {
      intervalMs: 1400,
      sleep: async (ms) => {
        waits.push(ms);
      }
    }).promise;
    expect(waits).toEqual([1400, 1400]);
  });
});

describe("abortableSleep", () => {
  it("resolves early on abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("endedJobState / isNotFoundError", () => {
  it("turns a lost or unreachable job into a failed one with the reason", () => {
    expect(endedJobState(job("running"), { kind: "lost" })).toMatchObject({ status: "failed", error: JOB_LOST_MESSAGE });
    expect(endedJobState(job("running"), { kind: "unreachable", error: "Failed to fetch" })?.error).toMatch(
      /Lost contact with the server \(Failed to fetch\)/
    );
    expect(endedJobState(job("running"), { kind: "aborted" })).toBeNull();
    expect(JOB_LOST_MESSAGE).toMatch(/Job lost.*run again/);
  });

  it("recognises only a 404 status", () => {
    expect(isNotFoundError(new HttpFailure(404))).toBe(true);
    expect(isNotFoundError(new HttpFailure(500))).toBe(false);
    expect(isNotFoundError(new Error("404"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});
