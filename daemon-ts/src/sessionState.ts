/**
 * Pure hook-event -> session-status transition model (MON-01) and
 * timeline-kind mapping (MON-03). Port of `daemon/src/session_state.rs`
 * (whole file, 174 lines) — intentionally side-effect-free (no imports of
 * store/fs/http): callers (the ingest handlers, via `ingest/dispatch.ts`)
 * are responsible for actually persisting the result and appending the
 * matching timeline entry.
 *
 * The `Notification` classifier is centrally defined here (a single
 * switch) precisely because the exact `notification_type` string values
 * were unconfirmed pending live-install validation (Phase 1 Open Question)
 * — when real traffic is observed, only this one function needs
 * correcting.
 */

/**
 * The enumerated hook events this daemon consumes. `SessionStart` is
 * included for completeness even though its handler
 * (`ingest/sessionStart.ts`) calls `store.upsertSessionStart` directly and
 * does not route through this module's `transition`/`timelineKind`
 * (mirrors `daemon/src/ingest/session_start.rs`, which also bypasses
 * `handle_ingest_event`).
 */
export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "SessionEnd";

/** Waiting-state classification for a `Notification` event's `notification_type` field. */
export type NotificationClass = "WaitingPermission" | "WaitingInput";

/**
 * Centrally-defined classifier mapping a raw `notification_type` string
 * into a waiting-state. Unrecognized values (including any future/unknown
 * string) default to `WaitingInput` (never silently dropped). Port of
 * `session_state.rs::classify_notification` lines 47-55 — copy the exact
 * string list.
 */
export function classifyNotification(notificationType: string): NotificationClass {
  switch (notificationType) {
    case "permission_request":
    case "permission":
    case "tool_permission":
    case "permission_prompt":
      return "WaitingPermission";
    default:
      return "WaitingInput";
  }
}

/**
 * Pure transition function: given the session's current status string and
 * the incoming hook event (plus the `Notification` event's raw
 * `notificationType`, when applicable), returns the new status string.
 *
 * Matches `shared/types.ts`'s `SessionStatus` union exactly: "running",
 * "waiting-permission", "waiting-input", "done". Port of
 * `session_state.rs::transition` lines 63-85 — copy the match arms
 * verbatim.
 */
export function transition(
  current: string,
  event: HookEvent,
  notificationType?: string,
): string {
  switch (event) {
    case "SessionStart":
      return "running";
    // UserPromptSubmit clears any prior done/waiting state back to
    // running, regardless of what `current` was.
    case "UserPromptSubmit":
      return "running";
    // PreToolUse is observe-only but still reflects the session as
    // actively running with a tool in flight.
    case "PreToolUse":
      return "running";
    // PostToolUse itself never changes status.
    case "PostToolUse":
      return current;
    case "Notification":
      return classifyNotification(notificationType ?? "") === "WaitingPermission"
        ? "waiting-permission"
        : "waiting-input";
    case "Stop":
    case "SubagentStop":
      return "done";
    // SessionEnd does not change status by itself (a done/waiting
    // unresolved session stays visible after the process exits).
    case "SessionEnd":
      return current;
  }
}

/**
 * Maps a hook event to its condensed-timeline `kind` (matches
 * `shared/types.ts`'s `TimelineEventKind`). Returns `null` for events that
 * do not append a timeline entry of their own (`SessionStart` — handled by
 * `ingest/sessionStart.ts`'s upsert path; `SessionEnd` — no timeline
 * entry). Port of `session_state.rs::timeline_kind` lines 92-102.
 */
export function timelineKind(event: HookEvent): string | null {
  switch (event) {
    case "SessionStart":
      return null;
    case "UserPromptSubmit":
      return "user_prompt";
    case "PreToolUse":
      return "tool_use";
    case "PostToolUse":
      return "tool_result";
    case "Notification":
      return "notification";
    case "Stop":
    case "SubagentStop":
      return "completion";
    case "SessionEnd":
      return null;
  }
}
