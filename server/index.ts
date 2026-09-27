import { createApp } from "./app.js";
import { config, isLoopbackHost } from "./config.js";

createApp().listen(config.port, config.host, () => {
  const displayHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Chess Analyst server listening on http://${displayHost}:${config.port}`);

  if (!isLoopbackHost(config.host)) {
    console.warn(`WARNING: API exposed on LAN; no auth (HOST=${config.host}). Unset HOST to bind to 127.0.0.1 only.`);
  }
});
