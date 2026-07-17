//! `POST /hooks/stop` and `POST /hooks/subagent-stop` handler (shared —
//! both events map identically: `session_state::transition` -> `done`,
//! `session_state::timeline_kind` -> `"completion"`, D-05: a finished
//! session stays prominent until acted on or dismissed).

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{ingest, session_state::HookEvent, AppState, IngestEventRequest};

pub async fn stop(
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
    let summary = payload
        .get("last_assistant_message")
        .and_then(Value::as_str)
        .map(|s| ingest::condensed_text(s, 200))
        .unwrap_or_else(|| "Agent turn complete".to_string());

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::Stop,
        cwd,
        notification_type: None,
        tool_name: None,
        timeline_summary: summary,
        payload_json: Some(payload.to_string()),
        is_error: false,
        first_prompt_text: None,
        mark_ended: false,
    };

    ingest::dispatch_ingest_event(&state, request).await
}
