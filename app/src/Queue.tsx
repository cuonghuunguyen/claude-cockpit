import type { Session } from "../../shared/types";
import { orderSessions } from "./format";
import { SessionCard } from "./SessionCard";

interface QueueProps {
  sessions: Session[];
}

/**
 * The dashboard's single vertical queue of cards (D-01) — not a grid, not a
 * table. Stack position is meaningful: `orderSessions` (D-04) biases
 * waiting/blocked and done sessions toward the top, with most-recent
 * activity as the tiebreaker/fallback.
 */
export function Queue({ sessions }: QueueProps) {
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
        <SessionCard key={session.sessionId} session={session} />
      ))}
    </div>
  );
}
