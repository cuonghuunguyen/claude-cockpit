#Requires -Version 5.1
<#
.SYNOPSIS
    Registers a Windows Task Scheduler task that launches the Cockpit daemon
    as a resident WSL2 child process at logon (Plan 01-07, FND-06's
    "daemon is up before the first session" precondition).

.DESCRIPTION
    RESEARCH.md "Auto-Start & Process Lifecycle" / Pitfall C: the WSL2
    utility VM idle-shuts-down roughly a minute after the last
    attached/foreground `wsl.exe` process exits (open WSL issue #8854),
    EVEN with systemd enabled. A fire-and-forget action such as
    `wsl.exe -d Ubuntu -- systemctl` (asking systemd to `start` the
    cockpit-daemon service unit) starts the daemon via systemd and then
    EXITS, which lets the VM idle-shut-down minutes later and silently
    kills the daemon along with it.

    This script instead registers a Task Scheduler action whose `wsl.exe`
    invocation directly `exec`s the daemon binary itself (via
    `bash -lc "exec <path>"`), so the Task Scheduler action's own process
    IS the long-running daemon process — keeping the WSL2 VM resident for
    as long as Windows considers the task "running". The task has no
    execution time limit and is not stopped on idle.

    Complementary, NOT alternative: `scripts/cockpit-autostart.md` also
    documents an in-VM systemd unit (`cockpit-daemon.service`,
    restart-on-failure) for crash recovery WITHIN an already-running VM
    session. That systemd unit is a resilience layer, not a substitute for
    this script's VM-keepalive mechanism — do not confuse "the daemon
    process restarts on crash" (systemd's job) with "the WSL2 VM itself
    stays booted" (this script's job).

.PARAMETER Distro
    The WSL distro name the daemon lives in. Defaults to $env:WSL_DISTRO_NAME
    if set (rarely set in a plain Windows PowerShell session — usually you
    must pass this explicitly), then falls back to "Ubuntu".

.PARAMETER DaemonPath
    Shell command that launches the Cockpit daemon, INSIDE the WSL distro's
    own filesystem. Since Phase 2.1's D-07 retirement, this is the Node
    daemon entrypoint (e.g.
    "node /home/<user>/claude-cockpit/daemon-ts/dist/main.js"), NOT the
    retired Rust binary path. Never a /mnt/c/... path — see RESEARCH.md
    Pitfall D (unrelated to this script, but the same WSL-native-filesystem
    discipline applies to the daemon's working directory/DB too).

.PARAMETER TaskName
    Name of the registered Scheduled Task. Default: "CockpitDaemonAutostart".

.PARAMETER RunWhetherLoggedOnOrNot
    Opt-in switch (default OFF — T-01-01b). When set, registers the task
    with -LogonType Password / S4U so it starts even before an interactive
    logon, at the cost of Task Scheduler needing to store a credential for
    the account (-Password / -User is required in that mode; the caller
    must supply -Password when passing this switch). When NOT set
    (default), the task uses -LogonType Interactive ("run only when user is
    logged on") — no credential storage, but the daemon only becomes
    reachable after that user's own interactive Windows logon completes.
    See scripts/cockpit-autostart.md for the full tradeoff writeup and the
    startup-race retry note (RESEARCH.md Open Question 2 / Assumption A3).
    THIS TRADEOFF MUST BE VALIDATED EMPIRICALLY ON THE TARGET MACHINE
    (Plan 01-07 Task 3, end-of-phase Windows UAT) — not assumed correct
    from this script alone.

.PARAMETER UserId
    Account the task runs as. Default: $env:USERNAME (the current user).
    Required (with -Password) when -RunWhetherLoggedOnOrNot is set.

.PARAMETER Password
    Password for -UserId, only used/required when -RunWhetherLoggedOnOrNot
    is set. Passed as a SecureString; never written to disk by this script.

.EXAMPLE
    # Default: run only when logged on (no stored credential) — Ubuntu distro
    .\register-task-scheduler.ps1 -DaemonPath "node /home/dev/claude-cockpit/daemon-ts/dist/main.js"

.EXAMPLE
    # Opt-in: run whether logged on or not (daemon up before first interactive logon)
    $cred = Get-Credential -UserName $env:USERNAME
    .\register-task-scheduler.ps1 -DaemonPath "node /home/dev/claude-cockpit/daemon-ts/dist/main.js" `
        -RunWhetherLoggedOnOrNot -UserId $cred.UserName -Password $cred.Password
#>

[CmdletBinding()]
param(
    [string]$Distro = $(if ($env:WSL_DISTRO_NAME) { $env:WSL_DISTRO_NAME } else { "Ubuntu" }),

    [Parameter(Mandatory = $true)]
    [string]$DaemonPath,

    [string]$TaskName = "CockpitDaemonAutostart",

    [switch]$RunWhetherLoggedOnOrNot,

    [string]$UserId = $env:USERNAME,

    [System.Security.SecureString]$Password
)

$ErrorActionPreference = "Stop"

if ($RunWhetherLoggedOnOrNot -and -not $Password) {
    throw "RunWhetherLoggedOnOrNot requires -Password (see scripts/cockpit-autostart.md for the credential-storage tradeoff this implies)."
}

$wslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
if (-not (Test-Path $wslExe)) {
    throw "wsl.exe not found at $wslExe — is WSL installed on this machine?"
}

# Resident invocation (Pitfall C): `bash -lc "exec <DaemonPath>"` replaces
# bash's own process image with the daemon binary via `exec`, so this
# wsl.exe invocation's process tree has no extra shell layer sitting
# around — the wsl.exe process this Scheduled Task keeps alive directly
# IS (via exec) the daemon. This is deliberately NOT a fire-and-forget
# systemd-unit-start-and-return command, which would exit immediately
# and let the WSL2 VM idle-shut-down minutes later, silently killing the
# daemon (Pitfall C's core failure mode).
$execCommand = "exec $DaemonPath"
$action = New-ScheduledTaskAction -Execute $wslExe -Argument "-d $Distro -- bash -lc `"$execCommand`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

# No execution time limit, no idle-triggered stop, allowed on battery — a
# short-lived/idle-stopped task would defeat the entire point of this
# script (keeping the WSL2 VM resident indefinitely).
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if ($RunWhetherLoggedOnOrNot) {
    # T-01-01b (Elevation of Privilege, mitigate): this mode requires Task
    # Scheduler to store a credential for $UserId so it can start the task
    # before any interactive logon. Opt-in only — never the default.
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Password -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -User $UserId -Password ([System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))) `
        -Force | Out-Null
    Write-Host "Registered '$TaskName' (RunWhetherLoggedOnOrNot=TRUE — Windows credential stored for '$UserId')."
} else {
    # Default (T-01-01b): "run only when logged on" — no stored credential,
    # but the daemon only becomes reachable after $UserId's own interactive
    # Windows logon completes. A same-login-session Windows-native Claude
    # Code session launched immediately after boot could race the daemon's
    # startup — see scripts/cockpit-autostart.md's startup-race retry note.
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force | Out-Null
    Write-Host "Registered '$TaskName' (RunWhetherLoggedOnOrNot=FALSE, default — no credential stored)."
}

Write-Host "Distro: $Distro"
Write-Host "Daemon path (inside WSL): $DaemonPath"
Write-Host ""
Write-Host "Verify: Start-ScheduledTask -TaskName '$TaskName'; then (after a moment) Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Uninstall: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
