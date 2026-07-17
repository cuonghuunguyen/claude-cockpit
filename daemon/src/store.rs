//! Rusqlite-backed session/event store.
//!
//! WAL journal mode + a single dedicated writer path (see `main.rs`'s
//! `spawn_db_writer`) is how this store stays safe under many concurrent
//! hook POSTs without hand-rolled locking (01-RESEARCH.md "Persistence").
//!
//! The DB file MUST live on the WSL-native filesystem (never `/mnt/...` —
//! RESEARCH.md Pitfall D); that guard lives in `main.rs::cockpit_dir`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// Opens (or creates) the SQLite database at `path`, enables WAL mode, and
/// ensures the `sessions` and `events` tables exist.
pub fn open_db(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
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
        CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);",
    )?;
    Ok(conn)
}

/// Current time as Unix epoch milliseconds.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Raw DB-shaped row (epoch-millis timestamps, matches the DDL above
/// exactly). Internal to the daemon and to tests; API responses convert
/// this into [`SessionApi`] so wire JSON matches `shared/types.ts`.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub workspace: Option<String>,
    pub branch: Option<String>,
    pub status: String,
    pub task_summary: Option<String>,
    pub current_tool: Option<String>,
    pub source: Option<String>,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub ended_at: Option<i64>,
    pub dismissed_at: Option<i64>,
}

/// API/wire-facing shape. Field names + types are chosen to match
/// `shared/types.ts`'s `Session` interface (camelCase, ISO 8601 timestamp
/// strings) even though the underlying DB stores epoch-millis integers.
///
/// Known gap (documented in 01-02-SUMMARY.md, not a blocker for this plan):
/// `workspace`/`branch`/`currentTool` derivation from `cwd` (MON-02) is not
/// implemented until a later plan, so these fields are `null` for now; and
/// `source` currently stores Claude Code's own SessionStart reason
/// (startup/resume/clear/compact) verbatim rather than the origin-environment
/// classification ("wsl" | "windows" | "vscode") `shared/types.ts` describes
/// — that classification is not derivable from the HTTP request alone and is
/// out of this plan's scope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionApi {
    pub session_id: String,
    pub workspace: Option<String>,
    pub branch: Option<String>,
    pub status: String,
    pub task_summary: Option<String>,
    pub current_tool: Option<String>,
    pub started_at: String,
    pub last_activity_at: String,
    pub ended_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub source: Option<String>,
}

impl From<&SessionRow> for SessionApi {
    fn from(row: &SessionRow) -> Self {
        SessionApi {
            session_id: row.session_id.clone(),
            workspace: row.workspace.clone(),
            branch: row.branch.clone(),
            status: row.status.clone(),
            task_summary: row.task_summary.clone(),
            current_tool: row.current_tool.clone(),
            started_at: millis_to_rfc3339(row.started_at),
            last_activity_at: millis_to_rfc3339(row.last_activity_at),
            ended_at: row.ended_at.map(millis_to_rfc3339),
            dismissed_at: row.dismissed_at.map(millis_to_rfc3339),
            source: row.source.clone(),
        }
    }
}

impl From<SessionRow> for SessionApi {
    fn from(row: SessionRow) -> Self {
        SessionApi::from(&row)
    }
}

/// Converts a Unix epoch (milliseconds) into a minimal RFC3339 UTC string
/// (e.g. `"2026-07-17T12:34:56.789Z"`) without pulling in a `chrono`
/// dependency. Uses Howard Hinnant's public-domain `civil_from_days`
/// algorithm (http://howardhinnant.github.io/date_algorithms.html) for the
/// days -> (year, month, day) conversion.
pub fn millis_to_rfc3339(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let secs_of_day = secs.rem_euclid(86400);
    let (hour, min, sec) = (secs_of_day / 3600, (secs_of_day / 60) % 60, secs_of_day % 60);

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{ms:03}Z")
}

