//! Ingest routes: one handler module per Claude Code hook event. Plan 01-02
//! wired only `session-start` (Walking Skeleton part B); Plan 01-03 adds the
//! full remaining event-type coverage (UserPromptSubmit, PreToolUse,
//! PostToolUse, Notification, Stop/SubagentStop, SessionEnd) plus the
//! dismiss endpoint (D-06).

pub mod notification;
pub mod post_tool_use;
pub mod pre_tool_use;
pub mod session_end;
pub mod session_start;
pub mod stop;
pub mod user_prompt_submit;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::{AppState, DbCommand, IngestEventRequest};

/// Token-gated ingest + read routes. Merged into the auth-protected half of
/// the router in `main.rs::build_router`.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/hooks/session-start", post(session_start::session_start))
        .route(
            "/hooks/user-prompt-submit",
            post(user_prompt_submit::user_prompt_submit),
        )
        .route("/hooks/pre-tool-use", post(pre_tool_use::pre_tool_use))
        .route("/hooks/post-tool-use", post(post_tool_use::post_tool_use))
        .route("/hooks/notification", post(notification::notification))
        .route("/hooks/stop", post(stop::stop))
        // SubagentStop routes to the same handler as Stop (both -> done,
        // 01-03-PLAN.md objective table).
        .route("/hooks/subagent-stop", post(stop::stop))
        .route("/hooks/session-end", post(session_end::session_end))
        .route("/sessions", get(list_sessions))
        .route("/sessions/{id}/dismiss", post(dismiss_session))
        .route("/sessions/{id}/events", get(list_session_events))
}

#[derive(Debug, Deserialize)]
struct ListSessionsQuery {
    /// `?active=true` (or `1`) restricts the listing to the active queue —
    /// `dismissed_at IS NULL` (D-06/D-07). Omitted/false returns the full
    /// history listing (unchanged default behavior from Plan 01-02).
    #[serde(default)]
    active: Option<String>,
}

fn is_truthy(v: &str) -> bool {
    matches!(v, "1" | "true" | "TRUE" | "yes")
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListSessionsQuery>,
) -> Result<Json<Vec<crate::store::SessionApi>>, StatusCode> {
    let active_only = query.active.as_deref().is_some_and(is_truthy);

    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::ListSessions {
            active_only,
            respond,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let api: Vec<crate::store::SessionApi> = rows.iter().map(Into::into).collect();
    Ok(Json(api))
}

/// `POST /sessions/:id/dismiss` (D-06): marks the session resolved so it
/// leaves the active queue (history retained).
async fn dismiss_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::DismissSession {
            session_id,
            respond,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let row = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match row {
        Some(row) => {
            publish_session_update(&state, &row);
            Ok(StatusCode::OK)
        }
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// `GET /sessions/:id/events` (Plan 01-05 D-09): the dashboard's expandable
/// per-session condensed-timeline fetch. Returns `[]` (not 404) for an
/// unknown session_id — the frontend only calls this for a session it
/// already has from `GET /sessions`, so an empty timeline is the correct,
/// harmless response rather than a special-cased error.
async fn list_session_events(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<crate::store::EventApi>>, StatusCode> {
    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::ListEvents { session_id, respond })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let api: Vec<crate::store::EventApi> = rows.iter().map(Into::into).collect();
    Ok(Json(api))
}

/// Shared dispatch helper used by every Plan 01-03 ingest handler: sends the
/// built [`IngestEventRequest`] to the DB-writer thread, awaits the updated
/// row, publishes it to the SSE broadcast channel (MON-04), and acks 200
/// fast. Centralizing this avoids duplicating the send/await/publish
/// boilerplate across six near-identical handler files.
pub async fn dispatch_ingest_event(
    state: &Arc<AppState>,
    request: IngestEventRequest,
) -> Result<StatusCode, StatusCode> {
    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::IngestEvent { request, respond })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let row = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    publish_session_update(state, &row);
    Ok(StatusCode::OK)
}

fn publish_session_update(state: &Arc<AppState>, row: &crate::store::SessionRow) {
    let api: crate::store::SessionApi = row.into();
    if let Ok(json) = serde_json::to_string(&api) {
        // Best-effort: `send` errors only when there are zero subscribers,
        // which is expected whenever no SSE client is currently connected.
        let _ = state.event_tx.send(json);
    }
}

/// Truncates an arbitrary JSON value into a short, human-readable summary
/// string for the condensed timeline (D-09) — used by handlers whose
/// payload includes free-form `tool_input`/`tool_response` data that must
/// never blow up storage (T-01-03a).
pub fn condensed_json_summary(value: &serde_json::Value, max_len: usize) -> String {
    condensed_text(&value.to_string(), max_len)
}

/// Truncates a plain-text string (e.g. a user prompt or assistant message)
/// to `max_len` characters for the condensed timeline (D-09/T-01-03a).
pub fn condensed_text(s: &str, max_len: usize) -> String {
    if s.chars().count() > max_len {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{truncated}…")
    } else {
        s.to_string()
    }
}
