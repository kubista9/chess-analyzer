import { defineConfig } from "vitest/config";

// Logic tests run in Node: the core modules are pure, and the IndexedDB store runs against
// fake-indexeddb (set up per test file with `import "fake-indexeddb/auto"`).
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]
  }
});
