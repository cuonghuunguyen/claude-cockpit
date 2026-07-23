/**
 * In-memory pending-decision registry (FND-04, ACT-01, ACT-03, D-04).
 *
 * The Node `Promise`/`Map` analogue of what a retired-Rust-daemon design
 * would have needed a `tokio::oneshot`/`Mutex<HashMap<...>>` for — Node's
 * single-threaded event loop makes the mutex unnecessary. Shape mirrors
 * `daemon/src/sse.ts`'s subscriber-registry discipline (register /
 * resolve-or-cleanup / "a missing entry is always a safe no-op, never a
 * throw"). See 03-RESEARCH.md Pattern 2.
 *
 * Deliberately NOT persisted: a daemon restart mid-decision correctly falls
 * through to Claude Code's own hook-timeout failsafe (D-03), matching the
 * project's existing "no separate in-memory session cache; everything reads
 * straight from SQLite" posture for anything that IS persisted.
 */

import type { Decision, DecisionKind } from "../../shared/types.js";

/** One selectable option of an `AskUserQuestion` question, as Claude's own `tool_input.questions[].options[]` shape (untyped/undocumented as a Cockpit wire type — internal to the daemon, never exposed via `shared/types.ts`). */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** One question of an `AskUserQuestion` call's `tool_input.questions` array (03-RESEARCH.md Pattern 3). */
export interface AskUserQuestionQuestionInput {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

interface RegistryEntry {
  resolve: (json: unknown) => void;
  timer: NodeJS.Timeout;
  kind: DecisionKind;
  /**
   * The ORIGINAL `tool_input.questions` array recorded at hold-begin, kept
   * only for `kind === "ask-user-question"` — the daemon needs this both to
   * render the card's options (`daemon/src/store.ts::derivePendingDecision`)
   * and, at answer time, to validate submitted labels against the recorded
   * options and to echo the array back unchanged in `updatedInput`
   * (03-RESEARCH.md Pitfall 5: never omit the echoed `questions` array).
   */
  questions?: AskUserQuestionQuestionInput[];
}

const pending = new Map<string, RegistryEntry>();

/**
 * Defensively parses `tool_input.questions` out of a raw, untrusted
 * `PreToolUse` payload for `AskUserQuestion` (the payload originates from
 * Claude Code's own tool call, but the daemon must not assume any field is
 * present/well-typed). Returns `undefined` (never throws) when the shape
 * doesn't match — the caller then registers the hold with no recorded
 * questions, and any later answer attempt fails safely via
 * `buildHookDecisionOutput`'s own guard.
 */
export function parseAskUserQuestionQuestions(toolInput: unknown): AskUserQuestionQuestionInput[] | undefined {
  if (!toolInput || typeof toolInput !== "object") {
    return undefined;
  }
  const rawQuestions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions)) {
    return undefined;
  }
  const parsed: AskUserQuestionQuestionInput[] = [];
  for (const rawQuestion of rawQuestions) {
    if (!rawQuestion || typeof rawQuestion !== "object") {
      continue;
    }
    const q = rawQuestion as Record<string, unknown>;
    if (typeof q.question !== "string" || !Array.isArray(q.options)) {
      continue;
    }
    const options: AskUserQuestionOption[] = [];
    for (const rawOption of q.options) {
      if (!rawOption || typeof rawOption !== "object") {
        continue;
      }
      const o = rawOption as Record<string, unknown>;
      if (typeof o.label !== "string") {
        continue;
      }
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
      });
    }
    parsed.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/** D-01/D-03: the "release to native prompt" payload — no decision at all. */
const EMPTY_DECISION: Record<string, never> = {};

/**
 * Slightly shorter than the wrapper's own ~590s `AbortSignal` budget
 * (`hook-client/pretooluse-wrapper.cjs`'s `HOLD_OPEN_TIMEOUT_MS`), so the
 * DAEMON's own timer fires first and can clean up state/log before the
 * wrapper's independent abort would have fired anyway (03-RESEARCH.md
 * Pattern 2).
 */
const PRODUCTION_DEFAULT_TIMEOUT_MS = 585_000;

/**
 * Test-only seam (never called from production code): overrides the
 * default pending-decision timeout so integration tests can exercise the
 * D-03(a) timeout-release path in milliseconds instead of waiting ~585s.
 * Restored to the production default in every spec's `afterEach`.
 */
let defaultTimeoutMs = PRODUCTION_DEFAULT_TIMEOUT_MS;
export function __setDefaultTimeoutMsForTests(ms: number): void {
  defaultTimeoutMs = ms;
}

