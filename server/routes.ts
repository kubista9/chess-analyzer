import express from "express";
import { z } from "zod";
import type { DashboardSnapshot, ReviewSummary } from "../shared/types.js";
import { jobStore } from "./store/jobStore.js";
import { runBulkAnalysis } from "./services/batchAnalysis.js";
import { runGameReview } from "./services/reviewAnalysis.js";

const bulkSchema = z.object({
  username: z.string().min(1),
  limit: z.union([z.literal(50), z.literal(100), z.literal(150)])
});

const reviewSchema = z.object({
  username: z.string().min(1),
  gameId: z.string().min(1),
  gameSummary: z.any().optional()
});

export const apiRouter = express.Router();

apiRouter.get("/health", (_request, response) => {
  response.json({ ok: true });
});

apiRouter.post("/bulk-analysis", async (request, response, next) => {
  try {
    const payload = bulkSchema.parse(request.body);
    const job = jobStore.create<DashboardSnapshot>("bulk-analysis", `Queued analysis for ${payload.username}`);

    void (async () => {
      try {
        jobStore.update(job.id, {
          status: "running",
          progress: 2,
          message: `Fetching recent games for ${payload.username}`
        });

        const result = await runBulkAnalysis(payload.username, payload.limit, (progress) => {
          jobStore.update(job.id, {
            status: "running",
            progress: 5 + Math.round((progress.completedGames / progress.totalGames) * 90),
            message: progress.message
          });
        });

        jobStore.update(job.id, {
          status: "completed",
          progress: 100,
          message: `Analysis ready for ${payload.username}`,
          result
        });
      } catch (error) {
        jobStore.update(job.id, {
          status: "failed",
          progress: 100,
          message: "Analysis failed",
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
    const job = jobStore.create<ReviewSummary>("game-review", `Queued deep review for ${payload.gameId}`);

    void (async () => {
      try {
        jobStore.update(job.id, {
          status: "running",
          progress: 10,
          message: "Running deep Stockfish review"
        });

        const result = await runGameReview(
          payload.username,
          payload.gameId,
          (payload.gameSummary as DashboardSnapshot["games"][number] | undefined) ?? null
        );

        jobStore.update(job.id, {
          status: "completed",
          progress: 100,
          message: "Deep review ready",
          result
        });
      } catch (error) {
        jobStore.update(job.id, {
          status: "failed",
          progress: 100,
          message: "Deep review failed",
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
