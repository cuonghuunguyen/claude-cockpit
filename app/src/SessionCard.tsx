import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../../shared/types";
import { formatRelativeTime, pendingAskHeadline, statusLabel } from "./format";
import { Timeline } from "./Timeline";

interface SessionCardProps {
  session: Session;
  /**
   * Called after a successful dismiss so the parent (`App.tsx`) can
   * optimistically move the card out of the active queue and into history
   * (D-06). Omitted for cards already rendered in history.
   */
  onDismiss?: (sessionId: string) => void;
  /**
   * `true` for cards rendered in the history list: no dismiss control, no
   * pending-ask headline (an already-dismissed session is no longer an
   * active response moment), but the expandable timeline still works.
   */
  historical?: boolean;
  /**
   * `true` when a `cockpit://focus-session` event most recently targeted
   * this card (D-10, via `Queue`'s `isHighlighted`). Scrolls the card into
   * view and applies `.session-card-highlighted`; the highlight is
   * transient — `App.tsx` clears it via a self-clearing timeout, this
   * component only reacts to the prop.
   */
  highlighted?: boolean;
}

/**
 * Response-surface session card (D-01..D-06, D-08, D-09).
 *
 * The card face always shows status, workspace·branch (MON-02), current
 * tool (only meaningful while `running`), last-activity relative time, and
 * the task-summary line (D-08). When the session is blocked or done, the
 * pending-ask headline (D-02) is rendered above everything else and takes
 * visual priority over the status/tool line — done stays visually
 * prominent until dismissed (D-05). Expanding shows the condensed/grouped
 * timeline (D-09); dismissing calls the Rust-proxied `dismiss_session`
 * command and moves the card to history (D-06).
 *
 * All session-derived text (task summary, tool name, workspace/branch) is
 * rendered through plain JSX text interpolation only — React escapes it by
 * default; no raw-HTML sink is used anywhere in this component
 * (T-01-05f).
 */
export function SessionCard({
  session,
  onDismiss,
  historical = false,
  highlighted = false,
}: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  const headline = historical ? null : pendingAskHeadline(session);

  async function handleDismiss() {
    setDismissing(true);
    setDismissError(null);
    try {
      // Tauri v2 auto-converts this camelCase JS arg key to the Rust
      // command's `session_id` snake_case parameter
      // (daemon_client::dismiss_session) — see 01-05-SUMMARY.md for the
      // fact-discipline note on this convention (Context7 quota exhausted
      // for this plan, consistent with 01-02/01-03; flagged for Windows
      // end-of-phase UAT alongside every other Tauri-runtime item).
      await invoke("dismiss_session", { sessionId: session.sessionId });
      onDismiss?.(session.sessionId);
    } catch (err) {
      console.error("cockpit: failed to dismiss session", session.sessionId, err);
      setDismissError("Could not dismiss — try again.");
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div
      ref={cardRef}
      className={
        "session-card" +
        ` session-card-status-${session.status}` +
        (headline ? " session-card-attention" : "") +
        (historical ? " session-card-historical" : "") +
        (highlighted ? " session-card-highlighted" : "")
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

      <div className="session-card-actions">
        <button
          type="button"
          className="session-card-expand-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide timeline" : "Show timeline"}
        </button>
        {!historical && (
          <button
            type="button"
            className="session-card-dismiss"
            onClick={handleDismiss}
            disabled={dismissing}
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </button>
        )}
      </div>
      {dismissError && <div className="session-card-error">{dismissError}</div>}

      {expanded && (
        <Timeline sessionId={session.sessionId} refreshKey={session.lastActivityAt} />
      )}
    </div>
  );
}
