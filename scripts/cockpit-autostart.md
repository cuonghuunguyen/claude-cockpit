# Cockpit Auto-Start (Windows Task Scheduler + WSL2 VM Keepalive)

Makes the Cockpit daemon come up **before the first Claude Code session of
the day** — including a native-Windows-only session where no WSL shell has
been opened yet, which would otherwise mean the WSL2 utility VM hasn't even
booted (FND-06's always-on precondition).

## Install

Run once, from an elevated or non-elevated Windows PowerShell session (task
registration for the current user does not require elevation):

```powershell
.\scripts\register-task-scheduler.ps1 -DaemonPath "/home/<user>/claude-cockpit/target/debug/cockpit-daemon"
```

`-Distro` defaults to `$env:WSL_DISTRO_NAME` if that's set in your shell,
else `"Ubuntu"` — pass `-Distro <name>` explicitly if your distro has a
different name (same convention as `COCKPIT_WSL_DISTRO` documented in the
repo root `README.md`).

## Why a resident `wsl.exe` invocation, not `systemctl`

RESEARCH.md Pitfall C, and open WSL/Microsoft issue #8854: the WSL2 utility
VM idle-shuts-down roughly a minute after the *last attached/foreground*
`wsl.exe` process exits — **even with systemd enabled inside the distro**.
A Task Scheduler action shaped like

```
wsl.exe -d Ubuntu -- systemctl start cockpit-daemon
```

asks systemd to start the daemon and then **exits immediately**. The daemon
itself may still be running (systemd keeps it alive), but the WSL2 VM that
daemon lives inside silently shuts down a minute later once no `wsl.exe`
process is left attached — taking the daemon down with it, with no error
surfaced anywhere.

`scripts/register-task-scheduler.ps1` instead registers an action that runs

```
wsl.exe -d <Distro> -- bash -lc "exec <DaemonPath>"
```

`exec` replaces `bash`'s own process image with the daemon binary, so the
Task Scheduler action's own process tree **is** the daemon — as long as
Task Scheduler considers that action "running" (no execution time limit,
not stopped on idle — both configured by the script), the WSL2 VM stays
resident and the daemon stays alive.

## Credential / logon-mode tradeoff (RESEARCH.md Open Question 2 / Assumption A3)

Task Scheduler's "At log on" trigger can run in two different **logon
types**, and this script exposes both via `-RunWhetherLoggedOnOrNot`:

| Mode | Flag | Daemon up before... | Credential storage |
|---|---|---|---|
| **Default: "run only when logged on"** | *(omit the flag)* | ...your own interactive Windows logon completes | None — no credential is stored by Task Scheduler |
| **Opt-in: "run whether logged on or not"** | `-RunWhetherLoggedOnOrNot -UserId <you> -Password <securestring>` | ...any interactive logon at all (starts as soon as the machine boots / the scheduled trigger fires) | Task Scheduler stores a credential for `-UserId` so it can start the task pre-logon |

**Recommendation: default to "run only when logged on"** (T-01-01b,
Elevation-of-Privilege mitigation) unless you specifically need the daemon
reachable before you've logged in at all (e.g. the machine auto-locks and
you want a Claude Code session launched by some other automation to be
captured immediately on unlock). Storing a Windows credential inside Task
Scheduler is a real attack-surface increase most single-user dev machines
don't need just to shave the small window described below.

### The startup-race window (default mode only)

With the default "run only when logged on" mode, there's a small window
right after your interactive logon completes where a native-Windows Claude
Code session launched in that same login session could fire a hook
*before* the Task Scheduler action has finished starting `wsl.exe` and the
daemon has finished binding its port. This does **not** break anything:

- `hook-client/pretooluse-wrapper.cjs` (Plan 01-06) fails open with its own
  hard 2-second `AbortSignal` budget — a tool call proceeds regardless, the
  user just sees one "Cockpit is not reachable" warning for that one
  session if the race is lost.
- Every other event is a plain `type: "http"` hook, which Claude Code
  itself treats as a silent, non-blocking failure on connection refusal —
  no user-visible error, the session simply isn't captured for events that
  arrive before the daemon is up (later events in the same session are
  captured normally once the daemon is ready, typically within a second or
  two of Windows logon).

No additional retry/backoff logic was added to the wrapper for this window
specifically — the existing fail-open design already degrades gracefully,
and this is a race measured in single-digit seconds at most on modern
hardware. **This assumption must be validated empirically** on the target
machine (Plan 01-07 Task 3 — a fresh Windows logon followed immediately by
a Claude Code session, end-of-phase Windows UAT) rather than assumed
correct from this document alone.

