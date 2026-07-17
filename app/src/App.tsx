import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../../shared/types";
import { Queue } from "./Queue";
import { SessionCard } from "./SessionCard";
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
 * (undismissed) sessions; dismissed sessions move to a collapsible history
 * section below (D-06), sorted most-recently-dismissed first.
 */
function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

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

  /**
   * Optimistic dismiss (D-06): the daemon's `dismiss_session` call already
   * succeeded by the time `SessionCard` invokes this (see
   * `SessionCard.tsx::handleDismiss`) — set `dismissedAt` locally right
   * away so the card moves to history immediately, without waiting on the
   * `cockpit://session-event` round-trip. That event still arrives shortly
   * after and reconciles the authoritative `dismissedAt` (same idempotent
   * upsert path used for every other live update).
   */
  function handleDismiss(sessionId: string) {
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === sessionId && !s.dismissedAt
          ? { ...s, dismissedAt: new Date().toISOString() }
          : s,
      ),
    );
  }

  const active = sessions.filter((s) => !s.dismissedAt);
  const history = sessions
    .filter((s) => s.dismissedAt)
    .sort((a, b) => (b.dismissedAt ?? "").localeCompare(a.dismissedAt ?? ""));

  return (
    <main className="cockpit-container">
      <h1>Claude Cockpit</h1>
      {loadError && <p className="dashboard-warning">{loadError}</p>}
      <Queue sessions={active} onDismiss={handleDismiss} />

      <section className="history-section">
        <button
          type="button"
          className="history-toggle"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
        >
          {historyOpen ? "Hide" : "Show"} history ({history.length})
        </button>
        {historyOpen && (
          <div className="history-list">
            {history.length === 0 ? (
              <p className="history-empty">No dismissed sessions yet.</p>
            ) : (
              history.map((session) => (
                <SessionCard key={session.sessionId} session={session} historical />
              ))
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
