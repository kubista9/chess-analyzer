import cors from "cors";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { config, isLoopbackHost } from "./config.js";
import { apiRouter } from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", apiRouter);
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
  response.status(500).json({
    error: error.message
  });
});

app.listen(config.port, config.host, () => {
  const displayHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Chess Analyst server listening on http://${displayHost}:${config.port}`);

  if (!isLoopbackHost(config.host)) {
    console.warn(`WARNING: API exposed on LAN; no auth (HOST=${config.host}). Unset HOST to bind to 127.0.0.1 only.`);
  }
});
