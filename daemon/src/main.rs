//! Claude Cockpit daemon — WSL-hosted axum service.
//!
//! Phase 1, Plan 01-02: binds `0.0.0.0:9427` inside WSL, generates/loads a
//! per-install CSPRNG token, opens a WAL-mode SQLite store on the WSL-native
//! filesystem, and wires the token-gated ingest routes.

mod auth;
mod events_sse;
mod ingest;
mod session_state;
mod store;

use axum::{routing::get, Router};
use rand::TryRng;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot};

/// Fixed daemon port, mirrored from `shared/types.ts`'s `COCKPIT_PORT`.
///
/// Locked per SKELETON.md: the daemon binds `0.0.0.0:9427` inside WSL so
/// Windows' localhost-forwarding proxy (default NAT-mode WSL2 networking)
/// can reach it from native-Windows and VS Code sessions, while WSL-origin
/// sessions reach it via ordinary same-host loopback. Security is enforced
/// by the per-install token + zero CORS (FND-05), not by bind address
/// (01-RESEARCH.md Pitfall A).
const COCKPIT_PORT: u16 = 9427;

/// CSPRNG token length in bytes (>= 32 per FND-05 / Don't-Hand-Roll table).
const TOKEN_BYTES: usize = 32;

/// Everything an ingest handler (Plan 01-03 Task 1) needs the DB-writer
/// thread to do for one incoming hook event: compute the status transition
/// (`session_state::transition`), update the session row, optionally set
/// the first-prompt task summary (D-08), and append a condensed-timeline
/// entry (unless `timeline_kind` is `None`, e.g. `SessionEnd`).
///
/// `is_error` events (Rule: D-10/MON-05) skip the status transition
/// entirely — they are recorded for visibility only and never reorder or
/// notify.
pub struct IngestEventRequest {
    pub session_id: String,
    pub event: session_state::HookEvent,
    /// Raw `cwd`, when the payload carries one (currently unused by any
    /// Plan 01-03 event — SessionStart already handles cwd in Plan 01-02 —
    /// kept for forward compatibility / defensive `ensure_session` calls).
    pub cwd: Option<String>,
    pub notification_type: Option<String>,
    pub tool_name: Option<String>,
    pub timeline_summary: String,
    pub payload_json: Option<String>,
    pub is_error: bool,
    /// Set only by `UserPromptSubmit`: the prompt text to store as
    /// `task_summary` if this is the session's first-ever prompt.
    pub first_prompt_text: Option<String>,
    /// Set only by `SessionEnd`: marks `ended_at` without touching status.
    pub mark_ended: bool,
}

/// Commands sent to the dedicated SQLite writer thread. A single writer
/// path is how this daemon avoids hand-rolled locking under concurrent hook
/// POSTs (01-RESEARCH.md "Persistence" / Don't-Hand-Roll table).
pub enum DbCommand {
    SessionStart {
        session_id: String,
        cwd: String,
        source: String,
        respond: oneshot::Sender<store::SessionRow>,
    },
    ListSessions {
        respond: oneshot::Sender<Vec<store::SessionRow>>,
    },
    /// One entry point for every Plan 01-03 ingest handler (UserPromptSubmit,
    /// PreToolUse, PostToolUse, Notification, Stop, SubagentStop,
    /// SessionEnd) — see [`IngestEventRequest`].
    IngestEvent {
        request: IngestEventRequest,
        respond: oneshot::Sender<store::SessionRow>,
    },
    /// `POST /sessions/:id/dismiss` (D-06).
    DismissSession {
        session_id: String,
        respond: oneshot::Sender<Option<store::SessionRow>>,
    },
}

/// Shared daemon state: the loaded auth token, a handle to the DB writer,
/// and the SSE broadcast channel (subscribed to by `events_sse` in Task 2).
pub struct AppState {
    pub token: String,
    pub db_tx: mpsc::Sender<DbCommand>,
    pub event_tx: broadcast::Sender<String>,
}

