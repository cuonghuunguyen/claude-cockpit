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
import { parseAskUserQuestionQuestions, registerPendingDecision } from "../decisions.js";
import type { DecisionKind } from "../../../shared/types.js";

/**
 * Conservative denylist (03-01 scope) of tools that never need an
 * interactive decision through this hold-open channel: read-only/inert
 * tools that never mutate state and are never gated by an interactive
 * permission prompt in practice. `AskUserQuestion` is handled separately
 * (see {@link needsDecision} below) — it always needs an answer regardless
 * of `permission_mode`, so it is never checked against this set or the
 * `permission_mode` gate. Everything else arriving at `PreToolUse` is
 * scoped conservatively as decision-requiring; this is the walking
 * skeleton of the whole phase's decision channel, not a claim that every
 * one of these tools would actually show a native permission prompt.
 */
const NO_DECISION_NEEDED_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "WebSearch", "BashOutput"]);

export function needsDecision(toolName: string | null, body: Record<string, unknown>): boolean {
  if (!toolName) {
    return false;
  }
  if (toolName === "AskUserQuestion") {
    // 03-03 (ACT-02): AskUserQuestion always blocks on a real answer —
    // unlike an ordinary tool-approval prompt, it is never skipped by
    // `permission_mode` (Claude Code shows its own interactive picker for
    // this tool regardless of mode), so it bypasses `holdsForPermissionMode`
    // entirely.
    return true;
  }
  if (NO_DECISION_NEEDED_TOOLS.has(toolName)) {
    return false;
  }
  return holdsForPermissionMode(body.permission_mode);
}

/**
 * Gates the hold on the session's current permission mode (D-fix, live
 * Phase 3 test): Claude Code only shows an interactive permission prompt in
 * `default` mode (docs.claude.code `/permission-modes`: "default... prompts
 * for user permission on first use of each tool"; `/hooks` "Common input
 * fields" confirms every hook event — including `PreToolUse` — carries a
 * `permission_mode` field alongside `session_id`/`cwd`). In `acceptEdits`,
 * `bypassPermissions`, `plan`, `auto`, and `dontAsk` modes the tool call
 * would never have prompted, so holding here would incorrectly stall a
 * session running with e.g. `--dangerously-skip-permissions`
 * (`bypassPermissions`) — every single tool call would otherwise show a
 * false "waiting for permission" card. `plan` mode additionally gets its own
 * 3-way `PermissionRequest`/`ExitPlanMode` contract in plan 03-05 — this
 * gate simply excludes it from 03-01's binary approve/deny hold, it does
 * not implement 03-05's behavior.
 *
 * A missing/non-string `permission_mode` (e.g. a Claude Code build that
 * predates the field) fails safe to the pre-existing hold behavior by
 * treating it the same as `"default"` — this is a deliberate fail-safe, not
 * a guess: we hold (as before this fix) rather than silently stop gating
 * permission prompts we can't classify.
 *
 * KNOWN LIMITATION (left as-is, not addressed by this fix): even in
 * `default` mode, a tool/command the user has already allow-listed (via
 * `allowedTools`, a project rule, or a prior "always allow" choice) would
 * still be held here, because this gate only inspects `permission_mode` —
 * it has no visibility into Claude Code's own allow-list evaluation, which
 * happens downstream of this hook. That case would show a hold the native
 * flow would have skipped; out of scope for this bug-fix pass.
 */
function holdsForPermissionMode(permissionMode: unknown): boolean {
  return permissionMode === undefined || permissionMode === null || permissionMode === "default";
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
