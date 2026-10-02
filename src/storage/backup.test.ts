import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type SrsState } from "../core/training/types";
import { BACKUP_APP, BACKUP_FORMAT, BACKUP_ISSUES_SHOWN, BackupError, backupFileName, parseBackup, type BackupFile } from "./backup";

const NOW = Date.UTC(2026, 9, 2, 12);
const SRS: SrsState = { box: 2, dueAt: NOW, introducedAt: NOW, lapses: 1, streak: 0, reviews: 3, lastReviewAt: NOW };

function backup(): BackupFile {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: NOW,
    settings: DEFAULT_SETTINGS,
    lineStates: [{ lineId: "eng-a", enabled: true, status: "reviewing", statusSetAt: NOW, updatedAt: NOW }],
    positionProgress: [
      {
        key: "white|epd-a",
        side: "white",
        epd: "epd-a",
        attempts: 3,
        clean: 2,
        incorrect: 1,
        wrongTries: 1,
        hintsUsed: 1,
        reveals: 0,
        firstSeenAt: NOW,
        lastPracticedAt: NOW,
        lastResult: "hinted",
        recent: ["clean", "clean", "hinted"],
        mastery: 0.7,
        srs: SRS,
        weakMoves: [{ san: "e4", count: 1, lastAt: NOW }]
      }
    ],
    lineProgress: [
      {
        lineId: "eng-a",
        runs: 2,
        cleanRuns: 1,
        movesPlayed: 12,
        movesClean: 11,
        wrongTries: 1,
        hintsUsed: 0,
        reveals: 0,
        recallAttempts: 1,
        recallCorrect: 1,
        lastPracticedAt: null,
        lastResult: null,
        srs: { box: 0, dueAt: null, introducedAt: null, lapses: 0, streak: 0, reviews: 0, lastReviewAt: null }
      }
    ],
    attempts: [
      {
        id: 1,
        at: NOW,
        day: "2026-10-02",
        mode: "next-move",
        side: "white",
        lineId: "eng-a",
        posKey: "white|epd-a",
        epd: "epd-a",
        expected: ["c4"],
        tries: [
          { san: "e4", verdict: "unverified" },
          { san: "c4", verdict: "book" }
        ],
        hintsShown: 1,
        revealed: false,
        result: "retried",
        durationMs: 4000
      },
      {
        id: 2,
        at: NOW + 1,
        day: "2026-10-02",
        mode: "recall",
        side: "black",
        lineId: "fr-a",
        posKey: null,
        epd: null,
        expected: ["French Defence"],
        tries: [],
        hintsShown: 0,
        revealed: false,
        result: "clean",
        durationMs: null
      }
    ],
    customLines: [
      {
        id: "custom-1",
        side: "black",
        chapter: "My lines",
        family: "English Opening",
        name: "Reversed Sicilian",
        eco: null,
        moves: "1.c4 e5",
        description: "",
        plans: [],
        createdAt: NOW,
        updatedAt: NOW
      }
    ]
  };
}

type StoreName = "lineStates" | "positionProgress" | "lineProgress" | "attempts" | "customLines";

/** A backup whose first record of `store` has `patch` applied. */
function patched(store: StoreName, patch: Record<string, unknown>): unknown {
  const file = backup();
  return { ...file, [store]: [{ ...file[store][0], ...patch }] };
}

