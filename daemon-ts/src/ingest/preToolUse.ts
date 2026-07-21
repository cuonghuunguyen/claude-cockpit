/**
 * `POST /hooks/pre-tool-use` handler — **observe-only in this phase**.
 *
 * Records the upcoming tool call (`tool_use` timeline entry, sets
 * `current_tool`) but never emits any hook-specific-output decision/
 * override field: this handler always acks 200 with no body, i.e. Claude
 * Code's own permission check runs unmodified. Deciding permissions is a
 * later phase (FND-04) — see this plan's `<threat_model>` T-2.1-11 and
 * negative acceptance check on this file. Mirrors
 * `daemon/src/ingest/pre_tool_use.rs`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedJsonSummary } from "../store.js";
import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

export function makePreToolUseHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
    const condensedInput = "tool_input" in body ? condensedJsonSummary(body.tool_input, 200) : "";
    const summary = toolName ? `${toolName}: ${condensedInput}` : condensedInput;

    const request: IngestEventRequest = {
      sessionId,
      event: "PreToolUse",
      cwd,
      notificationType: null,
      toolName,
      timelineSummary: summary,
      payloadJson: JSON.stringify(body),
      isError: false,
      firstPromptText: null,
      markEnded: false,
    };

    // Observe-only ack — no permission-decision output of any kind.
    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
