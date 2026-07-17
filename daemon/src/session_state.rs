//! Pure hook-event -> session-status transition model (MON-01) and
//! timeline-kind mapping (MON-03), per 01-03-PLAN.md's objective table.
//!
//! This module is intentionally side-effect-free: it takes the session's
//! current status plus the incoming hook event (and, for `Notification`, the
//! raw `notification_type` string) and returns the new status. Callers
//! (the ingest handlers, dispatched via `main.rs`'s DB-writer thread) are
//! responsible for actually persisting the result and appending the
//! matching timeline entry.
//!
//! The `Notification` classifier is centrally defined here (a single
//! match) precisely because the exact `notification_type` string values are
//! unconfirmed pending Task 3's live-install smoke test (01-RESEARCH.md
//! Open Question 1 / Assumption A2) — when Task 3 observes the real
//! strings, only this one function needs correcting.

/// The enumerated Phase-1 hook events this daemon consumes (01-03-PLAN.md
/// objective table). `SessionStart` is included for completeness even
/// though its handler was wired in Plan 01-02 and does not call through
/// this module today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Notification,
    Stop,
    SubagentStop,
    SessionEnd,
}

/// Waiting-state classification for a `Notification` event's
/// `notification_type` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationClass {
    WaitingPermission,
    WaitingInput,
}

/// Centrally-defined classifier mapping a raw `notification_type` string
/// into a waiting-state. Unrecognized values default to `WaitingInput`
/// (never silently dropped — 01-03-PLAN.md Task 1 action). The candidate
/// strings below are a reasoned best guess (RESEARCH.md A2); Task 3's live
/// smoke test confirms or corrects them against real Claude Code traffic —
/// this is the single place that correction needs to land.
pub fn classify_notification(notification_type: &str) -> NotificationClass {
    match notification_type {
        "permission_request" | "permission" | "tool_permission" | "permission_prompt" => {
            NotificationClass::WaitingPermission
        }
        "idle" | "waiting_for_input" | "input" | "needs_input" => NotificationClass::WaitingInput,
        _ => NotificationClass::WaitingInput,
    }
}

/// Pure transition function: given the session's current status string and
/// the incoming hook event (plus the `Notification` event's raw
/// `notification_type`, when applicable), returns the new status string.
///
/// Matches shared/types.ts's `SessionStatus` union exactly: "running",
/// "waiting-permission", "waiting-input", "done".
pub fn transition(current: &str, event: HookEvent, notification_type: Option<&str>) -> String {
    match event {
        HookEvent::SessionStart => "running".to_string(),
        // UserPromptSubmit clears any prior done/waiting state back to
        // running, regardless of what `current` was (01-03-PLAN.md Task 1
        // behavior).
        HookEvent::UserPromptSubmit => "running".to_string(),
        // PreToolUse is observe-only but still reflects the session as
        // actively running with a tool in flight.
        HookEvent::PreToolUse => "running".to_string(),
        // PostToolUse itself never changes status.
        HookEvent::PostToolUse => current.to_string(),
        HookEvent::Notification => match classify_notification(notification_type.unwrap_or("")) {
            NotificationClass::WaitingPermission => "waiting-permission".to_string(),
            NotificationClass::WaitingInput => "waiting-input".to_string(),
        },
        HookEvent::Stop | HookEvent::SubagentStop => "done".to_string(),
        // SessionEnd does not change status by itself (D-06/D-07: a
        // done/waiting unresolved session stays visible after the process
        // exits).
        HookEvent::SessionEnd => current.to_string(),
    }
}

/// Maps a hook event to its condensed-timeline `kind` (matches
/// shared/types.ts's `TimelineEventKind`). Returns `None` for events that
/// do not append a timeline entry of their own (`SessionStart` — handled by
/// Plan 01-02's upsert path; `SessionEnd` — 01-03-PLAN.md's objective table
/// lists no timeline entry for it).
pub fn timeline_kind(event: HookEvent) -> Option<&'static str> {
    match event {
        HookEvent::SessionStart => None,
        HookEvent::UserPromptSubmit => Some("user_prompt"),
        HookEvent::PreToolUse => Some("tool_use"),
        HookEvent::PostToolUse => Some("tool_result"),
        HookEvent::Notification => Some("notification"),
        HookEvent::Stop | HookEvent::SubagentStop => Some("completion"),
        HookEvent::SessionEnd => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_transitions_to_done_from_any_status() {
        assert_eq!(transition("running", HookEvent::Stop, None), "done");
        assert_eq!(transition("waiting-input", HookEvent::Stop, None), "done");
        assert_eq!(
            transition("waiting-permission", HookEvent::SubagentStop, None),
            "done"
        );
    }

    #[test]
    fn user_prompt_submit_clears_done_back_to_running() {
        assert_eq!(
            transition("done", HookEvent::UserPromptSubmit, None),
            "running"
        );
    }

    #[test]
    fn post_tool_use_does_not_change_status() {
        assert_eq!(
            transition("running", HookEvent::PostToolUse, None),
            "running"
        );
    }

    #[test]
    fn session_end_does_not_change_status() {
        assert_eq!(transition("done", HookEvent::SessionEnd, None), "done");
        assert_eq!(
            transition("waiting-input", HookEvent::SessionEnd, None),
            "waiting-input"
        );
    }

    #[test]
    fn notification_classifies_permission_vs_idle() {
        assert_eq!(
            transition("running", HookEvent::Notification, Some("permission_request")),
            "waiting-permission"
        );
        assert_eq!(
            transition("running", HookEvent::Notification, Some("idle")),
            "waiting-input"
        );
    }

    #[test]
    fn notification_defaults_unrecognized_type_to_waiting_input() {
        assert_eq!(
            classify_notification("some_future_unknown_type"),
            NotificationClass::WaitingInput
        );
    }

    #[test]
    fn timeline_kind_maps_every_enumerated_event() {
        assert_eq!(timeline_kind(HookEvent::UserPromptSubmit), Some("user_prompt"));
        assert_eq!(timeline_kind(HookEvent::PreToolUse), Some("tool_use"));
        assert_eq!(timeline_kind(HookEvent::PostToolUse), Some("tool_result"));
        assert_eq!(timeline_kind(HookEvent::Notification), Some("notification"));
        assert_eq!(timeline_kind(HookEvent::Stop), Some("completion"));
        assert_eq!(timeline_kind(HookEvent::SubagentStop), Some("completion"));
        assert_eq!(timeline_kind(HookEvent::SessionEnd), None);
    }
}
