//! `POST /hooks/pre-tool-use` handler — **observe-only in Phase 1**.
//!
//! Records the upcoming tool call (`tool_use` timeline entry, sets
//! `current_tool`) but never emits any hook-specific-output decision/
//! override field (the permission-verdict field Claude Code's schema
//! defines for this hook — deliberately not named literally in this file,
//! since it must never appear here at all): this handler always acks 200
//! with no body, i.e. Claude Code's own permission check runs unmodified.
//! Deciding permissions is Phase 3 (FND-04) — see 01-03-PLAN.md threat
//! T-01-06a and this plan's negative acceptance check on this file.

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{ingest, session_state::HookEvent, AppState, IngestEventRequest};

pub async fn pre_tool_use(
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
    let condensed_input = payload
        .get("tool_input")
        .map(|v| ingest::condensed_json_summary(v, 200))
        .unwrap_or_default();
    let summary = match &tool_name {
        Some(name) => format!("{name}: {condensed_input}"),
        None => condensed_input,
    };

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::PreToolUse,
        cwd,
        notification_type: None,
        tool_name,
        timeline_summary: summary,
        payload_json: Some(payload.to_string()),
        is_error: false,
        first_prompt_text: None,
        mark_ended: false,
    };

    // Observe-only ack — no permission-decision output of any kind.
    ingest::dispatch_ingest_event(&state, request).await
}
