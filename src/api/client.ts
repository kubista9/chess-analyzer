import type {
  AnalysisStatus,
  FixListResponse,
  GameResponse,
  ImportStatus,
  JobState,
  PlayerColor,
  RepertoireCoverageResponse,
  RepertoireResponse,
  SeedResponse,
  SnapshotResponse,
  SyncJobResult,
  TimeClass,
  TreeGamesResponse,
  TreeResponse
} from "../../shared/types";
import type { GameAnalysisResponse, RetryRequest, RetryResult } from "../../shared/review";
import type { RepEntry, RepStatus } from "../../shared/repertoire";
import type { AlternativesResponse } from "../../shared/alternatives";
import type { GameWindow } from "../../shared/window";
import { START_EPD } from "../../shared/epd";
import type { DrillAnswerRequest, DrillAnswerResponse, DrillFilter, DrillSessionResponse, DrillStats } from "../../shared/training/api";

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

  // 204 No Content (e.g. DELETE) has no body.
  return (response.status === 204 ? undefined : response.json()) as Promise<T>;
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

/** Both colours' repertoire lines, coverage and tables. */
export function fetchRepertoire(filters: RepertoireQuery, signal?: AbortSignal): Promise<RepertoireResponse> {
  return request<RepertoireResponse>(`/api/repertoire${query(repertoireParams(filters))}`, { signal });
}

/** A (re-)seed of the repertoire from the games: a dry-run diff, written when `apply`. */
export function seedRepertoire(filters: RepertoireQuery, apply: boolean): Promise<SeedResponse> {
  const { window, tc, hl } = repertoireParams(filters);
  return request<SeedResponse>("/api/repertoire/seed", { method: "POST", body: JSON.stringify({ apply, window, tc, hl }) });
}

export interface RepEntryEdit {
  color: PlayerColor;
  epd: string;
  uci?: string;
  locked?: boolean;
  status?: RepStatus;
  note?: string | null;
  /** Required when the entry is new. */
  ply?: number;
  /** The move this replaces and why (recorded in `replaced` when the move changes). */
  replaces?: { uci: string; loss?: number | null; reason?: string };
}

/** Sets the owner's move at a position (edited, locked) or changes an entry's lock, status or note. */
export function putRepEntry(edit: RepEntryEdit): Promise<{ entry: RepEntry }> {
  return request<{ entry: RepEntry }>("/api/repertoire/entry", { method: "PUT", body: JSON.stringify(edit) });
}

export function deleteRepEntry(color: PlayerColor, epd: string): Promise<void> {
  return request<void>(`/api/repertoire/entry${query({ color, epd })}`, { method: "DELETE" });
}

/** The ranked alternatives at an owner position; a 202 carries a preliminary ranking and the deep-search job. */
export function fetchAlternatives(tree: TreeQuery, moves: readonly string[], uci: string | null, signal?: AbortSignal): Promise<AlternativesResponse> {
  return request<AlternativesResponse>(`/api/alternatives${query({ ...treeParams(tree, moves), uci: uci ?? undefined })}`, { signal });
}

/** Coverage of the repertoire per colour (Home's line). */
export function fetchRepertoireCoverage(filters: RepertoireQuery, signal?: AbortSignal): Promise<RepertoireCoverageResponse> {
  return request<RepertoireCoverageResponse>(`/api/repertoire/coverage${query(repertoireParams(filters))}`, { signal });
}

/** The PGN download of one colour's repertoire. */
export function repertoireExportHref(color: PlayerColor, filters: RepertoireQuery): string {
  return `/api/repertoire/export${query({ color, ...repertoireParams(filters) })}`;
}

/** The opening review from the cache; a partial one comes with the job that completes it. */
export function fetchGameAnalysis(gameId: string, signal?: AbortSignal): Promise<GameAnalysisResponse> {
  return request<GameAnalysisResponse>(`/api/games/${encodeURIComponent(gameId)}/analysis`, { signal });
}

/** Judges a Retry move (scored on demand when the cache does not have it). */
export function postRetry(gameId: string, retry: RetryRequest, signal?: AbortSignal): Promise<RetryResult> {
  return request<RetryResult>(`/api/games/${encodeURIComponent(gameId)}/retry`, { method: "POST", body: JSON.stringify(retry), signal });
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

export function fetchDrillStats(signal?: AbortSignal): Promise<DrillStats> {
  return request<DrillStats>("/api/drills/stats", { signal });
}

/** A card to put first: its id, or a colour and a position by its moves from the start. */
export interface DrillFocus {
  id?: string;
  color?: PlayerColor;
  moves?: readonly string[];
}

export function fetchDrillSession(kind: DrillFilter, focus: DrillFocus | null, signal?: AbortSignal): Promise<DrillSessionResponse> {
  return request<DrillSessionResponse>(
    `/api/drills/due${query({
      kind,
      focus: focus?.id,
      color: focus?.moves ? focus.color : undefined,
      moves: focus?.moves?.length ? focus.moves.join(",") : undefined,
      epd: focus?.moves && !focus.moves.length ? START_EPD : undefined
    })}`,
    { signal }
  );
}

export function postDrillAnswer(answer: DrillAnswerRequest): Promise<DrillAnswerResponse> {
  return request<DrillAnswerResponse>("/api/drills/answer", { method: "POST", body: JSON.stringify(answer) });
}
