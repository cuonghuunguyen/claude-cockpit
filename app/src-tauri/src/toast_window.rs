//! Custom actionable decision toast window (NOT-02, D-05/D-06/D-07).
//!
//! Builds the single, reusable `cockpit-toast` `WebviewWindow` — always-on-
//! top, decorationless, transparent, no-focus-steal — that renders the
//! pending decision's Approve/Deny + reply controls straight from the
//! toast, without ever focusing the main Cockpit window (D-05).
//!
//! ## Windows main-thread deadlock (RESEARCH.md Pattern 5)
//!
//! Verified via docs.rs `tauri` 2.9.3's `WindowBuilder::build` "Known
//! issues": "On Windows, this function deadlocks when used in a synchronous
//! command or event handlers. You should use async commands and separate
//! threads when creating windows."
//!
//! [`spawn_decision_toast`] is itself an `async` command, but that alone is
//! not sufficient — the deadlock is about which call frame reaches
//! `.build()`, not merely the function's signature. Its only caller
//! ([`register_spawn_listener`]'s event handler) reaches it via a freshly
//! spawned `tauri::async_runtime::spawn` task, never inline from
//! `daemon_client::consume_events_once`'s own async SSE-consumer loop —
//! that loop (added in Plan 03-04 Task 2) only ever calls
//! `daemon_client::maybe_spawn_toast`, which emits [`SPAWN_TOAST_EVENT_NAME`]
//! and returns immediately; it never calls into this module directly.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

/// The single-instance toast window label. A new decision reuses (closes +
/// rebuilds) this same label rather than stacking multiple toasts —
/// multi-toast stacking is deferred (planner discretion, 03-04-PLAN.md).
pub const TOAST_WINDOW_LABEL: &str = "cockpit-toast";

/// Internal Tauri event `daemon_client::consume_events_once`'s SSE consumer
/// (Task 2) emits to request a toast spawn OFF its own async task's call
/// frame — see [`register_spawn_listener`] for why this indirection is
/// what actually avoids the Windows main-thread deadlock (RESEARCH.md
/// Pattern 5), not merely `spawn_decision_toast` being `async`. Owned by
/// this module (not `daemon_client.rs`) since the builder + the listener
/// that reaches it live here; `daemon_client.rs` imports this constant to
/// emit it.
pub const SPAWN_TOAST_EVENT_NAME: &str = "cockpit://spawn-toast";

/// Tauri event the toast's own webview listens for to receive the initial
/// pending-decision payload it should render (`app/src/ToastWindow.tsx`).
/// The toast also independently subscribes to the same global
/// `daemon_client::SESSION_EVENT_NAME` stream every window receives, so a
/// lost race on this one-shot event (webview not yet ready) self-heals on
/// the next SSE frame rather than leaving the toast permanently blank.
pub const TOAST_DECISION_EVENT_NAME: &str = "cockpit://toast-decision";

/// Builds (or replaces, if one is already open) the `cockpit-toast`
/// `WebviewWindow` and forwards `payload` — the raw SSE frame for the
/// session that just transitioned into `waiting-permission` with a pending
/// decision — to it via [`TOAST_DECISION_EVENT_NAME`].
///
/// Reuse/replace, not stacking (single-toast for this slice, 03-04-PLAN.md
/// "Task 1"): any existing `cockpit-toast` window is closed before a new
/// one is built.
#[tauri::command]
pub async fn spawn_decision_toast(app: AppHandle, payload: Value) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(TOAST_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let toast = WebviewWindowBuilder::new(
        &app,
        TOAST_WINDOW_LABEL,
        WebviewUrl::App("toast.html".into()),
    )
    .title("Claude Cockpit")
    .inner_size(380.0, 220.0)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .focused(false) // D-05: never steals focus from the terminal/editor
    .visible(true)
    .build()
    .map_err(|e| e.to_string())?;

    if let Err(err) = toast.emit(TOAST_DECISION_EVENT_NAME, &payload) {
        eprintln!("cockpit: failed to emit {TOAST_DECISION_EVENT_NAME}: {err}");
    }

    Ok(())
}

/// Registers a global listener for [`SPAWN_TOAST_EVENT_NAME`] that reaches
/// [`spawn_decision_toast`] via a freshly spawned async task. This
/// indirection — rather than `daemon_client::consume_events_once` calling
/// `spawn_decision_toast` directly — is what keeps the actual window build
/// off that SSE-consumer async loop's own call frame (RESEARCH.md
/// Pattern 5). `listen_any` (not `listen`) is used because
/// `daemon_client`'s emitters use the plain, all-targets `Emitter::emit`
/// (same as the existing `SESSION_EVENT_NAME`/`OFFLINE_WINDOW_EVENT_NAME`
/// broadcasts in this codebase), which `AppHandle::listen` alone does not
/// catch — only `listen_any` does (verified via docs.rs `tauri` 2.9.3).
///
/// Call exactly once, from `lib.rs`'s `setup()`.
pub fn register_spawn_listener(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any(SPAWN_TOAST_EVENT_NAME, move |event| {
        let handle = handle.clone();
        let payload: Value = match serde_json::from_str(event.payload()) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("cockpit: failed to parse {SPAWN_TOAST_EVENT_NAME} payload: {err}");
                return;
            }
        };
        tauri::async_runtime::spawn(async move {
            if let Err(err) = spawn_decision_toast(handle, payload).await {
                eprintln!("cockpit: failed to spawn decision toast: {err}");
            }
        });
    });
}
