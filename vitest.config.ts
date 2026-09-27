import { defineConfig } from "vitest/config";

// Tests cover pure logic in shared/ and server/ only. src/ is not under a Node tsconfig,
// so src tests would need their own tsconfig.test.web.json first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["shared/**/*.test.ts", "server/**/*.test.ts"]
  }
});
