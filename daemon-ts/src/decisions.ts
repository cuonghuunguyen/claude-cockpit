/**
 * In-memory pending-decision registry (FND-04, ACT-01, ACT-03, D-04).
 *
 * The Node `Promise`/`Map` analogue of what a retired-Rust-daemon design
 * would have needed a `tokio::oneshot`/`Mutex<HashMap<...>>` for — Node's
 * single-threaded event loop makes the mutex unnecessary. Shape mirrors
 * `daemon-ts/src/sse.ts`'s subscriber-registry discipline (register /
 * resolve-or-cleanup / "a missing entry is always a safe no-op, never a
 * throw"). See 03-RESEARCH.md Pattern 2.
 *
 * Deliberately NOT persisted: a daemon restart mid-decision correctly falls
 * through to Claude Code's own hook-timeout failsafe (D-03), matching the
 * project's existing "no separate in-memory session cache; everything reads
 * straight from SQLite" posture for anything that IS persisted.
 */

import type { Decision, DecisionKind } from "../../shared/types.js";

interface RegistryEntry {
  resolve: (json: unknown) => void;
  timer: NodeJS.Timeout;
  kind: DecisionKind;
}

const pending = new Map<string, RegistryEntry>();

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
): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      resolve(onTimeout());
    }, timeoutMs);
    pending.set(sessionId, { resolve, timer, kind });
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
 * Length bound (Unicode code points) for a free-text deny reason, matching
 * the existing `condensedJsonSummary`/`condensedText` discipline
 * (`daemon-ts/src/store.ts`) of counting `Array.from(...).length` rather
 * than raw UTF-16 `.length` (ACT-03 — never split a surrogate pair).
 */
const MAX_REASON_CODE_POINTS = 200;

/**
 * Builds the exact `hookSpecificOutput` JSON to deliver back to the held
 * hook for a resolved {@link Decision}, given the {@link DecisionKind} the
 * hold was registered under. This is the ONE choke point every response
 * surface (card, toast) funnels through — see this phase's
 * `<assumption_delta_decision>`. `ask-user-question` and `plan-mode` are an
 * exhaustive switch that throws on unhandled kinds; 03-03/03-05 fill them in.
 */
export function buildHookDecisionOutput(kind: DecisionKind, decision: Decision): unknown {
  switch (kind) {
    case "permission":
      return buildPermissionOutput(decision);
    case "ask-user-question":
      throw new Error("buildHookDecisionOutput: 'ask-user-question' is implemented in a later plan (03-03)");
    case "plan-mode":
      throw new Error("buildHookDecisionOutput: 'plan-mode' is implemented in a later plan (03-05)");
  }
}

/**
 * `permission` kind (ACT-01/ACT-03): approve -> `permissionDecision: "allow"`;
 * deny -> `"deny"` plus `permissionDecisionReason`, OMITTING the reason key
 * entirely when the reason is absent or whitespace-only (never an
 * empty-string reason shown to the session as feedback).
 */
function buildPermissionOutput(decision: Decision): unknown {
  if (decision.type === "approve") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  }
  if (decision.type === "deny") {
    const hookSpecificOutput: Record<string, unknown> = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    };
    const reason = decision.reason;
    if (typeof reason === "string" && reason.trim() !== "") {
      // Opaque, code-point-length-bounded UTF-8 string, passed through
      // verbatim and never interpreted/executed (ACT-03, T-03-04).
      hookSpecificOutput.permissionDecisionReason = Array.from(reason).slice(0, MAX_REASON_CODE_POINTS).join("");
    }
    return { hookSpecificOutput };
  }
  throw new Error(`buildHookDecisionOutput: Decision.type "${decision.type}" is not valid for kind "permission"`);
}
