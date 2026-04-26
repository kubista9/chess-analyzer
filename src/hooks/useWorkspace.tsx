import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { DashboardSnapshot, JobState, ReviewSummary } from "../../shared/types";

interface WorkspaceContextValue {
  snapshot: DashboardSnapshot | null;
  setSnapshot: (snapshot: DashboardSnapshot | null) => void;
  bulkJob: JobState<DashboardSnapshot> | null;
  setBulkJob: (job: JobState<DashboardSnapshot> | null) => void;
  reviewCache: Record<string, ReviewSummary>;
  setReview: (gameId: string, review: ReviewSummary) => void;
  reviewJobs: Record<string, JobState<ReviewSummary> | null>;
  setReviewJob: (gameId: string, job: JobState<ReviewSummary> | null) => void;
}

const STORAGE_KEY = "chess-analyst-workspace-v1";
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function loadStoredSnapshot(): DashboardSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as DashboardSnapshot;
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshotState] = useState<DashboardSnapshot | null>(() =>
    typeof window === "undefined" ? null : loadStoredSnapshot()
  );
  const [bulkJob, setBulkJob] = useState<JobState<DashboardSnapshot> | null>(null);
  const [reviewCache, setReviewCache] = useState<Record<string, ReviewSummary>>({});
  const [reviewJobs, setReviewJobs] = useState<Record<string, JobState<ReviewSummary> | null>>({});

  const setSnapshot = (nextSnapshot: DashboardSnapshot | null) => {
    setSnapshotState(nextSnapshot);

    if (!nextSnapshot) {
      window.localStorage.removeItem(STORAGE_KEY);
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
