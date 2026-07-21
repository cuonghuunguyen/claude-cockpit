/**
 * `POST /hooks/session-start` handler.
 *
 * Parses the Claude Code `SessionStart` payload, upserts the session row
 * directly via `store.upsertSessionStart` (this handler does NOT route
 * through `dispatchIngestEvent` — mirrors `daemon/src/ingest/session_start.rs`,
 * which also bypasses `handle_ingest_event`/`dispatch_ingest_event`),
 * acknowledges 200 with no body, and publishes the updated session (no-op
 * stub seam this wave, see `ingest/dispatch.ts`).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { getSessionApi, upsertSessionStart } from "../store.js";
import { publishSessionUpdate } from "./dispatch.js";

export function makeSessionStartHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    // Claude Code's own SessionStart reason (startup/resume/clear/compact),
    // NOT an origin-environment classification.
    const source = typeof body.source === "string" ? body.source : "unknown";

    upsertSessionStart(db, sessionId, cwd, source);
    publishSessionUpdate(getSessionApi(db, sessionId));

    reply.code(200).send();
  };
}
