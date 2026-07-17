//! The Tauri Rust backend is the **sole** daemon client (SKELETON.md "GUI ↔
//! daemon transport"). The webview never opens a network connection to the
//! WSL-hosted daemon directly — it only ever uses Tauri `invoke()`/`listen()`.
//! This module:
//!
//! 1. Reads the per-install auth token from inside WSL by shelling out to
//!    `wsl.exe` at startup ([`read_token`]) — the token never reaches the
//!    webview's JS runtime.
//! 2. Consumes the daemon's `GET /events` SSE stream and re-emits each frame
//!    as the Tauri event `cockpit://session-event` ([`spawn_sse_consumer`]).
//! 3. Exposes the [`get_sessions`] Tauri command for the frontend's initial
//!    session list.

use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

/// Fixed daemon base URL — mirrors `shared/types.ts`'s `COCKPIT_DAEMON_BASE_URL`.
/// Both native-Windows and WSL-origin traffic reach the daemon at this
/// literal address (SKELETON.md "Daemon bind address").
const DAEMON_BASE_URL: &str = "http://127.0.0.1:9427";

/// Tauri event name the webview's `listen()` call subscribes to.
pub const SESSION_EVENT_NAME: &str = "cockpit://session-event";

/// Must match `tauri.conf.json`'s `app.trayIcon.id` (configured in Plan
/// 01-01) — the handle this module updates at runtime to reflect
/// watching/not-watching (D-13).
const TRAY_ID: &str = "cockpit-tray";

/// Tauri event emitted when the daemon becomes reachable again after being
/// unreachable while Cockpit was open. Payload is a generic `{ from, to }`
/// epoch-millis wall-clock window — D-12 explicitly declines per-session
/// unwatched-session forensics; this is the only coverage-gap signal
/// Cockpit surfaces (D-13's "was offline from X to Y" banner).
pub const OFFLINE_WINDOW_EVENT_NAME: &str = "cockpit://offline-window";

/// Tauri-managed state holding the per-install token. Never exposed to the
/// webview directly — only Rust command handlers in this module read it.
pub struct TokenState(pub String);

/// Tauri-managed state tracking daemon reachability, driven by the SSE
/// consumer's own connect/reconnect transitions ([`consume_events_once`] /
/// [`spawn_sse_consumer`]). `None` = currently reachable; `Some(since_ms)` =
/// unreachable since that wall-clock instant (epoch millis). Drives the
/// tray watching/not-watching indicator and the offline-window event (D-13).
pub struct ReachabilityState(Mutex<Option<u64>>);

impl ReachabilityState {
    pub fn new() -> Self {
        ReachabilityState(Mutex::new(None))
    }
}

impl Default for ReachabilityState {
    fn default() -> Self {
        Self::new()
    }
}

/// Statuses that are allowed to fire a native OS notification (NOT-01,
/// D-05). `running` is deliberately absent — it never notifies.
const NOTIFIABLE_STATUSES: &[&str] = &["waiting-permission", "waiting-input", "done"];

/// Tauri-managed state tracking, per `session_id`, the last status a
/// notification decision was made for. Copies the exact
/// [`ReachabilityState`] "`Mutex`-wrapped state + `new()`/`Default`" shape
/// (see Pattern Map). Used by [`should_notify`] to implement D-08's
/// fire-once semantics: a notification fires only the moment a session's
/// status *transitions into* one of [`NOTIFIABLE_STATUSES`], never on a
/// repeated frame of the same status.
pub struct NotificationState(Mutex<HashMap<String, String>>);

impl NotificationState {
    pub fn new() -> Self {
        NotificationState(Mutex::new(HashMap::new()))
    }
}

impl Default for NotificationState {
    fn default() -> Self {
        Self::new()
    }
}

