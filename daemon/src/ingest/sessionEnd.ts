/**
 * `POST /hooks/session-end` handler.
 *
 * Marks `ended_at` (via `IngestEventRequest.markEnded`) but never changes
 * `status` by itself — a `done`/`waiting-*` unresolved session stays
 * visible in the active queue after the process exits. Mirrors
 * `daemon/src/ingest/session_end.rs`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

export function makeSessionEndHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const reason = typeof body.reason === "string" ? body.reason : "unknown";

    const request: IngestEventRequest = {
      sessionId,
      event: "SessionEnd",
      cwd,
      notificationType: null,
      toolName: null,
      timelineSummary: `session ended (${reason})`,
      payloadJson: JSON.stringify(body),
      isError: false,
      firstPromptText: null,
      markEnded: true,
    };

    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
