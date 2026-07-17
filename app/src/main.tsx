import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../../shared/types";
import { SessionCard } from "./SessionCard";
import "./App.css";

/**
 * Tauri event name the Rust backend's SSE consumer re-emits every daemon
 * session-update to (see `app/src-tauri/src/daemon_client.rs`). The webview
 * never talks to the daemon directly — only `invoke()`/`listen()`.
 */
const SESSION_EVENT_NAME = "cockpit://session-event";

/**
 * Phase 1, Plan 01-02 (Walking Skeleton part B): proves the end-to-end pipe
 * — one live session card updates with no manual refresh. The full
 * queue-of-cards dashboard (D-01..D-11 ordering/lifecycle) is Plan 01-05.
 */
function Dashboard() {
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
        if (idx === -1) {
          return [...prev, updated];
        }
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

  return (
    <main className="container">
      <h1>Claude Cockpit</h1>
      {loadError && <p className="dashboard-warning">{loadError}</p>}
      {sessions.length === 0 ? (
        <p>No live sessions yet — waiting for a SessionStart event.</p>
      ) : (
        sessions.map((session) => (
          <SessionCard key={session.sessionId} session={session} />
        ))
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);