/// D-08 fire-once transition detection. Records `new_status` as the
/// latest-seen status for `session_id` (so repeated frames of the same
/// status, or a later diff, always compare against the true last-seen
/// value) and returns `true` only when `new_status` is one of
/// [`NOTIFIABLE_STATUSES`] AND differs from whatever was previously
/// recorded for that `session_id` — i.e. a genuine transition *into* a
/// notifiable state, not a repeat or a transition between two non-notifiable
/// statuses.
///
/// Error frames never reach this function with a changed status at all: the
/// daemon's `transition()` (see `daemon/src/session_state.rs`) does not
/// change status for an `is_error` event, so an error frame's `status` is
/// identical to the previous frame's and this naturally returns `false`
/// (D-10/MON-05 — errors never notify).
fn should_notify(state: &NotificationState, session_id: &str, new_status: &str) -> bool {
    let mut map = state.0.lock().unwrap();
    let prev = map.insert(session_id.to_string(), new_status.to_string());
    NOTIFIABLE_STATUSES.contains(&new_status) && prev.as_deref() != Some(new_status)
}

/// Maps a notifiable status to the D-09 toast title ("the ask" — leads with
/// *why* the toast is interrupting, per D-09's triage-first ordering).
fn toast_title(status: &str) -> &'static str {
    match status {
        "waiting-permission" => "Permission needed",
        "waiting-input" => "Waiting for input",
        "done" => "Agent finished",
        _ => "Claude Cockpit",
    }
}

/// Fires a native OS toast for `value` (a parsed SSE frame) if-and-only-if
/// this frame represents a genuine transition into a notifiable status
/// (D-08, via [`should_notify`]). Assembles the D-09 title/body from the
/// frame's own `sessionId`/`status`/`workspace`/`branch`/`taskSummary`
/// fields, threading `sessionId` through as the notification's `extra`
/// payload so a future toast-click handler (Plan 02-03) has it available.
///
/// Body/title are assembled as PLAIN strings only — no HTML/markup
/// interpolation path — matching this repo's established
/// plain-text-interpolation discipline (T-01-05f) and capping the toast to
/// already-trusted, already-escaped daemon-derived fields (T-02-02-01).
///
/// All three notifiable statuses fire unconditionally in `should_notify`
/// (D-05: default-ON); [`notification_enabled`] then applies the D-06
/// settings gate for `waiting-input`/`done` only — `waiting-permission`
/// never consults the store at all (NOT-03, Pitfall 2).
fn maybe_fire_notification(app: &AppHandle, value: &Value) {
    let (Some(session_id), Some(status)) = (
        value.get("sessionId").and_then(Value::as_str),
        value.get("status").and_then(Value::as_str),
    ) else {
        return;
    };

    let notif_state = app.state::<NotificationState>();
    if !should_notify(notif_state.inner(), session_id, status) {
        return;
    }

    if !notification_enabled(app, status) {
        return;
    }

    let workspace = value
        .get("workspace")
        .and_then(Value::as_str)
        .unwrap_or("unknown workspace");
    let branch = value.get("branch").and_then(Value::as_str);
    let task_summary = value.get("taskSummary").and_then(Value::as_str);

    let location = match branch {
        Some(branch) => format!("{workspace}·{branch}"),
        None => workspace.to_string(),
    };
    let body = match task_summary {
        Some(summary) if !summary.is_empty() => format!("{location}\n{summary}"),
        _ => location,
    };

    let result = app
        .notification()
        .builder()
        .title(toast_title(status))
        .body(body)
        .extra("sessionId", session_id)
        .show();

    if let Err(err) = result {
        eprintln!("cockpit: failed to fire notification for session {session_id}: {err}");
    }
}

/// `tauri-plugin-store` file name — shared contract with
/// `NotificationSettings.tsx`'s `load("settings.json")` call (D-06). One
/// store file, one set of key names, one source of truth.
const SETTINGS_STORE_FILE: &str = "settings.json";

