import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { buildApp } from "../src/main.js";
import { openDb } from "../src/store.js";
import { subscriberCount } from "../src/sse.js";

const TEST_TOKEN = "sse-route-test-token-0123456789abcdef012345";

/** Opens a raw `GET /events` connection and resolves once the response
 * headers have arrived (mirrors a real SSE client's connect phase). */
function connectEvents(
  port: number,
  token?: string,
): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: "/events", method: "GET", headers },
      (res) => resolve({ req, res }),
    );
    req.on("error", reject);
    req.end();
  });
}

/** Reads the raw stream until exactly one complete `data: ...\n\n` frame
 * has arrived, then returns those bytes verbatim (no trimming/parsing). */
function readOneDataFrame(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n\n");
      if (idx !== -1 && buf.startsWith("data:")) {
        res.off("data", onData);
        resolve(buf.slice(0, idx + 2));
      }
    };
    res.on("data", onData);
    res.on("error", reject);
  });
}

describe("GET /events SSE route (byte-exact framing, token-gating, cleanup)", () => {
  let tmpDir: string;
  let db: DatabaseType;
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-sse-route-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
    app = buildApp(db, TEST_TOKEN);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 401 without a token", async () => {
    const res = await supertest(app.server).get("/events");
    expect(res.status).toBe(401);
  });

  it(
    "connects with 200/text-event-stream/no-cache/no-CORS, streams exactly one frame per mutation " +
      "(no initial snapshot), and cleans up the subscriber + keep-alive interval on disconnect",
    async () => {
      expect(subscriberCount()).toBe(0);

      const { req, res } = await connectEvents(port, TEST_TOKEN);
      try {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        expect(res.headers["cache-control"]).toBe("no-cache");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(subscriberCount()).toBe(1);

        const framePromise = readOneDataFrame(res);

        // No snapshot frame arrives on connect -- only this mutation
        // produces one, so awaiting the promise below proves the "no
        // initial snapshot" requirement as a side effect: if a snapshot had
        // already been sent, readOneDataFrame would have resolved with a
        // frame containing no sessionId before this POST ever ran.
        const postRes = await supertest(app.server)
          .post("/hooks/session-start")
          .set("Authorization", `Bearer ${TEST_TOKEN}`)
          .send({ session_id: "sse1", cwd: "/tmp/x", source: "startup" });
        expect(postRes.status).toBe(200);

        const frame = await framePromise;
        expect(frame.startsWith("data: ")).toBe(true);
        expect(frame.endsWith("\n\n")).toBe(true);
        expect(frame).not.toMatch(/event:|id:|retry:/);

        const payload = JSON.parse(frame.slice("data: ".length, frame.length - 2)) as {
          sessionId: string;
        };
        expect(payload.sessionId).toBe("sse1");
      } finally {
        req.destroy();
      }

      // Give the route's 'close' handler a tick to run (clearInterval +
      // unsubscribe happen synchronously inside it, but the 'close' event
      // itself is emitted asynchronously after req.destroy()).
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(subscriberCount()).toBe(0);
    },
  );
});
