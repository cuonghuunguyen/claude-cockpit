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
pub fn classify_notification(_notification_type: &str) -> NotificationClass {
    // RED: not yet implemented — see 01-03-PLAN.md Task 1 GREEN commit.
    todo!("classify_notification: implement in GREEN commit")
}

/// Pure transition function: given the session's current status string and
/// the incoming hook event (plus the `Notification` event's raw
/// `notification_type`, when applicable), returns the new status string.
///
/// Matches shared/types.ts's `SessionStatus` union exactly: "running",
/// "waiting-permission", "waiting-input", "done".
pub fn transition(_current: &str, _event: HookEvent, _notification_type: Option<&str>) -> String {
    // RED: not yet implemented — see 01-03-PLAN.md Task 1 GREEN commit.
    todo!("transition: implement in GREEN commit")
}

/// Maps a hook event to its condensed-timeline `kind` (matches
/// shared/types.ts's `TimelineEventKind`). Returns `None` for events that
/// do not append a timeline entry of their own (`SessionStart` — handled by
/// Plan 01-02's upsert path; `SessionEnd` — 01-03-PLAN.md's objective table
/// lists no timeline entry for it).
pub fn timeline_kind(_event: HookEvent) -> Option<&'static str> {
    // RED: not yet implemented — see 01-03-PLAN.md Task 1 GREEN commit.
    todo!("timeline_kind: implement in GREEN commit")
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
