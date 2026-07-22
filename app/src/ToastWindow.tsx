import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "../../shared/types";
import { pendingAskHeadline } from "./format";

/**
 * Tauri event the Rust backend's `toast_window::spawn_decision_toast`
 * emits, straight to this window, right after building it — carries the
 * raw SSE frame (a {@link Session}-shaped object) for the session whose
 * `waiting-permission` transition triggered the spawn
 * (`app/src-tauri/src/toast_window.rs`).
 */
const TOAST_DECISION_EVENT_NAME = "cockpit://toast-decision";

/**
 * Tauri event the Rust backend's SSE consumer re-emits every daemon
 * session-update to (see `app/src-tauri/src/daemon_client.rs`). Every
 * webview receives this same global broadcast — including this toast
 * window — which is how the toast auto-dismisses without any Rust-side
 * close-triggering logic (see the effect below).
 */
const SESSION_EVENT_NAME = "cockpit://session-event";

/**
 * The actionable decision toast (NOT-02, D-05/D-06/D-07): a second,
 * always-on-top webview entry (mounted via `toast.html`, never
 * `index.html`) rendering the SAME pending-decision shape
 * `SessionCard.tsx` renders — Approve/Deny + a reply box — and calling the
 * SAME `submit_decision` command. It never fabricates a decision on
 * appear/close/timeout (D-01/D-03): closing or ignoring this window leaves
 * the hold intact until the user acts in-app or the hook timeout releases
 * it to native.
 *
 * All model/tool-derived text (tool name, input summary, reason) renders
 * through plain JSX text interpolation only — no raw-HTML sink anywhere in
 * this component (T-01-05f), matching `SessionCard.tsx`'s discipline.
 */
export function ToastWindow() {
  const [session, setSession] = useState<Session | null>(null);
  const [responding, setResponding] = useState(false);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [denyRevealed, setDenyRevealed] = useState(false);
  const [denyReasonText, setDenyReasonText] = useState("");

  // Initial payload: the one-shot event the Rust side emits right after
  // building this window. A lost race here (webview not yet ready to
  // listen) self-heals on the next SESSION_EVENT_NAME frame below, since
  // that stream keeps broadcasting to every window regardless.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<Session>(TOAST_DECISION_EVENT_NAME, (event) => {
      setSession(event.payload);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Ongoing updates: the SAME global stream `App.tsx` consumes for the
  // main window. Filters to the currently-tracked session so this toast
  // only reacts to frames about the one decision it is showing.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<Session>(SESSION_EVENT_NAME, (event) => {
      setSession((prev) => {
        if (!prev || event.payload.sessionId !== prev.sessionId) {
          return prev;
        }
        return event.payload;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-dismiss (D-01/D-03): once the tracked session's pendingDecision
  // clears — resolved from the card, dismissed, or timed out — this toast
  // closes itself. Never sends a fabricated decision on close.
  useEffect(() => {
    if (session && session.pendingDecision === null) {
      void getCurrentWindow().close();
    }
  }, [session]);

  if (!session || !session.pendingDecision || session.pendingDecision.kind !== "permission") {
    return null;
  }

  const { pendingDecision, sessionId } = session;
  const headline = pendingAskHeadline(session) ?? "Needs your attention";

  /**
   * Shared submit path for Approve/Deny (mirrors `SessionCard.tsx`'s
   * `submitDecision`): a submit from a stale toast (already
   * resolved/dismissed elsewhere) is a harmless no-op per D-01/D-03 — the
   * daemon 404/409s a decision for a session with no pending hold, and
   * this surfaces as the same retryable error path as any other failure,
   * never a fabricated success. Closes over `sessionId` (a plain string,
   * destructured above) rather than `session` itself, since `session` is
   * `useState`-derived and TypeScript cannot narrow its null-check across
   * this nested function declaration.
   */
  async function submit(kind: "approve" | "deny", reason?: string) {
    setResponding(true);
    setRespondError(null);
    try {
      const trimmed = reason?.trim();
      const decision =
        kind === "approve"
          ? { type: "approve" as const }
          : trimmed
            ? { type: "deny" as const, reason: trimmed }
            : { type: "deny" as const };
      await invoke("submit_decision", { sessionId, decision });
      await getCurrentWindow().close();
    } catch (err) {
      console.error("cockpit: toast failed to submit decision", sessionId, err);
      setRespondError(
        kind === "approve" ? "Could not approve — try again." : "Could not deny — try again.",
      );
    } finally {
      setResponding(false);
    }
  }

  return (
    <div className="cockpit-toast">
      <div className="cockpit-toast-headline">{headline}</div>
      {(pendingDecision.toolName || pendingDecision.toolInputSummary) && (
        <div className="cockpit-toast-detail">
          {pendingDecision.toolName}
          {pendingDecision.toolName && pendingDecision.toolInputSummary ? ": " : ""}
          {pendingDecision.toolInputSummary}
        </div>
      )}
      {respondError && <div className="cockpit-toast-error">{respondError}</div>}
      <div className="cockpit-toast-controls">
        <button type="button" disabled={responding} onClick={() => void submit("approve")}>
          {responding ? "Approving…" : "Approve"}
        </button>
        {!denyRevealed && (
          <button type="button" disabled={responding} onClick={() => setDenyRevealed(true)}>
            Deny
          </button>
        )}
      </div>
      {denyRevealed && (
        <div className="cockpit-toast-deny-reveal">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={denyReasonText}
            onChange={(e) => setDenyReasonText(e.target.value)}
            disabled={responding}
          />
          <button
            type="button"
            disabled={responding}
            onClick={() => void submit("deny", denyReasonText)}
          >
            Confirm
          </button>
          <button type="button" disabled={responding} onClick={() => void submit("deny")}>
            Deny without reason
          </button>
        </div>
      )}
    </div>
  );
}

// Self-mounting entry point (this file IS toast.html's script entry —
// mirrors main.tsx + App.tsx combined, since this component is never
// reused anywhere else).
const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ToastWindow />
    </React.StrictMode>,
  );
}
