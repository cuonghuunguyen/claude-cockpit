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
import {
  dismissSession,
  getSession,
  getSessionApi,
  isTruthy,
  listSessionEvents,
  listSessions,
  updateSessionStatus,
} from "./store.js";
import { publishSessionUpdate } from "./ingest/dispatch.js";
import * as sse from "./sse.js";
import { makeSessionStartHandler } from "./ingest/sessionStart.js";
import { makeUserPromptSubmitHandler } from "./ingest/userPromptSubmit.js";
import { makePreToolUseHandler } from "./ingest/preToolUse.js";
import { makePermissionRequestHandler } from "./ingest/permissionRequest.js";
import { makePostToolUseHandler } from "./ingest/postToolUse.js";
import { makeNotificationHandler } from "./ingest/notification.js";
import { makeStopHandler } from "./ingest/stop.js";
import { makeSessionEndHandler } from "./ingest/sessionEnd.js";
import {
  buildHookDecisionOutput,
  getPendingDecisionKind,
  releasePendingDecisionOnDismiss,
  resolvePendingDecision,
} from "./decisions.js";
import type { Decision } from "../../shared/types.js";

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

  /**
   * `POST /sessions/:id/dismiss` (D-06): 200 if found, 404 if unknown. Also
   * releases a held decision (D-03(c)): dismissing a card while it is
   * holding a `PreToolUse` response open resolves that hold to an empty
   * decision, which `hook-client/pretooluse-wrapper.cjs` forwards as
   * release-to-native.
   */
  app.post<{ Params: SessionIdParams }>(
    "/sessions/:id/dismiss",
    { preHandler: auth },
    async (req, reply) => {
      const row = dismissSession(db, req.params.id);
      if (!row) {
        reply.code(404).send();
        return;
      }
      releasePendingDecisionOnDismiss(req.params.id);
      publishSessionUpdate(getSessionApi(db, req.params.id));
      reply.code(200).send();
    },
  );

  /**
   * `POST /sessions/:id/decision` (FND-04/ACT-01/ACT-03, D-04): resolves a
   * held `PreToolUse` response with the client-submitted {@link Decision}.
   * Mirrors the `dismiss` route's app->daemon POST pattern (03-RESEARCH.md,
   * `<assumption_delta_decision>`). 404/409 (T-03-02) when no pending entry
   * exists for `:id` — including a second POST after the hold already
   * resolved, timed out, or was dismissed; `resolvePendingDecision` is the
   * one-shot idempotent choke point that guarantees this.
   */
  app.post<{ Params: SessionIdParams; Body: Decision }>(
    "/sessions/:id/decision",
    { preHandler: auth },
    async (req, reply) => {
      const sessionId = req.params.id;
      const kind = getPendingDecisionKind(sessionId);
      if (!kind) {
        // No live hold for this session in the in-memory registry, yet the
        // client card believed a decision was still pending (it submitted
        // one) -- an ORPHANED HOLD. This happens when the registry entry is
        // gone but the SQL-persisted status is still `waiting-permission`:
        // either the daemon restarted (dev `tsx watch` wipes the in-memory
        // registry on every file save) or the hold's own ~585s timeout
        // already elapsed. In both cases the underlying hook process has
        // already released to native (or will, on its own timeout), so the
        // tool call is no longer actually blocked on us -- but the card keeps
        // rendering live-looking Approve/Deny controls that can only ever
        // 404. Reconcile the stored status back off `waiting-permission` (to
        // `running`, the same underlying state `beginPermissionHold` had
        // overridden -- see `sessionState.ts`/`store.ts`; this reuses the
        // existing `updateSessionStatus` writer rather than inventing a new
        // transition) and publish, so the next SSE frame clears the dead
        // controls. Guarded on the current status: a 404 for an
        // already-done/unknown session must never resurrect it to `running`.
        const row = getSession(db, sessionId);
        if (row && row.status === "waiting-permission") {
          updateSessionStatus(db, sessionId, "running", null);
          publishSessionUpdate(getSessionApi(db, sessionId));
        }
        reply.code(404).send();
        return;
      }

      let outputJson: unknown;
      try {
        outputJson = buildHookDecisionOutput(kind, req.body, sessionId);
      } catch (err) {
        reply.code(400).send({ error: (err as Error).message });
        return;
      }

      const resolved = resolvePendingDecision(sessionId, outputJson);
      if (!resolved) {
        // Lost a race against the registry's own timeout/dismiss between
        // the getPendingDecisionKind check above and here.
        reply.code(409).send();
        return;
      }

      publishSessionUpdate(getSessionApi(db, sessionId));
      reply.code(200).send();
    },
  );

  app.post("/hooks/session-start", { preHandler: auth }, makeSessionStartHandler(db));
  app.post("/hooks/user-prompt-submit", { preHandler: auth }, makeUserPromptSubmitHandler(db));
  app.post("/hooks/pre-tool-use", { preHandler: auth }, makePreToolUseHandler(db));
  // NEW (D-14/D-16, 03-05): the wildcard-matched general-gating mechanism —
  // registered next to /hooks/pre-tool-use, same auth preHandler (FND-05).
  app.post("/hooks/permission-request", { preHandler: auth }, makePermissionRequestHandler(db));
  app.post("/hooks/post-tool-use", { preHandler: auth }, makePostToolUseHandler(db));
  app.post("/hooks/notification", { preHandler: auth }, makeNotificationHandler(db));
  app.post("/hooks/stop", { preHandler: auth }, makeStopHandler(db));
  // subagent-stop shares the same handler as stop (mirrors ingest/mod.rs's
  // `.route("/hooks/subagent-stop", post(stop::stop))`).
  app.post("/hooks/subagent-stop", { preHandler: auth }, makeStopHandler(db));
  app.post("/hooks/session-end", { preHandler: auth }, makeSessionEndHandler(db));
}
