import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Tauri event the Rust backend emits when the daemon becomes reachable
 * again after being unreachable while Cockpit was open (see
 * `app/src-tauri/src/daemon_client.rs::mark_reachable`, driven by the SSE
 * consumer's own connect/reconnect transitions). Payload is a generic
 * epoch-millis window only — D-12 explicitly declines per-session
 * unwatched-session forensics; this is the only coverage-gap signal
 * Cockpit surfaces.
 */
const OFFLINE_WINDOW_EVENT_NAME = "cockpit://offline-window";

interface OfflineWindow {
  /** Epoch millis — when the daemon was first observed unreachable. */
  from: number;
  /** Epoch millis — when the daemon became reachable again. */
  to: number;
}

/**
 * Generic, dismissible "Cockpit was offline from X to Y" banner (D-13).
 *
 * Deliberately minimal: fail-open must stay invisible to normal workflow
 * (D-12) — no modal, no nag, no per-session reconstruction of what may have
 * auto-proceeded during the outage. One honest sentence about the coverage
 * gap; dismissing it clears it until the next real outage (a fresh
 * `cockpit://offline-window` event always un-dismisses).
 */
export function OfflineBanner() {
  const [window_, setWindow] = useState<OfflineWindow | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<OfflineWindow>(OFFLINE_WINDOW_EVENT_NAME, (event) => {
      setWindow(event.payload);
      setDismissed(false); // a new outage always gets its own fresh banner
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

  if (!window_ || dismissed) return null;

  const from = new Date(window_.from).toLocaleTimeString();
  const to = new Date(window_.to).toLocaleTimeString();

  return (
    <div className="offline-banner" role="status">
      <span>
        Cockpit was offline from {from} to {to} — sessions during that
        window may not have been watched.
      </span>
      <button
        type="button"
        className="offline-banner-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss offline notice"
      >
        Dismiss
      </button>
    </div>
  );
}