/// Upserts a session on `SessionStart`: creates the row if absent, or
/// updates `cwd`/`status`/`source`/`last_activity_at` if the session_id
/// already exists (no duplicate rows — session_id is the primary key).
/// Also derives and stores `workspace`/`branch` from `cwd` (MON-02).
pub fn upsert_session_start(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    source: &str,
) -> rusqlite::Result<SessionRow> {
    let now = now_millis();
    let (workspace, branch) = derive_workspace_and_branch(cwd);
    conn.execute(
        "INSERT INTO sessions
            (session_id, cwd, workspace, branch, status, source, started_at, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
            cwd = excluded.cwd,
            workspace = excluded.workspace,
            branch = excluded.branch,
            status = 'running',
            source = excluded.source,
            last_activity_at = excluded.last_activity_at",
        params![session_id, cwd, workspace, branch, source, now],
    )?;
    get_session(conn, session_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Defensively creates a minimal session row if `session_id` is not already
/// known — guards against a Plan 01-03 hook event arriving before (or
/// without) a `SessionStart` (e.g. Cockpit started mid-session, or an
/// out-of-order delivery). Never overwrites an existing row (`INSERT OR
/// IGNORE`); `cwd`, when available, seeds workspace/branch derivation.
pub fn ensure_session(
    conn: &Connection,
    session_id: &str,
    cwd: Option<&str>,
) -> rusqlite::Result<()> {
    let now = now_millis();
    let (workspace, branch) = cwd
        .map(derive_workspace_and_branch)
        .unwrap_or((None, None));
    conn.execute(
        "INSERT OR IGNORE INTO sessions
            (session_id, cwd, workspace, branch, status, started_at, last_activity_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5)",
        params![session_id, cwd, workspace, branch, now],
    )?;
    Ok(())
}

/// Bumps only `last_activity_at` — used for `is_error` events, which must
/// never change `status` (D-10/MON-05), but should still reflect that the
/// session had recent traffic.
pub fn touch_last_activity(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET last_activity_at = ?2 WHERE session_id = ?1",
        params![session_id, now_millis()],
    )?;
    Ok(())
}

/// Sets `ended_at` (SessionEnd) without touching `status` — a done/waiting
/// unresolved session stays visible after the process exits (D-06/D-07).
pub fn mark_ended(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET ended_at = ?2, last_activity_at = ?2 WHERE session_id = ?1",
        params![session_id, now_millis()],
    )?;
    Ok(())
}

/// Updates a session's live-state fields following a (non-error,
/// non-SessionEnd) hook event: the new `status` plus `current_tool` (the
/// in-flight tool name for `PreToolUse`, or `None` to clear it for every
/// other event), and bumps `last_activity_at`. Never touches
/// `task_summary`, `workspace`, `branch`, `ended_at`, or `dismissed_at` —
/// those are set by their own dedicated functions.
pub fn update_session_status(
    conn: &Connection,
    session_id: &str,
    status: &str,
    current_tool: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET status = ?2, current_tool = ?3, last_activity_at = ?4
         WHERE session_id = ?1",
        params![session_id, status, current_tool, now_millis()],
    )?;
    Ok(())
}

/// Sets `task_summary` only if it is currently `NULL` (D-08: the session's
/// first user prompt is the stable task summary; later prompts never
/// overwrite it).
pub fn set_task_summary_if_absent(
    conn: &Connection,
    session_id: &str,
    text: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET task_summary = ?2
         WHERE session_id = ?1 AND task_summary IS NULL",
        params![session_id, text],
    )?;
    Ok(())
}

/// Maximum stored length of `payload_json` per event (T-01-03a: bound
/// oversized/malformed hook payloads before storage — never store an
/// unbounded blob from untrusted tool/session input).
const MAX_PAYLOAD_JSON_LEN: usize = 8192;

/// Appends one condensed-timeline event row (D-09/MON-03). Marking
/// `is_error` records the event for visibility only — it is the caller's
/// responsibility (see `main.rs::handle_ingest_event`) to never invoke a
/// status transition alongside an error event (D-10/MON-05); this function
/// itself never touches the `sessions` table.
pub fn append_event(
    conn: &Connection,
    session_id: &str,
    kind: &str,
    tool_name: Option<&str>,
    summary: &str,
    payload_json: Option<&str>,
    is_error: bool,
) -> rusqlite::Result<()> {
    let truncated_payload = payload_json.map(|p| {
        if p.len() > MAX_PAYLOAD_JSON_LEN {
            p[..MAX_PAYLOAD_JSON_LEN].to_string()
        } else {
            p.to_string()
        }
    });
    conn.execute(
        "INSERT INTO events
            (session_id, kind, tool_name, summary, payload_json, is_error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session_id,
            kind,
            tool_name,
            summary,
            truncated_payload,
            is_error as i64,
            now_millis()
        ],
    )?;
    Ok(())
}

