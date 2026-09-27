import type { Db } from "./connection.js";

// Numbered, append-only migrations. Each phase adds new entries at the end and never
// edits an applied one; schema_migrations records what a database has seen.
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "archive months, games, opening plies, sync runs",
    sql: `
      CREATE TABLE archive_months (
        username      TEXT    NOT NULL,
        month         TEXT    NOT NULL,           -- 'YYYY-MM' from the archive URL
        url           TEXT    NOT NULL,
        etag          TEXT,
        last_modified TEXT,                       -- kept for reference; not RFC, never sent
        fetched_at    INTEGER NOT NULL,           -- ms, last 200
        checked_at    INTEGER NOT NULL,           -- ms, last 200 or 304
        last_status   INTEGER NOT NULL,
        game_count    INTEGER NOT NULL,           -- raw archive length
        raw_json      TEXT    NOT NULL,           -- the raw month response body
        derive_version INTEGER,                   -- NULL until derived
        kept_count    INTEGER,
        skipped_json  TEXT,
        PRIMARY KEY (username, month)
      );

      CREATE TABLE games (
        id             TEXT PRIMARY KEY,
        uuid           TEXT,
        username       TEXT    NOT NULL,
        source         TEXT    NOT NULL,          -- 'archive' | 'raw-games-seed'
        url            TEXT    NOT NULL,
        month          TEXT    NOT NULL,
        end_time       INTEGER NOT NULL,          -- Unix seconds, UTC
        time_class     TEXT    NOT NULL,
        time_control   TEXT    NOT NULL,
        tc_base        INTEGER,
        tc_inc         INTEGER,
        rated          INTEGER NOT NULL,
        color          TEXT    NOT NULL,
        result         TEXT    NOT NULL,          -- 'win' | 'draw' | 'loss'
        result_code    TEXT    NOT NULL,
        score          REAL    NOT NULL,
        my_rating      INTEGER NOT NULL,
        opp_rating     INTEGER NOT NULL,
        opp_name       TEXT    NOT NULL,
        eco            TEXT,
        eco_url        TEXT,
        opening_name   TEXT    NOT NULL,
        termination    TEXT,
        ply_count      INTEGER NOT NULL,
        pgn            TEXT    NOT NULL,
        derive_version INTEGER NOT NULL
      );
      CREATE INDEX games_end_time ON games (username, end_time);
      CREATE INDEX games_time_class ON games (time_class);
      CREATE INDEX games_color ON games (color);
      CREATE INDEX games_month ON games (username, month);

      CREATE TABLE game_plies (
        game_id    TEXT    NOT NULL REFERENCES games (id) ON DELETE CASCADE,
        ply        INTEGER NOT NULL,
        san        TEXT    NOT NULL,
        uci        TEXT    NOT NULL,
        epd_before TEXT    NOT NULL,
        epd_after  TEXT    NOT NULL,
        clock_ms   INTEGER,
        spent_ms   INTEGER,
        PRIMARY KEY (game_id, ply)
      ) WITHOUT ROWID;
      CREATE INDEX game_plies_epd_before ON game_plies (epd_before);

      CREATE TABLE sync_runs (
        id           INTEGER PRIMARY KEY,
        username     TEXT    NOT NULL,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        ok           INTEGER,
        summary_json TEXT
      );
    `
  },
  {
    version: 2,
    name: "engine configs, position evals, game analysis",
    sql: `
      -- One row per (engine version, search protocol). A new engine binary or protocol gives a
      -- new row, so results are never mixed across configs and old rows are kept.
      CREATE TABLE engine_configs (
        id             INTEGER PRIMARY KEY,
        engine_name    TEXT    NOT NULL,          -- from UCI "id name", e.g. 'Stockfish'
        engine_version TEXT    NOT NULL,          -- e.g. '18'
        protocol_json  TEXT    NOT NULL,          -- canonical JSON (sorted keys)
        opening_plies  INTEGER NOT NULL,          -- the opening window when the config was created
        created_at     INTEGER NOT NULL,
        UNIQUE (engine_version, protocol_json)
      );

      -- Engine results per position (EPD) and tier. lines_json holds
      -- {"lines": EngineLine[], "scored": EngineLine[], "terminal": ...}.
      CREATE TABLE positions (
        epd         TEXT    NOT NULL,
        config_id   INTEGER NOT NULL REFERENCES engine_configs (id),
        tier        TEXT    NOT NULL,             -- 'owner' | 'opponent'
        cp          INTEGER,                      -- side to move, rank-1 line (NULL with mate)
        mate        INTEGER,
        best_uci    TEXT,                         -- NULL for a terminal position
        lines_json  TEXT    NOT NULL,
        depth       INTEGER NOT NULL,
        nodes       INTEGER NOT NULL,
        analyzed_at INTEGER NOT NULL,
        PRIMARY KEY (epd, config_id, tier)
      ) WITHOUT ROWID;

      -- "This game is fully analysed (to plies) under this config." No foreign key to games:
      -- a month re-derive deletes and re-inserts its games, and must not drop these rows.
      CREATE TABLE game_analysis (
        game_id      TEXT    NOT NULL,
        config_id    INTEGER NOT NULL REFERENCES engine_configs (id),
        plies        INTEGER NOT NULL,            -- opening plies covered
        analyzed_at  INTEGER NOT NULL,
        summary_json TEXT    NOT NULL,
        PRIMARY KEY (game_id, config_id)
      ) WITHOUT ROWID;
      CREATE INDEX game_analysis_config ON game_analysis (config_id);
    `
  }
];

export function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version)
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const ran: number[] = [];

  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    })();
    ran.push(migration.version);
  }

  return ran;
}
