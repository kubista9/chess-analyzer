import { describe, expect, it } from "vitest";
import { GAME_WINDOWS, WINDOW_DAYS, endOfUtcDay, isInWindow, parseGameWindow, windowBounds } from "./window.js";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("endOfUtcDay", () => {
  it("is the last second of the UTC day", () => {
    expect(endOfUtcDay("2026-09-26")).toBe(at("2026-09-26T23:59:59Z"));
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => endOfUtcDay("2026-9-26")).toThrow();
    expect(() => endOfUtcDay("26.09.2026")).toThrow();
    expect(() => endOfUtcDay("2026-02-30")).toThrow();
    expect(() => endOfUtcDay("")).toThrow();
  });
});

describe("windowBounds / isInWindow", () => {
  const bounds = windowBounds(endOfUtcDay("2026-09-26"));

  it("defaults to a 183-day window", () => {
    expect(WINDOW_DAYS).toBe(183);
    expect(bounds.end - bounds.start).toBe(183 * 86_400);
    expect(bounds.start).toBe(at("2026-03-27T23:59:59Z"));
  });

  it("includes both ends and nothing outside them", () => {
    expect(isInWindow(at("2026-09-26T23:59:59Z"), bounds)).toBe(true);
    expect(isInWindow(at("2026-09-26T00:00:00Z"), bounds)).toBe(true);
    expect(isInWindow(at("2026-09-27T00:00:00Z"), bounds)).toBe(false);
    expect(isInWindow(bounds.start, bounds)).toBe(true);
    expect(isInWindow(bounds.start - 1, bounds)).toBe(false);
  });

  it("supports a shorter window", () => {
    const short = windowBounds(bounds.end, 90);
    expect(short.end - short.start).toBe(90 * 86_400);
  });
});

describe("parseGameWindow", () => {
  it("defaults to 6 months and accepts 3 months", () => {
    expect(parseGameWindow(undefined)).toBe("6m");
    expect(parseGameWindow("")).toBe("6m");
    expect(parseGameWindow("3m")).toBe("3m");
    expect(GAME_WINDOWS).toEqual({ "6m": WINDOW_DAYS, "3m": 90 });
  });

  it("rejects anything else", () => {
    expect(parseGameWindow("12m")).toBeNull();
    expect(parseGameWindow("toString")).toBeNull();
    expect(parseGameWindow(["6m"])).toBeNull();
  });
});
