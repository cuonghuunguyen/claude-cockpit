/**
 * `POST /hooks/permission-request` handler (D-14/D-16, FND-04,
 * ACT-01/ACT-02/ACT-03) — the NEW wildcard-matched general-gating
 * mechanism this phase migrates onto.
 *
 * Unlike `PreToolUse` (which fires for every tool call regardless of
 * whether Claude Code's own permission evaluation would actually prompt),
 * `PermissionRequest` fires ONLY after that evaluation has already decided
 * an interactive dialog is genuinely needed. There is therefore no
 * `needsDecision`-style gate here: every `PermissionRequest` event this
 * handler receives is held.
 *
 * Dispatches the {@link DecisionKind} by `tool_name`: `"ExitPlanMode"`
 * registers a `"plan-mode"` hold (the 3-way Yes / Yes-and-accept-edits / No
 * contract, D-16, 03-RESEARCH.md Pattern 4); every other tool registers the
 * ordinary `"permission"` hold (approve/deny — the same shape 03-01 shipped,
 * now emitting the `PermissionRequest`-shaped output built in
 * `decisions.ts`).
 *
 * Does NOT route through `dispatchIngestEvent`/`transition()`
 * (`ingest/dispatch.ts`) — `PermissionRequest` is not a member of
 * `sessionState.ts`'s `HookEvent` union and has no pure transition arm to
 * express "this call is now blocked pending a human" (03-RESEARCH.md
 * Pitfall 3). Instead this handler composes `ensureSession`/`appendEvent`
 * (timeline visibility) with `beginPermissionHold` (the same hold-begin
 * call-site `preToolUse.ts` uses for its own `AskUserQuestion` hold)
 * directly, mirroring `preToolUse.ts`'s hold-open shape (`reply.hijack()`
 * BEFORE the await, `registerPendingDecision`, raw write/end on resolve).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { appendEvent, condensedJsonSummary, ensureSession, getSessionApi } from "../store.js";
import { publishSessionUpdate } from "./dispatch.js";
import { beginPermissionHold } from "../sessionState.js";
import { registerPendingDecision } from "../decisions.js";
import type { DecisionKind } from "../../../shared/types.js";

export function makePermissionRequestHandler(db: DatabaseType) {
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
    // `null` rather than `""` when there was no `tool_input` to summarize,
    // matching `PendingDecision.toolInputSummary` (mirrors preToolUse.ts's
    // defect-B fix).
    const toolInputSummary = condensedInput.length > 0 ? condensedInput : null;

    // Defensive session creation + timeline entry, WITHOUT going through
    // dispatchIngestEvent (Pitfall 3 — see module doc comment above).
    ensureSession(db, sessionId, cwd);
    appendEvent(db, sessionId, "permission_request", toolName, summary, JSON.stringify(body), false);

    const kind: DecisionKind = toolName === "ExitPlanMode" ? "plan-mode" : "permission";

    // Hijack BEFORE the long await so Fastify never applies any default
    // request/handler timeout to this response (03-RESEARCH.md Pitfall 2).
    reply.hijack();

    beginPermissionHold(db, sessionId, toolName, toolInputSummary);
    publishSessionUpdate(getSessionApi(db, sessionId));

    const decisionJson = await registerPendingDecision(sessionId, kind, () => ({}));

    reply.raw.writeHead(200, { "Content-Type": "application/json" });
    reply.raw.end(JSON.stringify(decisionJson));
  };
}
