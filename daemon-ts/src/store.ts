/**
 * better-sqlite3-backed session/event store.
 *
 * Node's single-threaded event loop + `better-sqlite3`'s synchronous API
 * means every DB access can be a direct function call from a route handler
 * — no dedicated writer-thread/channel is needed (unlike the Rust daemon's
 * `spawn_db_writer`, which existed only because `rusqlite::Connection` is
 * not `Sync`). See 02.1-RESEARCH.md Pattern 1.
 *
 * The DB file MUST live on the WSL-native filesystem (never `/mnt/...` —
 * D-04); that guard lives in `main.ts::cockpitDir`.
 *
 * Schema below is copied VERBATIM from `daemon/src/store.rs::open_db` so an
 * existing Rust-written `cockpit.db` opens unchanged, with no migration.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Opens (or creates) the SQLite database at `path`, enables WAL mode, and
 * ensures the `sessions` and `events` tables exist (idempotent — safe to run
 * against an existing Rust-written DB with no migration, D-04).
 */
export function openDb(path: string): DatabaseType {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT,
        workspace TEXT,
        branch TEXT,
        status TEXT NOT NULL,
        task_summary TEXT,
        current_tool TEXT,
        source TEXT,
        started_at INTEGER,
        last_activity_at INTEGER,
        ended_at INTEGER NULL,
        dismissed_at INTEGER NULL
    );
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool_name TEXT,
        summary TEXT,
        payload_json TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
  `);
  return db;
}

/** Current time as Unix epoch milliseconds. */
export function nowMillis(): number {
  return Date.now();
}
