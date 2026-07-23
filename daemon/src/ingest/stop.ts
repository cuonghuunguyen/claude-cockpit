/**
 * `POST /hooks/stop` and `POST /hooks/subagent-stop` handler (shared — both
 * events map identically: `sessionState.transition` -> `done`,
 * `sessionState.timelineKind` -> `"completion"`; a finished session stays
 * prominent until acted on or dismissed). Mirrors `daemon/src/ingest/stop.rs`
 * — `routes.ts` registers this SAME handler under both route paths, exactly
 * as `ingest/mod.rs` routes `/hooks/subagent-stop` to `stop::stop`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedText } from "../store.js";
import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

export function makeStopHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const lastMessage =
      typeof body.last_assistant_message === "string" ? body.last_assistant_message : undefined;
    const summary = lastMessage !== undefined ? condensedText(lastMessage, 200) : "Agent turn complete";

    const request: IngestEventRequest = {
      sessionId,
      // Both /hooks/stop and /hooks/subagent-stop map to the same HookEvent
      // — transition()/timelineKind() treat Stop and SubagentStop
      // identically, so the choice here is immaterial to the result
      // (mirrors stop.rs, which always builds HookEvent::Stop regardless
      // of which route invoked it).
      event: "Stop",
      cwd,
      notificationType: null,
      toolName: null,
      timelineSummary: summary,
      payloadJson: JSON.stringify(body),
      isError: false,
      firstPromptText: null,
      markEnded: false,
    };

    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
