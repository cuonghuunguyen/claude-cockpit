/**
 * `POST /hooks/post-tool-use` handler.
 *
 * Appends a `tool_result` timeline entry (never changes status —
 * `sessionState.transition` maps `PostToolUse` to a no-op) and clears
 * `current_tool` (the in-flight tool call has finished). If the payload
 * indicates the tool call itself failed, the event is recorded as an
 * `error` (MON-05: visible in the timeline only, never a status change or
 * notification — `PostToolUse` was already a status no-op, so this is
 * consistent either way). Mirrors `daemon/src/ingest/post_tool_use.rs`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedJsonSummary } from "../store.js";
import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makePostToolUseHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
    const toolResponse = body.tool_response;
    const condensedOutput = "tool_response" in body ? condensedJsonSummary(toolResponse, 200) : "";
    const summary = toolName ? `${toolName}: ${condensedOutput}` : condensedOutput;

    // Best-effort detection of a failed tool call — checks
    // tool_response.is_error first, then the top-level is_error field.
    const nestedIsError = isRecord(toolResponse) ? toolResponse.is_error : undefined;
    const isError =
      (typeof nestedIsError === "boolean" ? nestedIsError : undefined) ??
      (typeof body.is_error === "boolean" ? body.is_error : undefined) ??
      false;

    const request: IngestEventRequest = {
      sessionId,
      event: "PostToolUse",
      cwd,
      notificationType: null,
      toolName,
      timelineSummary: summary,
      payloadJson: JSON.stringify(body),
      isError,
      firstPromptText: null,
      markEnded: false,
    };

    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
