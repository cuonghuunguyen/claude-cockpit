import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEvent,
  condensedJsonSummary,
  condensedText,
  deriveWorkspaceAndBranch,
  dismissSession,
  ensureSession,
  getSession,
  listSessions,
  markEnded,
  openDb,
  setTaskSummaryIfAbsent,
  touchLastActivity,
  updateSessionStatus,
  upsertSessionStart,
} from "../src/store.js";
import type { Database as DatabaseType } from "better-sqlite3";

describe("store write layer", () => {
  let tmpDir: string;
  let db: DatabaseType;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cockpit-store-write-test-"));
    db = openDb(join(tmpDir, "cockpit.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertSessionStart inserts a running session and derives workspace/branch", () => {
    const row = upsertSessionStart(db, "s1", "/some/repo", "startup");
    expect(row.status).toBe("running");
    expect(row.workspace).toBe("repo");
    expect(row.source).toBe("startup");
  });

  it("upsertSessionStart upserts (does not duplicate) on a second call for the same session_id", () => {
    upsertSessionStart(db, "s1", "/some/repo", "startup");
    upsertSessionStart(db, "s1", "/some/other-repo", "resume");
    const sessions = listSessions(db);
    expect(sessions.length).toBe(1);
    expect(sessions[0].workspace).toBe("other-repo");
    expect(sessions[0].source).toBe("resume");
  });

  it("ensureSession is INSERT OR IGNORE — never overwrites an existing row", () => {
    ensureSession(db, "s1", "/some/repo");
    updateSessionStatus(db, "s1", "done", null);
    ensureSession(db, "s1", "/some/other-repo");
    const row = getSession(db, "s1");
    expect(row?.status).toBe("done");
  });

  it("set_task_summary_if_absent_is_idempotent", () => {
    ensureSession(db, "s1", null);
    setTaskSummaryIfAbsent(db, "s1", "first prompt");
    setTaskSummaryIfAbsent(db, "s1", "a totally different second prompt");
    const row = getSession(db, "s1");
    expect(row?.taskSummary).toBe("first prompt");
  });

  it("touchLastActivity bumps last_activity_at only, never status", () => {
    ensureSession(db, "s1", null);
    updateSessionStatus(db, "s1", "waiting-input", null);
    touchLastActivity(db, "s1");
    const row = getSession(db, "s1");
    expect(row?.status).toBe("waiting-input");
  });

  it("markEnded sets ended_at without touching status", () => {
    ensureSession(db, "s1", null);
    updateSessionStatus(db, "s1", "done", null);
    markEnded(db, "s1");
    const row = getSession(db, "s1");
    expect(row?.status).toBe("done");
    expect(row?.endedAt).not.toBeNull();
  });

  it("updateSessionStatus sets both status and current_tool together", () => {
    ensureSession(db, "s1", null);
    updateSessionStatus(db, "s1", "running", "Bash");
    let row = getSession(db, "s1");
    expect(row?.status).toBe("running");
    expect(row?.currentTool).toBe("Bash");
    updateSessionStatus(db, "s1", "waiting-input", null);
    row = getSession(db, "s1");
    expect(row?.currentTool).toBeNull();
  });

  it("derive_workspace_and_branch_plain_posix_path", () => {
    const [workspace, branch] = deriveWorkspaceAndBranch("/some/repo");
    expect(workspace).toBe("repo");
    // No real .git dir at this path in the test environment -> null, never a throw.
    expect(branch).toBeNull();
  });

  it("derive_workspace_and_branch_normalizes_native_windows_path", () => {
    // Must not throw on a native-Windows cwd, and must still extract a sane
    // workspace name after /mnt/<drive>/... normalization.
    const [workspace, branch] = deriveWorkspaceAndBranch("C:\\Users\\x\\proj");
    expect(workspace).toBe("proj");
    expect(branch).toBeNull(); // no real .git at /mnt/c/Users/x/proj here
  });

  it("derive_workspace_and_branch_empty_cwd_is_none", () => {
    expect(deriveWorkspaceAndBranch("")).toEqual([null, null]);
    expect(deriveWorkspaceAndBranch("   ")).toEqual([null, null]);
  });

  it("appending_error_event_leaves_session_status_unchanged", () => {
    ensureSession(db, "s1", null);
    updateSessionStatus(db, "s1", "done", null);
    appendEvent(db, "s1", "error", null, "boom", null, true);
    const row = getSession(db, "s1");
    expect(row?.status).toBe("done");
  });

  it("append_event_trims_to_event_cap_without_deleting_the_session_row", () => {
    const sid = "s-event-cap-test-350";
    ensureSession(db, sid, null);
    for (let i = 0; i < 350; i++) {
      appendEvent(db, sid, "tool_use", null, `event ${i}`, null, false);
    }

    const count = db
      .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`)
      .get(sid) as { c: number };
    expect(count.c).toBe(300);

    const row = getSession(db, sid);
    expect(row).not.toBeNull();
  });

  it("a payload_json longer than 8192 chars is stored truncated to 8192", () => {
    ensureSession(db, "s1", null);
    const longPayload = "x".repeat(9000);
    appendEvent(db, "s1", "tool_use", null, "summary", longPayload, false);
    const stored = db
      .prepare(`SELECT payload_json FROM events WHERE session_id = ?`)
      .get("s1") as { payload_json: string };
    expect(stored.payload_json.length).toBe(8192);
  });

  it("dismiss_session_excludes_from_active_but_keeps_in_full_list", () => {
    ensureSession(db, "s1", null);
    ensureSession(db, "s2", null);

    const dismissed = dismissSession(db, "s1");
    expect(dismissed).not.toBeNull();
    expect(dismissed?.dismissedAt).not.toBeNull();

    const active = listSessions(db, { active: true });
    expect(active.length).toBe(1);
    expect(active[0].sessionId).toBe("s2");

    const full = listSessions(db);
    expect(full.length).toBe(2);
  });

  it("dismissSession returns null for an unknown session_id", () => {
    expect(dismissSession(db, "does-not-exist")).toBeNull();
  });

  describe("condensedText", () => {
    it("leaves a short string unchanged", () => {
      expect(condensedText("hello", 200)).toBe("hello");
    });

    it("a 201-emoji summary truncates to 200 code points without a broken surrogate", () => {
      // Each emoji below is a single Unicode code point represented as a
      // UTF-16 surrogate pair — str.slice(0, 200) would split one of these
      // pairs and produce an invalid/replacement character.
      const emoji = "\u{1F600}"; // 😀, a surrogate-pair code point
      const input = emoji.repeat(201);
      const result = condensedText(input, 200);
      // Result must be exactly the first 200 code points (each fully intact)
      // followed by the ellipsis marker — never a broken surrogate half.
      expect(Array.from(result.slice(0, result.length - 1)).length).toBe(200);
      expect(result.endsWith("…")).toBe(true);
      // Re-derive code points and confirm every one is a valid, complete emoji.
      const codePoints = Array.from(result.slice(0, result.length - 1));
      expect(codePoints.every((cp) => cp === emoji)).toBe(true);
    });
  });

  describe("condensedJsonSummary", () => {
    it("stringifies and condenses an arbitrary JSON value", () => {
      const result = condensedJsonSummary({ command: "ls" }, 200);
      expect(result).toBe('{"command":"ls"}');
    });
  });
});
