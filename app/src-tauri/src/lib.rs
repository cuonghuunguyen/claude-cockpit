mod daemon_client;

use daemon_client::{ReachabilityState, TokenState};
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            daemon_client::get_sessions,
            daemon_client::dismiss_session,
            daemon_client::get_session_events
        ])
        .setup(|app| {
            // The Tauri Rust backend is the sole daemon client (SKELETON.md):
            // read the per-install token here, hand it only to Rust command
            // handlers via managed state, and keep the SSE consumer's
            // re-emitted events as the webview's only path to daemon data.
            let token = daemon_client::read_token()
                .map_err(|e| format!("cockpit: failed to read daemon token via wsl.exe: {e}"))?;
            app.manage(TokenState(token.clone()));
            // Reachability state drives the tray watching/not-watching
            // indicator and the offline-window banner event (D-13),
            // updated as the SSE consumer connects/reconnects below.
            app.manage(ReachabilityState::new());
            daemon_client::spawn_sse_consumer(app.handle().clone(), token);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
