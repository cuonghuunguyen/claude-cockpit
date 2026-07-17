//! Library-crate re-export.
//!
//! `main.rs` remains the actual daemon binary and owns its own private copy
//! of `mod store;` (unchanged from Plans 01-02/01-03/01-04) — nothing here
//! changes that binary's behavior. This `lib.rs` exists solely so that
//! `daemon/tests/*.rs` (external integration tests, which can only see a
//! crate's *public library* API, not a binary crate's private internals)
//! can exercise `store` directly: `daemon/tests/restart_survival.rs` needs
//! to open a real SQLite connection, write sessions/events, drop/reopen the
//! connection (restart simulation), and assert on rehydration + the
//! event-cap trim (01-04-PLAN.md Task 2).
//!
//! `store.rs` has zero dependencies on any other daemon module (no
//! `crate::` references), so re-exporting it here as a second, independent
//! compilation of the same source file is safe — Cargo already supports a
//! package producing both a `lib` and a `bin` target from the same
//! `src/` tree when both `lib.rs` and `main.rs` are present, with no
//! `Cargo.toml` changes required.
pub mod store;
