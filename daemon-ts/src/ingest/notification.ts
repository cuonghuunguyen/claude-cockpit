/**
 * `POST /hooks/notification` handler.
 *
 * The **only** event that drives `waiting-permission`/`waiting-input`
 * status (not `PreToolUse`). Classifies the raw `notification_type` string
 * via the single centrally-defined `sessionState.classifyNotification`
 * function (applied inside `dispatchIngestEvent`'s call to
 * `sessionState.transition`). Mirrors
 * `daemon/src/ingest/notification.rs`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedText } from "../store.js";
import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

export function makeNotificationHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const notificationType =
      typeof body.notification_type === "string" ? body.notification_type : null;
    const message = typeof body.message === "string" ? body.message : "";

    const request: IngestEventRequest = {
      sessionId,
      event: "Notification",
      cwd,
      notificationType,
      toolName: null,
      timelineSummary: condensedText(message, 200),
      payloadJson: JSON.stringify(body),
      isError: false,
      firstPromptText: null,
      markEnded: false,
    };

    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
