import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../core/training/types";
import {
  ANALYSIS_MS_RANGE,
  ANIMATION_MS_RANGE,
  BOARD_THEMES,
  NEW_PER_DAY_RANGE,
  REPLY_DELAY_MS_RANGE,
  REVEAL_AFTER_RANGE,
  SETTING_CHOICES,
  SETTING_RANGES,
  SPARRING_LEVELS,
  VOLUME_RANGE,
  clampToRange,
  mergeSettings,
  type NumberRange
} from "./settings";

const CUSTOM: Settings = {
  version: 1,
  board: { theme: "blue", coordinates: false, legalMoveDots: false, highlightLastMove: false, animationMs: 0 },
  sound: { enabled: false, volume: 0.25 },
  engine: { enabled: false, analysisMs: 1500, sparringLevel: "strong" },
  practice: { newPerDay: 0, revealAfter: 5, replyDelayMs: 0 }
};

/** Every leaf of a settings object as [dotted path, value]. */
function leaves(value: unknown, path = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) {
    return [[path, value]];
  }
  return Object.entries(value).flatMap(([key, child]) => leaves(child, path === "" ? key : `${path}.${key}`));
}

function withPath(path: string, value: unknown): Record<string, unknown> {
  const [section, key] = path.split(".");
  return { [section]: { [key]: value } };
}

