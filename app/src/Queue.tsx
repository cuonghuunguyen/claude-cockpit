import type { Session } from "../../shared/types";
import { isHighlighted } from "./focus";
import { orderSessions } from "./format";
import { SessionCard } from "./SessionCard";

interface QueueProps {
  sessions: Session[];
  /** Passed through to each card's dismiss control (D-06). */
  onDismiss: (sessionId: string) => void;
  /**
   * The session id a `cockpit://focus-session` event most recently targeted
   * (D-10), or `null` once the highlight has self-cleared. Threaded down to
   * `SessionCard` via `isHighlighted` so exactly one card (or none) is
   * highlighted at a time.
   */
  highlightedSessionId?: string | null;
}

/**
 * The dashboard's single vertical queue of cards (D-01) — not a grid, not a
 * table. Stack position is meaningful: `orderSessions` (D-04) biases
 * waiting/blocked and done sessions toward the top, with most-recent
 * activity as the tiebreaker/fallback.
 */
export function Queue({ sessions, onDismiss, highlightedSessionId = null }: QueueProps) {
  const ordered = orderSessions(sessions);

  if (ordered.length === 0) {
    return (
      <p className="queue-empty">
        No active sessions — waiting for a SessionStart event.
      </p>
    );
  }

  return (
    <div className="queue" data-testid="queue">
      {ordered.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          onDismiss={onDismiss}
          highlighted={isHighlighted(session.sessionId, highlightedSessionId)}
        />
      ))}
    </div>
  );
}
