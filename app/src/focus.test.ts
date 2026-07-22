import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { focusTargetExists, isHighlighted } from "./focus";

function makeSession(overrides: Partial<Session> & Pick<Session, "sessionId">): Session {
  return {
    workspace: "repo",
    branch: "main",
    status: "running",
    taskSummary: null,
    currentTool: null,
    startedAt: "2026-07-17T10:00:00.000Z",
    lastActivityAt: "2026-07-17T10:00:00.000Z",
    endedAt: null,
    dismissedAt: null,
    source: "wsl",
    pendingDecision: null,
    ...overrides,
  };
}

describe("focusTargetExists (D-10 unknown-id guard)", () => {
  it("returns true when a session with the given id is present", () => {
    const sessions = [makeSession({ sessionId: "a" }), makeSession({ sessionId: "b" })];
    expect(focusTargetExists("b", sessions)).toBe(true);
  });

  it("returns false for an unknown session id", () => {
    const sessions = [makeSession({ sessionId: "a" })];
    expect(focusTargetExists("does-not-exist", sessions)).toBe(false);
  });

  it("returns false against an empty session list", () => {
    expect(focusTargetExists("anything", [])).toBe(false);
  });
});

describe("isHighlighted (D-10 highlight-decision)", () => {
  it("highlights the matching card", () => {
    expect(isHighlighted("a", "a")).toBe(true);
  });

  it("does not highlight a non-matching card", () => {
    expect(isHighlighted("a", "b")).toBe(false);
  });

  it("highlights nothing when highlightedSessionId is null (self-cleared state)", () => {
    expect(isHighlighted("a", null)).toBe(false);
  });
});