/// D-06 settings gate for `waiting-input`/`done` notifications, structurally
/// bypassed for `waiting-permission` (NOT-03, Pitfall 2): the permission
/// case returns `true` before this function's body ever touches the store
/// (see the `_ => return true` arm below), so there is no code path by
/// which a settings-store edit or a toggle bug can suppress a permission
/// notification.
///
/// Fails OPEN to firing (returns `true`) if the store can't be opened or
/// the key is absent/unset — a missing/corrupt settings file must never
/// silently swallow a notification the user would otherwise expect
/// (T-02-02-02 residual-risk mitigation), matching this file's established
/// log-and-degrade convention for fallible I/O.
fn notification_enabled(app: &AppHandle, status: &str) -> bool {
    let key = match status {
        "waiting-input" => "notify_input_enabled",
        "done" => "notify_done_enabled",
        // waiting-permission (or anything else reaching this point) is
        // structurally un-suppressible — no store read at all.
        _ => return true,
    };

    match app.store(SETTINGS_STORE_FILE) {
        Ok(store) => store
            .get(key)
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        Err(err) => {
            eprintln!(
                "cockpit: failed to open {SETTINGS_STORE_FILE} for notification gate, firing anyway: {err}"
            );
            true
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort tray tooltip update (D-13: passive indicator only — no
/// popups/nags). A missing/unconfigured tray is not treated as fatal.
fn set_tray_tooltip(app: &AppHandle, watching: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = if watching {
            "Claude Cockpit — watching"
        } else {
            "Claude Cockpit — not watching (daemon unreachable)"
        };
        if let Err(err) = tray.set_tooltip(Some(tooltip)) {
            eprintln!("cockpit: failed to update tray tooltip: {err}");
        }
    }
}

/// Called whenever the SSE consumer successfully (re)connects. Flips the
/// tray to "watching"; if the daemon had been unreachable, emits the
/// generic offline-window event so the frontend can show the "was offline
/// from X to Y" banner (D-13), then clears the recorded outage.
fn mark_reachable(app: &AppHandle, reachability: &ReachabilityState) {
    let was_offline_since = reachability.0.lock().unwrap().take();

    set_tray_tooltip(app, true);

    if let Some(since_millis) = was_offline_since {
        let payload = serde_json::json!({ "from": since_millis, "to": now_millis() });
        if let Err(err) = app.emit(OFFLINE_WINDOW_EVENT_NAME, payload) {
            eprintln!("cockpit: failed to emit {OFFLINE_WINDOW_EVENT_NAME}: {err}");
        }
    }
}

/// Called whenever the SSE consumer fails to connect / the stream errors.
/// Flips the tray to "not watching"; records the wall-clock instant the
/// outage began, if one isn't already recorded (idempotent across repeated
/// reconnect-loop failures during the same outage).
fn mark_unreachable(app: &AppHandle, reachability: &ReachabilityState) {
    let mut guard = reachability.0.lock().unwrap();
    if guard.is_none() {
        *guard = Some(now_millis());
    }
    drop(guard);

    set_tray_tooltip(app, false);
}

/// Reads the daemon's per-install auth token from inside WSL by shelling
/// out to `wsl.exe -d <Distro> -- bash -lc "cat ~/.cockpit/token"`.
///
/// Deviation (Rule 1 - bug): the plan's prose literally says
/// `wsl.exe -d <Distro> --exec cat ~/.cockpit/token`, but `--exec` (`-e`)
/// runs the command directly without the distro's default shell, so `~`
/// is never expanded and the read fails. Routing through `bash -lc` gives
/// the same one-hop trust boundary (same Windows user, no new network
/// surface) while actually expanding `~`.
pub fn read_token() -> Result<String, String> {
    let distro = std::env::var("COCKPIT_WSL_DISTRO")
        .or_else(|_| std::env::var("WSL_DISTRO_NAME"))
        .unwrap_or_else(|_| "Ubuntu".to_string());

    let output = std::process::Command::new("wsl.exe")
        .args(["-d", &distro, "--", "bash", "-lc", "cat ~/.cockpit/token"])
        .output()
        .map_err(|e| format!("failed to invoke wsl.exe (distro={distro}): {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "wsl.exe token read failed (distro={distro}, status={:?}): {stderr}",
            output.status.code()
        ));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(format!(
            "token read from WSL distro '{distro}' was empty — is the daemon running?"
        ));
    }
    Ok(token)
}

/// Spawns a background task that keeps a token-authed SSE connection open
/// to `GET /events`, re-emitting each frame as `cockpit://session-event`.
/// Reconnects with a short fixed backoff on any stream error (daemon
/// restart, transient network blip) rather than giving up. This same
/// connect/error transition also drives the tray watching/not-watching
/// indicator and the offline-window banner event (D-13) via the
/// [`ReachabilityState`] managed on `app` (see [`mark_reachable`] /
/// [`mark_unreachable`]).
pub fn spawn_sse_consumer(app: AppHandle, token: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = consume_events_once(&app, &token).await {
                eprintln!("cockpit: /events SSE consumer error, retrying in 2s: {err}");
                mark_unreachable(&app, app.state::<ReachabilityState>().inner());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn consume_events_once(app: &AppHandle, token: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{DAEMON_BASE_URL}/events"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("daemon GET /events returned {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    // WR-03 fix: accumulate raw bytes rather than decoding each network
    // chunk independently with `from_utf8_lossy`. Chunk boundaries are
    // determined by the OS/network stack, not by UTF-8 character
    // boundaries — a multi-byte character split across two chunks would
    // otherwise get silently replaced with U+FFFD in the earlier chunk.
    // Decoding is deferred until a complete frame (delimited by the ASCII
    // "\n\n" sequence, safe to search for in raw bytes) has been assembled.
    let mut buf: Vec<u8> = Vec::new();
    // WR-06 fix: only flip reachability to "watching" once at least one
    // chunk has actually arrived on this connection. Previously
    // `mark_reachable` fired right after the handshake succeeded, before
    // ever reading from the stream — if the daemon accepted the connection
    // and then immediately closed it (no chunks, `Ok(())` below), the
    // reconnect loop in `spawn_sse_consumer` never saw an `Err` and so
    // never called `mark_unreachable`, leaving the tray/offline-banner
    // logic stuck reporting "watching" during a flapping-daemon scenario.
    let mut received_any = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if !received_any {
            received_any = true;
            // Connection established AND actually streaming (D-13 tray
            // indicator + offline-window banner on reconnect, D-12 no
            // per-session forensics).
            mark_reachable(app, app.state::<ReachabilityState>().inner());
        }
        buf.extend_from_slice(&chunk);

        // SSE frames are separated by a blank line ("\n\n").
        while let Some(pos) = find_double_newline(&buf) {
            let frame_bytes: Vec<u8> = buf.drain(..pos + 2).collect();
            match std::str::from_utf8(&frame_bytes[..frame_bytes.len() - 2]) {
                Ok(frame) => emit_sse_frame(app, frame),
                Err(err) => {
                    eprintln!("cockpit: dropped non-UTF8 SSE frame: {err}");
                }
            }
        }
    }

    if received_any {
        Ok(())
    } else {
        Err("daemon closed /events stream without sending any data".to_string())
    }
}

/// Finds the byte offset of the first `"\n\n"` frame delimiter in `buf`, if
/// any. Operates on raw bytes (not `&str`) so it can be called safely
/// before a frame is known to be valid UTF-8 (WR-03) — `"\n\n"` is ASCII,
/// so it can never appear as part of a multi-byte UTF-8 sequence.
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn emit_sse_frame(app: &AppHandle, frame: &str) {
    for line in frame.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue; // ignore SSE comment/keep-alive/event-id lines
        };
        let data = data.strip_prefix(' ').unwrap_or(data);
        match serde_json::from_str::<Value>(data) {
            Ok(value) => {
                // Transition-detect + fire BEFORE re-emitting to the
                // webview (Pattern 2/3, Pitfall 3) — this Rust-side SSE
                // relay is the single choke point that sees every frame in
                // order, so detection lives here rather than in the
                // frontend's `App.tsx` upsert/merge path.
                maybe_fire_notification(app, &value);
                if let Err(err) = app.emit(SESSION_EVENT_NAME, value) {
                    eprintln!("cockpit: failed to emit {SESSION_EVENT_NAME}: {err}");
                }
            }
            Err(err) => {
                eprintln!("cockpit: failed to parse SSE frame as JSON: {err} (frame: {data})");
            }
        }
    }
}

/// Tauri command: GETs `/sessions` from the daemon with the held token and
/// returns the JSON array to the frontend's initial-load `invoke()` call.
#[tauri::command]
pub async fn get_sessions(token: tauri::State<'_, TokenState>) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{DAEMON_BASE_URL}/sessions"))
        .bearer_auth(&token.0)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("daemon GET /sessions returned {}", resp.status()));
    }

    resp.json::<Value>().await.map_err(|e| e.to_string())
}

