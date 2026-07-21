/**
 * Shared ingest dispatch — the MON-05 single enforcement point.
 *
 * Port of `daemon/src/main.rs::handle_ingest_event` (lines 232-296)
 * collapsed with `daemon/src/ingest/mod.rs::dispatch_ingest_event`/
 * `publish_session_update` (lines 130-158). EVERY ingest handler except
 * `ingest/sessionStart.ts` (which upserts directly, mirroring
 * `session_start.rs` bypassing this dispatch entirely) calls
 * {@link dispatchIngestEvent} — this is the ONE place the `isError`
 * short-circuit is allowed to exist (Pitfall 4 / T-2.1-07: do not
 * duplicate this branch in any handler).
 */

import type { Database as DatabaseType } from "better-sqlite3";

import {
  appendEvent,
  ensureSession,
  getSession,
  getSessionApi,
  markEnded as storeMarkEnded,
  setTaskSummaryIfAbsent,
  touchLastActivity,
  updateSessionStatus,
} from "../store.js";
import type { SessionApi } from "../store.js";
import { timelineKind, transition } from "../sessionState.js";
import type { HookEvent } from "../sessionState.js";

/**
 * Everything an ingest handler needs {@link dispatchIngestEvent} to do for
 * one incoming hook event: compute the status transition
 * (`sessionState.transition`), update the session row, optionally set the
 * first-prompt task summary (D-08), and append a condensed-timeline entry
 * (unless `timelineKind` is `null`, e.g. `SessionEnd`). Mirrors
 * `daemon/src/main.rs::IngestEventRequest`.
 */
export interface IngestEventRequest {
  sessionId: string;
  event: HookEvent;
  /** Raw `cwd`, when the payload carries one — feeds a defensive `ensureSession`. */
  cwd?: string | null;
  notificationType?: string | null;
  toolName?: string | null;
  timelineSummary: string;
  payloadJson?: string | null;
  /**
   * `isError` events (MON-05) skip the status transition entirely — they
   * are recorded for visibility only and never reorder or notify.
   */
  isError: boolean;
  /** Set only by `UserPromptSubmit`: the prompt text to store as `taskSummary` if this is the session's first-ever prompt. */
  firstPromptText?: string | null;
  /** Set only by `SessionEnd`: marks `endedAt` without touching status. */
  markEnded: boolean;
}

/**
 * Post-mutation SSE publish seam. Wave 2 implements this as a no-op stub —
 * a zero-subscriber case is expected and not an error (mirrors
 * `ingest/mod.rs::publish_session_update`'s "best-effort" semantics). Wave
 * 3 wires this one call site to `sse.publish(api)`.
 */
export function publishSessionUpdate(_api: SessionApi | null): void {
  // intentionally a no-op in Wave 2 — SSE wiring lands in Wave 3.
}

/**
 * Applies one {@link IngestEventRequest} against the store: ensures the
 * session row exists (defensive against a hook arriving before/without a
 * SessionStart), computes the status transition (skipped entirely for
 * `isError` events per MON-05), stores the first-prompt task summary when
 * present, appends the condensed-timeline entry (when the event has one),
 * and marks `endedAt` for `SessionEnd`. Then publishes the updated
 * `SessionApi` (best-effort stub, see {@link publishSessionUpdate}).
 *
 * THE FIRST BRANCH (`req.isError`) is the single MON-05 enforcement point
 * — do NOT duplicate this check in any `ingest/*.ts` handler.
 */
export function dispatchIngestEvent(db: DatabaseType, req: IngestEventRequest): SessionApi {
  const existing = getSession(db, req.sessionId);
  const currentStatus = existing?.status ?? "running";
  if (!existing) {
    ensureSession(db, req.sessionId, req.cwd ?? null);
  }

  if (req.isError) {
    // Errors are timeline-only (MON-05): never touch status, never
    // reorder, never notify. Still bump last_activity_at so the card's
    // "last activity" reflects real traffic.
    touchLastActivity(db, req.sessionId);
  } else if (req.markEnded) {
    // SessionEnd: mark ended_at only, status stays whatever it already
    // was (a done/waiting unresolved session stays visible).
    storeMarkEnded(db, req.sessionId);
  } else {
    const newStatus = transition(currentStatus, req.event, req.notificationType ?? undefined);
    // PreToolUse is the only event that sets a current_tool; every other
    // event clears it (no tool is currently in flight).
    const currentTool = req.event === "PreToolUse" ? (req.toolName ?? null) : null;
    updateSessionStatus(db, req.sessionId, newStatus, currentTool);

    if (req.firstPromptText) {
      setTaskSummaryIfAbsent(db, req.sessionId, req.firstPromptText);
    }
  }

  // An error always surfaces as an "error" timeline kind regardless of its
  // originating hook event (MON-05: visibility only, never a
  // status/notification effect — already guaranteed above since the
  // `req.isError` branch never calls `transition`/`updateSessionStatus`).
  const kind = req.isError ? "error" : timelineKind(req.event);
  if (kind) {
    appendEvent(
      db,
      req.sessionId,
      kind,
      req.toolName ?? null,
      req.timelineSummary,
      req.payloadJson ?? null,
      req.isError,
    );
  }

  const api = getSessionApi(db, req.sessionId);
  if (!api) {
    throw new Error(`dispatchIngestEvent: session ${req.sessionId} missing immediately after mutation`);
  }
  publishSessionUpdate(api);
  return api;
}
