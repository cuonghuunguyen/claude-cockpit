/**
 * Pure helpers for the D-10 window-focus + scroll-to-card + highlight
 * mechanism (Plan 02-03). Kept dependency-free and side-effect-free — no
 * React/Tauri imports — so the highlight decision is directly unit-testable
 * (see `focus.test.ts`), matching `format.ts`'s established pure-function
 * convention (see 02-PATTERNS.md "Pure, side-effect-free, never-mutate
 * transform functions").
 */

import type { Session } from "../../shared/types";

/**
 * `true` iff a session with `sessionId` is present in `sessions`. Guards a
 * `cockpit://focus-session` event carrying an unknown/stale session id from
 * ever driving a wrong-card highlight — an unknown id must be a safe no-op
 * (see PLAN.md's "safe no-op" truth for D-10 part a).
 */
export function focusTargetExists(sessionId: string, sessions: Session[]): boolean {
  return sessions.some((s) => s.sessionId === sessionId);
}

/**
 * `true` iff `cardSessionId` is the currently highlighted session. Strict
 * equality only; a `null` `highlightedSessionId` (no active highlight, e.g.
 * after the self-clearing timeout fires) highlights nothing.
 */
export function isHighlighted(
  cardSessionId: string,
  highlightedSessionId: string | null,
): boolean {
  return highlightedSessionId !== null && cardSessionId === highlightedSessionId;
}
