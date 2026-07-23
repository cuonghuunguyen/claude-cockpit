/**
 * `POST /hooks/pre-tool-use` handler (FND-04, ACT-01, ACT-03; reworked
 * D-14/03-05).
 *
 * Records the upcoming tool call (`tool_use` timeline entry, sets
 * `current_tool`) exactly as before. Per D-14, this handler is now
 * PASS-THROUGH for the general case: general tool-call permission gating
 * moved to the NEW wildcard `PermissionRequest` hook
 * (`ingest/permissionRequest.ts`), which Claude Code fires only after its
 * own permission evaluation has decided an interactive dialog is genuinely
 * needed. Holding here for every tool regardless of whether Claude Code
 * would actually prompt was the root cause of the phantom-hold defect this
 * migration removes (03-RESEARCH.md Finding A).
 *
 * `AskUserQuestion` (03-03, D-15) is the ONE deliberate exception and is
 * unchanged by this migration: it is not a permission decision at all (no
 * dialog for `PermissionRequest` to fire on) but an answer-injection
 * contract, so it keeps holding here exactly as before — mark the session
 * `waiting-permission`, publish the update, and HOLD the HTTP response open
 * (`reply.hijack()` — the same pattern already proven for `GET /events`,
 * bypassing Fastify 5's opt-in `handlerTimeout`) until
 * `registerPendingDecision` resolves — either via `POST
 * /sessions/:id/decision`, a dismiss, or the registry's own timeout (D-03).
 * The held response body is always the built `hookSpecificOutput` JSON (or
 * `{}` on release-to-native), forwarded verbatim by
 * `hook-client/pretooluse-wrapper.cjs` to Claude Code.
 *
 * Every other tool call gets a fast, non-blocking ack with NO decision
 * output of any kind — Claude Code's own native permission evaluation
 * decides, uninterrupted by this handler.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { condensedJsonSummary, getSessionApi } from "../store.js";
import { dispatchIngestEvent, publishSessionUpdate } from "./dispatch.js";
import type { IngestEventRequest } from "./dispatch.js";
import { beginPermissionHold } from "../sessionState.js";
import { parseAskUserQuestionQuestions, registerPendingDecision } from "../decisions.js";
import type { DecisionKind } from "../../../shared/types.js";

/**
 * Reduced per D-14/03-05: PreToolUse no longer resolves the general
 * tool-call permission decision (that moved to the wildcard
 * `PermissionRequest` hook — `ingest/permissionRequest.ts`). `true` iff the
 * incoming call is `AskUserQuestion` (03-03, D-15's preserved exception —
 * an answer-injection contract, not a permission decision); `false` for
 * every other tool, which now falls through to the fast, non-blocking ack.
 * The prior denylist/`permission_mode` heuristic (`NO_DECISION_NEEDED_TOOLS`
 * / `holdsForPermissionMode`) is removed — it was the phantom-hold defect's
 * root cause (holding on this hook for tools Claude Code's own permission
 * evaluation would never actually have prompted for).
 */
export function needsDecision(toolName: string | null, _body: Record<string, unknown>): boolean {
  return toolName === "AskUserQuestion";
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
    // Same condensed summary, reused for the held card's pending-decision
    // payload (defect-B fix) — `null` rather than `""` when there was no
    // `tool_input` to summarize, matching `PendingDecision.toolInputSummary`.
    const toolInputSummary = condensedInput.length > 0 ? condensedInput : null;

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

      beginPermissionHold(db, sessionId, toolName, toolInputSummary);
      publishSessionUpdate(getSessionApi(db, sessionId));

      // 03-03 (ACT-02): AskUserQuestion registers its own decision kind,
      // carrying the ORIGINAL tool_input.questions array on the pending
      // entry (decisions.ts) — needed both to render the card's options and,
      // at answer time, to validate/echo the answer (03-RESEARCH.md
      // Pattern 3, Pitfall 5). Every other decision-requiring tool keeps
      // 03-01's plain binary approve/deny "permission" kind.
      const kind: DecisionKind = toolName === "AskUserQuestion" ? "ask-user-question" : "permission";
      const questions = kind === "ask-user-question" ? parseAskUserQuestionQuestions(body.tool_input) : undefined;

      const decisionJson = await registerPendingDecision(sessionId, kind, () => ({}), undefined, questions);

      reply.raw.writeHead(200, { "Content-Type": "application/json" });
      reply.raw.end(JSON.stringify(decisionJson));
      return;
    }

    // Fast, non-blocking ack — no permission-decision output of any kind.
    reply.code(200).send();
  };
}
