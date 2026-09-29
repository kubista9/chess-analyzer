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
  },
  {
    version: 3,
    name: "backfill runs",
    sql: `
      -- One row per backfill run (CLI or server): what it did and the throughput it measured,
      -- so the next --dry-run and the Home estimate use this machine's real speed.
      CREATE TABLE backfill_runs (
        id                 INTEGER PRIMARY KEY,
        source             TEXT    NOT NULL,      -- 'cli' | 'server'
        pid                INTEGER NOT NULL,
        config_id          INTEGER NOT NULL REFERENCES engine_configs (id),
        workers            INTEGER NOT NULL,
        on_battery         INTEGER,               -- 1 / 0, NULL when unknown
        started_at         INTEGER NOT NULL,
        finished_at        INTEGER,
        status             TEXT    NOT NULL,      -- 'running' | 'completed' | 'paused' | 'failed'
        games_queued       INTEGER NOT NULL,
        games_done         INTEGER NOT NULL DEFAULT 0,
        games_failed       INTEGER NOT NULL DEFAULT 0,
        positions_searched INTEGER NOT NULL DEFAULT 0,
        nodes              INTEGER NOT NULL DEFAULT 0,
        search_ms          INTEGER NOT NULL DEFAULT 0, -- wall time with searches running
        error              TEXT
      );
    `
  },
  {
    version: 4,
    name: "repertoire entries",
    sql: `
      -- The owner's repertoire: per colour, one move for each owner-to-move position (EPD), so
      -- transposed positions share one entry. Seeded from his games, then edited by him.
      CREATE TABLE repertoire_entries (
        username      TEXT    NOT NULL,
        color         TEXT    NOT NULL CHECK (color IN ('white', 'black')),
        epd           TEXT    NOT NULL,
        uci           TEXT    NOT NULL,
        san           TEXT    NOT NULL,
        source        TEXT    NOT NULL CHECK (source IN ('from-games', 'seed-engine', 'edited')),
        status        TEXT    NOT NULL CHECK (status IN ('active', 'needs-review')),
        locked        INTEGER NOT NULL DEFAULT 0,  -- 1: a re-seed never changes it
        replaced_json TEXT,                        -- {uci, san, loss, reason} of the move it replaced
        reason        TEXT,                        -- the seed's explanation (facts only)
        note          TEXT,                        -- the owner's note
        ply           INTEGER NOT NULL,            -- the move's ply on the shortest path
        updated_at    INTEGER NOT NULL,            -- ms
        PRIMARY KEY (username, color, epd)
      ) WITHOUT ROWID;
    `
  },
  {
    version: 5,
    name: "drill cards and reviews",
    sql: `
      -- Spaced-repetition drills: one card per (kind, colour, owner-to-move EPD). The generated
      -- content (path, repertoire move, name, weight, source games) is rewritten by each
      -- regeneration; the Leitner state and the review log stay with the card id.
      CREATE TABLE drill_cards (
        username       TEXT    NOT NULL,
        id             TEXT    NOT NULL,              -- kind|color|epd
        kind           TEXT    NOT NULL CHECK (kind IN ('repertoire-line', 'own-mistake')),
        color          TEXT    NOT NULL CHECK (color IN ('white', 'black')),
        epd            TEXT    NOT NULL,
        status         TEXT    NOT NULL CHECK (status IN ('active', 'removed')),
        confirm        TEXT    NOT NULL CHECK (confirm IN ('none', 'pending', 'confirmed', 'rejected')),
        content_json   TEXT    NOT NULL,
        check_json     TEXT,                          -- the lazy deep check of a mistake card
        box            INTEGER NOT NULL DEFAULT 0,    -- 0 = new
        due_at         INTEGER,                       -- ms
        introduced_at  INTEGER,
        lapses         INTEGER NOT NULL DEFAULT 0,
        streak         INTEGER NOT NULL DEFAULT 0,
        reviews        INTEGER NOT NULL DEFAULT 0,
        last_review_at INTEGER,
        retired        INTEGER NOT NULL DEFAULT 0,
        generated_at   INTEGER NOT NULL,
        PRIMARY KEY (username, id),
        UNIQUE (username, kind, color, epd)
      ) WITHOUT ROWID;
      CREATE INDEX drill_cards_due ON drill_cards (username, status, due_at);

      -- Every answer, graded or not (append-only).
      CREATE TABLE drill_reviews (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT    NOT NULL,
        card_id     TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        reviewed_at INTEGER NOT NULL,
        uci         TEXT    NOT NULL,
        san         TEXT    NOT NULL,
        verdict     TEXT    NOT NULL,
        loss        REAL,
        graded      INTEGER NOT NULL,                 -- 1: the answer changed the schedule
        attempts    INTEGER NOT NULL,
        ms          INTEGER,
        box_before  INTEGER NOT NULL,
        box_after   INTEGER NOT NULL,
        due_after   INTEGER
      );
      CREATE INDEX drill_reviews_card ON drill_reviews (username, card_id, reviewed_at);

      -- Small per-owner values, e.g. the inputs stamp of the last card regeneration.
      CREATE TABLE drill_meta (
        username TEXT NOT NULL,
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (username, key)
      ) WITHOUT ROWID;
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
