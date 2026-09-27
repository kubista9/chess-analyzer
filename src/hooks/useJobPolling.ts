import { useEffect, useRef } from "react";
import { endedJobState, isJobActive, pollJob } from "../../shared/jobPolling";
import type { JobState } from "../../shared/types";
import { fetchJob } from "../api/client";

/**
 * Polls a queued or running job until it completes or fails (see shared/jobPolling.ts).
 * A lost job (404, e.g. after a server restart) or an unreachable server is reported
 * through onUpdate as a failed job with the reason. The effect restarts only when the job
 * id or its active state changes, never because onUpdate or the job object changed.
 */
export function useJobPolling<T>(job: JobState<T> | null, onUpdate: (job: JobState<T>) => void): void {
  const onUpdateRef = useRef(onUpdate);
  const jobRef = useRef(job);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
    jobRef.current = job;
  });

  const jobId = job?.id ?? null;
  const active = isJobActive(job);

  useEffect(() => {
    if (!jobId || !active) {
      return undefined;
    }

    const controller = new AbortController();
    void pollJob<T>({
      jobId,
      fetchJob: (id, signal) => fetchJob<T>(id, signal),
      onUpdate: (next) => onUpdateRef.current(next),
      signal: controller.signal
    }).then((end) => {
      const last = jobRef.current;
      const ended = last && last.id === jobId ? endedJobState(last, end) : null;
      if (ended) {
        onUpdateRef.current(ended);
      }
    });

    return () => controller.abort();
  }, [jobId, active]);
}
