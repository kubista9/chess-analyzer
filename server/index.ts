import { createApp } from "./app.js";
import { config, isLoopbackHost } from "./config.js";
import { getOpeningBook } from "./services/openingBook.js";

createApp().listen(config.port, config.host, () => {
  const displayHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Chess Analyst server listening on http://${displayHost}:${config.port}`);

  if (!isLoopbackHost(config.host)) {
    console.warn(`WARNING: API exposed on LAN; no auth (HOST=${config.host}). Unset HOST to bind to 127.0.0.1 only.`);
  }

  // Index the opening book (about 1 s) now rather than on the first tree request.
  setImmediate(() => getOpeningBook());
});
