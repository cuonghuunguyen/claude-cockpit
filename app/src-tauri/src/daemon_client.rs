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
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Fixed daemon base URL — mirrors `shared/types.ts`'s `COCKPIT_DAEMON_BASE_URL`.
/// Both native-Windows and WSL-origin traffic reach the daemon at this
/// literal address (SKELETON.md "Daemon bind address").
const DAEMON_BASE_URL: &str = "http://127.0.0.1:9427";

/// Tauri event name the webview's `listen()` call subscribes to.
pub const SESSION_EVENT_NAME: &str = "cockpit://session-event";

/// Tauri-managed state holding the per-install token. Never exposed to the
/// webview directly — only Rust command handlers in this module read it.
pub struct TokenState(pub String);

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
/// restart, transient network blip) rather than giving up.
pub fn spawn_sse_consumer(app: AppHandle, token: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = consume_events_once(&app, &token).await {
                eprintln!("cockpit: /events SSE consumer error, retrying in 2s: {err}");
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