/**
 * Registers a held decision for `sessionId` and returns a `Promise` that
 * resolves either when {@link resolvePendingDecision} is called for the same
 * `sessionId`, or when `timeoutMs` elapses (D-03(a) — resolves with
 * `onTimeout()`'s result, the release-to-native payload). Overwrites any
 * prior entry for the same `sessionId` (a session can only hold one decision
 * at a time; the ingest handlers never register a second hold before the
 * first resolves).
 */
export function registerPendingDecision(
  sessionId: string,
  kind: DecisionKind,
  onTimeout: () => unknown,
  timeoutMs: number = defaultTimeoutMs,
  questions?: AskUserQuestionQuestionInput[],
): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      resolve(onTimeout());
    }, timeoutMs);
    pending.set(sessionId, { resolve, timer, kind, questions });
  });
}

/**
 * Resolves the held decision for `sessionId` with `json` (the built
 * `hookSpecificOutput` payload). One-shot and idempotent (T-03-02): deletes
 * the Map entry before resolving, so a stale/replayed/duplicate call for an
 * already-resolved, timed-out, or dismissed hold safely returns `false`
 * rather than throwing or double-firing.
 */
export function resolvePendingDecision(sessionId: string, json: unknown): boolean {
  const entry = pending.get(sessionId);
  if (!entry) {
    return false;
  }
  clearTimeout(entry.timer);
  pending.delete(sessionId);
  entry.resolve(json);
  return true;
}

/** D-03(c): dismissing a held card releases the hook with the same "no decision" payload as a timeout. */
export function releasePendingDecisionOnDismiss(sessionId: string): boolean {
  return resolvePendingDecision(sessionId, EMPTY_DECISION);
}

/** True while `sessionId` currently has a held decision registered. */
export function hasPendingDecision(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** The `DecisionKind` a pending hold was registered with, or `null` if none is pending — needed by the decision route to select the right `buildHookDecisionOutput` branch. */
export function getPendingDecisionKind(sessionId: string): DecisionKind | null {
  return pending.get(sessionId)?.kind ?? null;
}

/**
 * The recorded `tool_input.questions` array for `sessionId`'s pending
 * `ask-user-question` hold, or `null` when there is no pending hold (or it
 * wasn't registered with any questions — a malformed `AskUserQuestion`
 * payload). Used both by `daemon/src/store.ts::derivePendingDecision`
 * (to render the card's options) and by `buildAskUserQuestionOutput` below
 * (to validate/echo at answer time).
 */
export function getPendingDecisionQuestions(sessionId: string): AskUserQuestionQuestionInput[] | null {
  return pending.get(sessionId)?.questions ?? null;
}

/**
 * Length bound (Unicode code points) for a free-text deny reason, matching
 * the existing `condensedJsonSummary`/`condensedText` discipline
 * (`daemon/src/store.ts`) of counting `Array.from(...).length` rather
 * than raw UTF-16 `.length` (ACT-03 — never split a surrogate pair).
 */
const MAX_REASON_CODE_POINTS = 200;

/**
 * Builds the exact `hookSpecificOutput` JSON to deliver back to the held
 * hook for a resolved {@link Decision}, given the {@link DecisionKind} the
 * hold was registered under. This is the ONE choke point every response
 * surface (card, toast) funnels through — see this phase's
 * `<assumption_delta_decision>`. `sessionId` is required for the
 * `ask-user-question` branch (to look up the recorded `tool_input.questions`
 * this same registry retained at hold-begin — see {@link RegistryEntry});
 * the caller (`daemon/src/routes.ts`'s decision route) MUST pass it
 * before resolving/deleting the pending entry. `permission` and `plan-mode`
 * both emit the `PermissionRequest` `decision.behavior` shape (03-05,
 * D-14/D-16) — only `ask-user-question` keeps `hookEventName: "PreToolUse"`
 * (03-03, D-15, untouched by this migration).
 */
export function buildHookDecisionOutput(kind: DecisionKind, decision: Decision, sessionId?: string): unknown {
  switch (kind) {
    case "permission":
      return buildPermissionOutput(decision);
    case "ask-user-question":
      return buildAskUserQuestionOutput(decision, sessionId);
    case "plan-mode":
      return buildPlanModeOutput(decision);
  }
}

/**
 * `ask-user-question` kind (ACT-02, 03-RESEARCH.md Pattern 3): answers the
 * FIRST recorded question only (matches this plan's `PendingDecision.options`
 * scope — see `store.ts::derivePendingDecision`). Validates every submitted
 * label against that question's recorded `options[].label` set (T-03-03 —
 * an arbitrary/fabricated label is rejected, never forwarded upstream),
 * comma-joins multiSelect selections into a single answer string, and
 * ALWAYS echoes the complete original `questions` array back unchanged
 * alongside the constructed `answers` map (Pitfall 5 — never assume
 * `updatedInput` is shallow-merged over the original `tool_input`).
 */
function buildAskUserQuestionOutput(decision: Decision, sessionId?: string): unknown {
  if (decision.type !== "answer") {
    throw new Error(`buildHookDecisionOutput: Decision.type "${decision.type}" is not valid for kind "ask-user-question"`);
  }
  if (!sessionId) {
    throw new Error("buildHookDecisionOutput: sessionId is required to build an ask-user-question decision");
  }
  const questions = getPendingDecisionQuestions(sessionId);
  if (!questions || questions.length === 0) {
    throw new Error("buildHookDecisionOutput: no recorded questions for this session's ask-user-question hold");
  }
  const firstQuestion = questions[0];
  const validLabels = new Set(firstQuestion.options.map((option) => option.label));
  for (const label of decision.answers) {
    if (!validLabels.has(label)) {
      throw new Error(
        `buildHookDecisionOutput: "${label}" is not one of the recorded options for "${firstQuestion.question}"`,
      );
    }
  }
  const joinedAnswer = decision.answers.join(", ");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        questions,
        answers: { [firstQuestion.question]: joinedAnswer },
      },
    },
  };
}

