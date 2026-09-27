import type {
  AnalysisStatus,
  FixListResponse,
  GameResponse,
  ImportStatus,
  JobState,
  PlayerColor,
  ReviewSummary,
  SnapshotResponse,
  SyncJobResult,
  TimeClass,
  TreeGamesResponse,
  TreeResponse
} from "../../shared/types";
import type { GameWindow } from "../../shared/window";

/** A non-2xx API answer. `status` lets the polling loop tell a lost job (404) from a blip. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's machine-readable reason, e.g. "on-battery". */
    readonly code?: string
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
    const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`, payload?.code);
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

export function fetchGame(gameId: string, signal?: AbortSignal): Promise<GameResponse> {
  return request<GameResponse>(`/api/games/${encodeURIComponent(gameId)}`, { signal });
}

/** Which tree: colour, window, time class (undefined = both) and weighting (false = hl=off). */
export interface TreeQuery {
  color: PlayerColor;
  window: GameWindow;
  timeClass?: TimeClass;
  /** false = unweighted; true = the window's default half-life. */
  weighted: boolean;
}

function treeParams(tree: TreeQuery, moves: readonly string[]): Record<string, string | undefined> {
  return {
    color: tree.color,
    moves: moves.join(",") || undefined,
    window: tree.window,
    tc: tree.timeClass,
    hl: tree.weighted ? undefined : "off"
  };
}

/** One node of the opening tree, reached by UCI moves from the start. */
export function fetchTreeNode(tree: TreeQuery, moves: readonly string[], signal?: AbortSignal): Promise<TreeResponse> {
  return request<TreeResponse>(`/api/tree${query(treeParams(tree, moves))}`, { signal });
}

/** One page of the games that played `uci` after `moves`. */
export function fetchTreeGames(
  tree: TreeQuery,
  moves: readonly string[],
  uci: string,
  page: number,
  signal?: AbortSignal
): Promise<TreeGamesResponse> {
  return request<TreeGamesResponse>(
    `/api/tree/games${query({ ...treeParams(tree, moves), uci, page: String(page) })}`,
    { signal }
  );
}

/** Filters for the answers over both colours (fix list, snapshot). */
export type RepertoireQuery = Omit<TreeQuery, "color">;

function repertoireParams(filters: RepertoireQuery): Record<string, string | undefined> {
  return { window: filters.window, tc: filters.timeClass, hl: filters.weighted ? undefined : "off" };
}

/** The results-only fix list over both colours. */
export function fetchFixList(filters: RepertoireQuery, signal?: AbortSignal): Promise<FixListResponse> {
  return request<FixListResponse>(`/api/fixlist${query(repertoireParams(filters))}`, { signal });
}

/** The opponent's main moves and the owner's answers, per colour. */
export function fetchSnapshot(filters: RepertoireQuery, signal?: AbortSignal): Promise<SnapshotResponse> {
  return request<SnapshotResponse>(`/api/snapshot${query(repertoireParams(filters))}`, { signal });
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

/** The engine check: coverage, queue, and the running backfill (server or CLI). */
export function fetchAnalysisStatus(signal?: AbortSignal): Promise<AnalysisStatus> {
  return request<AnalysisStatus>("/api/analysis/status", { signal });
}

/** Starts or resumes the backfill. Fails with code "on-battery" unless allowBattery. */
export function startBackfill(allowBattery = false): Promise<AnalysisStatus> {
  return request<AnalysisStatus>("/api/analysis/backfill", { method: "POST", body: JSON.stringify({ allowBattery }) });
}

export function pauseBackfill(): Promise<AnalysisStatus> {
  return request<AnalysisStatus>("/api/analysis/pause", { method: "POST", body: "{}" });
}
