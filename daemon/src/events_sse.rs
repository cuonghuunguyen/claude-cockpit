//! `GET /events` — token-gated Server-Sent Events broadcast (MON-04).
//!
//! Every ingest handler that mutates a session publishes a compact JSON
//! `SessionApi` frame onto `AppState.event_tx` (see
//! `ingest::session_start::session_start`); this endpoint subscribes a new
//! `broadcast::Receiver` per connection and streams those frames out as SSE
//! `data:` events. The Tauri Rust backend (the sole daemon client —
//! `app/src-tauri/src/daemon_client.rs`) is the only consumer; the webview
//! never opens this connection directly.

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use std::{convert::Infallible, sync::Arc};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

use crate::AppState;

/// Token-gated like every other route (auth is applied by the caller —
/// `main.rs::build_router` merges this behind `auth::require_token`).
pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/events", get(sse_handler))
}

async fn sse_handler(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.event_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(json) => Some(Ok(Event::default().data(json))),
        // A lagged receiver (client fell too far behind the broadcast
        // channel's buffer) drops the missed frames rather than erroring
        // the whole stream — the next GET /sessions call from the client
        // resyncs full state.
        Err(_lagged) => None,
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
