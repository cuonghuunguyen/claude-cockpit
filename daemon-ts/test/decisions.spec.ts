/**
 * Unit spec for `needsDecision`'s PreToolUse pass-through gate, the
 * pending-decision registry's register/resolve/idempotency/timeout/dismiss
 * contract, and `buildHookDecisionOutput`'s PermissionRequest-shaped
 * outputs (FND-04/ACT-01/ACT-02/ACT-03; reworked 03-05, D-14/D-16).
 *
 * The general (Bash) held-loop integration cases previously exercised here
 * through `POST /hooks/pre-tool-use` are RELOCATED to
 * `test/permission-request.spec.ts` (03-05): Bash no longer holds on
 * PreToolUse (D-14), so the general held loop now lives entirely behind the
 * new `POST /hooks/permission-request` route. `AskUserQuestion`'s held loop
 * remains covered by `test/ask-user-question.spec.ts` (unchanged, D-15).
 * The one HTTP integration case kept here (the decision-route's
 * orphan-reconciliation "never resurrect a done session" guard) is
 * unaffected by which hook produced a hold, so it stays as direct coverage
 * of `routes.ts`'s shared 404 handler.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { buildApp } from "../src/main.js";
import { openDb } from "../src/store.js";
import {
  __setDefaultTimeoutMsForTests,
  buildHookDecisionOutput,
  getPendingDecisionKind,
  hasPendingDecision,
  registerPendingDecision,
  releasePendingDecisionOnDismiss,
  resolvePendingDecision,
} from "../src/decisions.js";
import { needsDecision } from "../src/ingest/preToolUse.js";

const TEST_TOKEN = "decisions-test-token-0123456789abcdef012345";
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TEST_TOKEN}`);

describe("needsDecision (PreToolUse pass-through gate, D-14)", () => {
  it("returns true only for AskUserQuestion", () => {
    expect(needsDecision("AskUserQuestion", {})).toBe(true);
  });

  it.each(["Bash", "Write", "Agent", "Skill", "Read", "Glob"])(
    "returns false for %s regardless of permission_mode (general case is pass-through per D-14)",
    (toolName) => {
      expect(needsDecision(toolName, {})).toBe(false);
      expect(needsDecision(toolName, { permission_mode: "default" })).toBe(false);
      expect(needsDecision(toolName, { permission_mode: "bypassPermissions" })).toBe(false);
    },
  );

  it("returns false for a null tool name", () => {
    expect(needsDecision(null, {})).toBe(false);
  });
});

describe('buildHookDecisionOutput ("permission" kind, PermissionRequest-shaped per D-14)', () => {
  it("approve -> hookEventName PermissionRequest, decision.behavior allow", () => {
    expect(buildHookDecisionOutput("permission", { type: "approve" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("deny with a reason -> decision.behavior deny + message", () => {
    expect(buildHookDecisionOutput("permission", { type: "deny", reason: "not now" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "not now" },
      },
    });
  });

  it("deny with a blank reason omits message entirely", () => {
    const result = buildHookDecisionOutput("permission", { type: "deny", reason: "   " }) as {
      hookSpecificOutput: { decision: Record<string, unknown> };
    };
    expect(result.hookSpecificOutput.decision).toEqual({ behavior: "deny" });
    expect(result.hookSpecificOutput.decision).not.toHaveProperty("message");
  });

  it('throws for a Decision.type not valid for kind "permission"', () => {
    expect(() => buildHookDecisionOutput("permission", { type: "plan-allow" })).toThrow();
  });
});

describe('buildHookDecisionOutput ("plan-mode" kind, ACT-02/D-16)', () => {
  it("plan-allow -> decision.behavior allow", () => {
    expect(buildHookDecisionOutput("plan-mode", { type: "plan-allow" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("plan-allow-accept-edits -> decision.behavior allow + updatedPermissions setMode acceptEdits session", () => {
    expect(buildHookDecisionOutput("plan-mode", { type: "plan-allow-accept-edits" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
  });

  it("plan-deny with a message -> decision.behavior deny + message", () => {
    expect(
      buildHookDecisionOutput("plan-mode", { type: "plan-deny", message: "Not now — keep planning" }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Not now — keep planning" },
      },
    });
  });

  it("plan-deny with a blank message omits message entirely", () => {
    const result = buildHookDecisionOutput("plan-mode", { type: "plan-deny", message: "  " }) as {
      hookSpecificOutput: { decision: Record<string, unknown> };
    };
    expect(result.hookSpecificOutput.decision).toEqual({ behavior: "deny" });
    expect(result.hookSpecificOutput.decision).not.toHaveProperty("message");
  });

  it('throws for a Decision.type not valid for kind "plan-mode"', () => {
    expect(() => buildHookDecisionOutput("plan-mode", { type: "approve" })).toThrow();
  });
});

describe("pending-decision registry (register/resolve/idempotency/timeout/dismiss)", () => {
  afterEach(() => {
    __setDefaultTimeoutMsForTests(585_000); // restore the production default
  });

  it("register then resolve delivers the resolved json and clears the pending entry", async () => {
    const promise = registerPendingDecision("reg-1", "permission", () => ({}));
    expect(hasPendingDecision("reg-1")).toBe(true);
    expect(getPendingDecisionKind("reg-1")).toBe("permission");

    const resolved = resolvePendingDecision("reg-1", { ok: true });
    expect(resolved).toBe(true);
    expect(hasPendingDecision("reg-1")).toBe(false);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("resolvePendingDecision is idempotent -- a second resolve for the same id is a no-op returning false", async () => {
    const promise = registerPendingDecision("reg-2", "permission", () => ({}));
    expect(resolvePendingDecision("reg-2", { first: true })).toBe(true);
    expect(resolvePendingDecision("reg-2", { second: true })).toBe(false);
    await expect(promise).resolves.toEqual({ first: true });
  });

  it("resolvePendingDecision for an unknown sessionId is a safe no-op returning false", () => {
    expect(resolvePendingDecision("never-registered", {})).toBe(false);
  });

  it("releasePendingDecisionOnDismiss resolves the hold with the empty release-to-native payload", async () => {
    const promise = registerPendingDecision("reg-3", "permission", () => ({}));
    const released = releasePendingDecisionOnDismiss("reg-3");
    expect(released).toBe(true);
    await expect(promise).resolves.toEqual({});
  });

  it("the registry's own timeout resolves via onTimeout() and clears the pending entry", async () => {
    const promise = registerPendingDecision("reg-4", "permission", () => ({ timedOut: true }), 20);
    expect(hasPendingDecision("reg-4")).toBe(true);
    await expect(promise).resolves.toEqual({ timedOut: true });
    expect(hasPendingDecision("reg-4")).toBe(false);
  });

  it("getPendingDecisionKind returns null when nothing is pending", () => {
    expect(getPendingDecisionKind("no-such-session")).toBeNull();
  });
});

describe("decision route reconciliation guard (routes.ts, unaffected by the PermissionRequest migration)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-decisions-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a 404 decision POST for a session that is NOT waiting-permission never resurrects it (a done session stays done)", async () => {
    await auth(supertest(app.server).post("/hooks/session-start")).send({
      session_id: "orphan-done",
      cwd: "/tmp/x",
      source: "startup",
    });
    // Drive the session to `done` via a real Stop event.
    await auth(supertest(app.server).post("/hooks/stop")).send({ session_id: "orphan-done" });
    expect(hasPendingDecision("orphan-done")).toBe(false);

    const res = await auth(supertest(app.server).post("/sessions/orphan-done/decision")).send({
      type: "approve",
    });
    expect(res.status).toBe(404);

    // The reconciliation guard must not flip a done session to running.
    const after = await auth(supertest(app.server).get("/sessions"));
    const afterSession = (after.body as Array<{ sessionId: string; status: string }>).find(
      (s) => s.sessionId === "orphan-done",
    );
    expect(afterSession?.status).toBe("done");
  });
});
