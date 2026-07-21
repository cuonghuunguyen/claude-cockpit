//! `POST /hooks/user-prompt-submit` handler.
//!
//! Appends a `user_prompt` timeline entry and, if this is the session's
//! first-ever prompt, stores it verbatim as the stable `task_summary`
//! (D-08) — later prompts never overwrite it (`store::
//! set_task_summary_if_absent` is idempotent). Also clears any prior
//! `done`/`waiting-*` status back to `running` (01-03-PLAN.md Task 1
//! behavior), via `session_state::transition`.

use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::sync::Arc;

use crate::{ingest, session_state::HookEvent, AppState, IngestEventRequest};

pub async fn user_prompt_submit(
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

    // Claude Code's documented field name is `prompt`; `message` is
    // accepted defensively (exact payload shape verified live in Task 3).
    let prompt_text = payload
        .get("prompt")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let summary = ingest::condensed_text(&prompt_text, 200);

    let request = IngestEventRequest {
        session_id,
        event: HookEvent::UserPromptSubmit,
        cwd,
        notification_type: None,
        tool_name: None,
        timeline_summary: summary,
        payload_json: Some(payload.to_string()),
        is_error: false,
        first_prompt_text: if prompt_text.is_empty() {
            None
        } else {
            Some(prompt_text)
        },
        mark_ended: false,
    };

    ingest::dispatch_ingest_event(&state, request).await
}
