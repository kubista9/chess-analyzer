import { defineConfig } from "vitest/config";

// Tests cover pure logic in shared/ and server/ only. src/ is not under a Node tsconfig,
// so src tests would need their own tsconfig.test.web.json first.
export default defineConfig({
  test: {
    environment: "node",
    // The backfill and route tests drive fake engine processes; under a full parallel run on
    // a laptop on battery a 1-2 s test can take over 5 s.
    testTimeout: 20_000,
    include: ["shared/**/*.test.ts", "server/**/*.test.ts"]
  }
});
