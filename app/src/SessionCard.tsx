import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Decision, PendingDecision, Session } from "../../shared/types";
import { formatRelativeTime, pendingAskHeadline, statusLabel } from "./format";
import { Timeline } from "./Timeline";

/**
 * Builds the plain-text "which tool/command is this about" line rendered
 * directly under the "Needs your permission" headline (defect-B fix — the
 * card previously gave the user nothing to decide on). Pure and
 * side-effect-free, exported separately so it is directly unit-testable
 * without rendering the component — see `SessionCard.test.ts`.
 *
 * - `null` when there is no pending decision, or it isn't a `"permission"`
 *   kind (the card renders no decision controls in that case either).
 * - `"<toolName>: <toolInputSummary>"` when both are present.
 * - Falls back to whichever of the two is present when only one is.
 * - `null` when neither `toolName` nor `toolInputSummary` is present.
 */
export function decisionDetailText(pendingDecision: PendingDecision | null): string | null {
  if (!pendingDecision || pendingDecision.kind !== "permission") {
    return null;
  }
  const { toolName, toolInputSummary } = pendingDecision;
  if (toolName && toolInputSummary) {
    return `${toolName}: ${toolInputSummary}`;
  }
  return toolName ?? toolInputSummary ?? null;
}

/**
 * Builds the promoted {@link Decision} value the inline controls submit
 * (ACT-01/ACT-03). Kept as a pure, side-effect-free function (exported
 * separately from the click handlers below) so the payload shape is
 * directly unit-testable without rendering the component — see
 * `SessionCard.test.ts`.
 *
 * - `"approve"` always yields `{ type: "approve" }`.
 * - `"deny"` with a non-blank `reason` yields `{ type: "deny", reason }`
 *   (trimmed).
 * - `"deny"` with an absent/whitespace-only `reason` yields `{ type: "deny" }`
 *   with NO `reason` key at all — never an empty-string reason (mirrors
 *   03-01's daemon-side `buildHookDecisionOutput` omission rule).
 */
export function buildDecisionPayload(
  kind: "approve" | "deny",
  reason?: string,
): Decision {
  if (kind === "approve") {
    return { type: "approve" };
  }
  const trimmed = reason?.trim();
  return trimmed ? { type: "deny", reason: trimmed } : { type: "deny" };
}

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

  // Inline Approve/Deny controls (D-08/D-09/D-10). `responding` is the
  // in-flight loading state shared by both Approve and Deny (mirrors
  // `dismissing` above); `respondError` is retryable and never drops the
  // card (D-08's own "don't drop on error" requirement) — the card only
  // leaves the attention tier once `resolved` is set on a SUCCESSFUL
  // `submit_decision` call. `resolved` is deliberately local/optimistic
  // (D-10): the real reconciliation happens when the next
  // `cockpit://session-event` SSE frame updates `session.pendingDecision`
  // from App.tsx's upsert, at which point this component simply re-renders
  // from the fresh prop.
  const [responding, setResponding] = useState(false);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<"approved" | "denied" | null>(null);
  const [denyRevealed, setDenyRevealed] = useState(false);
  const [denyReasonText, setDenyReasonText] = useState("");

  useEffect(() => {
    if (highlighted) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  const headline = historical ? null : pendingAskHeadline(session);
  const isResolved = resolved !== null;
  // D-10: drop out of the attention tier immediately on a successful
  // decision, without waiting for the reconciling SSE frame.
  const showAttention = Boolean(headline) && !isResolved;
  const displayHeadline = isResolved
    ? resolved === "approved"
      ? "Approved — unblocking…"
      : "Denied"
    : headline;
  const showDecisionControls =
    !historical && !isResolved && session.pendingDecision?.kind === "permission";
  const decisionDetail =
    !historical && !isResolved ? decisionDetailText(session.pendingDecision) : null;

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

  /**
   * Shared submit path for both Approve and Deny (ACT-01/ACT-03): builds
   * the `Decision` payload via `buildDecisionPayload`, invokes the
   * Rust-proxied `submit_decision` command (mirrors `dismiss_session`'s
   * camelCase-JS-key -> snake_case-Rust-param convention), and only on
   * success sets the D-10 optimistic `resolved` state. On error the card
   * is left exactly as-is (never auto-dismissed) so the user can retry or
   * wait for the next SSE frame to reconcile.
   */
  async function submitDecision(kind: "approve" | "deny", reason?: string) {
    setResponding(true);
    setRespondError(null);
    try {
      await invoke("submit_decision", {
        sessionId: session.sessionId,
        decision: buildDecisionPayload(kind, reason),
      });
      setResolved(kind === "approve" ? "approved" : "denied");
      setDenyRevealed(false);
    } catch (err) {
      console.error(
        `cockpit: failed to submit ${kind} decision`,
        session.sessionId,
        err,
      );
      setRespondError(
        kind === "approve" ? "Could not approve — try again." : "Could not deny — try again.",
      );
    } finally {
      setResponding(false);
    }
  }

  function handleApprove() {
    void submitDecision("approve");
  }

  function handleDeny(reason?: string) {
    void submitDecision("deny", reason);
  }

  return (
    <div
      ref={cardRef}
      className={
        "session-card" +
        ` session-card-status-${session.status}` +
        (showAttention ? " session-card-attention" : "") +
        (historical ? " session-card-historical" : "") +
        (highlighted ? " session-card-highlighted" : "")
      }
      data-testid="session-card"
    >
      {displayHeadline && (
        <div
          className={
            "session-card-headline" +
            (isResolved ? " session-card-headline-resolved" : "")
          }
        >
          {displayHeadline}
          {decisionDetail && (
            <div className="session-card-decision-detail">{decisionDetail}</div>
          )}
          {showDecisionControls && (
            <div className="session-card-decision-controls">
              <button
                type="button"
                className="session-card-approve"
                onClick={handleApprove}
                disabled={responding}
              >
                {responding ? "Approving…" : "Approve"}
              </button>
              {!denyRevealed && (
                <button
                  type="button"
                  className="session-card-deny"
                  onClick={() => setDenyRevealed(true)}
                  disabled={responding}
                >
                  Deny
                </button>
              )}
              {denyRevealed && (
                <div className="session-card-deny-reveal">
                  <input
                    type="text"
                    className="session-card-deny-reason"
                    placeholder="Reason (optional)"
                    value={denyReasonText}
                    onChange={(e) => setDenyReasonText(e.target.value)}
                    disabled={responding}
                  />
                  <button
                    type="button"
                    className="session-card-deny-confirm"
                    onClick={() => handleDeny(denyReasonText)}
                    disabled={responding}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="session-card-deny-without-reason"
                    onClick={() => handleDeny()}
                    disabled={responding}
                  >
                    Deny without reason
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {respondError && (
        <div className="session-card-error session-card-decision-error">
          {respondError}
        </div>
      )}

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
