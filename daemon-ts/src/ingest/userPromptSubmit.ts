/**
 * `POST /hooks/user-prompt-submit` handler.
 *
 * Appends a `user_prompt` timeline entry and, if this is the session's
 * first-ever prompt, stores it verbatim as the stable `task_summary` (D-08)
 * — later prompts never overwrite it (`store.setTaskSummaryIfAbsent` is
 * idempotent). Also clears any prior `done`/`waiting-*` status back to
 * `running` via `sessionState.transition` (applied inside
 * `dispatchIngestEvent`). Mirrors `daemon/src/ingest/user_prompt_submit.rs`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedText } from "../store.js";
import { dispatchIngestEvent } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";

export function makeUserPromptSubmitHandler(db: DatabaseType) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    if (!sessionId) {
      reply.code(400).send();
      return;
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : null;

    // Claude Code's documented field name is `prompt`; `message` is
    // accepted defensively (exact payload shape verified live pre-Phase 2.1).
    const promptText =
      (typeof body.prompt === "string" ? body.prompt : undefined) ??
      (typeof body.message === "string" ? body.message : undefined) ??
      "";

    const request: IngestEventRequest = {
      sessionId,
      event: "UserPromptSubmit",
      cwd,
      notificationType: null,
      toolName: null,
      timelineSummary: condensedText(promptText, 200),
      payloadJson: JSON.stringify(body),
      isError: false,
      firstPromptText: promptText.length > 0 ? promptText : null,
      markEnded: false,
    };

    dispatchIngestEvent(db, request);
    reply.code(200).send();
  };
}
