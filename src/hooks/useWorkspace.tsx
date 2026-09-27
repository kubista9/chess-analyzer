import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { OWNER_USERNAME } from "../../shared/constants";
import type { OpeningsSnapshot, JobState, ReviewSummary } from "../../shared/types";

interface WorkspaceContextValue {
  snapshot: OpeningsSnapshot | null;
  setSnapshot: (snapshot: OpeningsSnapshot | null) => void;
  bulkJob: JobState<OpeningsSnapshot> | null;
  setBulkJob: (job: JobState<OpeningsSnapshot> | null) => void;
  // Reviews live in memory for this session only; the server caches them on disk.
  reviewCache: Record<string, ReviewSummary>;
  setReview: (gameId: string, review: ReviewSummary) => void;
  reviewJobs: Record<string, JobState<ReviewSummary> | null>;
  setReviewJob: (gameId: string, job: JobState<ReviewSummary> | null) => void;
}

// v2: results-only snapshot (colour split, W/D/L). A v1 snapshot has the old shape.
const STORAGE_KEY = "chess-analyst-workspace-v2";
// Keys of the v1 workspace, including the review cache that ran into the ~5 MB quota.
const LEGACY_STORAGE_KEYS = ["chess-analyst-workspace-v1", "chess-analyst-reviews-v1"];
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

function loadStoredSnapshot(): OpeningsSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const stored = JSON.parse(raw) as OpeningsSnapshot;
    // The owner is hard-coded; a snapshot saved for any other account is ignored.
    return stored.username?.trim().toLowerCase() === OWNER_USERNAME ? stored : null;
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshotState] = useState<OpeningsSnapshot | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    removeLegacyKeys();
    return loadStoredSnapshot();
  });
  const [bulkJob, setBulkJob] = useState<JobState<OpeningsSnapshot> | null>(null);
  const [reviewCache, setReviewCache] = useState<Record<string, ReviewSummary>>({});
  const [reviewJobs, setReviewJobs] = useState<Record<string, JobState<ReviewSummary> | null>>({});

  const setSnapshot = (nextSnapshot: OpeningsSnapshot | null) => {
    setSnapshotState(nextSnapshot);

    try {
      if (nextSnapshot) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSnapshot));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Keep the in-memory snapshot even if local storage is full or unavailable.
    }
  };

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      snapshot,
      setSnapshot,
      bulkJob,
      setBulkJob,
      reviewCache,
      setReview: (gameId, review) => {
        setReviewCache((current) => ({ ...current, [gameId]: review }));
      },
      reviewJobs,
      setReviewJob: (gameId, job) => {
        setReviewJobs((current) => ({ ...current, [gameId]: job }));
      }
    }),
    [snapshot, bulkJob, reviewCache, reviewJobs]
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
