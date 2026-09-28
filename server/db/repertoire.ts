import type { RepEntry, RepReplaced, RepSource, RepStatus } from "../../shared/repertoire.js";
import type { SeedChange } from "../../shared/repertoireSeed.js";
import type { PlayerColor } from "../../shared/types.js";
import type { Db } from "./connection.js";

// repertoire_entries: the owner's repertoire, one row per (colour, owner-to-move EPD).

interface Row {
  color: PlayerColor;
  epd: string;
  uci: string;
  san: string;
  source: RepSource;
  status: RepStatus;
  locked: number;
  replaced_json: string | null;
  reason: string | null;
  note: string | null;
  ply: number;
  updated_at: number;
}

function fromRow(row: Row): RepEntry {
  return {
    color: row.color,
    epd: row.epd,
    uci: row.uci,
    san: row.san,
    source: row.source,
    status: row.status,
    locked: row.locked === 1,
    replaced: row.replaced_json ? (JSON.parse(row.replaced_json) as RepReplaced) : null,
    reason: row.reason,
    note: row.note,
    ply: row.ply,
    updatedAt: row.updated_at
  };
}

const COLUMNS = "color, epd, uci, san, source, status, locked, replaced_json, reason, note, ply, updated_at";

/** Every entry of the owner (both colours), by colour, ply and EPD. */
export function listRepertoire(db: Db, username: string, color?: PlayerColor): RepEntry[] {
  const rows = (
    color
      ? db.prepare(`SELECT ${COLUMNS} FROM repertoire_entries WHERE username = ? AND color = ? ORDER BY color, ply, epd`).all(username, color)
      : db.prepare(`SELECT ${COLUMNS} FROM repertoire_entries WHERE username = ? ORDER BY color, ply, epd`).all(username)
  ) as Row[];
  return rows.map(fromRow);
}

export function getRepEntry(db: Db, username: string, color: PlayerColor, epd: string): RepEntry | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM repertoire_entries WHERE username = ? AND color = ? AND epd = ?`).get(username, color, epd) as
    | Row
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function upsertRepEntry(db: Db, username: string, entry: RepEntry): void {
  db.prepare(
    `INSERT INTO repertoire_entries (username, ${COLUMNS})
     VALUES (@username, @color, @epd, @uci, @san, @source, @status, @locked, @replacedJson, @reason, @note, @ply, @updatedAt)
     ON CONFLICT (username, color, epd) DO UPDATE SET
       uci = excluded.uci, san = excluded.san, source = excluded.source, status = excluded.status,
       locked = excluded.locked, replaced_json = excluded.replaced_json, reason = excluded.reason,
       note = excluded.note, ply = excluded.ply, updated_at = excluded.updated_at`
  ).run({
    username,
    color: entry.color,
    epd: entry.epd,
    uci: entry.uci,
    san: entry.san,
    source: entry.source,
    status: entry.status,
    locked: entry.locked ? 1 : 0,
    replacedJson: entry.replaced ? JSON.stringify(entry.replaced) : null,
    reason: entry.reason,
    note: entry.note,
    ply: entry.ply,
    updatedAt: entry.updatedAt
  });
}

export function deleteRepEntry(db: Db, username: string, color: PlayerColor, epd: string): boolean {
  return db.prepare("DELETE FROM repertoire_entries WHERE username = ? AND color = ? AND epd = ?").run(username, color, epd).changes > 0;
}

/**
 * Applies a seed diff in one transaction. A seeded entry keeps the current row's note and lock
 * flag (protected rows never appear in a diff).
 */
export function applySeedChanges(db: Db, username: string, changes: readonly SeedChange[], now: number): void {
  db.transaction(() => {
    for (const change of changes) {
      if (change.kind === "remove") {
        deleteRepEntry(db, username, change.color, change.epd);
        continue;
      }
      const after = change.after!;
      const current = getRepEntry(db, username, change.color, change.epd);
      upsertRepEntry(db, username, { ...after, locked: current?.locked ?? false, note: current?.note ?? null, updatedAt: now });
    }
  })();
}

/** Changes whenever an entry is written or removed (count and the sum of the update times). */
export function repertoireStamp(db: Db, username: string): string {
  const row = db.prepare("SELECT COUNT(*) AS n, TOTAL(updated_at) AS at FROM repertoire_entries WHERE username = ?").get(username) as {
    n: number;
    at: number;
  };
  return `${row.n}:${row.at}`;
}