/// Derives `(workspace, branch)` from a session's `cwd`.
///
/// - `workspace` = the final path segment (repo/dir name); `None` if `cwd`
///   is empty/unparseable.
/// - `branch` = a bounded, best-effort read of `<cwd>/.git/HEAD`; any
///   failure (non-git dir, unreadable/oversized HEAD, detached HEAD not
///   matching `ref: refs/heads/...`) yields `None`, never a panic or error
///   (T-01-03b: this reads an attacker-influenceable path, so it must never
///   block the ack).
///
/// Native-Windows cwds (`C:\Users\...`) are normalized to the WSL
/// `/mnt/c/...` mount point first, since the daemon itself always runs
/// inside WSL (01-03-PLAN.md notes) — a native-Windows session's cwd string
/// is otherwise meaningless to a WSL-side filesystem read.
pub fn derive_workspace_and_branch(cwd: &str) -> (Option<String>, Option<String>) {
    if cwd.trim().is_empty() {
        return (None, None);
    }
    let normalized = normalize_cwd(cwd);
    let workspace = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let branch = read_git_branch(&normalized);
    (workspace, branch)
}

/// Normalizes a native-Windows path (`C:\Users\x\proj` or `C:/Users/x/proj`)
/// into its WSL `/mnt/<drive>/...` equivalent; a path that's already
/// POSIX-shaped (WSL/Linux/macOS cwd) passes through unchanged.
fn normalize_cwd(cwd: &str) -> String {
    let bytes = cwd.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = cwd[2..].replace('\\', "/");
        let rest = rest.strip_prefix('/').unwrap_or(&rest).to_string();
        format!("/mnt/{drive}/{rest}")
    } else {
        cwd.to_string()
    }
}

/// Bounded, best-effort `.git/HEAD` read. Checks file size before reading
/// (never reads an unbounded/huge file into memory — T-01-03b) and only
/// recognizes the common `ref: refs/heads/<branch>` shape; a detached HEAD
/// (a raw commit SHA) or a missing/non-git directory yields `None`.
fn read_git_branch(cwd: &str) -> Option<String> {
    let head_path = std::path::Path::new(cwd).join(".git").join("HEAD");
    let metadata = std::fs::metadata(&head_path).ok()?;
    if metadata.len() > 4096 {
        return None; // not a legitimate HEAD file — bounded-read guard.
    }
    let contents = std::fs::read_to_string(&head_path).ok()?;
    contents
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(|b| b.to_string())
}

/// `POST /sessions/:id/dismiss` (D-06): sets `dismissed_at`, moving the
/// session out of the active queue (still present in the full/history
/// listing). Returns the updated row, or `None` if `session_id` is
/// unknown.
pub fn dismiss_session(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<SessionRow>> {
    conn.execute(
        "UPDATE sessions SET dismissed_at = ?2 WHERE session_id = ?1 AND dismissed_at IS NULL",
        params![session_id, now_millis()],
    )?;
    get_session(conn, session_id)
}

/// Lists sessions excluded from `dismissed_at IS NOT NULL` — the active
/// queue view (D-06/D-07). `list_sessions` (full/history) is unchanged.
pub fn list_active_sessions(conn: &Connection) -> rusqlite::Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, cwd, workspace, branch, status, task_summary, current_tool, source,
                started_at, last_activity_at, ended_at, dismissed_at
         FROM sessions WHERE dismissed_at IS NULL ORDER BY last_activity_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_session)?;
    rows.collect()
}

/// Reads a single session by its primary key.
pub fn get_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<SessionRow>> {
    conn.query_row(
        "SELECT session_id, cwd, workspace, branch, status, task_summary, current_tool, source,
                started_at, last_activity_at, ended_at, dismissed_at
         FROM sessions WHERE session_id = ?1",
        params![session_id],
        row_to_session,
    )
    .optional()
}

/// Lists all sessions, most-recently-active first.
pub fn list_sessions(conn: &Connection) -> rusqlite::Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, cwd, workspace, branch, status, task_summary, current_tool, source,
                started_at, last_activity_at, ended_at, dismissed_at
         FROM sessions ORDER BY last_activity_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_session)?;
    rows.collect()
}

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        session_id: row.get(0)?,
        cwd: row.get(1)?,
        workspace: row.get(2)?,
        branch: row.get(3)?,
        status: row.get(4)?,
        task_summary: row.get(5)?,
        current_tool: row.get(6)?,
        source: row.get(7)?,
        started_at: row.get(8)?,
        last_activity_at: row.get(9)?,
        ended_at: row.get(10)?,
        dismissed_at: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millis_to_rfc3339_epoch_zero() {
        assert_eq!(millis_to_rfc3339(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn millis_to_rfc3339_known_value() {
        // 2024-01-01T00:00:00.000Z
        assert_eq!(millis_to_rfc3339(1_704_067_200_000), "2024-01-01T00:00:00.000Z");
    }
}