## Complementary in-VM crash recovery: `cockpit-daemon.service` (systemd)

The Task Scheduler action above solves **VM keepalive** (is the WSL2 VM
itself still booted). It does **not** solve **process crash recovery**
(what if the daemon binary itself panics/segfaults while the VM stays up).
This machine already runs systemd as WSL's PID 1 (directly probed during
Phase 1 research), so ship a small complementary unit for that layer:

```ini
# /etc/systemd/system/cockpit-daemon.service — install INSIDE the WSL distro
[Unit]
Description=Claude Cockpit daemon
After=network.target

[Service]
Type=simple
ExecStart=/home/<user>/claude-cockpit/target/debug/cockpit-daemon
Restart=on-failure
RestartSec=2
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cockpit-daemon.service
```

**Do not treat this as a substitute for the Task Scheduler mechanism above**
— a systemd unit set to `Restart=on-failure` only restarts the process
*while the VM it lives in is still running*; it has no way to keep the VM
itself booted once every `wsl.exe` process has exited. The two mechanisms
are complementary layers of the same "daemon must stay up" requirement:
Task Scheduler keeps the **VM** alive, systemd keeps the **process** alive
within that VM.

If you enable this systemd unit, do NOT also point the Task Scheduler
action at a "start the systemd unit and return" command (see the pitfall
section above) — the Task Scheduler action must still directly `exec` the
daemon binary (or, if you prefer running the daemon exclusively under
systemd's supervision, the Task Scheduler action can instead hold the VM
open with a resident no-op like `bash -lc "exec sleep infinity"` after
`systemctl start`-ing the service — but this is a more complex two-process
shape than `register-task-scheduler.ps1` implements by default, and is not
this plan's recommended configuration).

## Verify

```powershell
# Confirm the task is registered and its last run succeeded:
Get-ScheduledTask -TaskName "CockpitDaemonAutostart" | Get-ScheduledTaskInfo

# Manually trigger it without logging off/on again:
Start-ScheduledTask -TaskName "CockpitDaemonAutostart"

# From the WSL side, confirm the daemon actually bound the port:
curl http://127.0.0.1:9427/health   # -> 200, no token required (Plan 01-02)
```

**VM keepalive smoke test (RESEARCH.md Pitfall C, Plan 01-07 Task 3):**
leave the machine idle for 10+ minutes after a fresh logon, then trigger a
hook (start a new Claude Code session) and confirm the daemon is still
reachable (`GET /health` still 200) and the new session appears in the
dashboard. This is the specific failure mode a fire-and-forget
`systemctl`-start action would NOT survive.

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName "CockpitDaemonAutostart" -Confirm:$false
```

## Static verification performed for this plan

`pwsh` (PowerShell Core) is not installed in the WSL sandbox this plan was
authored in, so `register-task-scheduler.ps1` could not be parsed via
`[ScriptBlock]::Create(...)` in this session (the plan's own documented
fallback for this exact situation: "otherwise a documented manual check").
What WAS verified in this sandbox:

- `grep -c 'wsl.exe' scripts/register-task-scheduler.ps1` = 7 (resident
  invocation referenced throughout: path resolution, the actual action
  argument string, comments, and the doc-string).
- `grep -c 'systemctl start' scripts/register-task-scheduler.ps1` = 0 (no
  fire-and-forget systemd-start-and-return action is ever constructed by
  this script).
- Manual read-through against PowerShell 5.1+/`ScheduledTasks` module
  cmdlet signatures (`Register-ScheduledTask`, `New-ScheduledTaskAction`,
  `New-ScheduledTaskTrigger -AtLogOn`, `New-ScheduledTaskSettingsSet`,
  `New-ScheduledTaskPrincipal`) — all built into Windows 10/11 out of the
  box, not third-party, and stable across Windows versions; Context7 MCP
  quota was exhausted this session (consistent with every prior Phase 1
  plan) so this was not live-doc-verified via Context7, only via
  established, versioned Microsoft cmdlet knowledge.
- **Deferred to Windows end-of-phase UAT (Plan 01-07 Task 3):** actually
  running `.\scripts\register-task-scheduler.ps1` on a real Windows
  machine, confirming `Register-ScheduledTask` succeeds without a syntax
  or parameter-binding error, and the full VM-keepalive + credential-mode
  smoke tests described above.
