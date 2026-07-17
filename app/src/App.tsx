import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../../shared/types";
import { Queue } from "./Queue";
import "./styles.css";

/**
 * Tauri event name the Rust backend's SSE consumer re-emits every daemon
 * session-update to (see `app/src-tauri/src/daemon_client.rs`). The webview
 * never talks to the daemon directly — only `invoke()`/`listen()` (see
 * SKELETON.md's "GUI ↔ daemon transport" decision).
 */
const SESSION_EVENT_NAME = "cockpit://session-event";

/**
 * The response-oriented queue-of-cards dashboard (Plan 01-05, D-01..D-10).
 *
 * Loads the full session list (`get_sessions` — active + history in one
 * call) on mount, then keeps it live via `listen(cockpit://session-event)`
 * with no manual refresh (MON-04). `Queue` renders only the still-active
 * (undismissed) sessions; Task 2 of this plan adds the dismiss control and
 * a history view for dismissed ones (D-06).
 */
function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    invoke<Session[]>("get_sessions")
      .then((initial) => {
        if (!cancelled) setSessions(initial);
      })
      .catch((err) => {
        console.error("cockpit: failed to load initial sessions", err);
        if (!cancelled) {
          setLoadError(
            "Could not reach the Cockpit daemon yet — waiting for live updates.",
          );
        }
      });

    listen<Session>(SESSION_EVENT_NAME, (event) => {
      const updated = event.payload;
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === updated.sessionId);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const active = sessions.filter((s) => !s.dismissedAt);

  return (
    <main className="cockpit-container">
      <h1>Claude Cockpit</h1>
      {loadError && <p className="dashboard-warning">{loadError}</p>}
      <Queue sessions={active} />
    </main>
  );
}

export default App;
