import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  MessageSquare,
  ShieldAlert,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import type { TimelineEvent } from "../../shared/types";
import { formatRelativeTime, groupTimelineEvents, type GroupedTimelineEntry } from "./format";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

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
 * Icon + tint per grouped entry kind, matching the shadcn conversational
 * activity-feed reference: blue for the user's own prompts, amber for
 * anything asking for attention (notifications/permission requests), green
 * for a finished turn, red for errors. Routine `tool_use`/`tool_result` runs
 * get a neutral tint — they are not a response moment, just a collapsed
 * activity log line (D-09).
 */
const KIND_STYLE: Record<
  GroupedTimelineEntry["kind"],
  { icon: LucideIcon; iconClass: string; rowClass: string }
> = {
  user_prompt: {
    icon: MessageSquare,
    iconClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    rowClass: "bg-blue-500/5",
  },
  notification: {
    icon: Bell,
    iconClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    rowClass: "bg-amber-500/5",
  },
  permission_request: {
    icon: ShieldAlert,
    iconClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    rowClass: "bg-amber-500/5",
  },
  completion: {
    icon: CheckCircle2,
    iconClass: "bg-green-500/15 text-green-600 dark:text-green-400",
    rowClass: "bg-green-500/5",
  },
  tool_use: {
    icon: TerminalSquare,
    iconClass: "bg-muted text-muted-foreground",
    rowClass: "bg-muted/40",
  },
  tool_result: {
    icon: TerminalSquare,
    iconClass: "bg-muted text-muted-foreground",
    rowClass: "bg-muted/40",
  },
  error: {
    icon: AlertTriangle,
    iconClass: "bg-destructive/15 text-destructive",
    rowClass: "bg-destructive/10",
  },
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
    <ScrollArea className="mt-1.5 max-h-80 border-t pt-2" data-testid="timeline">
      <div className="flex flex-col gap-1.5 pr-3">
        {grouped.map((entry) => {
          const style = KIND_STYLE[entry.kind];
          const Icon = style.icon;
          return (
            <div
              key={entry.key}
              className={
                "flex items-center gap-2.5 rounded-lg p-2 " +
                (entry.isError ? "bg-destructive/10" : style.rowClass)
              }
            >
              <span
                className={
                  "flex size-6 shrink-0 items-center justify-center rounded-full " +
                  (entry.isError ? "bg-destructive/15 text-destructive" : style.iconClass)
                }
              >
                <Icon className="size-3.5" />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className={
                    "truncate text-sm " +
                    (entry.isError ? "font-medium text-destructive" : "font-medium text-foreground")
                  }
                >
                  {entry.label}
                </span>
                {entry.count > 1 && (
                  <Badge variant="secondary" className="shrink-0">
                    {entry.count}
                  </Badge>
                )}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                {formatRelativeTime(entry.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
