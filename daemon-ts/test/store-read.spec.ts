import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isTruthy,
  listSessionEvents,
  listSessions,
  millisToRfc3339,
  openDb,
  rehydrateActiveSessions,
} from "../src/store.js";
import type { Database as DatabaseType } from "better-sqlite3";

/** Seeds a minimal session row directly (no ingest layer exists yet — Wave 2). */
function insertSession(
  db: DatabaseType,
  opts: {
    sessionId: string;
    status: string;
    lastActivityAt: number;
    dismissedAt?: number | null;
    startedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, status, started_at, last_activity_at, dismissed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    opts.status,
    opts.startedAt ?? opts.lastActivityAt,
    opts.lastActivityAt,
    opts.dismissedAt ?? null,
  );
}

function insertEvent(
  db: DatabaseType,
  sessionId: string,
  kind: string,
  createdAt: number,
  toolName: string | null = null,
): void {
  db.prepare(
    `INSERT INTO events (session_id, kind, tool_name, summary, is_error, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(sessionId, kind, toolName, kind, createdAt);
}

describe("store read layer", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DatabaseType;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-store-test-"));
    dbPath = join(tmpDir, "cockpit.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("millis_to_rfc3339_epoch_zero", () => {
    expect(millisToRfc3339(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("millis_to_rfc3339_known_value", () => {
    // 2024-01-01T00:00:00.000Z
    expect(millisToRfc3339(1_704_067_200_000)).toBe("2024-01-01T00:00:00.000Z");
  });

  it("openDb opens an existing DB idempotently in WAL mode", () => {
    expect(existsSync(dbPath)).toBe(true);
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    // Re-open the same path — must not throw / must not migrate.
    const db2 = openDb(dbPath);
    expect(db2.pragma("journal_mode", { simple: true })).toBe("wal");
    db2.close();
  });

  describe("isTruthy", () => {
    it("accepts exactly the documented truthy strings", () => {
      expect(isTruthy("1")).toBe(true);
      expect(isTruthy("true")).toBe(true);
      expect(isTruthy("TRUE")).toBe(true);
      expect(isTruthy("yes")).toBe(true);
    });

    it("rejects anything else", () => {
      expect(isTruthy("0")).toBe(false);
      expect(isTruthy("false")).toBe(false);
      expect(isTruthy("True")).toBe(false);
      expect(isTruthy("")).toBe(false);
      expect(isTruthy("YES")).toBe(false);
    });
  });

  it("listSessions returns sessions ordered by last_activity_at DESC", () => {
    insertSession(db, { sessionId: "s-old", status: "done", lastActivityAt: 1000 });
    insertSession(db, { sessionId: "s-new", status: "running", lastActivityAt: 3000 });
    insertSession(db, { sessionId: "s-mid", status: "waiting-input", lastActivityAt: 2000 });

    const sessions = listSessions(db);
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-new", "s-mid", "s-old"]);
    // Field-by-field camelCase + RFC3339 check against shared/types.ts Session shape.
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        sessionId: "s-new",
        status: "running",
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        lastActivityAt: "1970-01-01T00:00:03.000Z",
      }),
    );
  });

  it("listSessions({active: true}) filters out dismissed sessions", () => {
    insertSession(db, { sessionId: "s-active", status: "waiting-input", lastActivityAt: 2000 });
    insertSession(db, {
      sessionId: "s-dismissed",
      status: "done",
      lastActivityAt: 1000,
      dismissedAt: 1500,
    });

    const active = listSessions(db, { active: true });
    expect(active.map((s) => s.sessionId)).toEqual(["s-active"]);

    const full = listSessions(db);
    expect(full.map((s) => s.sessionId).sort()).toEqual(["s-active", "s-dismissed"]);
  });

  it("listSessionEvents returns chronological (ascending id) order for one session only", () => {
    insertSession(db, { sessionId: "s1", status: "running", lastActivityAt: 1000 });
    insertSession(db, { sessionId: "s2", status: "running", lastActivityAt: 1000 });
    insertEvent(db, "s1", "user_prompt", 100);
    insertEvent(db, "s1", "tool_use", 200, "Bash");
    insertEvent(db, "s2", "user_prompt", 150);

    const events = listSessionEvents(db, "s1");
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("user_prompt");
    expect(events[1].kind).toBe("tool_use");
    expect(events[1].toolName).toBe("Bash");
  });

  it("listSessionEvents returns [] (not an error) for an unknown session_id", () => {
    const events = listSessionEvents(db, "does-not-exist");
    expect(events).toEqual([]);
  });

  it("rehydrateActiveSessions returns only unresolved + undismissed sessions", () => {
    insertSession(db, { sessionId: "s-done-undismissed", status: "done", lastActivityAt: 1000 });
    insertSession(db, {
      sessionId: "s-done-dismissed",
      status: "done",
      lastActivityAt: 2000,
      dismissedAt: 2500,
    });
    insertSession(db, {
      sessionId: "s-waiting-undismissed",
      status: "waiting-permission",
      lastActivityAt: 3000,
    });
    insertSession(db, { sessionId: "s-running-undismissed", status: "running", lastActivityAt: 4000 });

    const rehydrated = rehydrateActiveSessions(db);
    const ids = rehydrated.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["s-done-undismissed", "s-waiting-undismissed"]);

    const full = listSessions(db);
    expect(full.some((s) => s.sessionId === "s-done-dismissed")).toBe(true);
  });
});
