import { describe, expect, it } from "vitest";

import { classifyNotification, timelineKind, transition } from "../src/sessionState.js";

// Ported from daemon/src/session_state.rs's #[cfg(test)] mod tests (lines
// 104-173) — same test names/assertions, reproduced 1:1 in vitest.
describe("sessionState", () => {
  it("stop_transitions_to_done_from_any_status", () => {
    expect(transition("running", "Stop")).toBe("done");
    expect(transition("waiting-input", "Stop")).toBe("done");
    expect(transition("waiting-permission", "SubagentStop")).toBe("done");
  });

  it("user_prompt_submit_clears_done_back_to_running", () => {
    expect(transition("done", "UserPromptSubmit")).toBe("running");
  });

  it("post_tool_use_does_not_change_status", () => {
    expect(transition("running", "PostToolUse")).toBe("running");
    expect(transition("waiting-input", "PostToolUse")).toBe("waiting-input");
  });

  it("session_end_does_not_change_status", () => {
    expect(transition("done", "SessionEnd")).toBe("done");
    expect(transition("waiting-input", "SessionEnd")).toBe("waiting-input");
  });

  it("notification_classifies_permission_vs_idle", () => {
    expect(transition("running", "Notification", "permission_request")).toBe("waiting-permission");
    expect(transition("running", "Notification", "idle")).toBe("waiting-input");
  });

  it("notification_defaults_unrecognized_type_to_waiting_input", () => {
    expect(classifyNotification("some_future_unknown_type")).toBe("WaitingInput");
    // Never dropped/undefined even for an empty or missing notification_type.
    expect(transition("running", "Notification", undefined)).toBe("waiting-input");
    expect(transition("running", "Notification", "")).toBe("waiting-input");
  });

  it("timeline_kind_maps_every_enumerated_event", () => {
    expect(timelineKind("SessionStart")).toBeNull();
    expect(timelineKind("UserPromptSubmit")).toBe("user_prompt");
    expect(timelineKind("PreToolUse")).toBe("tool_use");
    expect(timelineKind("PostToolUse")).toBe("tool_result");
    expect(timelineKind("Notification")).toBe("notification");
    expect(timelineKind("Stop")).toBe("completion");
    expect(timelineKind("SubagentStop")).toBe("completion");
    expect(timelineKind("SessionEnd")).toBeNull();
  });

  it("session_start_transitions_to_running", () => {
    expect(transition("done", "SessionStart")).toBe("running");
  });

  it("pre_tool_use_transitions_to_running", () => {
    expect(transition("waiting-input", "PreToolUse")).toBe("running");
  });

  it("every classifier candidate string classifies as documented", () => {
    expect(classifyNotification("permission_request")).toBe("WaitingPermission");
    expect(classifyNotification("permission")).toBe("WaitingPermission");
    expect(classifyNotification("tool_permission")).toBe("WaitingPermission");
    expect(classifyNotification("permission_prompt")).toBe("WaitingPermission");
    expect(classifyNotification("idle")).toBe("WaitingInput");
    expect(classifyNotification("waiting_for_input")).toBe("WaitingInput");
    expect(classifyNotification("input")).toBe("WaitingInput");
    expect(classifyNotification("needs_input")).toBe("WaitingInput");
  });
});
