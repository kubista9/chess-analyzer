import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config, findRepoRoot, isLoopbackHost } from "./config.js";

describe("config.rootDir", () => {
  it("is the repo root, independent of process.cwd()", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.rootDir, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("chess-analyzer");
    expect(config.cacheDir).toBe(path.join(config.rootDir, "storage", "cache"));
  });

  it("walks up to the nearest package.json", () => {
    expect(findRepoRoot(path.join(config.rootDir, "dist", "server"))).toBe(config.rootDir);
    expect(findRepoRoot(path.join(config.rootDir, "server", "services"))).toBe(config.rootDir);
  });

  it("throws when there is no package.json above", () => {
    expect(() => findRepoRoot(path.parse(config.rootDir).root)).toThrow(/No package.json/);
  });
});

describe("isLoopbackHost", () => {
  it("accepts only loopback names", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});
