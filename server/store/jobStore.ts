import crypto from "node:crypto";
import type { JobState } from "../../shared/types.js";

class JobStore {
  private jobs = new Map<string, JobState<unknown>>();

  create<T>(type: JobState<T>["type"], message: string): JobState<T> {
    const job: JobState<T> = {
      id: crypto.randomUUID(),
      type,
      status: "queued",
      progress: 0,
      message
    };

    this.jobs.set(job.id, job as JobState<unknown>);
    return job;
  }

  update<T>(id: string, patch: Partial<JobState<T>>): JobState<T> {
    const current = this.get<T>(id);
    const next = { ...current, ...patch };
    this.jobs.set(id, next as JobState<unknown>);
    return next;
  }

  get<T>(id: string): JobState<T> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown job: ${id}`);
    }

    return job as JobState<T>;
  }
}

export const jobStore = new JobStore();
