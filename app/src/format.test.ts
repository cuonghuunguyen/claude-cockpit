import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { compareSessions, orderSessions } from "./format";

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
