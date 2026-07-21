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

/**
 * Raw DB-shaped row (epoch-millis timestamps, matches the DDL above
 * exactly). API responses convert this into {@link SessionApi} so wire JSON
 * matches `shared/types.ts`. Mirrors `daemon/src/store.rs::SessionRow`.
 */
export interface SessionRow {
  sessionId: string;
  cwd: string | null;
  workspace: string | null;
  branch: string | null;
  status: string;
  taskSummary: string | null;
  currentTool: string | null;
  source: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  endedAt: number | null;
  dismissedAt: number | null;
}

/**
 * API/wire-facing shape. Field names + types match `shared/types.ts`'s
 * `Session` interface exactly (camelCase, RFC3339 timestamp strings) even
 * though the underlying DB stores epoch-millis integers. Mirrors
 * `daemon/src/store.rs::SessionApi`.
 */
export interface SessionApi {
  sessionId: string;
  workspace: string | null;
  branch: string | null;
  status: string;
  taskSummary: string | null;
  currentTool: string | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  dismissedAt: string | null;
  source: string | null;
}

/**
 * Converts a Unix epoch (milliseconds) into an RFC3339 UTC string (e.g.
 * `"2026-07-17T12:34:56.789Z"`). Rust's version hand-rolled Howard
 * Hinnant's `civil_from_days` calendar algorithm to avoid a `chrono`
 * dependency; Node needs none of that — `Date#toISOString()` already
 * produces the same millisecond-precision, `Z`-suffixed format (RESEARCH.md
 * Pattern 3). Do NOT port the calendar-math algorithm.
 */
export const millisToRfc3339 = (millis: number): string => new Date(millis).toISOString();

function toSessionApi(row: SessionRow): SessionApi {
  return {
    sessionId: row.sessionId,
    workspace: row.workspace,
    branch: row.branch,
    status: row.status,
    taskSummary: row.taskSummary,
    currentTool: row.currentTool,
    startedAt: millisToRfc3339(row.startedAt ?? 0),
    lastActivityAt: millisToRfc3339(row.lastActivityAt ?? 0),
    endedAt: row.endedAt === null || row.endedAt === undefined ? null : millisToRfc3339(row.endedAt),
    dismissedAt:
      row.dismissedAt === null || row.dismissedAt === undefined ? null : millisToRfc3339(row.dismissedAt),
    source: row.source,
  };
}

const SESSION_COLUMNS = `session_id, cwd, workspace, branch, status, task_summary, current_tool, source,
                started_at, last_activity_at, ended_at, dismissed_at`;

interface SessionSqlRow {
  session_id: string;
  cwd: string | null;
  workspace: string | null;
  branch: string | null;
  status: string;
  task_summary: string | null;
  current_tool: string | null;
  source: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  ended_at: number | null;
  dismissed_at: number | null;
}

function sqlRowToSessionRow(row: SessionSqlRow): SessionRow {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    workspace: row.workspace,
    branch: row.branch,
    status: row.status,
    taskSummary: row.task_summary,
    currentTool: row.current_tool,
    source: row.source,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    endedAt: row.ended_at,
    dismissedAt: row.dismissed_at,
  };
}

/**
 * `?active=` truthiness check — accepts exactly this string set. Port of
 * `daemon/src/ingest/mod.rs::is_truthy`.
 */
export function isTruthy(v: string): boolean {
  return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

/**
 * Lists sessions, most-recently-active first. When `opts.active` is true,
 * restricts to the active queue (`dismissed_at IS NULL` — D-06/D-07);
 * otherwise returns the full/history listing. Mirrors
 * `daemon/src/store.rs::list_sessions` / `list_active_sessions`.
 */
export function listSessions(
  db: DatabaseType,
  opts?: { active?: boolean },
): SessionApi[] {
  const whereClause = opts?.active ? "WHERE dismissed_at IS NULL " : "";
  const rows = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ${whereClause}ORDER BY last_activity_at DESC`)
    .all() as SessionSqlRow[];
  return rows.map((r) => toSessionApi(sqlRowToSessionRow(r)));
}

/**
 * Startup rehydration query (FND-03/D-07): sessions that were still
 * *unresolved* when the daemon last stopped — waiting on the user
 * (`waiting-permission` / `waiting-input`) or finished but not yet
 * acknowledged (`done`) — and not dismissed. `running` sessions are
 * deliberately excluded: nothing needs to be manually restored for them.
 * Copied verbatim from `daemon/src/store.rs::rehydrate_active_sessions`.
 */
export function rehydrateActiveSessions(db: DatabaseType): SessionApi[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE status IN ('waiting-permission', 'waiting-input', 'done')
         AND dismissed_at IS NULL
       ORDER BY last_activity_at DESC`,
    )
    .all() as SessionSqlRow[];
  return rows.map((r) => toSessionApi(sqlRowToSessionRow(r)));
}

/**
 * Raw DB-shaped timeline-event row (epoch-millis `created_at`). Converted
 * to {@link EventApi} for wire responses, mirroring the SessionRow/SessionApi
 * split above. Mirrors `daemon/src/store.rs::EventRow`.
 */
export interface EventRow {
  kind: string;
  toolName: string | null;
  summary: string;
  isError: boolean;
  createdAt: number;
}

/**
 * API/wire-facing shape matching `shared/types.ts`'s `TimelineEvent`
 * (camelCase, ISO 8601 `createdAt`). Mirrors
 * `daemon/src/store.rs::EventApi`.
 */
export interface EventApi {
  kind: string;
  toolName: string | null;
  summary: string;
  isError: boolean;
  createdAt: string;
}

interface EventSqlRow {
  kind: string;
  tool_name: string | null;
  summary: string | null;
  is_error: number;
  created_at: number;
}

function toEventApi(row: EventSqlRow): EventApi {
  return {
    kind: row.kind,
    toolName: row.tool_name,
    summary: row.summary ?? "",
    isError: row.is_error !== 0,
    createdAt: millisToRfc3339(row.created_at),
  };
}

/**
 * Lists a session's condensed-timeline events in chronological order
 * (oldest first, ascending `id`). Returns `[]` (not an error) for an
 * unknown `session_id` — the frontend only ever calls this for a session it
 * already has from `GET /sessions`. Mirrors
 * `daemon/src/store.rs::list_events`.
 */
export function listSessionEvents(db: DatabaseType, sessionId: string): EventApi[] {
  const rows = db
    .prepare(
      `SELECT kind, tool_name, summary, is_error, created_at
       FROM events WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as EventSqlRow[];
  return rows.map(toEventApi);
}
