import type { OpeningsSnapshot, JobState, ReviewSummary } from "../../shared/types";
import type { BulkAnalysisLimit } from "../../shared/constants";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export async function startBulkAnalysis(limit: BulkAnalysisLimit): Promise<JobState<OpeningsSnapshot>> {
  return request<JobState<OpeningsSnapshot>>("/api/bulk-analysis", {
    method: "POST",
    body: JSON.stringify({ limit })
  });
}

export async function startGameReview(params: {
  gameId: string;
  gameSummary?: OpeningsSnapshot["games"][number];
}): Promise<JobState<ReviewSummary>> {
  return request<JobState<ReviewSummary>>("/api/game-review", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function fetchJob<T>(jobId: string): Promise<JobState<T>> {
  return request<JobState<T>>(`/api/jobs/${jobId}`);
}