/**
 * `permission` kind (ACT-01/ACT-03; reworked D-14/03-05 to the
 * `PermissionRequest` `decision.behavior` shape): approve ->
 * `decision:{behavior:"allow"}`; deny -> `decision:{behavior:"deny"}` plus
 * `message`, OMITTING the `message` key entirely when the reason is absent
 * or whitespace-only (never an empty-string reason shown to the session as
 * feedback). `hookEventName` is now `"PermissionRequest"` (the general case
 * no longer resolves via `PreToolUse` — see the module-level
 * `<assumption_delta_decision>` in 03-05-PLAN.md).
 */
function buildPermissionOutput(decision: Decision): unknown {
  if (decision.type === "approve") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    };
  }
  if (decision.type === "deny") {
    const decisionOutput: Record<string, unknown> = { behavior: "deny" };
    const reason = decision.reason;
    if (typeof reason === "string" && reason.trim() !== "") {
      // Opaque, code-point-length-bounded UTF-8 string, passed through
      // verbatim and never interpreted/executed (ACT-03, T-03-04).
      decisionOutput.message = Array.from(reason).slice(0, MAX_REASON_CODE_POINTS).join("");
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: decisionOutput,
      },
    };
  }
  throw new Error(`buildHookDecisionOutput: Decision.type "${decision.type}" is not valid for kind "permission"`);
}

/**
 * `plan-mode` kind (ACT-02, D-16, 03-RESEARCH.md Pattern 4): the
 * `ExitPlanMode`-triggered 3-way `PermissionRequest` contract. `plan-allow`
 * ("Yes") -> `decision:{behavior:"allow"}`; `plan-allow-accept-edits` ("Yes,
 * and auto-accept edits for the rest of this session") ->
 * `decision:{behavior:"allow", updatedPermissions:[{type:"setMode",
 * mode:"acceptEdits", destination:"session"}]}` — a real, native,
 * session-scoped Claude Code mode change requiring zero Cockpit-side
 * bookkeeping; `plan-deny` ("No") -> `decision:{behavior:"deny"}` plus
 * `message`, OMITTING the key entirely when blank (mirrors `permission`'s
 * deny-message discipline above).
 */
function buildPlanModeOutput(decision: Decision): unknown {
  if (decision.type === "plan-allow") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    };
  }
  if (decision.type === "plan-allow-accept-edits") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      },
    };
  }
  if (decision.type === "plan-deny") {
    const decisionOutput: Record<string, unknown> = { behavior: "deny" };
    const message = decision.message;
    if (typeof message === "string" && message.trim() !== "") {
      decisionOutput.message = Array.from(message).slice(0, MAX_REASON_CODE_POINTS).join("");
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: decisionOutput,
      },
    };
  }
  throw new Error(`buildHookDecisionOutput: Decision.type "${decision.type}" is not valid for kind "plan-mode"`);
}
