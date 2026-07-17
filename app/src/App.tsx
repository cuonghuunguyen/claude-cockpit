import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../../shared/types";
import { NotificationSettings } from "./NotificationSettings";
import { OfflineBanner } from "./OfflineBanner";
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

/** Upsert a single live-updated session into the current list by `sessionId`. */
function upsert(prev: Session[], updated: Session): Session[] {
  const idx = prev.findIndex((s) => s.sessionId === updated.sessionId);
  if (idx === -1) return [...prev, updated];
  const next = [...prev];
  next[idx] = updated;
  return next;
}

/**
 * Merge the `get_sessions` snapshot into the current (possibly already
 * live-updated) state without clobbering anything newer (WR-02). For each
 * session in the snapshot: if a live update for that same session already
 * landed in `prev` with a strictly newer `lastActivityAt`, keep the live
 * version; otherwise take the snapshot's version. Sessions present only in
 * `prev` (a live event for a session not yet in the snapshot) are preserved.
 */
function mergeSnapshotKeepingNewer(prev: Session[], snapshot: Session[]): Session[] {
  const byId = new Map(prev.map((s) => [s.sessionId, s] as const));
  for (const incoming of snapshot) {
    const existing = byId.get(incoming.sessionId);
    if (!existing || existing.lastActivityAt <= incoming.lastActivityAt) {
      byId.set(incoming.sessionId, incoming);
    }
  }
  return Array.from(byId.values());
}

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

    async function bootstrap() {
      // WR-02 fix: subscribe *before* fetching the snapshot so no live
      // `cockpit://session-event` emitted while `get_sessions` is still
      // in flight is lost (Tauri's emit/listen has no event replay).
      unlisten = await listen<Session>(SESSION_EVENT_NAME, (event) => {
        const updated = event.payload;
        setSessions((prev) => upsert(prev, updated));
      });

      if (cancelled) {
        unlisten();
        return;
      }

      try {
        const initial = await invoke<Session[]>("get_sessions");
        if (cancelled) return;
        // Merge, don't overwrite: any session already updated live (via an
        // event that arrived before this slower HTTP round-trip resolved)
        // must not be clobbered by the now-stale snapshot for that session.
        setSessions((prev) => mergeSnapshotKeepingNewer(prev, initial));
      } catch (err) {
        console.error("cockpit: failed to load initial sessions", err);
        if (!cancelled) {
          setLoadError(
            "Could not reach the Cockpit daemon yet — waiting for live updates.",
          );
        }
      }
    }

    bootstrap();

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
      <OfflineBanner />
      <NotificationSettings />
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
