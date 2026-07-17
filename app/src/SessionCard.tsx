import type { Session } from "../../shared/types";
import { formatRelativeTime, pendingAskHeadline, statusLabel } from "./format";

interface SessionCardProps {
  session: Session;
}

/**
 * Response-surface session card (D-01..D-05, D-08).
 *
 * The card face always shows status, workspace·branch (MON-02), current
 * tool (only meaningful while `running`), last-activity relative time, and
 * the task-summary line (D-08). When the session is blocked or done, the
 * pending-ask headline (D-02) is rendered above everything else and takes
 * visual priority over the status/tool line — done stays visually
 * prominent until dismissed (D-05).
 *
 * Expand-to-timeline and dismiss-to-history (D-06, D-09) are added in
 * Task 2 of this plan.
 *
 * All session-derived text (task summary, tool name, workspace/branch) is
 * rendered through plain JSX text interpolation only — React escapes it by
 * default; no raw-HTML sink is used anywhere in this component
 * (T-01-05f).
 */
export function SessionCard({ session }: SessionCardProps) {
  const headline = pendingAskHeadline(session);

  return (
    <div
      className={
        "session-card" +
        ` session-card-status-${session.status}` +
        (headline ? " session-card-attention" : "")
      }
      data-testid="session-card"
    >
      {headline && <div className="session-card-headline">{headline}</div>}

      <div className="session-card-meta">
        <span className={`status-badge status-badge-${session.status}`}>
          {statusLabel(session.status)}
        </span>
        <span className="session-card-workspace">
          {session.workspace ?? "unknown workspace"}
          {session.branch ? ` · ${session.branch}` : ""}
        </span>
        {session.status === "running" && session.currentTool && (
          <span className="session-card-tool">{session.currentTool}</span>
        )}
        <span className="session-card-activity">
          {formatRelativeTime(session.lastActivityAt)}
        </span>
      </div>

      {session.taskSummary && (
        <div className="session-card-summary">{session.taskSummary}</div>
      )}
    </div>
  );
}
