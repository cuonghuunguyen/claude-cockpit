//! Per-install token auth middleware (FND-05).
//!
//! Accepts the token via `Authorization: Bearer <token>` OR `?token=<token>`
//! (the query-param path exists because some hook clients / `EventSource`
//! cannot set custom headers — see SKELETON.md). Applied to every route
//! except `/health` (see `main.rs::build_router`). Never emits a permissive
//! CORS header — this daemon has zero cross-origin support by design; the
//! webview never talks to it directly (the Tauri Rust backend is the sole
//! client), so no browser origin should ever be able to read a response.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use crate::AppState;

/// Constant-time byte comparison to avoid a timing side-channel on token
/// comparison (T-01-05a).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn extract_token(req: &Request) -> Option<String> {
    if let Some(header) = req.headers().get(axum::http::header::AUTHORIZATION) {
        if let Ok(s) = header.to_str() {
            if let Some(stripped) = s.strip_prefix("Bearer ") {
                return Some(stripped.to_string());
            }
        }
    }
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "token" {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Axum middleware: 401s any request whose token (header or query) does not
/// constant-time-match the loaded per-install token.
pub async fn require_token(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = extract_token(&req);
    let ok = match provided {
        Some(token) => constant_time_eq(token.as_bytes(), state.token.as_bytes()),
        None => false,
    };
    if !ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_equal_slices() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
    }

    #[test]
    fn constant_time_eq_rejects_mismatch() {
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"short", b"longer-value"));
    }
}
