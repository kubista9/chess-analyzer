import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { apiRouter } from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", apiRouter);

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
  response.status(500).json({
    error: error.message
  });
});

app.listen(config.port, () => {
  console.log(`Chess Analyst server listening on http://localhost:${config.port}`);
});
