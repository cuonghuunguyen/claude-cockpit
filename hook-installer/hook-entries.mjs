// hook-entries.mjs — canonical Cockpit hook-entry templates (Plan 01-07,
// FND-01/FND-02/FND-06).
//
// Fact discipline (Context7 quota exhausted this session, consistent with
// every prior Phase 1 plan's SUMMARY — see hook-installer/README.md
// "Fact-checking note"): verified directly against a live fetch of
// https://code.claude.com/docs/en/hooks (curl, not Context7) rather than
// from training-data assumptions:
//   (a) `type:"http"` hooks DO support a `headers` field ("Additional HTTP
//       headers as key-value pairs") — so the token is delivered as a real
//       `Authorization: Bearer <token>` header, not a `?token=` query
//       fallback. The header VALUE is a literal string in settings.json
//       (no `$VAR` env-var interpolation is used — that mechanism exists
//       for a different use case and requires an `allowedEnvVars`
//       allow-list we don't need here).
//   (b) `settings.json` hooks schema: top-level `"hooks"` object keyed by
//       Claude Code event name (`"SessionStart"`, `"PreToolUse"`, ...) ->
//       array of `{ "matcher": "...", "hooks": [ {type, ...} ] }` groups.
//       `"matcher": "*"` (or `""`/omitted) matches every occurrence of the
//       event.
//   (c) `timeout` is in SECONDS for `command`/`http`/`mcp_tool` hooks
//       (default 600s) — confirms the plan's "aggressive timeout (5s)" is
//       5 real seconds, not 5000ms.
//   (d) Command hooks: `command` (executable) + `args` (argument vector) ->
//       spawned directly with NO shell involved ("exec form"). This is the
//       form Cockpit uses for the PreToolUse wrapper (no shell-quoting
//       concerns for the token/port arguments).
//   (e) No official "description"/"id"/"name" passthrough field is
//       documented on any hook-handler object, so Cockpit does NOT add a
//       non-standard top-level field to hook objects as its tag (unknown
//       schema-rejection behavior is unconfirmed and not worth risking a
//       corrupted settings.json). Instead the marker rides inside fields
//       that ARE documented as free-form: an extra `headers` entry for
//       http hooks (headers are explicitly "key-value pairs", no
//       restriction on which), and an extra, harmless CLI flag appended to
//       `args` for the PreToolUse command hook (the wrapper's own arg
//       parser silently ignores unrecognized flags — see
//       hook-client/pretooluse-wrapper.cjs `resolveConfig`).

/** Fixed daemon port (see README.md "Locked Architecture" / shared/types.ts). */
export const COCKPIT_PORT = 9427;

/** Stable, grep-able Cockpit tag. Rides inside a documented free-form field
 * (an extra HTTP header for http hooks; an extra ignored CLI flag for the
 * PreToolUse command hook) rather than a non-standard top-level hook field,
 * to avoid any risk of settings.json schema rejection. */
export const COCKPIT_MARKER = "cockpit-managed-hook-v1";

/** The literal HTTP header name carrying the marker on http-type entries. */
export const COCKPIT_MARKER_HEADER = "X-Cockpit-Managed";

/** The literal CLI flag carrying the marker on the PreToolUse command entry. */
export const COCKPIT_MARKER_ARG = `--cockpit-managed=${COCKPIT_MARKER}`;

/**
 * Every Claude Code hook event Cockpit installs as a plain `type:"http"`
 * entry, mapped to the exact daemon route (daemon/src/ingest/mod.rs
 * `routes()`, Plan 01-02/01-03). PreToolUse is deliberately excluded here —
 * it is the one event installed as a `type:"command"` wrapper instead (see
 * `buildPreToolUseEntry` below; RESEARCH.md "Pitfall B" / A4).
 */
export const HTTP_EVENT_ROUTES = {
  SessionStart: "/hooks/session-start",
  UserPromptSubmit: "/hooks/user-prompt-submit",
  PostToolUse: "/hooks/post-tool-use",
  Notification: "/hooks/notification",
  Stop: "/hooks/stop",
  SubagentStop: "/hooks/subagent-stop",
  SessionEnd: "/hooks/session-end",
};

/** All Cockpit-managed event names, http events plus PreToolUse and
 * PermissionRequest. */
export const ALL_COCKPIT_EVENTS = [
  ...Object.keys(HTTP_EVENT_ROUTES),
  "PreToolUse",
  "PermissionRequest",
];

/** Aggressive per-hook timeout (seconds) for the native http entries — the
 * daemon acks in well under a second; 5s is a generous ceiling that still
 * fails fast against a genuinely hung/unreachable daemon (fact (c) above). */
const HTTP_HOOK_TIMEOUT_SECONDS = 5;

