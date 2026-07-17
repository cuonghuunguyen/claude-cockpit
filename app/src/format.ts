/**
 * Pure formatting/ordering helpers for the queue-of-cards dashboard
 * (Plan 01-05). Kept dependency-free and side-effect-free so the
 * ordering/grouping logic is directly unit-testable (see `format.test.ts`)
 * independent of React/Tauri.
 */

import type { Session, SessionStatus, TimelineEvent } from "../../shared/types";

/**
 * Statuses that make a session's card a "response surface" per D-02: the
 * session needs the user's attention (blocked on permission/input, or
 * finished and awaiting acknowledgement per D-05). `running` is the only
 * non-attention status in Phase 1.
 */
export function isAttentionStatus(status: SessionStatus): boolean {
  return (
    status === "waiting-permission" ||
    status === "waiting-input" ||
    status === "done"
  );
}

/** Short, human-readable label for a status badge. */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting-permission":
      return "Waiting for permission";
    case "waiting-input":
      return "Waiting for you";
    case "done":
      return "Done";
  }
}

/**
 * The card's headline text (D-02) when the session is a response moment —
 * the "pending ask" that supersedes tool/status prominence. Returns `null`
 * for a plain `running` session, where the headline has no home yet (the
 * card falls back to status/tool/workspace as its primary content).
 */
export function pendingAskHeadline(session: Session): string | null {
  switch (session.status) {
    case "waiting-permission":
      return "Needs your permission";
    case "waiting-input":
      return "Waiting on you";
    case "done":
      return "Finished — your turn";
    case "running":
      return null;
  }
}

/**
 * Tier order for `compareSessions` (D-01): index 0 is the highest-priority
 * tier. Attention-needing statuses (waiting-permission, waiting-input, done)
 * rank above the plain `running` tier; within the attention tiers,
 * waiting-permission ranks above waiting-input, which ranks above done.
 * This is the Phase 2 4-tier model (D-01..D-04) that replaces Phase 1's
 * 2-bucket placeholder ordering (D-04) — do NOT add a 5th "idle" tier
 * or a time-based demotion; see 02-CONTEXT.md D-01.
 */
const TIER_ORDER: SessionStatus[] = [
  "waiting-permission",
  "waiting-input",
  "done",
  "running",
];

/** Returns the tier index (0..3, lower = higher priority) for a status. */
function tierIndex(status: SessionStatus): number {
  return TIER_ORDER.indexOf(status);
}

/**
 * Phase 2 ordering comparator (D-01..D-04): tier index first (waiting-
 * permission > waiting-input > done > running), then an asymmetric
 * `lastActivityAt` tiebreak per tier — oldest-first within the three
 * attention tiers (the longest-waiting session leads, D-03), newest-first
 * within `running` (the most recently active session leads, D-04).
 * Deliberately does NOT look at timeline/error data at all — an error event
 * only ever bumps a session's `lastActivityAt` (a same-tier tiebreaker
 * signal), it can never move a `running` session above a waiting/done one
 * (D-10/MON-05: errors never reorder the queue across tiers).
 */
export function compareSessions(a: Session, b: Session): number {
  const tierDiff = tierIndex(a.status) - tierIndex(b.status);
  if (tierDiff !== 0) return tierDiff;
  if (a.status === "running") {
    // Running tier: most-recent activity first (D-04).
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  }
  // Attention tiers: oldest (longest-waiting) activity first (D-03/D-04).
  return a.lastActivityAt.localeCompare(b.lastActivityAt);
}

/** Returns a new, ordered array — never mutates `sessions` (D-04). */
export function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort(compareSessions);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats an ISO 8601 timestamp as a short relative-time string ("just
 * now", "5m ago", "3h ago", "2d ago"). Falls back to the raw ISO string on
 * an unparseable input rather than throwing — hook-derived timestamps
 * should never crash card rendering.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const diffMs = now.getTime() - then;
  if (diffMs < 0) return "just now";
  if (diffMs < MINUTE_MS) return "just now";
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  return `${Math.floor(diffMs / DAY_MS)}d ago`;
}

/**
 * Timeline event kinds that are collapsed into a single grouped entry when
 * they occur consecutively (D-09 "routine runs collapse"). Prompts,
 * notifications (permission requests / idle), completions, and errors are
 * never grouped — they are always called out individually.
 */
const ROUTINE_TIMELINE_KINDS = new Set<TimelineEvent["kind"]>([
  "tool_use",
  "tool_result",
]);

/** One row in the expanded card's condensed/grouped timeline (D-09). */
export interface GroupedTimelineEntry {
  key: string;
  kind: TimelineEvent["kind"];
  label: string;
  isError: boolean;
  count: number;
  createdAt: string;
}

function routineLabel(kind: TimelineEvent["kind"], toolName: string | null, count: number): string {
  const verb = kind === "tool_use" ? "Ran" : "Completed";
  const noun = count === 1 ? "call" : "calls";
  if (toolName) {
    return `${verb} ${count} ${toolName} ${noun}`;
  }
  return `${verb} ${count} tool ${noun}`;
}

/**
 * Groups a chronological (oldest-first) list of timeline events per D-09:
 * consecutive non-error `tool_use`/`tool_result` events of the same kind
 * collapse into one summarizing entry (e.g. "Ran 5 Bash calls"); every
 * `user_prompt`, `notification`, `completion`, and `error` entry is kept
 * individual. An `isError` event is never grouped, regardless of its `kind`
 * (defensive — the daemon already forces `kind: "error"` for these, see
 * `daemon/src/main.rs::handle_ingest_event`).
 */
export function groupTimelineEvents(events: TimelineEvent[]): GroupedTimelineEntry[] {
  const out: GroupedTimelineEntry[] = [];
  let i = 0;
  while (i < events.length) {
    const event = events[i];
    const isRoutine = ROUTINE_TIMELINE_KINDS.has(event.kind) && !event.isError;

    if (!isRoutine) {
      out.push({
        key: `${i}-${event.kind}`,
        kind: event.kind,
        label: event.summary || statusLikeFallback(event.kind),
        isError: event.isError,
        count: 1,
        createdAt: event.createdAt,
      });
      i += 1;
      continue;
    }

    let j = i;
    while (
      j < events.length &&
      events[j].kind === event.kind &&
      !events[j].isError
    ) {
      j += 1;
    }
    const run = events.slice(i, j);
    const sameTool = run.every((e) => e.toolName === run[0].toolName);
    out.push({
      key: `${i}-${event.kind}-group`,
      kind: event.kind,
      label: routineLabel(event.kind, sameTool ? run[0].toolName : null, run.length),
      isError: false,
      count: run.length,
      createdAt: run[run.length - 1].createdAt,
    });
    i = j;
  }
  return out;
}

function statusLikeFallback(kind: TimelineEvent["kind"]): string {
  switch (kind) {
    case "user_prompt":
      return "Prompt submitted";
    case "notification":
      return "Notification";
    case "completion":
      return "Turn finished";
    case "error":
      return "Error";
    case "permission_request":
      return "Permission requested";
    default:
      return kind;
  }
}
