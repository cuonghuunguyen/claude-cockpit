/**
 * Integration spec for the hold-open decision loop (FND-04/ACT-01/ACT-03,
 * 03-RESEARCH.md Pattern 2). Exercises `registerPendingDecision`,
 * `resolvePendingDecision`, and `buildHookDecisionOutput`
 * (`daemon-ts/src/decisions.ts`) indirectly through the real, token-gated
 * HTTP surface: a decision-requiring `POST /hooks/pre-tool-use` is held
 * open by the daemon and resolved only by the new `POST
 * /sessions/:id/decision` route — mirrors `test/ingest-routes.spec.ts`'s
 * harness (real Fastify app + real on-disk temp SQLite file, bearer-token
 * auth).
 *
 * RED (Task 1): `decisions.ts` and the decision route do not exist yet —
 * every case below must fail until Task 2 (GREEN) implements them. No
 * assertion here is weakened to make this pass prematurely.
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

const TEST_TOKEN = "decisions-test-token-0123456789abcdef012345";
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TEST_TOKEN}`);

describe("hold-open decision loop (held POST /hooks/pre-tool-use, resolved by POST /sessions/:id/decision)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-decisions-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    // Explicit listen (mirrors test/sse-route.spec.ts) rather than
    // `app.ready()` — concurrent held requests each drive supertest to
    // dispatch real sockets against `app.server`, and supertest's own
    // lazy `listen(0)` would otherwise race across two simultaneous
    // requests fired before the server has an address yet.
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
   * Fires a supertest `Test` request immediately via its own `.end()` —
   * NOT `await`/`.then()`. superagent's `Request` only actually dispatches
   * the HTTP call once `.then()`/`.end()` is invoked, so a plain
   * `const p = auth(supertest(...).post(...)).send(...)` assigned without
   * awaiting/then-ing would never actually reach the server, which matters
   * here because the whole point is to start a held request and inspect
   * server-side state (`hasPendingDecision`) WHILE it is still in flight.
   * Returns a genuine `Promise` the test can `await` later, once the held
   * response has been resolved server-side.
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

  it("held PreToolUse resolves only after POST /sessions/:id/decision, with the built approve JSON", async () => {
    await startSession("hold-approve");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-approve",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();
    expect(hasPendingDecision("hold-approve")).toBe(true);

    const decisionRes = await auth(supertest(app.server).post("/sessions/hold-approve/decision")).send({
      type: "approve",
    });
    expect(decisionRes.status).toBe(200);

    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  });

  it("deny with a reason returns deny JSON carrying permissionDecisionReason", async () => {
    await startSession("hold-deny-reason");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-deny-reason",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/hold-deny-reason/decision")).send({
      type: "deny",
      reason: "Not right now",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Not right now",
      },
    });
  });

  it("deny with an absent/whitespace-only reason omits permissionDecisionReason entirely", async () => {
    await startSession("hold-deny-empty");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-deny-empty",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/hold-deny-empty/decision")).send({
      type: "deny",
      reason: "   ",
    });

    const heldRes = await held;
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(
      (heldRes.body as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput,
    ).not.toHaveProperty("permissionDecisionReason");
  });

  it("two sessions held concurrently: deciding session A resolves only A, leaves B pending", async () => {
    await startSession("hold-a");
    await startSession("hold-b");

    const heldA = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-a",
        tool_name: "Bash",
        tool_input: { command: "echo a" },
      }),
    );
    const heldB = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-b",
        tool_name: "Bash",
        tool_input: { command: "echo b" },
      }),
    );
    await tick();

    expect(hasPendingDecision("hold-a")).toBe(true);
    expect(hasPendingDecision("hold-b")).toBe(true);

    await auth(supertest(app.server).post("/sessions/hold-a/decision")).send({ type: "approve" });

    const resA = await heldA;
    expect(
      (resA.body as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision,
    ).toBe("allow");
    expect(hasPendingDecision("hold-a")).toBe(false);
    expect(hasPendingDecision("hold-b")).toBe(true);

    await auth(supertest(app.server).post("/sessions/hold-b/decision")).send({ type: "deny" });
    const resB = await heldB;
    expect(
      (resB.body as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  it("a decision POST for a sessionId with no pending entry returns 404/409, and a second POST after resolution likewise does not re-resolve", async () => {
    const noHold = await auth(supertest(app.server).post("/sessions/never-held/decision")).send({
      type: "approve",
    });
    expect([404, 409]).toContain(noHold.status);

    await startSession("hold-once");
    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-once",
        tool_name: "Bash",
        tool_input: { command: "echo once" },
      }),
    );
    await tick();

    const first = await auth(supertest(app.server).post("/sessions/hold-once/decision")).send({
      type: "approve",
    });
    expect(first.status).toBe(200);
    await held;

    const second = await auth(supertest(app.server).post("/sessions/hold-once/decision")).send({
      type: "approve",
    });
    expect([404, 409]).toContain(second.status);
  });

  it("timeout path: an injected short timeoutMs resolves the held response to an empty decision", async () => {
    __setDefaultTimeoutMsForTests(30);
    await startSession("hold-timeout");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-timeout",
        tool_name: "Bash",
        tool_input: { command: "echo timeout" },
      }),
    );

    const heldRes = await held;
    expect(heldRes.body).toEqual({});
    expect(hasPendingDecision("hold-timeout")).toBe(false);
  });

  it("dismiss path: POST /sessions/:id/dismiss while held resolves to an empty decision and removes the card from the active queue", async () => {
    await startSession("hold-dismiss");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-dismiss",
        tool_name: "Bash",
        tool_input: { command: "echo dismiss" },
      }),
    );
    await tick();
    expect(hasPendingDecision("hold-dismiss")).toBe(true);

    const dismissRes = await auth(supertest(app.server).post("/sessions/hold-dismiss/dismiss"));
    expect(dismissRes.status).toBe(200);

    const heldRes = await held;
    expect(heldRes.body).toEqual({});
    expect(hasPendingDecision("hold-dismiss")).toBe(false);

    const active = await auth(supertest(app.server).get("/sessions?active=true"));
    expect(active.body.some((s: { sessionId: string }) => s.sessionId === "hold-dismiss")).toBe(false);
  });

  it("a read-only tool that needs no decision still acks immediately without holding", async () => {
    await startSession("no-hold-readonly");

    const res = await auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
      session_id: "no-hold-readonly",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x/file.txt" },
    });

    expect(res.status).toBe(200);
    expect(hasPendingDecision("no-hold-readonly")).toBe(false);
  });

  // Defect A (live Phase 3 test): sessions running in an auto/bypass
  // permission mode never show a native permission prompt, so Cockpit must
  // not hold PreToolUse for them either — see `needsDecision`/
  // `holdsForPermissionMode` in `daemon-ts/src/ingest/preToolUse.ts`.
  it("a Bash call in default permission mode DOES hold (explicit permission_mode)", async () => {
    await startSession("mode-default");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "mode-default",
        tool_name: "Bash",
        tool_input: { command: "echo default" },
        permission_mode: "default",
      }),
    );
    await tick();

    expect(hasPendingDecision("mode-default")).toBe(true);

    await auth(supertest(app.server).post("/sessions/mode-default/decision")).send({ type: "approve" });
    const res = await held;
    expect(res.status).toBe(200);
    expect(
      (res.body as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision,
    ).toBe("allow");
  });

  it("a Bash call in bypassPermissions mode does NOT hold — fast ack, no pending decision registered", async () => {
    await startSession("mode-bypass");

    const res = await auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
      session_id: "mode-bypass",
      tool_name: "Bash",
      tool_input: { command: "echo bypass" },
      permission_mode: "bypassPermissions",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(hasPendingDecision("mode-bypass")).toBe(false);
  });

  it("a Bash call in acceptEdits mode does NOT hold — fast ack, no pending decision registered", async () => {
    await startSession("mode-accept-edits");

    const res = await auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
      session_id: "mode-accept-edits",
      tool_name: "Bash",
      tool_input: { command: "echo accept-edits" },
      permission_mode: "acceptEdits",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(hasPendingDecision("mode-accept-edits")).toBe(false);
  });

  it("a Bash call with no permission_mode field at all still holds (fail-safe treats missing as default)", async () => {
    await startSession("mode-missing");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "mode-missing",
        tool_name: "Bash",
        tool_input: { command: "echo missing-mode" },
      }),
    );
    await tick();

    expect(hasPendingDecision("mode-missing")).toBe(true);

    await auth(supertest(app.server).post("/sessions/mode-missing/decision")).send({ type: "approve" });
    await held;
  });

  // Defect B: the held card must carry enough info to actually decide on —
  // tool name AND a concise summary of the tool input, not just "something
  // is pending" — see `PendingDecision.toolInputSummary` (shared/types.ts).
  it("a held permission decision's SessionApi carries toolName and toolInputSummary for the card to render", async () => {
    await startSession("hold-detail");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "hold-detail",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    );
    await tick();

    const sessionRes = await auth(supertest(app.server).get("/sessions?active=true"));
    const session = (sessionRes.body as Array<{ sessionId: string; pendingDecision: unknown }>).find(
      (s) => s.sessionId === "hold-detail",
    );
    expect(session).toBeDefined();
    expect(
      (session as { pendingDecision: { toolName: string; toolInputSummary: string } }).pendingDecision.toolName,
    ).toBe("Bash");
    expect(
      (session as { pendingDecision: { toolName: string; toolInputSummary: string } }).pendingDecision
        .toolInputSummary,
    ).toContain("rm -rf /tmp/x");

    await auth(supertest(app.server).post("/sessions/hold-detail/decision")).send({ type: "approve" });
    await held;
  });
});