/** Outer backstop timeout (seconds) for the PreToolUse command hook. Raised
 * from the Phase 1 observe-only value (10s) to accommodate the wrapper's
 * hold-open decision wait (`HOLD_OPEN_TIMEOUT_MS = 590_000` in
 * `hook-client/pretooluse-wrapper.cjs`, D-02) — must exceed that budget, just
 * under Claude Code's own default 600s hook timeout (03-RESEARCH.md Pitfall
 * 1: at the old 10s value, Cockpit's decision channel silently reverted to
 * the native prompt after ~10s regardless of how fast the user could click). */
const COMMAND_HOOK_TIMEOUT_SECONDS = 590;

/**
 * Builds one `{matcher, hooks:[...]}` group for a native http Cockpit
 * entry.
 */
export function buildHttpHookEntry({ event, port, token }) {
  const routePath = HTTP_EVENT_ROUTES[event];
  if (!routePath) {
    throw new Error(`buildHttpHookEntry: unknown Cockpit http event "${event}"`);
  }
  return {
    matcher: "*",
    hooks: [
      {
        type: "http",
        url: `http://127.0.0.1:${port}${routePath}`,
        headers: {
          Authorization: `Bearer ${token}`,
          [COCKPIT_MARKER_HEADER]: COCKPIT_MARKER,
        },
        timeout: HTTP_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

/**
 * Builds the one `{matcher, hooks:[...]}` group for the PreToolUse command
 * wrapper (hook-client/pretooluse-wrapper.cjs, Plan 01-06). Uses "exec
 * form" (`command` + `args`, no shell) per fact (d) above — no quoting
 * concerns for the token/port values. The wrapper itself (not this
 * settings.json entry) is what POSTs to the daemon's
 * `http://127.0.0.1:<port>/hooks/pre-tool-use` route — PreToolUse is the
 * ONE Cockpit event that never appears as a bare http URL in settings.json.
 */
export function buildPreToolUseEntry({ port, token, nodePath, wrapperPath }) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: nodePath,
        args: [
          wrapperPath,
          "--token",
          token,
          "--port",
          String(port),
          COCKPIT_MARKER_ARG,
        ],
        timeout: COMMAND_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

/**
 * Builds the one `{matcher, hooks:[...]}` group for the wildcard
 * PermissionRequest command wrapper (Plan 03-06, D-14/D-16/D-18). Reuses the
 * SAME shared wrapper script as `buildPreToolUseEntry` above (dependency-free,
 * `--route`-parameterized, hook-client/pretooluse-wrapper.cjs) — no second
 * wrapper script, no wrapper edit — but targets the daemon's
 * `/hooks/permission-request` route instead via an extra `--route` arg.
 *
 * The matcher is deliberately the wildcard `"*"`, not a narrower
 * `ExitPlanMode`-only matcher: per D-16, PermissionRequest is now the ONE
 * general-gating mechanism for ordinary tool-call permission decisions AND
 * the plan-mode 3-way (ExitPlanMode dispatches internally on `tool_name` in
 * the daemon handler, 03-05). Once D-14 lands, PreToolUse no longer actively
 * resolves anything except the AskUserQuestion branch (D-15), so there is no
 * competing resolution for PermissionRequest to race against — the
 * RESEARCH.md "ExitPlanMode-only" caution (Pitfall 4 / Open Question 1) that
 * motivated a narrower matcher is superseded (D-19).
 *
 * Must NEVER be marked `async: true` (T-03-12) — an async command hook
 * cannot hold Claude Code open for a decision at all, silently discarding
 * every hold.
 */
export function buildPermissionRequestEntry({ port, token, nodePath, wrapperPath }) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: nodePath,
        args: [
          wrapperPath,
          "--token",
          token,
          "--port",
          String(port),
          "--route",
          "/hooks/permission-request",
          COCKPIT_MARKER_ARG,
        ],
        timeout: COMMAND_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

/**
 * Builds the full set of Cockpit-managed hook-entry groups, keyed by event
 * name, ready to be merged into an existing settings.json `"hooks"` object.
 */
export function buildCockpitHooksBlock({ port, token, nodePath, wrapperPath }) {
  const block = {};
  for (const event of Object.keys(HTTP_EVENT_ROUTES)) {
    block[event] = buildHttpHookEntry({ event, port, token });
  }
  block.PreToolUse = buildPreToolUseEntry({ port, token, nodePath, wrapperPath });
  block.PermissionRequest = buildPermissionRequestEntry({ port, token, nodePath, wrapperPath });
  return block;
}

/**
 * True if a single hook-handler object (an entry inside a
 * `{matcher, hooks:[...]}` group's `hooks` array) is Cockpit-managed, per
 * the marker carried in its `headers` (http) or `args` (command).
 */
export function isCockpitHandler(handler) {
  if (!handler || typeof handler !== "object") return false;
  if (handler.headers && handler.headers[COCKPIT_MARKER_HEADER] === COCKPIT_MARKER) {
    return true;
  }
  if (Array.isArray(handler.args) && handler.args.includes(COCKPIT_MARKER_ARG)) {
    return true;
  }
  return false;
}