/// Resolves `~/.cockpit`, refusing to proceed if `$HOME` resolves under
/// `/mnt/...` (DrvFs) — 01-RESEARCH.md Pitfall D: SQLite's locking model is
/// unreliable on DrvFs cross-OS mounts.
fn cockpit_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME env var must be set (WSL-native filesystem)");
    let dir = PathBuf::from(&home).join(".cockpit");
    if home.starts_with("/mnt/") {
        panic!(
            "refusing to run with $HOME ({home}) under /mnt/ (DrvFs) — \
             cockpit.db must live on the WSL-native filesystem, see \
             01-RESEARCH.md Pitfall D"
        );
    }
    dir
}

/// Loads the per-install token from `~/.cockpit/token`, generating one via a
/// CSPRNG (`OsRng`, >= 32 bytes, hex-encoded) and persisting it with 0600
/// permissions if it does not already exist.
fn load_or_create_token(dir: &std::path::Path) -> std::io::Result<String> {
    let token_path = dir.join("token");
    if token_path.exists() {
        let contents = fs::read_to_string(&token_path)?;
        return Ok(contents.trim().to_string());
    }

    // rand 0.10 renamed the OS-CSPRNG type to `SysRng` (re-exported from the
    // `getrandom` crate) and it implements the fallible `TryRng` trait
    // rather than the infallible `Rng` — the OS entropy source can fail.
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS CSPRNG (SysRng) failed to generate the per-install token");
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    fs::write(&token_path, &token)?;
    set_owner_only_permissions(&token_path)?;
    Ok(token)
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// Builds the axum router: `/health` is unauthenticated (liveness only, no
/// data); every other route requires the per-install token (FND-05), and
/// this daemon emits no permissive CORS headers on any route.
pub fn build_router(state: Arc<AppState>) -> Router {
    let protected = ingest::routes()
        .merge(events_sse::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(protected)
        .with_state(state)
}

/// Spawns a single dedicated writer thread owning the SQLite connection.
/// `rusqlite::Connection` is not `Sync`, so rather than sharing it across
/// tokio's async worker threads, every write/read goes through this one
/// thread via an mpsc channel — trivially safe, and matches WAL mode's
/// single-writer/multi-reader model.
fn spawn_db_writer(conn: rusqlite::Connection) -> mpsc::Sender<DbCommand> {
    let (tx, mut rx) = mpsc::channel::<DbCommand>(256);
    std::thread::spawn(move || {
        while let Some(cmd) = rx.blocking_recv() {
            match cmd {
                DbCommand::SessionStart {
                    session_id,
                    cwd,
                    source,
                    respond,
                } => {
                    if let Ok(row) = store::upsert_session_start(&conn, &session_id, &cwd, &source) {
                        let _ = respond.send(row);
                    }
                }
                DbCommand::ListSessions { respond } => {
                    let rows = store::list_sessions(&conn).unwrap_or_default();
                    let _ = respond.send(rows);
                }
                DbCommand::IngestEvent { request, respond } => {
                    if let Ok(row) = handle_ingest_event(&conn, request) {
                        let _ = respond.send(row);
                    }
                }
                DbCommand::DismissSession { session_id, respond } => {
                    let row = store::dismiss_session(&conn, &session_id)
                        .ok()
                        .flatten();
                    let _ = respond.send(row);
                }
            }
        }
    });
    tx
}

/// Applies one [`IngestEventRequest`] against the store: ensures the
/// session row exists (defensive against a hook arriving before/without a
/// SessionStart — e.g. Cockpit started mid-session), computes the status
/// transition (skipped entirely for `is_error` events per D-10/MON-05),
/// stores the first-prompt task summary when present, appends the
/// condensed-timeline entry (when the event has one), and marks `ended_at`
/// for `SessionEnd`.
fn handle_ingest_event(
    conn: &rusqlite::Connection,
    req: IngestEventRequest,
) -> rusqlite::Result<store::SessionRow> {
    let existing = store::get_session(conn, &req.session_id)?;
    let current_status = existing
        .as_ref()
        .map(|r| r.status.clone())
        .unwrap_or_else(|| "running".to_string());
    if existing.is_none() {
        store::ensure_session(conn, &req.session_id, req.cwd.as_deref())?;
    }

    if req.is_error {
        // Errors are timeline-only (D-10/MON-05): never touch status, never
        // reorder, never notify. Still bump last_activity_at so the card's
        // "last activity" reflects real traffic.
        store::touch_last_activity(conn, &req.session_id)?;
    } else if req.mark_ended {
        // SessionEnd: mark ended_at only, status stays whatever it already
        // was (D-06/D-07 — a done/waiting unresolved session stays visible).
        store::mark_ended(conn, &req.session_id)?;
    } else {
        let new_status = session_state::transition(
            &current_status,
            req.event,
            req.notification_type.as_deref(),
        );
        // PreToolUse is the only event that sets a current_tool; every
        // other event clears it (no tool is currently in flight).
        let current_tool = if matches!(req.event, session_state::HookEvent::PreToolUse) {
            req.tool_name.as_deref()
        } else {
            None
        };
        store::update_session_status(conn, &req.session_id, &new_status, current_tool)?;

        if let Some(text) = &req.first_prompt_text {
            store::set_task_summary_if_absent(conn, &req.session_id, text)?;
        }
    }

    // An error always surfaces as an "error" timeline kind regardless of
    // its originating hook event (D-10/MON-05: visibility only, never a
    // status/notification effect — already guaranteed above since the
    // `req.is_error` branch never calls `transition`/`update_session_status`).
    let kind = if req.is_error {
        Some("error")
    } else {
        session_state::timeline_kind(req.event)
    };
    if let Some(kind) = kind {
        store::append_event(
            conn,
            &req.session_id,
            kind,
            req.tool_name.as_deref(),
            &req.timeline_summary,
            req.payload_json.as_deref(),
            req.is_error,
        )?;
    }

    store::get_session(conn, &req.session_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

#[tokio::main]
async fn main() {
    let dir = cockpit_dir();
    fs::create_dir_all(&dir).expect("failed to create ~/.cockpit");

    let token = load_or_create_token(&dir).expect("failed to load/create per-install token");

    let db_path = dir.join("cockpit.db");
    let conn = store::open_db(&db_path).expect("failed to open cockpit.db (WAL)");

    let db_tx = spawn_db_writer(conn);
    let (event_tx, _rx) = broadcast::channel::<String>(256);

    let state = Arc::new(AppState {
        token,
        db_tx,
        event_tx,
    });

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", COCKPIT_PORT))
        .await
        .unwrap_or_else(|e| panic!("failed to bind 0.0.0.0:{COCKPIT_PORT}: {e}"));

    println!("cockpit-daemon listening on 0.0.0.0:{COCKPIT_PORT}");
    axum::serve(listener, app)
        .await
        .expect("axum server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spins up a full daemon instance (real router, real SQLite at a temp
    /// path, real DB-writer thread) bound to an OS-assigned loopback port,
    /// and returns its base URL. Exercises the exact same code path as
    /// `main()`, just without the fixed 9427 bind (so tests can run
    /// concurrently / without root).
    async fn spawn_test_daemon(token: &str) -> String {
        let db_path = std::env::temp_dir().join(format!(
            "cockpit-test-{}-{}.db",
            std::process::id(),
            now_suffix()
        ));
        let _ = std::fs::remove_file(&db_path);

        let conn = store::open_db(&db_path).expect("open test db");
        let db_tx = spawn_db_writer(conn);
        let (event_tx, _rx) = broadcast::channel::<String>(16);
        let state = Arc::new(AppState {
            token: token.to_string(),
            db_tx,
            event_tx,
        });

        let app = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        format!("http://{addr}")
    }

    fn now_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[tokio::test]
    async fn health_is_reachable_without_a_token() {
        let base = spawn_test_daemon("irrelevant-token-for-this-test").await;
        let client = reqwest::Client::new();
        let resp = client
            .get(format!("{base}/health"))
            .send()
            .await
            .expect("GET /health");
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn session_start_requires_token_and_upserts_exactly_one_row() {
        let token = "test-token-0123456789abcdef0123456789abcdef";
        let base = spawn_test_daemon(token).await;
        let client = reqwest::Client::new();

        // No token -> 401, and no row is written.
        let resp = client
            .post(format!("{base}/hooks/session-start"))
            .json(&serde_json::json!({"session_id": "t1", "cwd": "/tmp/x", "source": "startup"}))
            .send()
            .await
            .expect("POST without token");
        assert_eq!(resp.status(), 401, "un-tokened session-start must be rejected");

        // Valid token -> 200.
        let resp = client
            .post(format!("{base}/hooks/session-start"))
            .bearer_auth(token)
            .json(&serde_json::json!({"session_id": "t1", "cwd": "/tmp/x", "source": "startup"}))
            .send()
            .await
            .expect("POST with token");
        assert_eq!(resp.status(), 200);

        // Second session-start for the same session_id upserts, not
        // duplicates.
        let resp = client
            .post(format!("{base}/hooks/session-start"))
            .bearer_auth(token)
            .json(&serde_json::json!({"session_id": "t1", "cwd": "/tmp/y", "source": "resume"}))
            .send()
            .await
            .expect("POST duplicate session_id");
        assert_eq!(resp.status(), 200);

        // GET /sessions with a valid token -> 200 JSON array including the
        // one upserted session (camelCase, matching shared/types.ts).
        let resp = client
            .get(format!("{base}/sessions"))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET /sessions");
        assert_eq!(resp.status(), 200);
        assert!(
            resp.headers().get("access-control-allow-origin").is_none(),
            "daemon must never emit a CORS header (FND-05)"
        );
        let body: serde_json::Value = resp.json().await.expect("parse /sessions JSON");
        let sessions = body.as_array().expect("/sessions returns a JSON array");
        assert_eq!(
            sessions.len(),
            1,
            "duplicate session-start must upsert, not create a second row"
        );
        assert_eq!(sessions[0]["sessionId"], "t1");

        // GET /sessions without a token -> 401.
        let resp = client
            .get(format!("{base}/sessions"))
            .send()
            .await
            .expect("GET /sessions without token");
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn events_sse_is_token_gated_and_streams_session_start() {
        use futures_util::StreamExt;

        let token = "sse-test-token-0123456789abcdef0123456789";
        let base = spawn_test_daemon(token).await;
        let client = reqwest::Client::new();

        // No token -> 401 (SSE endpoint is behind the same auth middleware).
        let resp = client
            .get(format!("{base}/events"))
            .send()
            .await
            .expect("GET /events without token");
        assert_eq!(resp.status(), 401);

        // Valid token -> 200, and a subsequent session-start is streamed.
        let resp = client
            .get(format!("{base}/events"))
            .bearer_auth(token)
            .send()
            .await
            .expect("GET /events with token");
        assert_eq!(resp.status(), 200);

        let mut stream = resp.bytes_stream();

        // Give the SSE subscriber a moment to register before publishing.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        client
            .post(format!("{base}/hooks/session-start"))
            .bearer_auth(token)
            .json(&serde_json::json!({"session_id": "sse1", "cwd": "/tmp/z", "source": "startup"}))
            .send()
            .await
            .expect("POST session-start to trigger SSE frame");

        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
            .await
            .expect("SSE frame did not arrive within 5s")
            .expect("SSE stream ended unexpectedly")
            .expect("SSE stream chunk error");
        let text = String::from_utf8_lossy(&frame);
        assert!(
            text.contains("sse1"),
            "expected the session-start SSE frame to mention session_id sse1, got: {text}"
        );
    }
}
