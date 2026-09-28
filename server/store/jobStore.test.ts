import { describe, expect, it } from "vitest";
import { FINISHED_TTL_MS, JobStore } from "./jobStore.js";

/** A promise with its resolve/reject handles, to hold a job open in a test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JobStore.startOrReuse", () => {
  it("joins a running job with the same key instead of starting a second run", async () => {
    const store = new JobStore();
    const gate = deferred<string>();
    let runs = 0;
    const run = () => {
      runs += 1;
      return gate.promise;
    };

    const first = store.startOrReuse("sync", "sync", "Sync", run);
    const second = store.startOrReuse("sync", "sync", "Sync", run);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(first.job).toMatchObject({ key: "sync", type: "sync", status: "queued" });

    await settle();
    expect(runs).toBe(1);
    expect(store.get(first.job.id)?.status).toBe("running");

    gate.resolve("done");
    await settle();
    expect(store.get(first.job.id)).toMatchObject({ status: "completed", progress: 100, result: "done" });
  });

  it("keys are independent: two reviews of different games run side by side", () => {
    const store = new JobStore();
    const a = store.startOrReuse("review:1", "game-review", "Review", () => new Promise(() => {}));
    const b = store.startOrReuse("review:2", "game-review", "Review", () => new Promise(() => {}));
    expect(a.job.id).not.toBe(b.job.id);
    expect(store.startOrReuse("review:1", "game-review", "Review", () => new Promise(() => {})).job.id).toBe(a.job.id);
  });

  it("starts a new job once the previous one for the key has finished", async () => {
    const store = new JobStore();
    const first = store.startOrReuse("sync", "sync", "Sync", async () => 1);
    await settle();
    const second = store.startOrReuse("sync", "sync", "Sync", async () => 2);
    expect(second.reused).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("records a failure with its reason and frees the key for a retry", async () => {
    const store = new JobStore();
    const failed = store.startOrReuse("sync", "sync", "Sync", async () => {
      throw new Error("Chess.com is down");
    });
    await settle();
    expect(store.get(failed.job.id)).toMatchObject({ status: "failed", error: "Chess.com is down", message: "Sync failed" });

    const retry = store.startOrReuse("sync", "sync", "Sync", async () => "ok");
    expect(retry.reused).toBe(false);
  });

  it("treats a synchronous throw in run as a failed job, not a crash", async () => {
    const store = new JobStore();
    const { job } = store.startOrReuse("sync", "sync", "Sync", () => {
      throw new Error("boom");
    });
    await settle();
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: "boom" });
  });

  it("reports progress, clamped below 100 until the job completes", async () => {
    const store = new JobStore();
    const gate = deferred<void>();
    const { job } = store.startOrReuse("sync", "sync", "Sync", async (reporter) => {
      reporter.progress(40, "Checking 2026-07");
      await gate.promise;
      reporter.progress(250, "Almost");
    });
    await settle();
    expect(store.get(job.id)).toMatchObject({ status: "running", progress: 40, message: "Checking 2026-07" });
    gate.resolve();
    await settle();
    expect(store.get(job.id)).toMatchObject({ status: "completed", progress: 100 });
  });
});

describe("JobStore.get / active / eviction", () => {
  it("returns undefined for an unknown id (the route answers 404)", () => {
    expect(new JobStore().get("no-such-job")).toBeUndefined();
  });

  it("lists only queued and running jobs as active", async () => {
    const store = new JobStore();
    const running = store.startOrReuse("sync", "sync", "Sync", () => new Promise(() => {}));
    store.completed("review:1", "game-review", "Ready", { cached: true });
    await settle();
    expect(store.active().map((job) => job.id)).toEqual([running.job.id]);
  });

  it("evicts finished jobs after 30 minutes but never a running one", async () => {
    let now = 1_000_000;
    const store = new JobStore({ now: () => now });
    const done = store.completed("review:1", "game-review", "Ready", "result");
    const running = store.startOrReuse("sync", "sync", "Sync", () => new Promise(() => {}));
    await settle();

    now += FINISHED_TTL_MS - 1;
    expect(store.get(done.id)?.result).toBe("result");
    now += 2;
    expect(store.get(done.id)).toBeUndefined();
    expect(store.get(running.job.id)?.status).toBe("running");
  });

  it("hands out copies, so callers cannot mutate stored jobs", () => {
    const store = new JobStore();
    const job = store.completed("review:1", "game-review", "Ready", 1);
    const copy = store.get(job.id)!;
    copy.status = "failed";
    expect(store.get(job.id)?.status).toBe("completed");
  });
});