describe("mergeSettings", () => {
  it.each([undefined, null, 42, "settings", true, [], [1, 2]])("returns the defaults for %j", (stored) => {
    expect(mergeSettings(stored)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a fresh copy that shares no object with the defaults", () => {
    const merged = mergeSettings(undefined);
    expect(merged).not.toBe(DEFAULT_SETTINGS);
    for (const section of ["board", "sound", "engine", "practice"] as const) {
      expect(merged[section]).not.toBe(DEFAULT_SETTINGS[section]);
    }
    merged.board.theme = "grey";
    merged.practice.newPerDay = 1;
    expect(DEFAULT_SETTINGS.board.theme).toBe("green");
    expect(DEFAULT_SETTINGS.practice.newPerDay).toBe(10);
  });

  it("keeps complete valid settings unchanged", () => {
    expect(mergeSettings(CUSTOM)).toEqual(CUSTOM);
    expect(mergeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("fills missing sections and keys from the defaults", () => {
    const merged = mergeSettings({ board: { theme: "brown" }, practice: { newPerDay: 3 } });
    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      board: { ...DEFAULT_SETTINGS.board, theme: "brown" },
      practice: { ...DEFAULT_SETTINGS.practice, newPerDay: 3 }
    });
  });

  it("drops unknown keys at every level", () => {
    const merged = mergeSettings({ ...CUSTOM, theme: "dark", extra: { a: 1 }, board: { ...CUSTOM.board, pieces: "alpha" } });
    expect(merged).toEqual(CUSTOM);
    expect(Object.keys(merged)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect(Object.keys(merged.board)).toEqual(Object.keys(DEFAULT_SETTINGS.board));
  });

  it("does not pick up keys inherited from the prototype", () => {
    const stored = Object.create({ sound: { enabled: false, volume: 0 } }) as Record<string, unknown>;
    expect(mergeSettings(stored)).toEqual(DEFAULT_SETTINGS);
  });

  it("replaces values of the wrong type with the default, field by field", () => {
    const merged = mergeSettings({
      board: { theme: 3, coordinates: "no", legalMoveDots: 0, highlightLastMove: null, animationMs: "300" },
      sound: { enabled: "true", volume: true },
      engine: { enabled: false, analysisMs: { ms: 900 }, sparringLevel: ["club"] },
      practice: { newPerDay: 7, revealAfter: undefined, replyDelayMs: [] }
    });
    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      engine: { ...DEFAULT_SETTINGS.engine, enabled: false },
      practice: { ...DEFAULT_SETTINGS.practice, newPerDay: 7 }
    });
  });

  it("replaces a section that is not an object with the default section", () => {
    const merged = mergeSettings({ board: "green", sound: null, engine: [true], practice: 5 });
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps known choices and rejects unknown ones", () => {
    for (const theme of BOARD_THEMES) {
      expect(mergeSettings({ board: { theme } }).board.theme).toBe(theme);
    }
    for (const level of SPARRING_LEVELS) {
      expect(mergeSettings({ engine: { sparringLevel: level } }).engine.sparringLevel).toBe(level);
    }
    expect(mergeSettings({ board: { theme: "purple" } }).board.theme).toBe("green");
    expect(mergeSettings({ board: { theme: "Green" } }).board.theme).toBe("green");
    expect(mergeSettings({ engine: { sparringLevel: "grandmaster" } }).engine.sparringLevel).toBe("club");
  });

  const ranges: [string, NumberRange][] = [
    ["board.animationMs", ANIMATION_MS_RANGE],
    ["sound.volume", VOLUME_RANGE],
    ["engine.analysisMs", ANALYSIS_MS_RANGE],
    ["practice.newPerDay", NEW_PER_DAY_RANGE],
    ["practice.revealAfter", REVEAL_AFTER_RANGE],
    ["practice.replyDelayMs", REPLY_DELAY_MS_RANGE]
  ];

  it.each(ranges)("clamps %s to its range", (path, range) => {
    const read = (value: unknown) => leaves(mergeSettings(withPath(path, value))).find(([leaf]) => leaf === path)?.[1];
    expect(read(range.min - 1)).toBe(range.min);
    expect(read(range.min - 1_000_000)).toBe(range.min);
    expect(read(range.max + 1)).toBe(range.max);
    expect(read(range.max * 1000)).toBe(range.max);
    expect(read(range.min)).toBe(range.min);
    expect(read(range.max)).toBe(range.max);
  });

  it("uses the documented limits", () => {
    expect(VOLUME_RANGE).toMatchObject({ min: 0, max: 1 });
    expect(ANALYSIS_MS_RANGE).toMatchObject({ min: 200, max: 5000 });
    expect(NEW_PER_DAY_RANGE).toMatchObject({ min: 0, max: 50 });
    expect(REVEAL_AFTER_RANGE).toMatchObject({ min: 3, max: 8 });
    expect(REPLY_DELAY_MS_RANGE).toMatchObject({ min: 0, max: 2000 });
    expect(ANIMATION_MS_RANGE).toMatchObject({ min: 0, max: 600 });
  });

  it("rounds whole-number settings and keeps the volume fractional", () => {
    const merged = mergeSettings({
      board: { animationMs: 149.6 },
      sound: { volume: 0.333 },
      engine: { analysisMs: 1234.4 },
      practice: { newPerDay: 4.5, revealAfter: 3.4, replyDelayMs: 99.5 }
    });
    expect(merged.board.animationMs).toBe(150);
    expect(merged.sound.volume).toBe(0.333);
    expect(merged.engine.analysisMs).toBe(1234);
    expect(merged.practice).toEqual({ newPerDay: 5, revealAfter: 3, replyDelayMs: 100 });
  });

  it("treats NaN and infinite numbers as missing", () => {
    const merged = mergeSettings({ sound: { volume: Number.NaN }, practice: { newPerDay: Infinity, revealAfter: -Infinity } });
    expect(merged.sound.volume).toBe(DEFAULT_SETTINGS.sound.volume);
    expect(merged.practice.newPerDay).toBe(DEFAULT_SETTINGS.practice.newPerDay);
    expect(merged.practice.revealAfter).toBe(DEFAULT_SETTINGS.practice.revealAfter);
  });

  it("always reports this app's settings version", () => {
    expect(mergeSettings({ version: 7 }).version).toBe(1);
    expect(mergeSettings({ version: "1" }).version).toBe(1);
    expect(mergeSettings({ ...CUSTOM, version: 0 })).toEqual(CUSTOM);
  });

  it("is idempotent", () => {
    const messy = { board: { theme: "nope", animationMs: 9000 }, sound: { volume: -2 }, junk: true };
    const once = mergeSettings(messy);
    expect(mergeSettings(once)).toEqual(once);
  });

  it("merges over other defaults when given", () => {
    const defaults: Settings = { ...CUSTOM, practice: { ...CUSTOM.practice, newPerDay: 20 } };
    expect(mergeSettings({ board: { theme: "grey" } }, defaults)).toEqual({ ...defaults, board: { ...defaults.board, theme: "grey" } });
  });

  it("has a range for every numeric setting and a list for every choice, each containing the default", () => {
    for (const [path, value] of leaves(DEFAULT_SETTINGS)) {
      if (path === "version") {
        continue;
      }
      if (typeof value === "number") {
        const range = SETTING_RANGES[path];
        expect(range, path).toBeDefined();
        expect(clampToRange(value, range)).toBe(value);
      }
      if (typeof value === "string") {
        expect(SETTING_CHOICES[path], path).toContain(value);
      }
    }
    const leafPaths = leaves(DEFAULT_SETTINGS).map(([path]) => path);
    for (const path of [...Object.keys(SETTING_RANGES), ...Object.keys(SETTING_CHOICES)]) {
      expect(leafPaths, path).toContain(path);
    }
  });
});

describe("clampToRange", () => {
  it("clamps and rounds by the range", () => {
    expect(clampToRange(-5, NEW_PER_DAY_RANGE)).toBe(0);
    expect(clampToRange(12.5, NEW_PER_DAY_RANGE)).toBe(13);
    expect(clampToRange(51, NEW_PER_DAY_RANGE)).toBe(50);
    expect(clampToRange(0.42, VOLUME_RANGE)).toBe(0.42);
    expect(clampToRange(1.01, VOLUME_RANGE)).toBe(1);
  });

  it("lists every theme and level once", () => {
    expect(BOARD_THEMES).toEqual(["green", "brown", "blue", "grey"]);
    expect(SPARRING_LEVELS).toEqual(["relaxed", "club", "strong", "best"]);
  });
});
