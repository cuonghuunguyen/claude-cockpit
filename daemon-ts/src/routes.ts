/**
 * Route registration. Port of `daemon/src/main.rs::build_router` +
 * `daemon/src/ingest/mod.rs::routes` — the read routes (`GET /sessions`,
 * `GET /sessions?active=true`, `GET /sessions/:id/events`) from Wave 1,
 * Wave 2's ingest (`POST /hooks/*`) and dismiss (`POST /sessions/:id/dismiss`)
 * routes, and Wave 3's `GET /events` SSE stream (port of
 * `daemon/src/events_sse.rs`).
 */

import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { requireToken } from "./auth.js";
import { dismissSession, getSessionApi, isTruthy, listSessionEvents, listSessions } from "./store.js";
import { publishSessionUpdate } from "./ingest/dispatch.js";
import * as sse from "./sse.js";
import { makeSessionStartHandler } from "./ingest/sessionStart.js";
import { makeUserPromptSubmitHandler } from "./ingest/userPromptSubmit.js";
import { makePreToolUseHandler } from "./ingest/preToolUse.js";
import { makePostToolUseHandler } from "./ingest/postToolUse.js";
import { makeNotificationHandler } from "./ingest/notification.js";
import { makeStopHandler } from "./ingest/stop.js";
import { makeSessionEndHandler } from "./ingest/sessionEnd.js";

interface ListSessionsQuery {
  /** `?active=true` (or `1`/`TRUE`/`yes`) restricts to the active queue. */
  active?: string;
}

interface SessionIdParams {
  id: string;
}

/**
 * Registers every token-gated route on `app`. `/health` is registered
 * separately in `main.ts` and is NOT behind this auth hook.
 */
export function registerRoutes(app: FastifyInstance, db: DatabaseType, token: string): void {
  const auth = requireToken(token);

  app.get<{ Querystring: ListSessionsQuery }>(
    "/sessions",
    { preHandler: auth },
    async (req, reply) => {
      const activeOnly = req.query.active !== undefined && isTruthy(req.query.active);
      const sessions = listSessions(db, { active: activeOnly });
      reply.send(sessions);
    },
  );

  app.get<{ Params: SessionIdParams }>(
    "/sessions/:id/events",
    { preHandler: auth },
    async (req, reply) => {
      const events = listSessionEvents(db, req.params.id);
      reply.send(events);
    },
  );

  /**
   * `GET /events` (MON-04): token-gated SSE broadcast. Hand-rolled via
   * `reply.raw`/`reply.hijack()` (RESEARCH.md "SSE route with hand-rolled
   * framing") to guarantee byte-exact framing against
   * `daemon/src/events_sse.rs` — the unchanged Tauri consumer
   * (`daemon_client.rs::emit_sse_frame`) is a raw byte-level `\n\n` splitter
   * that only recognizes a literal `data:` prefix. No initial snapshot
   * frame is sent on connect (the Rust `/events` never does either); the
   * client resyncs via `GET /sessions`. `Connection: keep-alive` is
   * included per the hand-rolled pattern but is not itself asserted by the
   * unchanged consumer (which tolerates any non-`data:` line).
   */
  app.get("/events", { preHandler: auth }, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // SSE headers must reach the client immediately, not whenever the first
    // frame happens to be written -- `writeHead` alone only buffers them
    // until the first body write, which could be seconds/minutes away.
    reply.raw.flushHeaders();
    reply.hijack();

    sse.subscribe(reply.raw);
    // Matches axum's `KeepAlive::default()` cadence (15s empty-comment frame).
    const keepAlive = setInterval(() => {
      reply.raw.write(":\n\n");
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(keepAlive);
      sse.unsubscribe(reply.raw);
    });
  });

  /** `POST /sessions/:id/dismiss` (D-06): 200 if found, 404 if unknown. */
  app.post<{ Params: SessionIdParams }>(
    "/sessions/:id/dismiss",
    { preHandler: auth },
    async (req, reply) => {
      const row = dismissSession(db, req.params.id);
      if (!row) {
        reply.code(404).send();
        return;
      }
      publishSessionUpdate(getSessionApi(db, req.params.id));
      reply.code(200).send();
    },
  );

  app.post("/hooks/session-start", { preHandler: auth }, makeSessionStartHandler(db));
  app.post("/hooks/user-prompt-submit", { preHandler: auth }, makeUserPromptSubmitHandler(db));
  app.post("/hooks/pre-tool-use", { preHandler: auth }, makePreToolUseHandler(db));
  app.post("/hooks/post-tool-use", { preHandler: auth }, makePostToolUseHandler(db));
  app.post("/hooks/notification", { preHandler: auth }, makeNotificationHandler(db));
  app.post("/hooks/stop", { preHandler: auth }, makeStopHandler(db));
  // subagent-stop shares the same handler as stop (mirrors ingest/mod.rs's
  // `.route("/hooks/subagent-stop", post(stop::stop))`).
  app.post("/hooks/subagent-stop", { preHandler: auth }, makeStopHandler(db));
  app.post("/hooks/session-end", { preHandler: auth }, makeSessionEndHandler(db));
}
