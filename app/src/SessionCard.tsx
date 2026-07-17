import type { Session } from "../../shared/types";

interface SessionCardProps {
  session: Session;
}

/**
 * Minimal live session card — Phase 1, Plan 01-02 (Walking Skeleton part B).
 *
 * This proves one card renders and updates live from a daemon-pushed Tauri
 * event (MON-01, MON-04). The response-oriented card hierarchy (pending-ask
 * headline, condensed timeline, workspace·branch — D-01..D-11) is designed
 * in Plan 01-05; this component intentionally stays minimal until then.
 *
 * `workspace`/`branch`/`currentTool` may render as "unknown" for now — their
 * derivation from `cwd` (MON-02) is out of this plan's scope (see
 * `daemon/src/store.rs`'s `SessionApi` doc comment).
 */
export function SessionCard({ session }: SessionCardProps) {
  return (
    <div className="session-card" data-testid="session-card">
      <div className="session-card-status">{session.status}</div>
      <div className="session-card-workspace">
        {session.workspace ?? "(workspace unknown)"}
        {session.branch ? ` · ${session.branch}` : ""}
      </div>
      {session.taskSummary && (
        <div className="session-card-summary">{session.taskSummary}</div>
      )}
      {session.currentTool && (
        <div className="session-card-tool">tool: {session.currentTool}</div>
      )}
      <div className="session-card-activity">
        last activity: {session.lastActivityAt}
      </div>
    </div>
  );
}
