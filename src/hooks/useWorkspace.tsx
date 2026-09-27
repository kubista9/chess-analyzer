import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { OpeningsSnapshot, JobState, ReviewSummary } from "../../shared/types";

interface WorkspaceContextValue {
  snapshot: OpeningsSnapshot | null;
  setSnapshot: (snapshot: OpeningsSnapshot | null) => void;
  bulkJob: JobState<OpeningsSnapshot> | null;
  setBulkJob: (job: JobState<OpeningsSnapshot> | null) => void;
  reviewCache: Record<string, ReviewSummary>;
  setReview: (gameId: string, review: ReviewSummary) => void;
  reviewJobs: Record<string, JobState<ReviewSummary> | null>;
  setReviewJob: (gameId: string, job: JobState<ReviewSummary> | null) => void;
}

const STORAGE_KEY = "chess-analyst-workspace-v1";
const REVIEW_STORAGE_KEY = "chess-analyst-reviews-v1";
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function loadStoredSnapshot(): OpeningsSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as OpeningsSnapshot;
  } catch {
    return null;
  }
}

function loadStoredReviews(): Record<string, ReviewSummary> {
  try {
    const raw = window.localStorage.getItem(REVIEW_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw) as Record<string, ReviewSummary>;
  } catch {
    return {};
  }
}

function storeReviews(reviews: Record<string, ReviewSummary>): void {
  try {
    window.localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(reviews));
  } catch {
    // Keep the in-memory cache even if local storage is full or unavailable.
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshotState] = useState<OpeningsSnapshot | null>(() =>
    typeof window === "undefined" ? null : loadStoredSnapshot()
  );
  const [bulkJob, setBulkJob] = useState<JobState<OpeningsSnapshot> | null>(null);
  const [reviewCache, setReviewCache] = useState<Record<string, ReviewSummary>>(() =>
    typeof window === "undefined" ? {} : loadStoredReviews()
  );
  const [reviewJobs, setReviewJobs] = useState<Record<string, JobState<ReviewSummary> | null>>({});

  const setSnapshot = (nextSnapshot: OpeningsSnapshot | null) => {
    setSnapshotState(nextSnapshot);

    if (!nextSnapshot) {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(REVIEW_STORAGE_KEY);
      setReviewCache({});
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSnapshot));
  };

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      snapshot,
      setSnapshot,
      bulkJob,
      setBulkJob,
      reviewCache,
      setReview: (gameId, review) => {
        setReviewCache((current) => {
          const next = { ...current, [gameId]: review };
          storeReviews(next);
          return next;
        });
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
