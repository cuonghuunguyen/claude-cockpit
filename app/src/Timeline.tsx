import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TimelineEvent } from "../../shared/types";
import { formatRelativeTime, groupTimelineEvents, type GroupedTimelineEntry } from "./format";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

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
 * Left-border color per grouped entry kind, matching the shadcn
 * conversational-transcript reference: blue for the user's own prompts,
 * amber for anything asking for attention (notifications/permission
 * requests), green for a finished turn, red for errors. Routine
 * `tool_use`/`tool_result` runs get a neutral border — they are not a
 * response moment, just a collapsed activity log line (D-09).
 */
const KIND_BORDER_CLASS: Record<GroupedTimelineEntry["kind"], string> = {
  user_prompt: "border-l-blue-500",
  notification: "border-l-amber-500",
  permission_request: "border-l-amber-500",
  completion: "border-l-green-600",
  tool_use: "border-l-border",
  tool_result: "border-l-border",
  error: "border-l-red-600",
};

/**
 * Expandable per-session condensed timeline (D-09). Fetches via the
 * Rust-proxied `get_session_events` Tauri command (added this plan —
 * `app/src-tauri/src/daemon_client.rs`); the webview never calls the
 * daemon directly. Consecutive routine tool_use/tool_result runs are
 * grouped by `groupTimelineEvents`; prompts, notifications, completions,
 * and errors are always shown individually. Errors are visually distinct
 * (drive off `entry.isError`, never a specific `kind`) but never affect
 * queue ordering (D-10/MON-05) — this component has no way to influence
 * `Queue`'s ordering at all.
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
    return <div className="pt-1.5 text-sm text-muted-foreground">{error}</div>;
  }
  if (events === null) {
    return <div className="pt-1.5 text-sm text-muted-foreground">Loading timeline…</div>;
  }
  if (events.length === 0) {
    return <div className="pt-1.5 text-sm text-muted-foreground">No timeline events yet.</div>;
  }

  const grouped = groupTimelineEvents(events);

  return (
    <ScrollArea className="mt-1.5 max-h-72 border-t border-dashed pt-1.5" data-testid="timeline">
      <div className="flex flex-col gap-0.5 pr-3">
        {grouped.map((entry, index) => (
          <div key={entry.key}>
            {index > 0 && <Separator className="my-0.5 opacity-60" />}
            <div
              className={
                "flex items-center justify-between gap-3 border-l-2 pl-2.5 text-sm " +
                KIND_BORDER_CLASS[entry.kind] +
                (entry.isError ? " border-l-red-600 font-medium text-red-600 dark:text-red-400" : " text-foreground")
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{entry.label}</span>
                {entry.count > 1 && (
                  <Badge variant="secondary" className="shrink-0">
                    {entry.count}
                  </Badge>
                )}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {formatRelativeTime(entry.createdAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
