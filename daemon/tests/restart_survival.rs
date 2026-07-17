//! Restart-survival + event-cap integration test (01-04-PLAN.md Task 2,
//! FND-03/D-07/D-11).
//!
//! Exercises the store layer directly (not the HTTP/axum layer) against a
//! real on-disk SQLite file: writes sessions/events, drops the `Connection`
//! and reopens the *same* file path (the closest in-process simulation of
//! "the daemon process restarted"), and asserts that:
//!   (a) unresolved, undismissed sessions rehydrate into the active queue
//!   (b) dismissed sessions remain in history but not in the active queue
//!   (c) events written before the restart are still present
//!   (d) a session that exceeded the 300-event cap retains at most 300
//!       events, and its session row is never deleted
//!
//! Uses `cockpit_daemon::store` (the library-target re-export in
//! `daemon/src/lib.rs`) since integration tests under `daemon/tests/` can
//! only see a crate's public library API, not a binary crate's internals.

use cockpit_daemon::store;

fn temp_db_path(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "cockpit-restart-survival-{name}-{}-{}.db",
        std::process::id(),
        now_suffix()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn now_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[test]
fn restart_survives_rehydration_history_and_event_cap() {
    let db_path = temp_db_path("main");

    // --- Pre-restart: seed sessions + events on a real on-disk DB. ---
    {
        let conn = store::open_db(&db_path).expect("open db (pre-restart)");

        // Unresolved + undismissed: must rehydrate after restart.
        store::ensure_session(&conn, "waiting-session", None).unwrap();
        store::update_session_status(&conn, "waiting-session", "waiting-permission", None)
            .unwrap();
        store::append_event(
            &conn,
            "waiting-session",
            "notification",
            None,
            "needs a permission decision",
            None,
            false,
        )
        .unwrap();

        // done + undismissed: must also rehydrate (D-07).
        store::ensure_session(&conn, "done-session", None).unwrap();
        store::update_session_status(&conn, "done-session", "done", None).unwrap();

        // done + dismissed: must NOT rehydrate, but must remain in history.
        store::ensure_session(&conn, "dismissed-session", None).unwrap();
        store::update_session_status(&conn, "dismissed-session", "done", None).unwrap();
        store::dismiss_session(&conn, "dismissed-session").unwrap();

        // plain running + undismissed: must NOT rehydrate (not blocked).
        store::ensure_session(&conn, "running-session", None).unwrap();

        // A session that exceeds the 300-event cap.
        store::ensure_session(&conn, "capped-session", None).unwrap();
        for i in 0..350 {
            store::append_event(
                &conn,
                "capped-session",
                "tool_use",
                None,
                &format!("event {i}"),
                None,
                false,
            )
            .unwrap();
        }

        // conn drops here, simulating the daemon process exiting.
    }

    // --- "Restart": reopen the same DB file from scratch. ---
    let conn = store::open_db(&db_path).expect("reopen db (restart simulation)");

    // (a) unresolved + undismissed sessions rehydrate.
    let rehydrated = store::rehydrate_active_sessions(&conn).expect("rehydrate query");
    let mut rehydrated_ids: Vec<&str> = rehydrated.iter().map(|r| r.session_id.as_str()).collect();
    rehydrated_ids.sort();
    assert_eq!(
        rehydrated_ids,
        vec!["done-session", "waiting-session"],
        "only unresolved (waiting/done) + undismissed sessions should rehydrate after restart"
    );

    // (b) dismissed sessions: absent from the active queue, present in
    // history.
    let active = store::list_active_sessions(&conn).expect("list_active_sessions");
    assert!(
        !active.iter().any(|r| r.session_id == "dismissed-session"),
        "dismissed session must not repopulate the active queue after restart"
    );
    let full = store::list_sessions(&conn).expect("list_sessions (history)");
    assert!(
        full.iter().any(|r| r.session_id == "dismissed-session"),
        "dismissed session must still be present in history after restart"
    );

    // (c) pre-restart events are still present.
    let waiting_event_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = 'waiting-session'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        waiting_event_count, 1,
        "events written before the restart must still be present after reopen"
    );

    // (d) the capped session retains at most 300 events, and the session
    // row itself was never deleted.
    let capped_event_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = 'capped-session'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        capped_event_count, 300,
        "a session that exceeded the 300-event cap must retain exactly the newest 300 across restart"
    );
    assert!(
        store::get_session(&conn, "capped-session").unwrap().is_some(),
        "the capped session's row must never be auto-deleted (D-11)"
    );

    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
}
