import type { DashboardSnapshot, JobState, ReviewSummary } from "../../shared/types";
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

export async function startBulkAnalysis(username: string, limit: BulkAnalysisLimit): Promise<JobState<DashboardSnapshot>> {
  return request<JobState<DashboardSnapshot>>("/api/bulk-analysis", {
    method: "POST",
    body: JSON.stringify({ username, limit })
  });
}

export async function startGameReview(params: {
  username: string;
  gameId: string;
  gameSummary?: DashboardSnapshot["games"][number];
}): Promise<JobState<ReviewSummary>> {
  return request<JobState<ReviewSummary>>("/api/game-review", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function fetchJob<T>(jobId: string): Promise<JobState<T>> {
  return request<JobState<T>>(`/api/jobs/${jobId}`);
}
