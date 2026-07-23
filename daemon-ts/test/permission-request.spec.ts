/**
 * Integration spec for the wildcard `PermissionRequest` hold-open decision
 * channel (D-14/D-16, FND-04, ACT-01/ACT-02/ACT-03), plus the PreToolUse
 * pass-through regression this migration introduces.
 *
 * Mirrors `test/decisions.spec.ts`'s pre-migration harness (real
 * `app.listen({port:0, host:"127.0.0.1"})`, the immediate-dispatch
 * `sendNow()` helper, `tick()`, and `__setDefaultTimeoutMsForTests` for the
 * timeout path) but drives the held-decision loop through the NEW `POST
 * /hooks/permission-request` route instead of `POST /hooks/pre-tool-use`
 * (03-05's rework: PreToolUse no longer resolves the general case).
 *
 * RED (Task 1): `POST /hooks/permission-request` does not exist yet (404),
 * `buildHookDecisionOutput`'s "permission" branch still emits the OLD
 * `PreToolUse`/`permissionDecision` shape, and the "plan-mode" branch still
 * throws — every case below must fail until Task 2 (GREEN part 1) and
 * Task 3 (GREEN part 2) implement them. No assertion here is weakened to
 * make this pass prematurely.
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
import { __setDefaultTimeoutMsForTests, hasPendingDecision } from "../src/decisions.js";

const TEST_TOKEN = "permission-request-test-token-0123456789ab";
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TEST_TOKEN}`);

describe("wildcard PermissionRequest hold (POST /hooks/permission-request, resolved by POST /sessions/:id/decision) + PreToolUse pass-through", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-permission-request-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    // Explicit listen (mirrors decisions.spec.ts / ask-user-question.spec.ts)
    // — concurrent held requests each drive supertest to dispatch real
    // sockets against `app.server`, and supertest's own lazy `listen(0)`
    // would otherwise race across simultaneous requests fired before the
    // server has an address yet.
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    __setDefaultTimeoutMsForTests(585_000); // restore the production default
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startSession(sessionId: string): Promise<void> {
    await auth(supertest(app.server).post("/hooks/session-start")).send({
      session_id: sessionId,
      cwd: "/tmp/x",
      source: "startup",
    });
  }

  /**
   * Fires a supertest `Test` request immediately via its own `.end()` — NOT
   * `await`/`.then()` — so the request is genuinely in flight (and can be
   * inspected server-side via `hasPendingDecision`) before this test awaits
   * the returned `Promise` later, once the held response resolves.
   */
  function sendNow(reqBuilder: supertest.Test): Promise<supertest.Response> {
    return new Promise((resolve, reject) => {
      reqBuilder.end((err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  /** Small tick so the held request has actually registered its pending
   * decision before the test issues the resolving/inspecting call. */
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------
  // General "permission" kind (ordinary tool, e.g. Bash) via
  // POST /hooks/permission-request.
  // ---------------------------------------------------------------------

  it("held PermissionRequest for an ordinary tool resolves only after POST /sessions/:id/decision, with the PermissionRequest decision.behavior allow shape", async () => {
    await startSession("pr-approve");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-approve",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();
    expect(hasPendingDecision("pr-approve")).toBe(true);

    const decisionRes = await auth(supertest(app.server).post("/sessions/pr-approve/decision")).send({
      type: "approve",
    });
    expect(decisionRes.status).toBe(200);

    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("deny with a reason returns decision.behavior deny + message", async () => {
    await startSession("pr-deny-reason");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-deny-reason",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/pr-deny-reason/decision")).send({
      type: "deny",
      reason: "not now",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "not now" },
      },
    });
  });

  it("deny with an absent/whitespace-only reason omits the message key entirely", async () => {
    await startSession("pr-deny-empty");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-deny-empty",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/pr-deny-empty/decision")).send({
      type: "deny",
      reason: "   ",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
    expect(
      (heldRes.body as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision,
    ).not.toHaveProperty("message");
  });

  it("two sessions held concurrently via PermissionRequest: deciding session A resolves only A, leaves B pending", async () => {
    await startSession("pr-hold-a");
    await startSession("pr-hold-b");

    const heldA = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-hold-a",
        tool_name: "Bash",
        tool_input: { command: "echo a" },
      }),
    );
    const heldB = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-hold-b",
        tool_name: "Bash",
        tool_input: { command: "echo b" },
      }),
    );
    await tick();

    expect(hasPendingDecision("pr-hold-a")).toBe(true);
    expect(hasPendingDecision("pr-hold-b")).toBe(true);

    await auth(supertest(app.server).post("/sessions/pr-hold-a/decision")).send({ type: "approve" });

    const resA = await heldA;
    expect(
      (resA.body as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior,
    ).toBe("allow");
    expect(hasPendingDecision("pr-hold-a")).toBe(false);
    expect(hasPendingDecision("pr-hold-b")).toBe(true);

    await auth(supertest(app.server).post("/sessions/pr-hold-b/decision")).send({ type: "deny" });
    const resB = await heldB;
    expect(
      (resB.body as { hookSpecificOutput: { decision: { behavior: string } } }).hookSpecificOutput.decision.behavior,
    ).toBe("deny");
  });

  // ---------------------------------------------------------------------
  // Plan-mode kind (ExitPlanMode) via POST /hooks/permission-request.
  // ---------------------------------------------------------------------

  it("plan-mode: ExitPlanMode registers a plan-mode pending decision; plan-allow resolves decision.behavior allow", async () => {
    await startSession("pr-plan-allow");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-plan-allow",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      }),
    );
    await tick();
    expect(hasPendingDecision("pr-plan-allow")).toBe(true);

    const sessionRes = await auth(supertest(app.server).get("/sessions?active=true"));
    const session = (
      sessionRes.body as Array<{ sessionId: string; pendingDecision: { kind: string; options: unknown[] } | null }>
    ).find((s) => s.sessionId === "pr-plan-allow");
    expect(session?.pendingDecision?.kind).toBe("plan-mode");
    expect(session?.pendingDecision?.options.length).toBe(3);

    await auth(supertest(app.server).post("/sessions/pr-plan-allow/decision")).send({ type: "plan-allow" });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("plan-mode: plan-allow-accept-edits resolves decision.behavior allow + updatedPermissions setMode acceptEdits session", async () => {
    await startSession("pr-plan-accept-edits");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-plan-accept-edits",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/pr-plan-accept-edits/decision")).send({
      type: "plan-allow-accept-edits",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    });
  });

  it("plan-mode: plan-deny with a message resolves decision.behavior deny + message", async () => {
    await startSession("pr-plan-deny");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-plan-deny",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/pr-plan-deny/decision")).send({
      type: "plan-deny",
      message: "Not now — keep planning",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Not now — keep planning" },
      },
    });
  });

  it("plan-mode: plan-deny with a blank message omits the message key entirely", async () => {
    await startSession("pr-plan-deny-blank");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-plan-deny-blank",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/pr-plan-deny-blank/decision")).send({
      type: "plan-deny",
      message: "   ",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
    expect(
      (heldRes.body as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision,
    ).not.toHaveProperty("message");
  });

  // ---------------------------------------------------------------------
  // PreToolUse pass-through regression (D-14's phantom-hold root cause is
  // gone: PreToolUse no longer resolves allow/deny for the general case).
  // ---------------------------------------------------------------------

  it.each(["Bash", "Agent", "Skill", "Write"])(
    "PreToolUse pass-through: %s returns a fast ack and does NOT hold (regression for D-14)",
    async (toolName) => {
      await startSession(`no-hold-${toolName}`);

      const res = await auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: `no-hold-${toolName}`,
        tool_name: toolName,
        tool_input: { anything: "goes-here" },
      });

      expect(res.status).toBe(200);
      expect(hasPendingDecision(`no-hold-${toolName}`)).toBe(false);
    },
  );

  // ---------------------------------------------------------------------
  // Failsafes (D-01/D-03): timeout, mid-hold dismiss, unknown session — all
  // release to native identically to the pre-migration PreToolUse hold.
  // ---------------------------------------------------------------------

  it("timeout path: an injected short timeoutMs resolves the held PermissionRequest response to an empty decision", async () => {
    __setDefaultTimeoutMsForTests(30);
    await startSession("pr-timeout");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-timeout",
        tool_name: "Bash",
        tool_input: { command: "echo timeout" },
      }),
    );

    const heldRes = await held;
    expect(heldRes.body).toEqual({});
    expect(hasPendingDecision("pr-timeout")).toBe(false);
  });

  it("dismiss path: POST /sessions/:id/dismiss while a PermissionRequest is held resolves to an empty decision", async () => {
    await startSession("pr-dismiss");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-dismiss",
        tool_name: "Bash",
        tool_input: { command: "echo dismiss" },
      }),
    );
    await tick();
    expect(hasPendingDecision("pr-dismiss")).toBe(true);

    const dismissRes = await auth(supertest(app.server).post("/sessions/pr-dismiss/dismiss"));
    expect(dismissRes.status).toBe(200);

    const heldRes = await held;
    expect(heldRes.body).toEqual({});
    expect(hasPendingDecision("pr-dismiss")).toBe(false);
  });

  it("a decision POST for a sessionId with no pending PermissionRequest entry returns 404/409", async () => {
    const noHold = await auth(supertest(app.server).post("/sessions/pr-never-held/decision")).send({
      type: "approve",
    });
    expect([404, 409]).toContain(noHold.status);
  });

  it("CR-02: dismissing a held permission-kind decision resets status off waiting-permission so GET /sessions never serves a stale card", async () => {
    await startSession("cr02-dismiss-permission");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "cr02-dismiss-permission",
        tool_name: "Bash",
        tool_input: { command: "echo cr02" },
      }),
    );
    await tick();
    expect(hasPendingDecision("cr02-dismiss-permission")).toBe(true);

    const dismissRes = await auth(supertest(app.server).post("/sessions/cr02-dismiss-permission/dismiss"));
    expect(dismissRes.status).toBe(200);

    const after = await auth(supertest(app.server).get("/sessions"));
    const row = (
      after.body as Array<{ sessionId: string; status: string; pendingDecision: unknown }>
    ).find((s) => s.sessionId === "cr02-dismiss-permission");
    expect(row).toBeDefined();
    expect(row?.pendingDecision).toBeNull();
    expect(row?.status).not.toBe("waiting-permission");

    await held;
  });

  it("CR-02: dismissing a held plan-mode-kind decision resets status off waiting-permission so GET /sessions never serves a stale card", async () => {
    await startSession("cr02-dismiss-plan-mode");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "cr02-dismiss-plan-mode",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      }),
    );
    await tick();
    expect(hasPendingDecision("cr02-dismiss-plan-mode")).toBe(true);

    const dismissRes = await auth(supertest(app.server).post("/sessions/cr02-dismiss-plan-mode/dismiss"));
    expect(dismissRes.status).toBe(200);

    const after = await auth(supertest(app.server).get("/sessions"));
    const row = (
      after.body as Array<{ sessionId: string; status: string; pendingDecision: unknown }>
    ).find((s) => s.sessionId === "cr02-dismiss-plan-mode");
    expect(row).toBeDefined();
    expect(row?.pendingDecision).toBeNull();
    expect(row?.status).not.toBe("waiting-permission");

    await held;
  });

  it("orphaned hold: a 404 decision POST after a PermissionRequest timeout reconciles the stored status off waiting-permission", async () => {
    __setDefaultTimeoutMsForTests(30);
    await startSession("pr-orphan-hold");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-orphan-hold",
        tool_name: "Bash",
        tool_input: { command: "echo orphan" },
      }),
    );

    const heldRes = await held;
    expect(heldRes.body).toEqual({});
    expect(hasPendingDecision("pr-orphan-hold")).toBe(false);

    const before = await auth(supertest(app.server).get("/sessions?active=true"));
    const beforeSession = (
      before.body as Array<{ sessionId: string; status: string; pendingDecision: unknown }>
    ).find((s) => s.sessionId === "pr-orphan-hold");
    expect(beforeSession?.status).toBe("waiting-permission");
    expect(beforeSession?.pendingDecision).not.toBeNull();

    const staleApprove = await auth(supertest(app.server).post("/sessions/pr-orphan-hold/decision")).send({
      type: "approve",
    });
    expect(staleApprove.status).toBe(404);

    const after = await auth(supertest(app.server).get("/sessions?active=true"));
    const afterSession = (
      after.body as Array<{ sessionId: string; status: string; pendingDecision: unknown }>
    ).find((s) => s.sessionId === "pr-orphan-hold");
    expect(afterSession?.status).toBe("running");
    expect(afterSession?.pendingDecision).toBeNull();
  });

  // Defect-B parity: the held card must carry toolName + a concise
  // toolInputSummary, matching the pre-migration PreToolUse hold's contract.
  it("a held permission decision's SessionApi carries toolName and toolInputSummary", async () => {
    await startSession("pr-hold-detail");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/permission-request")).send({
        session_id: "pr-hold-detail",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    const sessionRes = await auth(supertest(app.server).get("/sessions?active=true"));
    const session = (sessionRes.body as Array<{ sessionId: string; pendingDecision: unknown }>).find(
      (s) => s.sessionId === "pr-hold-detail",
    );
    expect(session).toBeDefined();
    expect(
      (session as { pendingDecision: { toolName: string; toolInputSummary: string } }).pendingDecision.toolName,
    ).toBe("Bash");
    expect(
      (session as { pendingDecision: { toolName: string; toolInputSummary: string } }).pendingDecision
        .toolInputSummary,
    ).toContain("rm -rf /tmp/x");

    await auth(supertest(app.server).post("/sessions/pr-hold-detail/decision")).send({ type: "approve" });
    await held;
  });
});
