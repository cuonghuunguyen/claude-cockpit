import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TimelineEvent } from "../../shared/types";
import { formatRelativeTime, groupTimelineEvents } from "./format";

interface TimelineProps {
  sessionId: string;
  /**
   * Any value that changes whenever this session receives a new hook
   * event — passing `session.lastActivityAt` re-triggers the fetch below
   * on every live `cockpit://session-event` for this session, so an
   * expanded timeline stays current with no manual refresh (MON-04).
   */
  refreshKey?: string;
}

/**
 * Expandable per-session condensed timeline (D-09). Fetches via the
 * Rust-proxied `get_session_events` Tauri command (added this plan —
 * `app/src-tauri/src/daemon_client.rs`); the webview never calls the
 * daemon directly. Consecutive routine tool_use/tool_result runs are
 * grouped by `groupTimelineEvents`; prompts, notifications, completions,
 * and errors are always shown individually. Errors are visually distinct
 * (`.timeline-entry-error`) but never affect queue ordering (D-10/MON-05)
 * — this component has no way to influence `Queue`'s ordering at all.
 */
export function Timeline({ sessionId, refreshKey }: TimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    invoke<TimelineEvent[]>("get_session_events", { sessionId })
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((err) => {
        console.error("cockpit: failed to load session timeline", sessionId, err);
        if (!cancelled) setError("Could not load timeline.");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  if (error) {
    return <div className="timeline timeline-error">{error}</div>;
  }
  if (events === null) {
    return <div className="timeline timeline-loading">Loading timeline…</div>;
  }
  if (events.length === 0) {
    return <div className="timeline timeline-empty">No timeline events yet.</div>;
  }

  const grouped = groupTimelineEvents(events);

  return (
    <ul className="timeline" data-testid="timeline">
      {grouped.map((entry) => (
        <li
          key={entry.key}
          className={
            `timeline-entry timeline-entry-${entry.kind}` +
            (entry.isError ? " timeline-entry-error" : "")
          }
        >
          <span className="timeline-entry-label">{entry.label}</span>
          <span className="timeline-entry-time">{formatRelativeTime(entry.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
