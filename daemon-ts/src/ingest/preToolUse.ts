/**
 * `POST /hooks/pre-tool-use` handler (FND-04, ACT-01, ACT-03).
 *
 * Records the upcoming tool call (`tool_use` timeline entry, sets
 * `current_tool`) exactly as before. For a decision-requiring tool
 * ({@link needsDecision}) the handler no longer acks immediately: it marks
 * the session `waiting-permission`, publishes the update so the card shows
 * the ask without delay, and HOLDS the HTTP response open
 * (`reply.hijack()` — the same pattern already proven for `GET /events`,
 * bypassing Fastify 5's opt-in `handlerTimeout`) until
 * `registerPendingDecision` resolves — either via `POST
 * /sessions/:id/decision`, a dismiss, or the registry's own timeout (D-03).
 * The held response body is always the built `hookSpecificOutput` JSON
 * (or `{}` on release-to-native), forwarded verbatim by
 * `hook-client/pretooluse-wrapper.cjs` to Claude Code.
 *
 * Ordinary (non-decision) tool calls keep today's fast, non-blocking ack —
 * this handler is no longer observe-only in general, but it emits no
 * decision output for anything `needsDecision` excludes. Mirrors
 * `daemon/src/ingest/pre_tool_use.rs`'s original shape, extended per
 * 03-RESEARCH.md Pattern 2.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedJsonSummary, getSessionApi } from "../store.js";
import { dispatchIngestEvent, publishSessionUpdate } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";
import { beginPermissionHold } from "../sessionState.js";
import { registerPendingDecision } from "../decisions.js";

/**
 * Conservative denylist (03-01 scope) of tools that never need an
 * interactive decision through this hold-open channel: read-only/inert
 * tools that never mutate state and are never gated by an interactive
 * permission prompt in practice. `AskUserQuestion` is explicitly excluded
 * here too — it gets its own answer-injection contract in a later plan
 * (03-03), not the binary approve/deny built in this plan. Everything else
 * arriving at `PreToolUse` is scoped conservatively as decision-requiring;
 * this is the walking skeleton of the whole phase's decision channel, not a
 * claim that every one of these tools would actually show a native
 * permission prompt.
 */
const NO_DECISION_NEEDED_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "WebSearch", "BashOutput"]);

export function needsDecision(toolName: string | null, _body: Record<string, unknown>): boolean {
  if (!toolName) {
    return false;
  }
  if (toolName === "AskUserQuestion") {
    return false; // 03-03 owns AskUserQuestion's answer-injection contract.
  }
  return !NO_DECISION_NEEDED_TOOLS.has(toolName);
}

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

    dispatchIngestEvent(db, request);

    if (needsDecision(toolName, body)) {
      // Hijack BEFORE the long await so Fastify never applies any default
      // request/handler timeout to this response (03-RESEARCH.md Pitfall 2).
      reply.hijack();

      beginPermissionHold(db, sessionId, toolName);
      publishSessionUpdate(getSessionApi(db, sessionId));

      const decisionJson = await registerPendingDecision(sessionId, "permission", () => ({}));

      reply.raw.writeHead(200, { "Content-Type": "application/json" });
      reply.raw.end(JSON.stringify(decisionJson));
      return;
    }

    // Fast, non-blocking ack — no permission-decision output of any kind.
    reply.code(200).send();
  };
}
