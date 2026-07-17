//! Claude Cockpit daemon — WSL-hosted axum service.
//!
//! Phase 1, Plan 01-01: placeholder entrypoint only. Real HTTP routes, SQLite
//! persistence, and the SSE push endpoint are wired up in Plan 01-02.

/// Fixed daemon port, mirrored from `shared/types.ts`'s `COCKPIT_PORT`.
///
/// Locked per SKELETON.md: the daemon binds `0.0.0.0:9427` inside WSL so that
/// Windows' localhost-forwarding proxy (default NAT-mode WSL2 networking) can
/// reach it from native-Windows and VS Code sessions, while WSL-origin
/// sessions reach it via ordinary same-host loopback.
const COCKPIT_PORT: u16 = 9427;

fn main() {
    println!("cockpit-daemon placeholder — will bind 0.0.0.0:{COCKPIT_PORT} starting Plan 01-02");
}
