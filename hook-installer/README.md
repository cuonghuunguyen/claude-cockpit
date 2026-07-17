# hook-installer

One-time global hook installer for Claude Cockpit (FND-01, FND-02, FND-06).
Writes Cockpit's Claude Code hooks into `~/.claude/settings.json` via a
**tagged read-modify-write merge** that never clobbers hooks you already
have configured.

## Why "once per OS side"

`~/.claude/settings.json` on the WSL side (`/home/<user>/.claude/settings.json`)
and on the Windows side (`%USERPROFILE%\.claude\settings.json`) are **two
distinct files on two distinct filesystems** — a native-Windows Claude Code
CLI (and a VS Code integrated terminal using a Windows shell profile) reads
the Windows-side file; a WSL-side CLI (including a VS Code terminal using a
WSL shell profile) reads the WSL-side file. Run this installer **once on
each side**:

```bash
# WSL side (run inside your WSL distro, where the daemon also lives):
node hook-installer/install.mjs install

# Windows side (run with a Windows-native `node`, e.g. from a native
# PowerShell/cmd prompt or a Windows-side clone of this repo):
node hook-installer/install.mjs install
```

Both invocations write the same literal hook content (both sides reach the
daemon via the identical string `http://127.0.0.1:9427/hooks/<event>` —
Windows' default NAT-mode WSL2 localhost-forwarding makes this work
transparently). The only real difference between the two runs is **how the
per-install token is resolved**:

- **WSL side:** read directly from `~/.cockpit/token` (same filesystem the
  daemon wrote it to at first startup, Plan 01-02).
- **Windows side:** the token lives inside the WSL distro's filesystem, so
  the installer shells out to
  `wsl.exe -d <Distro> -- bash -lc "cat ~/.cockpit/token"` — the exact same
  command Tauri's own `daemon_client.rs::read_token` uses (Plan 01-02),
  including the same fix for a `--exec`-vs-`bash -lc` `~`-expansion bug
  documented there. The distro name comes from `--distro`, else
  `COCKPIT_WSL_DISTRO`, else `WSL_DISTRO_NAME`, else defaults to `"Ubuntu"`.

## What gets installed

| Event | Hook type | Target |
|---|---|---|
| `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd` | `type: "http"` | `http://127.0.0.1:9427/hooks/<event>`, `Authorization: Bearer <token>` header, 5s timeout |
| `PreToolUse` | `type: "command"` | `node <repo>/hook-client/pretooluse-wrapper.cjs --token <token> --port 9427` (Plan 01-06's fail-open, warn-once wrapper) |

PreToolUse is the **only** event installed as a command wrapper — every
other event is a plain `http` entry. This mirrors RESEARCH.md's "Fail-Open
Contract": a native `http` hook fails silently on connection failure, with
no config field to attach a custom warning message, so only PreToolUse (the
event D-13's "you're not being watched" warning needs to ride on) gets the
wrapper.

### Fact-checking note (Context7 quota exhausted, consistent with every
prior Phase 1 plan's SUMMARY)

Context7 MCP returned "monthly quota exceeded" for this plan too (no `ctx7`
CLI fallback installed in this environment). Instead of relying on training
data, the hook schema facts below were verified by directly `curl`-fetching
the live `https://code.claude.com/docs/en/hooks` page this session and
grepping the rendered HTML for the authoritative field tables:

- `type: "http"` hooks accept a documented `headers` field ("Additional
  HTTP headers as key-value pairs") — so the token is delivered as a real
  `Authorization: Bearer <token>` header (not the `?token=` query
  fallback the daemon also accepts, per Plan 01-02).
- `timeout` is in **seconds** for `command`/`http`/`mcp_tool` hooks
  (default 600s) — this installer's 5s (http) / 10s (PreToolUse command
  backstop) are real seconds, not milliseconds.
- Command hooks support an **exec form**: `command` (executable) +
  `args` (argument vector), spawned directly with no shell — used for the
  PreToolUse wrapper so the token/port values need no shell-quoting.
- `"matcher": "*"` (or `""`/omitted) matches every occurrence of an event —
  used for every Cockpit entry, since Cockpit watches every session, not a
  specific tool.
- No official passthrough field (`description`/`id`/`name`) is documented on
  hook-handler objects, so this installer does **not** add a non-standard
  top-level field as its tag (unknown-field-rejection behavior is
  unconfirmed and not worth risking a corrupted settings.json). The
  Cockpit marker instead rides inside fields that ARE documented as
  free-form: an extra `X-Cockpit-Managed` header for `http` entries, and an
  extra, silently-ignored `--cockpit-managed=...` flag appended to the
  PreToolUse wrapper's `args` (the wrapper's own arg parser only reacts to
  `--token`/`--port`, see `hook-client/pretooluse-wrapper.cjs`).

## Non-clobbering, idempotent, tagged merge

- **Install/repair** strip any *stale* Cockpit-tagged entry for each
  Cockpit-managed event (repair-safe) and append the fresh canonical entry
  — every other hook, and every other event, is left byte-for-byte
  untouched. Running `install` twice does not duplicate entries.
- **Uninstall** removes only Cockpit-tagged entries; an event key is
  deleted entirely only if Cockpit's own entry was the only thing ever
  installed there. Your other hooks for that event (or any other event)
  are never touched.
- **`repair`** is identical to `install` — running it after the daemon's
  token has been regenerated (e.g. after wiping `~/.cockpit/token`)
  refreshes the embedded token in every Cockpit entry.

## Self-test (fixture-only — never touches your real settings.json)

```bash
node hook-installer/install.mjs --self-test
```

Runs the full non-clobber / idempotency / repair / uninstall acceptance
test against a throwaway `fs.mkdtempSync()` temp directory. It never reads
or writes `~/.claude/settings.json` — verified as part of Plan 01-07's
execution: the real settings.json's marker count was checked (`0`) both
before and after every test run in this session.

## Manual verification / testing against a specific file

```bash
node hook-installer/install.mjs install --settings-path /path/to/fixture.json --token FAKE-TOKEN
node hook-installer/install.mjs uninstall --settings-path /path/to/fixture.json
```

All CLI options: `--settings-path`, `--token`, `--port`, `--wrapper-path`,
`--node-path`, `--distro`, `--side` (`wsl`|`windows`, overrides the
`process.platform`-based auto-detection used for token resolution).

## Uninstall

```bash
node hook-installer/install.mjs uninstall
```

Removes only Cockpit's tagged hook entries from `~/.claude/settings.json`;
everything else you have configured is left in place.
