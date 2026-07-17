//! Ingest routes: one handler module per Claude Code hook event. Phase 1
//! Plan 01-02 wires only `session-start` (Walking Skeleton part B); the full
//! event-type coverage (UserPromptSubmit, PreToolUse, PostToolUse,
//! Notification, Stop/SubagentStop, SessionEnd) arrives in Plan 01-03.

pub mod session_start;

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::{AppState, DbCommand};

/// Token-gated ingest + read routes. Merged into the auth-protected half of
/// the router in `main.rs::build_router`.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/hooks/session-start", post(session_start::session_start))
        .route("/sessions", get(list_sessions))
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::store::SessionApi>>, StatusCode> {
    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::ListSessions { respond })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let api: Vec<crate::store::SessionApi> = rows.iter().map(Into::into).collect();
    Ok(Json(api))
}
