import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { buildApp } from "../src/main.js";
import { openDb } from "../src/store.js";

const TEST_TOKEN = "ingest-test-token-0123456789abcdef012345";

describe("ingest routes (real Fastify instance + real on-disk SQLite temp file)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-ingest-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("session_start_requires_token_and_upserts_exactly_one_row", async () => {
    // No token -> 401, and no row is written.
    let res = await supertest(app.server)
      .post("/hooks/session-start")
      .send({ session_id: "t1", cwd: "/tmp/x", source: "startup" });
    expect(res.status).toBe(401);

    // Valid token -> 200.
    res = await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "t1", cwd: "/tmp/x", source: "startup" });
    expect(res.status).toBe(200);

    // Second session-start for the same session_id upserts, not duplicates.
    res = await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "t1", cwd: "/tmp/y", source: "resume" });
    expect(res.status).toBe(200);

    res = await supertest(app.server)
      .get("/sessions")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.body.length).toBe(1);
    expect(res.body[0].sessionId).toBe("t1");
  });

  it("appending_error_event_leaves_session_status_unchanged (MON-05)", async () => {
    await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "err1", cwd: "/tmp/x", source: "startup" });
    await supertest(app.server)
      .post("/hooks/stop")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "err1" });

    // Session is now "done". A post-tool-use with is_error:true must leave
    // status unchanged and append an "error" kind timeline entry.
    const res = await supertest(app.server)
      .post("/hooks/post-tool-use")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "err1", tool_name: "Bash", tool_response: { is_error: true, output: "boom" } });
    expect(res.status).toBe(200);

    const sessions = await supertest(app.server)
      .get("/sessions")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(sessions.body[0].status).toBe("done");

    const events = await supertest(app.server)
      .get("/sessions/err1/events")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    const lastEvent = events.body[events.body.length - 1];
    expect(lastEvent.kind).toBe("error");
    expect(lastEvent.isError).toBe(true);
  });

  it("stop-and-subagent-stop-both-set-done", async () => {
    await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "stop1", cwd: "/tmp/x", source: "startup" });
    await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "stop2", cwd: "/tmp/x", source: "startup" });

    await supertest(app.server)
      .post("/hooks/stop")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "stop1" });
    await supertest(app.server)
      .post("/hooks/subagent-stop")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "stop2" });

    const res = await supertest(app.server)
      .get("/sessions")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    const byId = Object.fromEntries(
      (res.body as Array<{ sessionId: string; status: string }>).map((s) => [s.sessionId, s.status]),
    );
    expect(byId.stop1).toBe("done");
    expect(byId.stop2).toBe("done");
  });

  it("dismiss returns 404 for unknown id, 200 and excludes from active for a known one", async () => {
    let res = await supertest(app.server)
      .post("/sessions/does-not-exist/dismiss")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(404);

    await supertest(app.server)
      .post("/hooks/session-start")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({ session_id: "dismiss1", cwd: "/tmp/x", source: "startup" });

    res = await supertest(app.server)
      .post("/sessions/dismiss1/dismiss")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(200);

    const active = await supertest(app.server)
      .get("/sessions?active=true")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(active.body.some((s: { sessionId: string }) => s.sessionId === "dismiss1")).toBe(false);

    const full = await supertest(app.server)
      .get("/sessions")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);
    expect(full.body.some((s: { sessionId: string }) => s.sessionId === "dismiss1")).toBe(true);
  });

  it("dismiss route requires a token", async () => {
    const res = await supertest(app.server).post("/sessions/whatever/dismiss");
    expect(res.status).toBe(401);
  });

  it("full hook lifecycle drives the expected status/timeline sequence", async () => {
    const auth = (r: supertest.Test) => r.set("Authorization", `Bearer ${TEST_TOKEN}`);

    await auth(supertest(app.server).post("/hooks/session-start")).send({
      session_id: "life1",
      cwd: "/tmp/life",
      source: "startup",
    });
    await auth(supertest(app.server).post("/hooks/user-prompt-submit")).send({
      session_id: "life1",
      prompt: "build the dashboard",
    });
    await auth(supertest(app.server).post("/hooks/pre-tool-use")).send({
      session_id: "life1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    await auth(supertest(app.server).post("/hooks/post-tool-use")).send({
      session_id: "life1",
      tool_name: "Bash",
      tool_response: { output: "file.txt" },
    });
    await auth(supertest(app.server).post("/hooks/notification")).send({
      session_id: "life1",
      notification_type: "permission_request",
      message: "May I run this?",
    });

    const res = await auth(supertest(app.server).get("/sessions/life1/events"));
    expect(res.body.map((e: { kind: string }) => e.kind)).toEqual([
      "user_prompt",
      "tool_use",
      "tool_result",
      "notification",
    ]);

    const sessions = await auth(supertest(app.server).get("/sessions"));
    expect(sessions.body[0].status).toBe("waiting-permission");
    expect(sessions.body[0].taskSummary).toBe("build the dashboard");
  });
});
