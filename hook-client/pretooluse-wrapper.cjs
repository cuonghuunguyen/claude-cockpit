#!/usr/bin/env node
// pretooluse-wrapper.cjs — dependency-free Node `type:"command"` hook wrapper
// for Claude Code's PreToolUse event.
//
// Why this exists (see 01-RESEARCH.md "Fail-Open Contract", Pitfall B): a
// native `type:"http"` hook entry fails silently on connection failure —
// there is no config field to attach a custom message to that failure. D-13
// requires "warn once per session, then silent" UX, which only a
// client-side wrapper can implement. This is the ONLY event Cockpit installs
// as a command-hook wrapper; every other event is a plain `type:"http"`
// entry (RESEARCH.md A4).
//
// Contract (D-12/D-13, FND-06):
//   - Reads the raw PreToolUse hook JSON from stdin and forwards it verbatim
//     to `POST http://127.0.0.1:<port>/hooks/pre-tool-use`.
//   - Tokened via `Authorization: Bearer <token>` (resolved from --token/
//     --port CLI args, else COCKPIT_TOKEN/COCKPIT_PORT env vars, else a
//     default port of 9427 — the installer, Plan 01-07, is the one that
//     actually supplies --token/--port or the env, not the user's shell).
//   - Hard `AbortSignal.timeout(2000)` connect+response budget — independent
//     of, and far tighter than, whatever `timeout` the hook config itself
//     declares (default 600s), so a dead daemon can never hang a tool call.
//   - On success (2xx): pass through the daemon's response body and exit 0.
//     Phase 1 is observe-only — this handler (and the daemon's own
//     pre_tool_use handler) never emits a permissionDecision/override field.
//   - On failure (timeout, connection refused, non-2xx): FAIL OPEN. Check a
//     per-session marker file at `os.tmpdir()/cockpit-warned-<session_id>`;
//     if absent, write it and print ONE short warning to stderr, then exit 1
//     (non-blocking per Claude Code's hook contract: the tool call still
//     proceeds, stderr text is shown to the user). If the marker already
//     exists, exit 0 silently — no repeat warning, no per-tool-call spam.
//   - NEVER exits 2 (blocking) — that would violate the fail-open contract.
//
// Dependency-free by design (.claude/CLAUDE.md "What NOT to Use"): only
// Node built-ins (global fetch, AbortSignal.timeout, fs, os, path, process).
// No npm install at hook-install time.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 9427;
const CONNECT_TIMEOUT_MS = 2000;

/** Parses `--token <value>` / `--port <value>` from argv, falling back to
 * `COCKPIT_TOKEN` / `COCKPIT_PORT` env vars, then a hardcoded default port.
 * The installer (Plan 01-07) is responsible for supplying these — never
 * assume a shell-exported env var. */
function resolveConfig(argv, env) {
  let token = env.COCKPIT_TOKEN || null;
  let port = env.COCKPIT_PORT || String(DEFAULT_PORT);

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token" && argv[i + 1] !== undefined) {
      token = argv[i + 1];
      i++;
    } else if (argv[i] === "--port" && argv[i + 1] !== undefined) {
      port = argv[i + 1];
      i++;
    }
  }

  return { token, port };
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    // If stdin is already closed/empty (e.g. a TTY with no piped input),
    // 'end' still fires; nothing further to guard here.
  });
}

/** Warn-once-per-session marker path (D-13). Falls back to a fixed
 * "unknown-session" marker if the payload has no parseable session_id, so
 * the wrapper never crashes on malformed stdin. */
function markerPath(sessionId) {
  const safeId = sessionId && typeof sessionId === "string" ? sessionId : "unknown-session";
  return path.join(os.tmpdir(), `cockpit-warned-${safeId}`);
}

/** FAIL OPEN (D-12/D-13): the tool call already proceeds regardless of this
 * function's exit code choice (exit 1 is non-blocking) — this only decides
 * whether a warning is shown. Exits the process; never returns. */
function failOpenWarnOnce(sessionId) {
  const marker = markerPath(sessionId);
  if (!fs.existsSync(marker)) {
    try {
      fs.writeFileSync(marker, String(Date.now()));
    } catch {
      // Best-effort marker write — if it fails (e.g. read-only tmpdir), we
      // may warn more than once, but we must never let that crash or block
      // the tool call. Fail open regardless.
    }
    process.stderr.write(
      "Cockpit is not reachable — this session is not being watched.\n",
    );
    process.exit(1); // non-blocking: tool call proceeds, stderr IS shown
  }
  process.exit(0); // already warned this session — stay silent, still open
}

async function main() {
  const { token, port } = resolveConfig(process.argv.slice(2), process.env);
  const raw = await readStdin();

  let sessionId;
  try {
    const payload = JSON.parse(raw);
    sessionId = payload && payload.session_id;
  } catch {
    sessionId = undefined; // malformed stdin JSON — still fail open below
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/pre-tool-use`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
      body: raw,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`non-2xx: ${res.status}`);
    }

    // Success: observe-only pass-through. Never emit/forward a permission
    // decision override in Phase 1 — the daemon's own handler acks empty.
    const text = await res.text();
    process.stdout.write(text || "{}");
    process.exit(0);
  } catch (_err) {
    // Daemon unreachable, timed out, or returned non-2xx — fail OPEN.
    failOpenWarnOnce(sessionId);
  }
}

main();
