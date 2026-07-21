//! `POST /hooks/session-end` handler.
//!
//! Marks `ended_at` (via `IngestEventRequest.mark_ended`) but never changes
//! `status` by itself — a `done`/`waiting-*` unresolved session stays
//! visible in the active queue after the process exits (D-06/D-07).

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{session_state::HookEvent, AppState, IngestEventRequest};

pub async fn session_end(
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
    let reason = payload
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::SessionEnd,
        cwd,
        notification_type: None,
        tool_name: None,
        timeline_summary: format!("session ended ({reason})"),
        payload_json: Some(payload.to_string()),
        is_error: false,
        first_prompt_text: None,
        mark_ended: true,
    };

    crate::ingest::dispatch_ingest_event(&state, request).await
}
