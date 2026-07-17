//! `POST /hooks/post-tool-use` handler.
//!
//! Appends a `tool_result` timeline entry (never changes status —
//! `session_state::transition` maps `PostToolUse` to a no-op) and clears
//! `current_tool` (the in-flight tool call has finished). If the payload
//! indicates the tool call itself failed, the event is recorded as an
//! `error` (D-10/MON-05: visible in the timeline only, never a status
//! change or notification — `PostToolUse` was already a status no-op, so
//! this is consistent either way).

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{ingest, session_state::HookEvent, AppState, IngestEventRequest};

pub async fn post_tool_use(
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
    let tool_name = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let condensed_output = payload
        .get("tool_response")
        .map(|v| ingest::condensed_json_summary(v, 200))
        .unwrap_or_default();
    let summary = match &tool_name {
        Some(name) => format!("{name}: {condensed_output}"),
        None => condensed_output,
    };

    // Best-effort detection of a failed tool call — exact field name/shape
    // unconfirmed (RESEARCH.md payload-uncertainty note); check the common
    // candidates defensively rather than assuming one.
    let is_error = payload
        .get("tool_response")
        .and_then(|r| r.get("is_error"))
        .and_then(Value::as_bool)
        .or_else(|| payload.get("is_error").and_then(Value::as_bool))
        .unwrap_or(false);

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::PostToolUse,
        cwd,
        notification_type: None,
        tool_name,
        timeline_summary: summary,
        payload_json: Some(payload.to_string()),
        is_error,
        first_prompt_text: None,
        mark_ended: false,
    };

    ingest::dispatch_ingest_event(&state, request).await
}
