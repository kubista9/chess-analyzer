import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { config } from "./config.js";
import { HttpError, apiRouter } from "./routes.js";

/** The Express app: the API under /api, plus the built frontend when dist/web exists. */
export function createApp(router: express.Router = apiRouter): express.Express {
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use("/api", router);
  app.use(express.static(config.publicDistDir));

  app.use(async (request, response, next) => {
    try {
      const staticIndex = path.join(config.publicDistDir, "index.html");
      await fs.access(staticIndex);

      if (!request.path.startsWith("/api")) {
        response.sendFile(staticIndex);
        return;
      }
    } catch {
      // Vite serves the frontend in development, so missing build output is fine here.
    }

    next();
  });

  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
    response.status(status).json({
      error: error instanceof z.ZodError ? `Invalid request: ${z.prettifyError(error)}` : error.message
    });
  });

  return app;
}
