import { DEFAULT_SETTINGS, type BoardTheme, type Settings, type SparringLevel } from "../core/training/types";

// Settings read from IndexedDB or a backup may have been written by an older build (fewer keys),
// a newer one (more keys) or by hand. Everything the app reads goes through mergeSettings, which
// keeps exactly the shape of DEFAULT_SETTINGS: a known key with a value of the right type is kept
// (numbers clamped to their range, choices checked against their list), anything else falls back
// to the default, and unknown keys are dropped.

/** An allowed range for a numeric setting. */
export interface NumberRange {
  min: number;
  max: number;
  /** Rounded to a whole number. */
  integer: boolean;
}

/** Piece animation, ms (0 = none). */
export const ANIMATION_MS_RANGE: NumberRange = { min: 0, max: 600, integer: true };
/** Sound volume, a fraction (0 silent, 1 full). */
export const VOLUME_RANGE: NumberRange = { min: 0, max: 1, integer: false };
/** Engine thinking time per check, ms. */
export const ANALYSIS_MS_RANGE: NumberRange = { min: 200, max: 5000, integer: true };
/** New positions introduced per day, positions. */
export const NEW_PER_DAY_RANGE: NumberRange = { min: 0, max: 50, integer: true };
/** Wrong tries before the solution is shown, tries (the minimum is the hint ladder's MIN_REVEAL_AFTER, 3). */
export const REVEAL_AFTER_RANGE: NumberRange = { min: 3, max: 8, integer: true };
/** Pause before the app plays the opponent's reply, ms. */
export const REPLY_DELAY_MS_RANGE: NumberRange = { min: 0, max: 2000, integer: true };

// Records (rather than arrays) so the compiler insists on every member of the union.
const BOARD_THEME_SET: Record<BoardTheme, true> = { green: true, brown: true, blue: true, grey: true };
const SPARRING_LEVEL_SET: Record<SparringLevel, true> = { relaxed: true, club: true, strong: true, best: true };

/** Every board theme, in menu order. */
export const BOARD_THEMES = Object.keys(BOARD_THEME_SET) as BoardTheme[];
/** Every sparring level, from the most forgiving to the strongest. */
export const SPARRING_LEVELS = Object.keys(SPARRING_LEVEL_SET) as SparringLevel[];

/** The range of every numeric setting, by dotted path ("practice.newPerDay"). */
export const SETTING_RANGES: Readonly<Record<string, NumberRange>> = {
  "board.animationMs": ANIMATION_MS_RANGE,
  "sound.volume": VOLUME_RANGE,
  "engine.analysisMs": ANALYSIS_MS_RANGE,
  "practice.newPerDay": NEW_PER_DAY_RANGE,
  "practice.revealAfter": REVEAL_AFTER_RANGE,
  "practice.replyDelayMs": REPLY_DELAY_MS_RANGE
};

/** The allowed values of every choice setting, by dotted path. */
export const SETTING_CHOICES: Readonly<Record<string, readonly string[]>> = {
  "board.theme": BOARD_THEMES,
  "engine.sparringLevel": SPARRING_LEVELS
};

/** `value` limited to the range (and rounded when the range is whole numbers). */
export function clampToRange(value: number, range: NumberRange): number {
  const rounded = range.integer ? Math.round(value) : value;
  return Math.min(range.max, Math.max(range.min, rounded));
}

/** Stored settings merged over the defaults: unknown keys dropped, wrong types replaced, numbers clamped. Never shares objects with the defaults. */
export function mergeSettings(stored: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const merged = mergeSection(defaults as unknown as Record<string, unknown>, stored, "") as unknown as Settings;
  // The format version belongs to the app, not to the stored data: a future format migrates the
  // stored value before it gets here.
  return { ...merged, version: defaults.version };
}

function mergeSection(defaults: Record<string, unknown>, stored: unknown, path: string): Record<string, unknown> {
  const source = isPlainObject(stored) ? stored : {};
  const result: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const fieldPath = path === "" ? key : `${path}.${key}`;
    const value = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
    result[key] = isPlainObject(fallback) ? mergeSection(fallback, value, fieldPath) : mergeValue(fieldPath, fallback, value);
  }
  return result;
}

function mergeValue(path: string, fallback: unknown, value: unknown): unknown {
  if (typeof value !== typeof fallback) {
    return fallback;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    const range = SETTING_RANGES[path];
    return range ? clampToRange(value, range) : value;
  }
  if (typeof value === "string") {
    const choices = SETTING_CHOICES[path];
    return choices && !choices.includes(value) ? fallback : value;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