/// Tauri command: POSTs the token-authed `/sessions/:id/dismiss` (D-06) so
/// the frontend can remove a session from the active queue while keeping
/// it in history. Consumed by the UI in Plan 01-05.
#[tauri::command]
pub async fn dismiss_session(
    token: tauri::State<'_, TokenState>,
    session_id: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{DAEMON_BASE_URL}/sessions/{session_id}/dismiss"))
        .bearer_auth(&token.0)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "daemon POST /sessions/{session_id}/dismiss returned {}",
            resp.status()
        ));
    }

    Ok(())
}

/// Tauri command: GETs the token-authed `/sessions/:id/events` (Plan 01-05
/// D-09) so the frontend's expanded-card timeline can fetch a single
/// session's condensed event history. Added in this plan — no route existed
/// to fetch per-session events before it (see 01-05-SUMMARY.md deviations).
#[tauri::command]
pub async fn get_session_events(
    token: tauri::State<'_, TokenState>,
    session_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{DAEMON_BASE_URL}/sessions/{session_id}/events"))
        .bearer_auth(&token.0)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "daemon GET /sessions/{session_id}/events returned {}",
            resp.status()
        ));
    }

    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod notification_tests {
    use super::*;

    #[test]
    fn fires_on_first_transition_into_notifiable_status() {
        let state = NotificationState::new();
        assert!(should_notify(&state, "s1", "waiting-permission"));
    }

    #[test]
    fn does_not_refire_on_repeated_same_status() {
        let state = NotificationState::new();
        assert!(should_notify(&state, "s1", "waiting-permission"));
        assert!(!should_notify(&state, "s1", "waiting-permission"));
    }

    #[test]
    fn refires_after_leaving_and_reentering_a_notifiable_status() {
        let state = NotificationState::new();
        assert!(should_notify(&state, "s1", "waiting-permission")); // enters
        assert!(!should_notify(&state, "s1", "waiting-permission")); // stays
        assert!(!should_notify(&state, "s1", "running")); // leaves (not itself notifiable)
        assert!(should_notify(&state, "s1", "waiting-permission")); // re-enters: new transition
    }

    #[test]
    fn never_fires_for_running_status() {
        let state = NotificationState::new();
        assert!(!should_notify(&state, "s1", "running"));
        assert!(!should_notify(&state, "s1", "running"));
    }

    #[test]
    fn dedups_rapid_repeated_frames_of_the_same_status() {
        let state = NotificationState::new();
        assert!(should_notify(&state, "s1", "done"));
        for _ in 0..5 {
            assert!(!should_notify(&state, "s1", "done"));
        }
    }
}
