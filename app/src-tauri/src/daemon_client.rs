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
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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

    // Connection established: the daemon is reachable (D-13 tray indicator
    // + offline-window banner on reconnect, D-12 no per-session forensics).
    mark_reachable(app, app.state::<ReachabilityState>().inner());

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE frames are separated by a blank line ("\n\n").
        while let Some(pos) = buf.find("\n\n") {
            let frame = buf[..pos].to_string();
            buf.drain(..pos + 2);
            emit_sse_frame(app, &frame);
        }
    }

    Ok(())
}

fn emit_sse_frame(app: &AppHandle, frame: &str) {
    for line in frame.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue; // ignore SSE comment/keep-alive/event-id lines
        };
        let data = data.strip_prefix(' ').unwrap_or(data);
        match serde_json::from_str::<Value>(data) {
            Ok(value) => {
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
