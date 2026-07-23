# Claude Cockpit

A native desktop companion for developers running many Claude Code sessions
at once. Cockpit listens to Claude Code lifecycle events via hooks, streams
them to a lightweight local service, and surfaces the sessions that need
your attention in a single queue — so you never have to poll a terminal to
discover an agent has been stuck.

See `.planning/PROJECT.md` for the full product context and
`.planning/phases/01-foundation-live-session-dashboard/SKELETON.md` for the
architectural contract this repo implements.

## Locked Architecture (do not re-litigate without a phase-level decision)

| Constant | Value | Why |
|---|---|---|
| Daemon port | **`9427`** (fixed, not dynamic) | One identical hook URL string works across WSL, native Windows, and VS Code sessions. |
| Daemon bind address | **`0.0.0.0:9427`** inside WSL — *not* `127.0.0.1` | Windows' default NAT-mode WSL2 localhost-forwarding proxy reaches the WSL VM's virtual interface, not its loopback. A `127.0.0.1`-only bind is invisible to native-Windows/VS Code sessions. Security comes from the token + no-CORS, not from bind address. |
| Auth scheme | `Authorization: Bearer <token>` header, with a `?token=<token>` query-param fallback for clients that can't set custom headers | Per-install CSPRNG token (≥32 bytes), generated once, stored `~/.cockpit/token` (0600) inside WSL. |
| GUI ↔ daemon transport | The **Tauri Rust backend** is the exclusive daemon client — the webview never calls the daemon directly (it uses Tauri `invoke()`/`listen()`). | Avoids a CORS/same-origin conflict a direct webview→daemon call would create, keeps the token out of webview JS. |
| Persistence | `rusqlite` (bundled SQLite), WAL mode, file at `~/.cockpit/cockpit.db` on the **WSL-native** filesystem (never `/mnt/c/...`) | DrvFs/9P locking semantics are unreliable for SQLite. |

## Directory Layout

```
daemon/             Node/TypeScript daemon (fastify + better-sqlite3), runs INSIDE WSL2
shared/             Shared type contracts (shared/types.ts) consumed by the frontend
app/                Tauri v2 desktop shell (Windows-native)
  src-tauri/        Rust backend: tray icon, daemon client, notifications
  src/              React 19 + Vite 6 frontend (queue-of-cards dashboard)
```

`hook-installer/` (global hook install) and `hook-client/` (the PreToolUse
fail-open wrapper) are added in later Phase 1 plans (01-06, 01-07) — they do
not exist yet in this scaffold.

## Local Development

Two halves run on two sides of the WSL/Windows boundary:

```bash
# 1. WSL side — run the daemon (this is where it must live; see table above)
npm --prefix daemon run build
node daemon/dist/main.js

# 2. Windows side — run the Tauri desktop app (compiles the React/Vite
#    frontend automatically via beforeDevCommand)
cd app
npm install
npm run tauri dev
```

**Note for WSL-only dev machines:** the Tauri crate (`app/src-tauri`)
requires Linux WebKit/GTK system libraries to compile
(see https://tauri.app/start/prerequisites/#linux). If those aren't
installed, build and verify the daemon and frontend independently instead of
a bare `cargo build` at the workspace root:

```bash
npm --prefix daemon run build      # Node/TypeScript daemon
npm --prefix app run build          # Vite production bundle
```

Full `cargo tauri dev`/`cargo tauri build` verification happens on the
Windows side.

**WSL distro name:** the Tauri backend reads the daemon's per-install token
via `wsl.exe -d <Distro> -- bash -lc "cat ~/.cockpit/token"` at startup. It
defaults to `$WSL_DISTRO_NAME` (falling back to `"Ubuntu"`); set
`COCKPIT_WSL_DISTRO` before launching the Tauri app if your distro has a
different name.
