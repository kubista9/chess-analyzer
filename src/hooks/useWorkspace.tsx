import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { JOB_LOST_MESSAGE, isJobActive } from "../../shared/jobPolling";
import type { ImportStatus, JobState, ReviewSummary, SyncJobResult } from "../../shared/types";
import { ApiError, fetchActiveJobs, fetchJob, fetchStatus, startSync as postSync } from "../api/client";
import { useJobPolling } from "./useJobPolling";

// The pages read everything from the server's game store; nothing is cached in the browser
// except the id of a running sync job, so a reload can resume (or report a lost job).

interface WorkspaceContextValue {
  /** GET /api/status, refreshed on load and after every sync. */
  status: ImportStatus | null;
  statusError: string | null;
  refreshStatus: () => void;
  syncJob: JobState<SyncJobResult> | null;
  startSync: (full?: boolean) => Promise<void>;
  /** Bumped when a sync completes, so pages refetch their store queries. */
  dataVersion: number;
  // Reviews live in memory for this session only; the server caches them on disk.
  reviewCache: Record<string, ReviewSummary>;
  setReview: (gameId: string, review: ReviewSummary) => void;
  reviewJobs: Record<string, JobState<ReviewSummary> | null>;
  setReviewJob: (gameId: string, job: JobState<ReviewSummary> | null) => void;
}

const SYNC_JOB_KEY = "chess-analyst-sync-job";
// A stored job id older than the server's finished-job TTL can no longer be looked up.
const SYNC_JOB_MAX_AGE_MS = 30 * 60 * 1000;
// Keys of earlier workspaces: the v1 snapshot and review cache, and the v2 results snapshot
// that the store-driven pages no longer need.
const LEGACY_STORAGE_KEYS = ["chess-analyst-workspace-v1", "chess-analyst-reviews-v1", "chess-analyst-workspace-v2"];
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function removeLegacyKeys(): void {
  try {
    for (const key of LEGACY_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; nothing to clean up then.
  }
}

function readStoredSyncJobId(): string | null {
  try {
    const raw = window.localStorage.getItem(SYNC_JOB_KEY);
    const stored = raw ? (JSON.parse(raw) as { id?: unknown; at?: unknown }) : null;
    if (typeof stored?.id === "string" && typeof stored.at === "number" && Date.now() - stored.at < SYNC_JOB_MAX_AGE_MS) {
      return stored.id;
    }
    return null;
  } catch {
    return null;
  }
}

function storeSyncJobId(id: string | null): void {
  try {
    if (id) {
      window.localStorage.setItem(SYNC_JOB_KEY, JSON.stringify({ id, at: Date.now() }));
    } else {
      window.localStorage.removeItem(SYNC_JOB_KEY);
    }
  } catch {
    // Without storage a reload simply does not resume the job.
  }
}

/** A failed sync job made on the client: a lost job id, or a start request that failed. */
function failedSyncJob(id: string, error: string): JobState<SyncJobResult> {
  const at = Date.now();
  return { id, key: "sync", type: "sync", status: "failed", progress: 100, message: "Sync", error, createdAt: at, updatedAt: at };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncJob, setSyncJob] = useState<JobState<SyncJobResult> | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [reviewCache, setReviewCache] = useState<Record<string, ReviewSummary>>({});
  const [reviewJobs, setReviewJobs] = useState<Record<string, JobState<ReviewSummary> | null>>({});
  const startingSync = useRef(false);

  const refreshStatus = useCallback(() => {
    fetchStatus()
      .then((next) => {
        setStatus(next);
        setStatusError(null);
      })
      .catch((error: unknown) => setStatusError(errorText(error, "Could not load the sync status.")));
  }, []);

  const handleSyncUpdate = useCallback(
    (job: JobState<SyncJobResult>) => {
      setSyncJob(job);
      if (isJobActive(job)) {
        return;
      }
      storeSyncJobId(null);
      if (job.status === "completed" && job.result) {
        setStatus(job.result.status);
        setStatusError(null);
        setDataVersion((version) => version + 1);
      } else {
        refreshStatus();
      }
    },
    [refreshStatus]
  );

  useJobPolling(syncJob, handleSyncUpdate);

  // On load: drop old keys, read the status, and resume a sync this browser started (or
  // one that is running on the server). A stored id the server no longer knows is a lost job.
  useEffect(() => {
    removeLegacyKeys();
    refreshStatus();

    const controller = new AbortController();
    const storedId = readStoredSyncJobId();
    const resume = storedId
      ? fetchJob<SyncJobResult>(storedId, controller.signal).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) {
            storeSyncJobId(null);
            return failedSyncJob(storedId, JOB_LOST_MESSAGE);
          }
          return null;
        })
      : fetchActiveJobs(controller.signal)
          .then((jobs) => (jobs.find((job) => job.type === "sync") as JobState<SyncJobResult> | undefined) ?? null)
          .catch(() => null);

    void resume.then((job) => {
      if (controller.signal.aborted || !job) {
        return;
      }
      if (isJobActive(job) || job.error === JOB_LOST_MESSAGE) {
        setSyncJob(job);
      } else {
        storeSyncJobId(null);
      }
    });

    return () => controller.abort();
  }, [refreshStatus]);

  const startSync = useCallback(async (full = false) => {
    // One click, one request; the server also joins a running sync (two tabs).
    if (startingSync.current) {
      return;
    }
    startingSync.current = true;
    try {
      const job = await postSync(full);
      storeSyncJobId(job.id);
      setSyncJob(job);
    } catch (error) {
      setSyncJob(failedSyncJob("", errorText(error, "Could not start the sync.")));
    } finally {
      startingSync.current = false;
    }
  }, []);

  const setReview = useCallback((gameId: string, review: ReviewSummary) => {
    setReviewCache((current) => ({ ...current, [gameId]: review }));
  }, []);

  const setReviewJob = useCallback((gameId: string, job: JobState<ReviewSummary> | null) => {
    setReviewJobs((current) => ({ ...current, [gameId]: job }));
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      status,
      statusError,
      refreshStatus,
      syncJob,
      startSync,
      dataVersion,
      reviewCache,
      setReview,
      reviewJobs,
      setReviewJob
    }),
    [status, statusError, refreshStatus, syncJob, startSync, dataVersion, reviewCache, setReview, reviewJobs, setReviewJob]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }

  return context;
}
