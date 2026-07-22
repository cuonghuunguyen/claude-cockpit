#!/usr/bin/env node
// pretooluse-wrapper.cjs — dependency-free Node `type:"command"` hook wrapper,
// generic/event-agnostic (03-RESEARCH.md Pattern 1), currently installed for
// Claude Code's PreToolUse event (a second PermissionRequest entry lands in
// 03-05, reusing this same script via the `--route` flag below).
//
// Why this exists (see 01-RESEARCH.md "Fail-Open Contract", Pitfall B): a
// native `type:"http"` hook entry fails silently on connection failure —
// there is no config field to attach a custom message to that failure. D-13
// requires "warn once per session, then silent" UX, which only a
// client-side wrapper can implement. This is the ONLY event(s) Cockpit
// installs as a command-hook wrapper; every other event is a plain
// `type:"http"` entry (RESEARCH.md A4).
//
// Contract (D-01/D-02/D-03, FND-04/FND-06, 03-RESEARCH.md Pattern 1):
//   - Reads the raw hook JSON from stdin and forwards it verbatim to
//     `POST http://127.0.0.1:<port><route>` (`--route` defaults to
//     `/hooks/pre-tool-use`; `/hooks/permission-request` is the 03-05 case).
//   - Tokened via `Authorization: Bearer <token>` (resolved from --token/
//     --port/--route CLI args, else COCKPIT_TOKEN/COCKPIT_PORT env vars, else
//     a default port of 9427 — the installer, Plan 01-07, is the one that
//     actually supplies --token/--port or the env, not the user's shell).
//   - `AbortSignal.timeout(HOLD_OPEN_TIMEOUT_MS)` (~590s, just under Claude
//     Code's default 600s hook budget) bounds the decision request. The
//     SAME budget covers both "daemon unreachable at connect" (a refused/
//     failed connection surfaces near-instantly regardless of this value —
//     the connect-phase fail-open from Phase 1 is UNCHANGED, D-02) and "the
//     daemon is legitimately holding this open waiting on the user" (the
//     daemon's own registry timer, ~585s, always fires first and resolves
//     with a real response before this budget would ever elapse on its own).
//   - On success (2xx): pass through the daemon's response body verbatim and
//     exit 0. The body is now a genuine decision object (`permissionDecision:
//     "allow"/"deny"` + optional `permissionDecisionReason`) OR an empty `{}`
//     release-to-native payload (D-01/D-03) — never fabricated here, always
//     whatever the daemon computed.
//   - On failure (timeout, connection refused, non-2xx): FAIL OPEN. Check a
//     per-session marker file at `os.tmpdir()/cockpit-warned-<session_id>`;
//     if absent, write it and print ONE short warning to stderr, then exit 1
//     (non-blocking per Claude Code's hook contract: the tool call still
//     proceeds, stderr text is shown to the user). If the marker already
//     exists, exit 0 silently — no repeat warning, no per-tool-call spam.
//   - NEVER exits 2 (blocking) — that would violate the fail-open contract.
//     NEVER sets `async: true` on the hook entry — see 03-RESEARCH.md
//     Anti-Patterns (async hooks cannot deliver a decision at all).
//
// Dependency-free by design (.claude/CLAUDE.md "What NOT to Use"): only
// Node built-ins (global fetch, AbortSignal.timeout, fs, os, path, process).
// No npm install at hook-install time.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 9427;
const DEFAULT_ROUTE = "/hooks/pre-tool-use";
const CONNECT_TIMEOUT_MS = 2000; // still bounds the stdin-read phase only (readStdin below) — unrelated to the decision-wait budget.
/** ~590s, just under Claude Code's default 600s hook timeout (D-02, 03-RESEARCH.md Pattern 1). Bounds the actual decision-request fetch call — covers both the connect phase and the (possibly long) hold-open wait. */
const HOLD_OPEN_TIMEOUT_MS = 590_000;

/** Parses `--token <value>` / `--port <value>` / `--route <value>` from
 * argv, falling back to `COCKPIT_TOKEN` / `COCKPIT_PORT` env vars (no env
 * fallback for `--route` — it defaults to the PreToolUse route), then
 * hardcoded defaults. The installer (Plan 01-07) is responsible for
 * supplying these — never assume a shell-exported env var. */
function resolveConfig(argv, env) {
  let token = env.COCKPIT_TOKEN || null;
  let port = env.COCKPIT_PORT || String(DEFAULT_PORT);
  let route = DEFAULT_ROUTE;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token" && argv[i + 1] !== undefined) {
      token = argv[i + 1];
      i++;
    } else if (argv[i] === "--port" && argv[i + 1] !== undefined) {
      port = argv[i + 1];
      i++;
    } else if (argv[i] === "--route" && argv[i + 1] !== undefined) {
      route = argv[i + 1];
      i++;
    }
  }

  return { token, port, route };
}

/** WR-04 fix: `AbortSignal.timeout(CONNECT_TIMEOUT_MS)` on the `fetch()` call
 * only bounds the request phase — it never fires if stdin itself never
 * emits 'end' (a hung pipe, a caller-side bug). That left the "independent
 * of, and far tighter than, whatever `timeout` the hook config declares"
 * claim above unenforced for the stdin-read phase. Bound this read with its
 * own timer so the fail-open budget holds even if stdin never closes. */
function readStdin(timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(buf), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(buf);
    });
    // If stdin is already closed/empty (e.g. a TTY with no piped input),
    // 'end' still fires promptly; the timer above is the fail-safe if it
    // doesn't.
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
  const { token, port, route } = resolveConfig(process.argv.slice(2), process.env);
  const raw = await readStdin();

  let sessionId;
  try {
    const payload = JSON.parse(raw);
    sessionId = payload && payload.session_id;
  } catch {
    sessionId = undefined; // malformed stdin JSON — still fail open below
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
      body: raw,
      // Covers BOTH "daemon unreachable at connect" (fails near-instantly
      // regardless of the budget size — D-02, the connect-phase fail-open
      // is unchanged) AND "the daemon is legitimately holding this open
      // waiting on a Cockpit decision" (D-01/D-03).
      signal: AbortSignal.timeout(HOLD_OPEN_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`non-2xx: ${res.status}`);
    }

    // Success: forward the daemon's decision JSON verbatim. This is either
    // a real permissionDecision/decision object the user (or a timeout/
    // dismiss) resolved, or an empty `{}` release-to-native payload — never
    // fabricated here.
    const text = await res.text();
    process.stdout.write(text || "{}");
    process.exit(0);
  } catch (_err) {
    // Daemon unreachable, timed out, or returned non-2xx — fail OPEN.
    failOpenWarnOnce(sessionId);
  }
}

main();
