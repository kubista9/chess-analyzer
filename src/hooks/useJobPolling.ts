import { useEffect } from "react";
import type { JobState } from "../../shared/types";
import { fetchJob } from "../api/client";

export function useJobPolling<T>(
  job: JobState<T> | null,
  onUpdate: (job: JobState<T>) => void
): void {
  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") {
      return;
    }

    const intervalId = window.setInterval(async () => {
      const next = await fetchJob<T>(job.id);
      onUpdate(next);
    }, 1400);

    return () => window.clearInterval(intervalId);
  }, [job, onUpdate]);
}
