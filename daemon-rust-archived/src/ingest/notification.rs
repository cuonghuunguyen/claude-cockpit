//! `POST /hooks/notification` handler.
//!
//! The **only** event that drives `waiting-permission`/`waiting-input`
//! status (not `PreToolUse` — 01-RESEARCH.md's Hook Payload → Session-State
//! Mapping table). Classifies the raw `notification_type` string via the
//! single centrally-defined `session_state::classify_notification`
//! function; Task 3's live-install smoke test confirms/corrects the exact
//! string values against real Claude Code traffic.

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{ingest, session_state::HookEvent, AppState, IngestEventRequest};

pub async fn notification(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Result<StatusCode, StatusCode> {
    let session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or(StatusCode::BAD_REQUEST)?
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let notification_type = payload
        .get("notification_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::Notification,
        cwd,
        notification_type,
        tool_name: None,
        timeline_summary: ingest::condensed_text(&message, 200),
        payload_json: Some(payload.to_string()),
        is_error: false,
        first_prompt_text: None,
        mark_ended: false,
    };

    ingest::dispatch_ingest_event(&state, request).await
}