function rejection(input: unknown): BackupError {
  try {
    parseBackup(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    return error as BackupError;
  }
  throw new Error("expected parseBackup to throw");
}

describe("parseBackup", () => {
  it("accepts a valid backup unchanged", () => {
    expect(parseBackup(backup())).toEqual(backup());
  });

  it("accepts the file's JSON text", () => {
    expect(parseBackup(JSON.stringify(backup()))).toEqual(backup());
  });

  it("drops unknown keys", () => {
    const file = backup();
    const extended = {
      ...file,
      comment: "made on my laptop",
      lineStates: [{ ...file.lineStates[0], colour: "red" }],
      positionProgress: [{ ...file.positionProgress[0], srs: { ...SRS, ease: 2.5 } }]
    };
    expect(parseBackup(extended)).toEqual(file);
  });

  it("normalises settings instead of rejecting them", () => {
    const file = { ...backup(), settings: { board: { theme: "brown", animationMs: 9999 }, sound: { volume: "loud" }, extra: 1 } };
    expect(parseBackup(file).settings).toEqual({
      ...DEFAULT_SETTINGS,
      board: { ...DEFAULT_SETTINGS.board, theme: "brown", animationMs: 600 }
    });
    expect(parseBackup({ ...backup(), settings: {} }).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts empty stores and attempts without an id", () => {
    const file = backup();
    const { id: _id, ...anonymous } = file.attempts[0];
    const minimal = { ...file, lineStates: [], positionProgress: [], lineProgress: [], customLines: [], attempts: [anonymous, anonymous] };
    expect(parseBackup(minimal).attempts).toEqual([anonymous, anonymous]);
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["an array", [backup()]],
    ["an object without the app", { ...backup(), app: undefined }],
    ["another app's file", { ...backup(), app: "chess-analyzer" }],
    ["a JSON array as text", "[1, 2]"]
  ])("rejects %s as not a backup", (_label, input) => {
    const error = rejection(input);
    expect(error.message).toBe("This file is not a backup of the opening trainer.");
    expect(error.issues).toEqual([]);
    expect(error.name).toBe("BackupError");
  });

  it("rejects text that is not JSON", () => {
    expect(rejection("{ app: opening-trainer").message).toBe("This file is not a backup of the opening trainer: it is not valid JSON.");
    expect(rejection("").message).toMatch(/not valid JSON/);
  });

  it("asks for an update when the backup is from a newer format", () => {
    expect(rejection({ ...backup(), format: BACKUP_FORMAT + 1 }).message).toBe(
      `This backup was made by a newer version of the app (format ${BACKUP_FORMAT + 1}). Update the app, then import it again.`
    );
  });

  it.each([0, "1", "2", null, undefined])("rejects the unknown format %j", (format) => {
    expect(rejection({ ...backup(), format }).message).toBe("This backup has a format this app does not know, so it cannot be imported.");
  });

  it("names the damaged field", () => {
    const file = backup();
    const error = rejection({ ...file, positionProgress: [{ ...file.positionProgress[0], srs: { ...SRS, box: "two" } }] });
    expect(error.message).toBe(
      "This backup is damaged or incomplete, so it cannot be imported: positionProgress[0].srs.box: expected number, received string."
    );
    expect(error.issues).toEqual(["positionProgress[0].srs.box: expected number, received string"]);
  });

  it("names a missing store and a missing header field", () => {
    const { customLines: _customLines, exportedAt: _exportedAt, ...rest } = backup();
    const error = rejection(rest);
    expect(error.issues).toEqual(["exportedAt: expected number, received undefined", "customLines: expected array, received undefined"]);
  });

  it("quotes the first problems and counts the rest", () => {
    const file = backup();
    const broken = Array.from({ length: BACKUP_ISSUES_SHOWN + 2 }, (_, index) => ({ ...file.lineStates[0], lineId: `l-${index}`, enabled: "yes" }));
    const error = rejection({ ...file, lineStates: broken });
    expect(error.issues).toHaveLength(BACKUP_ISSUES_SHOWN + 2);
    const quoted = /lineStates\[0\]\.enabled: .*; lineStates\[1\]\.enabled: .*; lineStates\[2\]\.enabled: .* \(and 2 more\)\.$/;
    expect(error.message).toMatch(quoted);
  });

  it.each([
    ["a negative count", patched("lineProgress", { runs: -1 }), "lineProgress[0].runs"],
    ["a fractional count", patched("positionProgress", { attempts: 1.5 }), "positionProgress[0].attempts"],
    ["mastery above 1", patched("positionProgress", { mastery: 1.2 }), "positionProgress[0].mastery"],
    ["an unknown result", patched("positionProgress", { recent: ["great"] }), "positionProgress[0].recent[0]"],
    ["an unknown side", patched("customLines", { side: "both" }), "customLines[0].side"],
    ["an unknown verdict", patched("attempts", { tries: [{ san: "c4", verdict: "brilliant" }] }), "attempts[0].tries[0].verdict"],
    ["an unknown mode", patched("attempts", { mode: "blitz" }), "attempts[0].mode"],
    ["three hints", patched("attempts", { hintsShown: 3 }), "attempts[0].hintsShown"],
    ["a malformed day", patched("attempts", { day: "2/10/2026" }), "attempts[0].day"],
    ["an attempt id of 0", patched("attempts", { id: 0 }), "attempts[0].id"],
    ["an unknown line status", patched("lineStates", { status: "done" }), "lineStates[0].status"],
    ["an empty line id", patched("lineProgress", { lineId: "" }), "lineProgress[0].lineId"],
    ["settings that are not an object", { ...backup(), settings: [] }, "settings"],
    ["a store that is not a list", { ...backup(), attempts: { 1: backup().attempts[0] } }, "attempts"]
  ])("rejects %s", (_label, input, path) => {
    const error = rejection(input);
    expect(error.issues.map((issue) => issue.slice(0, issue.indexOf(": ")))).toContain(path);
  });

  it("rejects a progress key that does not match its side and position", () => {
    const file = backup();
    const error = rejection({ ...file, positionProgress: [{ ...file.positionProgress[0], side: "black" }] });
    expect(error.issues).toEqual(["positionProgress[0].key: the key does not match the side and position"]);
  });

  it.each([
    ["lineStates", 'lineStates[1]: the key "eng-a" appears more than once'],
    ["positionProgress", 'positionProgress[1]: the key "white|epd-a" appears more than once'],
    ["lineProgress", 'lineProgress[1]: the key "eng-a" appears more than once'],
    ["attempts", "attempts[1]: the key 1 appears more than once"],
    ["customLines", 'customLines[1]: the key "custom-1" appears more than once']
  ] as const)("rejects duplicate keys in %s", (store, issue) => {
    const file = backup();
    // The second copy differs in a field, so only the key makes it a duplicate.
    const copy = store === "attempts" ? { ...file.attempts[0], at: NOW + 5 } : { ...file[store][0] };
    expect(rejection({ ...file, [store]: [file[store][0], copy] }).issues).toEqual([issue]);
  });

  it("is a readable Error", () => {
    const error = new BackupError("Broken.", ["a: b"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BackupError");
    expect(error.message).toBe("Broken.");
    expect(error.issues).toEqual(["a: b"]);
    expect(new BackupError("No issues.").issues).toEqual([]);
  });
});

describe("backupFileName", () => {
  it("names the file after the local day", () => {
    expect(backupFileName(new Date(2026, 9, 2, 12).getTime())).toBe("opening-trainer-backup-2026-10-02.json");
    expect(backupFileName(new Date(2027, 0, 9, 0, 0, 1).getTime())).toBe("opening-trainer-backup-2027-01-09.json");
    expect(backupFileName(new Date(2026, 11, 31, 23, 59).getTime())).toBe("opening-trainer-backup-2026-12-31.json");
  });
});
