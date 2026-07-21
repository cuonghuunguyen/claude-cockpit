import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { buildApp } from "../src/main.js";
import { openDb } from "../src/store.js";

const TEST_TOKEN = "test-token-0123456789abcdef0123456789ab";

describe("read routes (real Fastify instance + real on-disk SQLite temp file)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-routes-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("health_is_reachable_without_a_token", async () => {
    const res = await supertest(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  describe("session_route_token_gated", () => {
    it("returns 401 with no token", async () => {
      const res = await supertest(app.server).get("/sessions");
      expect(res.status).toBe(401);
    });

    it("returns 401 (not 500) for a wrong-length token", async () => {
      const res = await supertest(app.server)
        .get("/sessions")
        .set("Authorization", "Bearer too-short");
      expect(res.status).toBe(401);
    });

    it("returns 401 for an empty ?token=", async () => {
      const res = await supertest(app.server).get("/sessions?token=");
      expect(res.status).toBe(401);
    });

    it("returns 200 JSON array with a valid Bearer token, and no CORS header", async () => {
      const res = await supertest(app.server)
        .get("/sessions")
        .set("Authorization", `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("accepts the token via ?token= query param fallback", async () => {
      const res = await supertest(app.server).get(`/sessions?token=${TEST_TOKEN}`);
      expect(res.status).toBe(200);
    });

    it("prefers the Bearer header over ?token= when both are present", async () => {
      const res = await supertest(app.server)
        .get("/sessions?token=wrong-value-entirely")
        .set("Authorization", `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  describe("session_events_route_is_token_gated_and_chronological", () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO sessions (session_id, status, started_at, last_activity_at)
         VALUES (?, 'running', 100, 100)`,
      ).run("ev1");
      db.prepare(
        `INSERT INTO events (session_id, kind, tool_name, summary, is_error, created_at)
         VALUES (?, 'user_prompt', NULL, 'build the dashboard', 0, 100)`,
      ).run("ev1");
      db.prepare(
        `INSERT INTO events (session_id, kind, tool_name, summary, is_error, created_at)
         VALUES (?, 'tool_use', 'Bash', 'ran ls', 0, 200)`,
      ).run("ev1");
    });

    it("returns 401 without a token", async () => {
      const res = await supertest(app.server).get("/sessions/ev1/events");
      expect(res.status).toBe(401);
    });

    it("returns 200, chronological (ascending id), camelCase, with a valid token", async () => {
      const res = await supertest(app.server)
        .get("/sessions/ev1/events")
        .set("Authorization", `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      expect(res.body[0].kind).toBe("user_prompt");
      expect(res.body[1].kind).toBe("tool_use");
      expect(res.body[1].toolName).toBe("Bash");
    });
  });

  describe("empty_list_cases", () => {
    it("GET /sessions on an empty DB returns []", async () => {
      const res = await supertest(app.server)
        .get("/sessions")
        .set("Authorization", `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("GET /sessions/:id/events for an unknown session_id returns [] (200, never 404)", async () => {
      const res = await supertest(app.server)
        .get("/sessions/does-not-exist/events")
        .set("Authorization", `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
