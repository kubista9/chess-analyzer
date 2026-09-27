import type {
  GameResponse,
  GamesResponse,
  ImportStatus,
  JobState,
  OpeningReportResponse,
  PlayerColor,
  ReviewSummary,
  SyncJobResult,
  TimeClass
} from "../../shared/types";
import type { GameWindow } from "../../shared/window";

/** A non-2xx API answer. `status` lets the polling loop tell a lost job (404) from a blip. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
}

export function fetchStatus(signal?: AbortSignal): Promise<ImportStatus> {
  return request<ImportStatus>("/api/status", { signal });
}

export function startSync(full = false): Promise<JobState<SyncJobResult>> {
  return request<JobState<SyncJobResult>>("/api/sync", {
    method: "POST",
    body: JSON.stringify({ full })
  });
}

export interface GameQuery {
  window: GameWindow;
  timeClass?: TimeClass;
  color?: PlayerColor;
}

export function fetchGames(filter: GameQuery, signal?: AbortSignal): Promise<GamesResponse> {
  return request<GamesResponse>(
    `/api/games${query({ window: filter.window, tc: filter.timeClass, color: filter.color })}`,
    { signal }
  );
}

export function fetchGame(gameId: string, signal?: AbortSignal): Promise<GameResponse> {
  return request<GameResponse>(`/api/games/${encodeURIComponent(gameId)}`, { signal });
}

export function fetchOpeningReport(window: GameWindow, signal?: AbortSignal): Promise<OpeningReportResponse> {
  return request<OpeningReportResponse>(`/api/openings/report${query({ window })}`, { signal });
}

export function startGameReview(gameId: string): Promise<JobState<ReviewSummary>> {
  return request<JobState<ReviewSummary>>("/api/game-review", {
    method: "POST",
    body: JSON.stringify({ gameId })
  });
}

export function fetchJob<T>(jobId: string, signal?: AbortSignal): Promise<JobState<T>> {
  return request<JobState<T>>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function fetchActiveJobs(signal?: AbortSignal): Promise<JobState<unknown>[]> {
  return request<JobState<unknown>[]>("/api/jobs/active", { signal });
}
