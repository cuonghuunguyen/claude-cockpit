/**
 * Integration spec for `AskUserQuestion` answer-injection (ACT-02,
 * 03-RESEARCH.md "Pattern 3: AskUserQuestion answer injection" + "Pitfall
 * 5"). Mirrors `test/decisions.spec.ts`'s hold-open harness: a held
 * `PreToolUse` for `AskUserQuestion` is resolved only via `POST
 * /sessions/:id/decision`, whose `hookSpecificOutput` echoes the original
 * `tool_input.questions` array unchanged and adds an `answers` map keyed by
 * the question's full text (never an index/header).
 *
 * RED (Task 1): `needsDecision` still excludes `AskUserQuestion` entirely
 * (03-01 scope, "03-03 owns AskUserQuestion's answer-injection contract"),
 * and `buildHookDecisionOutput`'s `ask-user-question` branch throws
 * "implemented in a later plan (03-03)" — every case below must fail until
 * Task 2 (GREEN) implements them. No assertion here is weakened to make
 * this pass prematurely.
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

const TEST_TOKEN = "ask-user-question-test-token-0123456789ab";
const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TEST_TOKEN}`);

describe("AskUserQuestion answer-injection (held PreToolUse resolved by POST /sessions/:id/decision)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-ask-user-question-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    // Explicit listen (mirrors test/decisions.spec.ts) — concurrent held
    // requests each drive supertest to dispatch real sockets against
    // `app.server`, and supertest's own lazy `listen(0)` would otherwise
    // race across simultaneous requests fired before the server has an
    // address yet.
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

  const SINGLE_QUESTION = {
    questions: [
      {
        question: "Which approach should we take?",
        header: "Approach",
        options: [
          { label: "Fast", description: "Ship quickly, iterate later" },
          { label: "Careful", description: "Take more time, fewer surprises" },
        ],
        multiSelect: false,
      },
    ],
  };

  const MULTISELECT_QUESTION = {
    questions: [
      {
        question: "Which frameworks should we support?",
        header: "Frameworks",
        options: [{ label: "React" }, { label: "Svelte" }, { label: "Vue" }],
        multiSelect: true,
      },
    ],
  };

  it("a held AskUserQuestion registers a pending decision of kind ask-user-question, options reflecting the first question's option labels", async () => {
    await startSession("aq-registers");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "aq-registers",
        tool_name: "AskUserQuestion",
        tool_input: SINGLE_QUESTION,
      }),
    );
    await tick();

    expect(hasPendingDecision("aq-registers")).toBe(true);

    const sessionRes = await auth(supertest(app.server).get("/sessions?active=true"));
    const session = (
      sessionRes.body as Array<{
        sessionId: string;
        pendingDecision: { kind: string; options: Array<{ label: string }> } | null;
      }>
    ).find((s) => s.sessionId === "aq-registers");
    expect(session).toBeDefined();
    expect(session?.pendingDecision?.kind).toBe("ask-user-question");
    expect(session?.pendingDecision?.options.map((o) => o.label)).toEqual(["Fast", "Careful"]);

    // Resolve to keep the held connection from lingering past the test.
    await auth(supertest(app.server).post("/sessions/aq-registers/decision")).send({
      type: "answer",
      answers: ["Fast"],
    });
    await held;
  });

  it("submitting {type:'answer', answers:['<label>']} resolves the hold with allow + updatedInput echoing questions and keying the answer by question text", async () => {
    await startSession("aq-answer");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "aq-answer",
        tool_name: "AskUserQuestion",
        tool_input: SINGLE_QUESTION,
      }),
    );
    await tick();

    const decisionRes = await auth(supertest(app.server).post("/sessions/aq-answer/decision")).send({
      type: "answer",
      answers: ["Careful"],
    });
    expect(decisionRes.status).toBe(200);

    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    expect(heldRes.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          questions: SINGLE_QUESTION.questions,
          answers: { "Which approach should we take?": "Careful" },
        },
      },
    });
  });

  it("a multiSelect question with two selected labels produces a single comma-joined answer string", async () => {
    await startSession("aq-multiselect");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "aq-multiselect",
        tool_name: "AskUserQuestion",
        tool_input: MULTISELECT_QUESTION,
      }),
    );
    await tick();

    await auth(supertest(app.server).post("/sessions/aq-multiselect/decision")).send({
      type: "answer",
      answers: ["React", "Svelte"],
    });

    const heldRes = await held;
    expect(
      (
        heldRes.body as {
          hookSpecificOutput: { updatedInput: { answers: Record<string, string> } };
        }
      ).hookSpecificOutput.updatedInput.answers,
    ).toEqual({ "Which frameworks should we support?": "React, Svelte" });
  });

  it("an answer label NOT present in the recorded options is rejected (400/409) and never forwarded into updatedInput", async () => {
    __setDefaultTimeoutMsForTests(50);
    await startSession("aq-invalid-label");

    const held = sendNow(
      auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
        session_id: "aq-invalid-label",
        tool_name: "AskUserQuestion",
        tool_input: SINGLE_QUESTION,
      }),
    );
    await tick();

    const rejected = await auth(supertest(app.server).post("/sessions/aq-invalid-label/decision")).send({
      type: "answer",
      answers: ["Not-a-real-option"],
    });
    expect([400, 409]).toContain(rejected.status);

    // Never forwarded: the hold is still pending immediately after the
    // rejected submission...
    expect(hasPendingDecision("aq-invalid-label")).toBe(true);

    // ...and eventually resolves via its own (short, test-injected) timeout
    // to the plain release-to-native payload — never an `updatedInput`
    // carrying the rejected label.
    const heldRes = await held;
    expect(heldRes.body).toEqual({});
  });
});
