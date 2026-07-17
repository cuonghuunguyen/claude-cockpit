//! `POST /hooks/session-start` handler.
//!
//! Parses the Claude Code `SessionStart` payload, upserts the session row
//! off the hot path (via the dedicated DB-writer channel — see
//! `main.rs::spawn_db_writer`), acknowledges fast, and publishes the updated
//! session on the SSE broadcast channel so `GET /events` (added in Plan
//! 01-02 Task 2) can push it live to the Tauri backend.

use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::{AppState, DbCommand};

#[derive(Debug, Deserialize)]
pub struct SessionStartPayload {
    pub session_id: String,
    pub cwd: String,
    /// Claude Code's own SessionStart reason (startup/resume/clear/compact),
    /// NOT an origin-environment classification — see `store::SessionApi`
    /// doc comment for why these are different concepts.
    #[serde(default)]
    pub source: Option<String>,
}

pub async fn session_start(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SessionStartPayload>,
) -> Result<StatusCode, StatusCode> {
    let source = payload.source.unwrap_or_else(|| "unknown".to_string());

    let (respond, rx) = oneshot::channel();
    state
        .db_tx
        .send(DbCommand::SessionStart {
            session_id: payload.session_id,
            cwd: payload.cwd,
            source,
            respond,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let row = rx.await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let api: crate::store::SessionApi = (&row).into();
    if let Ok(json) = serde_json::to_string(&api) {
        // Best-effort: `send` errors only when there are zero subscribers,
        // which is expected whenever no SSE client is currently connected.
        let _ = state.event_tx.send(json);
    }

    Ok(StatusCode::OK)
}
