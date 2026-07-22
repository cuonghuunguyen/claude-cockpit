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

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { PendingDecision } from "../../shared/types.js";

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
  /** FND-04/ACT-01: the pending ask this session is currently holding open, derived from `status`/`currentTool` (never persisted separately). */
  pendingDecision: PendingDecision | null;
}

/**
 * Derives the wire-facing {@link PendingDecision} for a `waiting-permission`
 * session (this plan's only `kind`; `ask-user-question`/`plan-mode` are
 * 03-03/03-05). `null` for every other status — the card/toast render
 * nothing when there is no held decision. Options mirror `decisions.ts`'s
 * `buildHookDecisionOutput("permission", ...)` contract: Approve carries a
 * plain `{type:"approve"}` Decision; Deny carries `{type:"deny"}` with
 * `revealReasonOnSelect` so the UI expands a reason box before submitting
 * (D-09) rather than submitting an empty-reason deny immediately.
 */
function derivePendingDecision(row: SessionRow): PendingDecision | null {
  if (row.status !== "waiting-permission") {
    return null;
  }
  return {
    kind: "permission",
    toolName: row.currentTool,
    prompt: row.currentTool ? `Approve ${row.currentTool}?` : "Approve this tool call?",
    options: [
      { label: "Approve", decision: { type: "approve" } },
      { label: "Deny", decision: { type: "deny" }, revealReasonOnSelect: true },
    ],
  };
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
    pendingDecision: derivePendingDecision(row),
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
 * Reads a single session by its primary key (raw DB shape). Returns `null`
 * if unknown. Mirrors `daemon/src/store.rs::get_session`. Used by the
 * ingest dispatch layer (`ingest/dispatch.ts`) to read the session's
 * current status before computing a transition, and by every write
 * function below that needs to hand back the post-mutation row.
 */
export function getSession(db: DatabaseType, sessionId: string): SessionRow | null {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
    .get(sessionId) as SessionSqlRow | undefined;
  return row ? sqlRowToSessionRow(row) : null;
}

/** Wire-facing (`SessionApi`) convenience wrapper around {@link getSession}. */
export function getSessionApi(db: DatabaseType, sessionId: string): SessionApi | null {
  const row = getSession(db, sessionId);
  return row ? toSessionApi(row) : null;
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

// ---------------------------------------------------------------------------
// Write layer (Wave 2). Mirrors `daemon/src/store.rs`'s write-side functions
// verbatim (SQL + constants). Node's single-threaded event loop +
// better-sqlite3's synchronous API means every function below is a direct,
// synchronous call — no writer-thread/channel is needed (see module doc
// comment / RESEARCH.md Pattern 1).
// ---------------------------------------------------------------------------

/**
 * Upserts a session on `SessionStart`: creates the row if absent, or
 * updates `cwd`/`status`/`source`/`last_activity_at` if the session_id
 * already exists (no duplicate rows — session_id is the primary key).
 * Also derives and stores `workspace`/`branch` from `cwd` (MON-02).
 * Mirrors `daemon/src/store.rs::upsert_session_start`.
 */
export function upsertSessionStart(
  db: DatabaseType,
  sessionId: string,
  cwd: string,
  source: string,
): SessionRow {
  const now = nowMillis();
  const [workspace, branch] = deriveWorkspaceAndBranch(cwd);
  db.prepare(
    `INSERT INTO sessions
        (session_id, cwd, workspace, branch, status, source, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
        cwd = excluded.cwd,
        workspace = excluded.workspace,
        branch = excluded.branch,
        status = 'running',
        source = excluded.source,
        last_activity_at = excluded.last_activity_at`,
  ).run(sessionId, cwd, workspace, branch, source, now, now);
  const row = getSession(db, sessionId);
  if (!row) {
    throw new Error(`upsertSessionStart: session ${sessionId} missing immediately after insert`);
  }
  return row;
}

/**
 * Defensively creates a minimal session row if `sessionId` is not already
 * known — guards against a hook event arriving before (or without) a
 * `SessionStart` (e.g. Cockpit started mid-session, or an out-of-order
 * delivery). Never overwrites an existing row (`INSERT OR IGNORE`); `cwd`,
 * when available, seeds workspace/branch derivation. Mirrors
 * `daemon/src/store.rs::ensure_session`.
 */
export function ensureSession(db: DatabaseType, sessionId: string, cwd?: string | null): void {
  const now = nowMillis();
  const [workspace, branch] = cwd ? deriveWorkspaceAndBranch(cwd) : [null, null];
  db.prepare(
    `INSERT OR IGNORE INTO sessions
        (session_id, cwd, workspace, branch, status, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  ).run(sessionId, cwd ?? null, workspace, branch, now, now);
}

/**
 * Bumps only `last_activity_at` — used for `is_error` events, which must
 * never change `status` (MON-05), but should still reflect that the
 * session had recent traffic. Mirrors
 * `daemon/src/store.rs::touch_last_activity`.
 */
export function touchLastActivity(db: DatabaseType, sessionId: string): void {
  db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE session_id = ?`).run(
    nowMillis(),
    sessionId,
  );
}

/**
 * Sets `ended_at` (SessionEnd) without touching `status` — a done/waiting
 * unresolved session stays visible after the process exits (D-06/D-07).
 * Mirrors `daemon/src/store.rs::mark_ended`.
 */
export function markEnded(db: DatabaseType, sessionId: string): void {
  const now = nowMillis();
  db.prepare(
    `UPDATE sessions SET ended_at = ?, last_activity_at = ? WHERE session_id = ?`,
  ).run(now, now, sessionId);
}

/**
 * Updates a session's live-state fields following a (non-error,
 * non-SessionEnd) hook event: the new `status` plus `currentTool` (the
 * in-flight tool name for `PreToolUse`, or `null` to clear it for every
 * other event), and bumps `last_activity_at`. Never touches
 * `task_summary`, `workspace`, `branch`, `ended_at`, or `dismissed_at` —
 * those are set by their own dedicated functions above/below. Mirrors
 * `daemon/src/store.rs::update_session_status` (which sets `status` and
 * `current_tool` together in the same statement — this port keeps that
 * atomicity rather than splitting into two separate SQL statements).
 */
export function updateSessionStatus(
  db: DatabaseType,
  sessionId: string,
  status: string,
  currentTool: string | null,
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, current_tool = ?, last_activity_at = ? WHERE session_id = ?`,
  ).run(status, currentTool, nowMillis(), sessionId);
}

/**
 * Hold-begin status writer (FND-04, 03-RESEARCH.md Pitfall 3): same
 * UPDATE shape as {@link updateSessionStatus} (status + current_tool +
 * last_activity_at together, one statement), but invoked directly by
 * `sessionState.ts::beginPermissionHold` at the exact moment an ingest
 * handler decides a `PreToolUse` call is now a held decision — NOT via the
 * event-driven `dispatchIngestEvent`/`transition()` path, whose pure
 * `PreToolUse -> "running"` mapping has no concept of "this call is blocked
 * pending a human" (see `sessionState.ts` for why this is a separate
 * call-site rather than a new `transition()` match arm).
 */
export function setStatusForHold(
  db: DatabaseType,
  sessionId: string,
  status: string,
  toolName: string | null,
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, current_tool = ?, last_activity_at = ? WHERE session_id = ?`,
  ).run(status, toolName, nowMillis(), sessionId);
}

/**
 * Sets `task_summary` only if it is currently `NULL` (D-08: the session's
 * first user prompt is the stable task summary; later prompts never
 * overwrite it). Mirrors `daemon/src/store.rs::set_task_summary_if_absent`.
 */
export function setTaskSummaryIfAbsent(db: DatabaseType, sessionId: string, text: string): void {
  db.prepare(
    `UPDATE sessions SET task_summary = ? WHERE session_id = ? AND task_summary IS NULL`,
  ).run(text, sessionId);
}

/**
 * `POST /sessions/:id/dismiss` (D-06): sets `dismissed_at`, moving the
 * session out of the active queue (still present in the full/history
 * listing). Returns the updated row, or `null` if `sessionId` is unknown.
 * Mirrors `daemon/src/store.rs::dismiss_session`.
 */
export function dismissSession(db: DatabaseType, sessionId: string): SessionRow | null {
  db.prepare(
    `UPDATE sessions SET dismissed_at = ? WHERE session_id = ? AND dismissed_at IS NULL`,
  ).run(nowMillis(), sessionId);
  return getSession(db, sessionId);
}

/**
 * Maximum stored length of `payload_json` per event (bound
 * oversized/malformed hook payloads before storage — never store an
 * unbounded blob from untrusted tool/session input). Mirrors
 * `daemon/src/store.rs::MAX_PAYLOAD_JSON_LEN`.
 */
const MAX_PAYLOAD_JSON_LEN = 8192;

/**
 * Per-session event cap (D-11): a single session's timeline never grows
 * unbounded on disk, but the session row itself is never deleted. Mirrors
 * `daemon/src/store.rs::EVENT_CAP`.
 */
const EVENT_CAP = 300;

/**
 * Trim cadence: run the (slightly more expensive) capped-DELETE roughly
 * every this many inserts for a given session_id, not on every single
 * insert, so the hot write path (one INSERT) stays cheap. Mirrors
 * `daemon/src/store.rs::TRIM_EVERY_N_INSERTS`.
 */
const TRIM_EVERY_N_INSERTS = 50;

/**
 * Per-session insert counters used to amortize the cap-trim (see
 * {@link TRIM_EVERY_N_INSERTS}). A plain in-process `Map` — Rust's version
 * needed a `Mutex<HashMap<...>>` only because multiple OS threads could
 * touch it concurrently; Node's single-threaded event loop makes the mutex
 * unnecessary (RESEARCH.md Pattern 1). Deliberately non-persisted: it
 * resets to 0 on daemon restart, meaning a session could transiently hold
 * slightly more than `EVENT_CAP` rows for a short window right after a
 * restart, but the trim itself (`DELETE ... ORDER BY id DESC LIMIT`) is
 * idempotent and always correct whenever it runs.
 */
const insertCounters = new Map<string, number>();

/**
 * Appends one condensed-timeline event row (MON-03). Marking `isError`
 * records the event for visibility only — it is the caller's
 * responsibility (see `ingest/dispatch.ts`) to never invoke a status
 * transition alongside an error event (MON-05); this function itself never
 * touches the `sessions` table (aside from the amortized event-cap trim
 * below, which only ever deletes from `events`). Truncates `payloadJson` to
 * {@link MAX_PAYLOAD_JSON_LEN} characters before insert — mirrors
 * `daemon/src/store.rs::append_event` (Rust truncates by byte length since
 * `payload_json: &str`; this port truncates by JS string length, which is
 * an equivalent DoS-bound guard for this purpose). Never truncates
 * `summary` itself (matching Rust, which also never touches summary here —
 * callers pre-condense it via {@link condensedText}/{@link condensedJsonSummary}
 * before calling this function).
 */
export function appendEvent(
  db: DatabaseType,
  sessionId: string,
  kind: string,
  toolName: string | null,
  summary: string,
  payloadJson: string | null,
  isError: boolean,
): void {
  const truncatedPayload =
    payloadJson !== null && payloadJson.length > MAX_PAYLOAD_JSON_LEN
      ? payloadJson.slice(0, MAX_PAYLOAD_JSON_LEN)
      : payloadJson;

  db.prepare(
    `INSERT INTO events
        (session_id, kind, tool_name, summary, payload_json, is_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, kind, toolName, summary, truncatedPayload, isError ? 1 : 0, nowMillis());

  const counter = (insertCounters.get(sessionId) ?? 0) + 1;
  if (counter >= TRIM_EVERY_N_INSERTS) {
    insertCounters.set(sessionId, 0);
    trimSessionEvents(db, sessionId);
  } else {
    insertCounters.set(sessionId, counter);
  }
}

/**
 * Deletes every `events` row for `sessionId` beyond the newest
 * {@link EVENT_CAP}, keyed by `id` (monotonically increasing insertion
 * order). Never touches the `sessions` table — a session's row is never
 * deleted by trimming (D-11). Mirrors
 * `daemon/src/store.rs::trim_session_events`.
 */
function trimSessionEvents(db: DatabaseType, sessionId: string): void {
  db.prepare(
    `DELETE FROM events WHERE session_id = ? AND id NOT IN (
        SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(sessionId, sessionId, EVENT_CAP);
}

/**
 * Truncates a plain-text string (e.g. a user prompt or assistant message)
 * to `maxLen` Unicode code points for the condensed timeline, appending an
 * ellipsis when truncated. Uses `Array.from(s)` (code-point aware) rather
 * than `s.slice(0, maxLen)` — the latter operates on UTF-16 code units and
 * can split a surrogate pair mid-character (a real porting hazard:
 * RESEARCH.md line 226). Mirrors `daemon/src/ingest/mod.rs::condensed_text`
 * (which counts `.chars()` and appends `…` on truncation) — the ellipsis
 * suffix is preserved here so timeline summaries stay byte-for-byte
 * identical to the Rust daemon's output when truncation actually triggers.
 */
export function condensedText(s: string, maxLen: number): string {
  const codePoints = Array.from(s);
  if (codePoints.length > maxLen) {
    return `${codePoints.slice(0, maxLen).join("")}…`;
  }
  return s;
}

/**
 * Truncates an arbitrary JSON value into a short, human-readable summary
 * string for the condensed timeline — used by handlers whose payload
 * includes free-form `tool_input`/`tool_response` data that must never blow
 * up storage. Mirrors `daemon/src/ingest/mod.rs::condensed_json_summary`.
 */
export function condensedJsonSummary(value: unknown, maxLen: number): string {
  return condensedText(JSON.stringify(value), maxLen);
}

/**
 * Derives `(workspace, branch)` from a session's `cwd`.
 *
 * - `workspace` = the final path segment (repo/dir name); `null` if `cwd`
 *   is empty/unparseable.
 * - `branch` = a bounded, best-effort read of `<cwd>/.git/HEAD`; any
 *   failure (non-git dir, unreadable/oversized HEAD, detached HEAD not
 *   matching `ref: refs/heads/...`) yields `null`, never a throw (this
 *   reads an attacker-influenceable path, so it must never block the ack —
 *   Security Domain T-2.1-05).
 *
 * Native-Windows cwds (`C:\Users\...`) are normalized to the WSL
 * `/mnt/c/...` mount point first, since the daemon itself always runs
 * inside WSL — a native-Windows session's cwd string is otherwise
 * meaningless to a WSL-side filesystem read. Mirrors
 * `daemon/src/store.rs::derive_workspace_and_branch` verbatim (including
 * `normalize_cwd`/`read_git_branch`).
 */
export function deriveWorkspaceAndBranch(cwd: string): [string | null, string | null] {
  if (cwd.trim() === "") {
    return [null, null];
  }
  const normalized = normalizeCwd(cwd);
  const workspace = basename(normalized) || null;
  const branch = readGitBranch(normalized);
  return [workspace, branch];
}

/**
 * Normalizes a native-Windows path (`C:\Users\x\proj` or `C:/Users/x/proj`)
 * into its WSL `/mnt/<drive>/...` equivalent; a path that's already
 * POSIX-shaped (WSL/Linux/macOS cwd) passes through unchanged. Mirrors
 * `daemon/src/store.rs::normalize_cwd`.
 */
function normalizeCwd(cwd: string): string {
  if (cwd.length >= 2 && /^[A-Za-z]$/.test(cwd[0]) && cwd[1] === ":") {
    const drive = cwd[0].toLowerCase();
    let rest = cwd.slice(2).replace(/\\/g, "/");
    if (rest.startsWith("/")) {
      rest = rest.slice(1);
    }
    return `/mnt/${drive}/${rest}`;
  }
  return cwd;
}

/**
 * Bounded, best-effort `.git/HEAD` read. Checks file size before reading
 * (never reads an unbounded/huge file into memory) and only recognizes the
 * common `ref: refs/heads/<branch>` shape; a detached HEAD (a raw commit
 * SHA) or a missing/non-git directory yields `null`. Mirrors
 * `daemon/src/store.rs::read_git_branch`.
 */
function readGitBranch(cwd: string): string | null {
  const headPath = join(cwd, ".git", "HEAD");
  let size: number;
  try {
    size = statSync(headPath).size;
  } catch {
    return null;
  }
  if (size > 4096) {
    return null; // not a legitimate HEAD file — bounded-read guard.
  }
  let contents: string;
  try {
    contents = readFileSync(headPath, "utf8");
  } catch {
    return null;
  }
  const trimmed = contents.trim();
  const prefix = "ref: refs/heads/";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
}
