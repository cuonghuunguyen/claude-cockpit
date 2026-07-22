mod daemon_client;
mod toast_window;

use daemon_client::{NotificationState, ReachabilityState, TokenState};
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            daemon_client::get_sessions,
            daemon_client::dismiss_session,
            daemon_client::get_session_events,
            daemon_client::submit_decision,
            toast_window::spawn_decision_toast
        ])
        .setup(|app| {
            // Reachability state drives the tray watching/not-watching
            // indicator and the offline-window banner event (D-13),
            // updated as the SSE consumer connects/reconnects below. Managed
            // eagerly (before the token is available) so `mark_unreachable`
            // has somewhere to record state while we're still waiting on WSL.
            app.manage(ReachabilityState::new());

            // D-08 fire-once transition tracking (session_id -> last-seen
            // status) for the notification firing gate added in
            // `daemon_client.rs::maybe_fire_notification` — managed
            // eagerly for the same reason as `ReachabilityState` above.
            app.manage(NotificationState::new());

            // Off-main-thread toast spawn trigger (RESEARCH.md Pattern 5):
            // the SSE consumer only ever emits `SPAWN_TOAST_EVENT_NAME`;
            // this listener is the sole path that reaches
            // `toast_window::spawn_decision_toast`'s actual window build,
            // via its own freshly spawned async task.
            toast_window::register_spawn_listener(app.handle());

            // WR-01 fix: `read_token()` shells out to `wsl.exe`, which can
            // block for many seconds on a cold WSL2 VM boot. Running that
            // synchronously inside `setup()` would freeze the whole Tauri
            // main thread before the window even finishes initializing, and
            // a failure here would propagate via `?` and abort app startup
            // entirely. Instead, do the read on a blocking task off the
            // async runtime's worker threads, and degrade gracefully (log +
            // leave `TokenState` unmanaged) rather than crashing the app if
            // it fails — the daemon-dependent Tauri commands already return
            // `Result`, so an unmanaged `TokenState` will surface as a
            // normal per-call error instead of a fatal startup failure.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let token = tauri::async_runtime::spawn_blocking(daemon_client::read_token)
                    .await
                    .expect("read_token blocking task panicked");
                match token {
                    Ok(token) => {
                        handle.manage(TokenState(token.clone()));
                        daemon_client::spawn_sse_consumer(handle.clone(), token);
                    }
                    Err(e) => {
                        eprintln!("cockpit: failed to read daemon token via wsl.exe: {e}");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
