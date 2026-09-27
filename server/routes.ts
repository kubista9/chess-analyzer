import express from "express";
import { z } from "zod";
import { BULK_ANALYSIS_LIMITS } from "../shared/constants.js";
import type { OpeningsSnapshot, ReviewSummary } from "../shared/types.js";
import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { jobStore } from "./store/jobStore.js";
import { syncOnce } from "./services/archiveImport.js";
import { buildImportStatus } from "./services/importStatus.js";
import { runBulkAnalysis } from "./services/batchAnalysis.js";
import { readCachedGameReview, runGameReview } from "./services/reviewAnalysis.js";

const bulkSchema = z.object({
  limit: z.literal(BULK_ANALYSIS_LIMITS)
});

const reviewSchema = z.object({
  gameId: z.string().min(1)
});

const syncSchema = z.object({
  full: z.boolean().optional()
});

export const apiRouter = express.Router();

apiRouter.get("/health", (_request, response) => {
  response.json({ ok: true });
});

// The SQLite game store (P2a). The legacy pages still use /bulk-analysis until P2b.
apiRouter.get("/status", (_request, response, next) => {
  try {
    response.json(buildImportStatus(getDb(), config.owner));
  } catch (error) {
    next(error);
  }
});

// Runs the archive sync and answers with its summary. A second request while one is
// running joins it. {full: true} also revalidates closed months.
apiRouter.post("/sync", async (request, response, next) => {
  try {
    const payload = syncSchema.parse(request.body ?? {});
    const summary = await syncOnce(getDb(), config.owner, { full: payload.full });
    response.json({ summary, status: buildImportStatus(getDb(), config.owner) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/bulk-analysis", async (request, response, next) => {
  try {
    const payload = bulkSchema.parse(request.body);
    const job = jobStore.create<OpeningsSnapshot>("bulk-analysis", `Queued game sync for ${config.owner}`);

    void (async () => {
      try {
        jobStore.update(job.id, {
          status: "running",
          progress: 2,
          message: `Fetching recent games for ${config.owner}`
        });

        const result = await runBulkAnalysis(payload.limit, (progress) => {
          const analysisProgress =
            progress.totalGames > 0 ? Math.round((progress.completedGames / progress.totalGames) * 90) : 90;

          jobStore.update(job.id, {
            status: "running",
            progress: 5 + analysisProgress,
            message: progress.message
          });
        });

        jobStore.update(job.id, {
          status: "completed",
          progress: 100,
          message: `Games ready for ${config.owner}`,
          result
        });
      } catch (error) {
        jobStore.update(job.id, {
          status: "failed",
          progress: 100,
          message: "Loading games failed",
          error: error instanceof Error ? error.message : "Unknown analysis error"
        });
      }
    })();

    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/game-review", async (request, response, next) => {
  try {
    const payload = reviewSchema.parse(request.body);
    const job = jobStore.create<ReviewSummary>("game-review", `Queued opening review for ${payload.gameId}`);
    const cachedReview = await readCachedGameReview(payload.gameId);

    if (cachedReview) {
      const completedJob = jobStore.update<ReviewSummary>(job.id, {
        status: "completed",
        progress: 100,
        message: "Opening review ready",
        result: cachedReview
      });
      response.json(completedJob);
      return;
    }

    void (async () => {
      try {
        jobStore.update(job.id, {
          status: "running",
          progress: 10,
          message: "Running the Stockfish opening review"
        });

        const result = await runGameReview(payload.gameId);

        jobStore.update(job.id, {
          status: "completed",
          progress: 100,
          message: "Opening review ready",
          result
        });
      } catch (error) {
        jobStore.update(job.id, {
          status: "failed",
          progress: 100,
          message: "Opening review failed",
          error: error instanceof Error ? error.message : "Unknown review error"
        });
      }
    })();

    response.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/jobs/:jobId", (request, response, next) => {
  try {
    response.json(jobStore.get(request.params.jobId));
  } catch (error) {
    next(error);
  }
});
