import { describe, expect, it } from "vitest";
import type { Session, TimelineEvent } from "../../shared/types";
import { compareSessions, groupTimelineEvents, orderSessions } from "./format";

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
    ...overrides,
  };
}

describe("compareSessions / orderSessions (D-04 Phase-1 biased ordering)", () => {
  it("places a waiting-permission session above a plain running session", () => {
    const running = makeSession({
      sessionId: "running",
      status: "running",
      lastActivityAt: "2026-07-17T12:00:00.000Z",
    });
    const waiting = makeSession({
      sessionId: "waiting",
      status: "waiting-permission",
      lastActivityAt: "2026-07-17T09:00:00.000Z",
    });

    const ordered = orderSessions([running, waiting]);
    expect(ordered.map((s) => s.sessionId)).toEqual(["waiting", "running"]);
  });

  it("orders two waiting sessions by lastActivityAt (most recent first)", () => {
    const older = makeSession({
      sessionId: "older",
      status: "waiting-input",
      lastActivityAt: "2026-07-17T09:00:00.000Z",
    });
    const newer = makeSession({
      sessionId: "newer",
      status: "waiting-input",
      lastActivityAt: "2026-07-17T11:00:00.000Z",
    });

    const ordered = orderSessions([older, newer]);
    expect(ordered.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });

  it("a done session also biases above a running session", () => {
    const running = makeSession({ sessionId: "running", status: "running" });
    const done = makeSession({ sessionId: "done", status: "done" });

    expect(orderSessions([running, done]).map((s) => s.sessionId)).toEqual([
      "done",
      "running",
    ]);
  });

  it("does not mutate the input array", () => {
    const sessions = [
      makeSession({ sessionId: "a", status: "running" }),
      makeSession({ sessionId: "b", status: "done" }),
    ];
    const copy = [...sessions];
    orderSessions(sessions);
    expect(sessions).toEqual(copy);
  });

  it("an activity bump on a running session (e.g. from an error event) never lets it outrank a blocked/done session (D-10/MON-05)", () => {
    const blocked = makeSession({
      sessionId: "blocked",
      status: "waiting-permission",
      lastActivityAt: "2026-07-17T08:00:00.000Z",
    });
    const runningWithRecentError = makeSession({
      sessionId: "running-recent",
      status: "running",
      // Simulates an is_error event bumping last_activity_at to just now —
      // the daemon touches last_activity_at on every event, including
      // errors, but never changes status for one.
      lastActivityAt: "2026-07-17T23:59:00.000Z",
    });

    const ordered = compareSessions(blocked, runningWithRecentError);
    expect(ordered).toBeLessThan(0);
    expect(
      orderSessions([runningWithRecentError, blocked]).map((s) => s.sessionId),
    ).toEqual(["blocked", "running-recent"]);
  });
});

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    kind: "tool_use",
    toolName: null,
    summary: "",
    isError: false,
    createdAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("groupTimelineEvents (D-09 condensed/grouped timeline)", () => {
  it("collapses a run of 5 consecutive same-kind routine events into one grouped entry", () => {
    const events: TimelineEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ kind: "tool_use", toolName: "Bash", summary: `cmd ${i}` }),
    );

    const grouped = groupTimelineEvents(events);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].count).toBe(5);
    expect(grouped[0].label).toContain("5");
  });

  it("renders a prompt/permission/completion/error each individually, never grouped", () => {
    const events: TimelineEvent[] = [
      makeEvent({ kind: "user_prompt", summary: "build the dashboard" }),
      makeEvent({ kind: "notification", summary: "permission requested" }),
      makeEvent({ kind: "completion", summary: "turn finished" }),
      makeEvent({ kind: "error", summary: "boom", isError: true }),
    ];

    const grouped = groupTimelineEvents(events);
    expect(grouped).toHaveLength(4);
    grouped.forEach((entry) => expect(entry.count).toBe(1));
    expect(grouped.map((e) => e.kind)).toEqual([
      "user_prompt",
      "notification",
      "completion",
      "error",
    ]);
    expect(grouped[3].isError).toBe(true);
  });

  it("does not group a routine event into a run that contains an error", () => {
    const events: TimelineEvent[] = [
      makeEvent({ kind: "tool_use", toolName: "Bash" }),
      makeEvent({ kind: "tool_use", toolName: "Bash", isError: true }),
      makeEvent({ kind: "tool_use", toolName: "Bash" }),
    ];

    const grouped = groupTimelineEvents(events);
    // The error event splits the run: [routine], [error], [routine].
    expect(grouped).toHaveLength(3);
    expect(grouped[1].isError).toBe(true);
    expect(grouped[1].count).toBe(1);
  });

  it("mixed routine runs interleaved with call-outs group only the routine runs", () => {
    const events: TimelineEvent[] = [
      makeEvent({ kind: "user_prompt", summary: "start" }),
      makeEvent({ kind: "tool_use", toolName: "Edit" }),
      makeEvent({ kind: "tool_use", toolName: "Edit" }),
      makeEvent({ kind: "tool_use", toolName: "Edit" }),
      makeEvent({ kind: "completion", summary: "done" }),
    ];

    const grouped = groupTimelineEvents(events);
    expect(grouped.map((e) => e.kind)).toEqual([
      "user_prompt",
      "tool_use",
      "completion",
    ]);
    expect(grouped[1].count).toBe(3);
  });
});
