#!/usr/bin/env node
// install.mjs — one-time global hook installer (Plan 01-07, FND-01/FND-02).
//
// Subcommands:
//   node install.mjs install     — tagged read-modify-write merge into
//                                   ~/.claude/settings.json (or --settings-path)
//   node install.mjs repair      — identical to install (refreshes Cockpit's
//                                   own tagged entries from the canonical
//                                   template; never touches other hooks)
//   node install.mjs uninstall   — removes ONLY Cockpit-tagged entries
//   node install.mjs --self-test — runs the non-clobber/idempotency/uninstall
//                                   acceptance test against a throwaway temp
//                                   settings.json (fs.mkdtempSync) — NEVER
//                                   touches the real ~/.claude/settings.json
//
// Dependency-free (Node built-ins only): fs, os, path, child_process, url.
//
// ⚠️ SAFETY: this file is run ONCE PER OS SIDE by the end user (WSL side and
// Windows side separately — the two settings.json files live on distinct
// filesystems, RESEARCH.md "Global Hook Install"). `install`/`repair`/
// `uninstall` default to the REAL `~/.claude/settings.json` when
// `--settings-path` is not given. Automated verification of this file
// (CI, or an executor agent building/testing it) must ONLY ever invoke
// `--self-test` or pass an explicit `--settings-path` pointing at a
// throwaway fixture — never run the bare `install`/`repair`/`uninstall`
// subcommands against a real machine's settings.json during development.

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

import {
  COCKPIT_PORT,
  ALL_COCKPIT_EVENTS,
  buildCockpitHooksBlock,
  isCockpitHandler,
} from "./hook-entries.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** `hook-installer/` lives at the repo root's top level (README.md
 * "Directory Layout") — the wrapper it points PreToolUse at lives in the
 * sibling `hook-client/` directory. */
export function resolveRepoRoot() {
  return path.resolve(__dirname, "..");
}

export function defaultWrapperPath(repoRoot) {
  return path.join(repoRoot, "hook-client", "pretooluse-wrapper.cjs");
}

export function defaultSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/** WSL side (this OS side IS where the daemon lives, Plan 01-02): the token
 * file is directly readable at `~/.cockpit/token` (0600, written by the
 * daemon on first startup). */
export function readTokenFromWslFilesystem() {
  const tokenPath = path.join(os.homedir(), ".cockpit", "token");
  return fs.readFileSync(tokenPath, "utf8").trim();
}

/** Windows side: the token lives inside the WSL distro's filesystem, not
 * reachable directly. Mirrors `app/src-tauri/src/daemon_client.rs::read_token`
 * exactly (Plan 01-02) — `wsl.exe -d <Distro> -- bash -lc "cat ~/.cockpit/token"`,
 * NOT `--exec`, because `--exec` bypasses the distro's default shell and `~`
 * is never expanded (01-02-SUMMARY.md Deviation #2, carried forward here). */
export function readTokenFromWslBridge(distro) {
  const output = execFileSync(
    "wsl.exe",
    ["-d", distro, "--", "bash", "-lc", "cat ~/.cockpit/token"],
    { encoding: "utf8" },
  );
  const token = output.trim();
  if (!token) {
    throw new Error(
      `token read from WSL distro '${distro}' was empty — is the daemon running?`,
    );
  }
  return token;
}

export function resolveDistro(explicit) {
  return (
    explicit ||
    process.env.COCKPIT_WSL_DISTRO ||
    process.env.WSL_DISTRO_NAME ||
    "Ubuntu"
  );
}

export function resolveToken({ tokenOverride, side, distro }) {
  if (tokenOverride) return tokenOverride;
  if (side === "windows") return readTokenFromWslBridge(distro);
  return readTokenFromWslFilesystem();
}

// ---------------------------------------------------------------------------
// settings.json read/write
// ---------------------------------------------------------------------------

export function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

export function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Tagged read-modify-write merge (T-01-01a: non-clobbering, idempotent)
// ---------------------------------------------------------------------------

/** Removes any existing Cockpit-tagged handlers from one event's list of
 * `{matcher, hooks:[...]}` groups, dropping any group left with zero
 * handlers afterward (a group that held ONLY a stale Cockpit handler).
 * Non-Cockpit handlers/groups are returned untouched, in their original
 * order. */
function stripCockpitHandlers(groups) {
  return (groups || [])
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter((h) => !isCockpitHandler(h)),
    }))
    .filter((group) => group.hooks.length > 0);
}

/**
 * Install/repair: for every Cockpit-managed event, strip any stale Cockpit
 * entry (repair-safe, idempotent) then append the fresh canonical entry.
 * Every other event key and every non-Cockpit handler/group, in every
 * event (including the Cockpit-managed ones), is left byte-for-byte
 * untouched (T-01-01a).
 */
export function mergeInstallEntries(settings, cockpitBlock) {
  settings.hooks = settings.hooks || {};
  for (const event of Object.keys(cockpitBlock)) {
    const preserved = stripCockpitHandlers(settings.hooks[event]);
    settings.hooks[event] = [...preserved, cockpitBlock[event]];
  }
  return settings;
}

/**
 * Uninstall: removes ONLY Cockpit-tagged handlers from every Cockpit-managed
 * event. An event key is deleted entirely if nothing but Cockpit's own
 * entry ever lived there; otherwise the user's other groups/handlers for
 * that event are preserved as-is. Never touches events Cockpit doesn't
 * manage.
 */
export function uninstallCockpitEntries(settings) {
  settings.hooks = settings.hooks || {};
  for (const event of ALL_COCKPIT_EVENTS) {
    if (!(event in settings.hooks)) continue;
    const preserved = stripCockpitHandlers(settings.hooks[event]);
    if (preserved.length > 0) {
      settings.hooks[event] = preserved;
    } else {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return settings;
}

/** Counts Cockpit-tagged handlers anywhere in `settings.hooks` — used by
 * both the self-test and as a human-readable install summary. */
export function countCockpitHandlers(settings) {
  let count = 0;
  for (const groups of Object.values(settings.hooks || {})) {
    for (const group of groups) {
      for (const handler of group.hooks || []) {
        if (isCockpitHandler(handler)) count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseOpts(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a
        .slice(2)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function printUsage() {
  console.error(
    [
      "Usage: node hook-installer/install.mjs <install|repair|uninstall> [options]",
      "       node hook-installer/install.mjs --self-test",
      "",
      "Options:",
      "  --settings-path <path>   Override the target settings.json (default: ~/.claude/settings.json)",
      "  --token <token>          Explicit token (skips WSL token resolution; mainly for testing)",
      "  --port <port>            Daemon port (default: 9427)",
      "  --wrapper-path <path>    PreToolUse wrapper path (default: <repo>/hook-client/pretooluse-wrapper.cjs)",
      "  --node-path <path>       Node executable for the PreToolUse command hook (default: node)",
      "  --distro <name>          WSL distro name, Windows side only (default: $COCKPIT_WSL_DISTRO/$WSL_DISTRO_NAME/Ubuntu)",
      "  --side <wsl|windows>     Force which OS side's token-resolution strategy to use (default: auto-detect via process.platform)",
    ].join("\n"),
  );
}

function runInstallLike(cmd, opts) {
  const settingsPath = opts.settingsPath || defaultSettingsPath();
  const settings = loadSettings(settingsPath);

  const side = opts.side || (process.platform === "win32" ? "windows" : "wsl");
  const distro = resolveDistro(opts.distro);
  const port = opts.port ? Number(opts.port) : COCKPIT_PORT;
  const token = resolveToken({ tokenOverride: opts.token, side, distro });
  const repoRoot = resolveRepoRoot();
  const nodePath = opts.nodePath || "node";
  const wrapperPath = opts.wrapperPath || defaultWrapperPath(repoRoot);

  const cockpitBlock = buildCockpitHooksBlock({ port, token, nodePath, wrapperPath });
  mergeInstallEntries(settings, cockpitBlock);
  writeSettings(settingsPath, settings);

  console.log(
    `Cockpit hooks ${cmd === "repair" ? "repaired" : "installed"} into ${settingsPath} ` +
      `(${Object.keys(cockpitBlock).length} events, side=${side}, port=${port}).`,
  );
}

function runUninstall(opts) {
  const settingsPath = opts.settingsPath || defaultSettingsPath();
  const settings = loadSettings(settingsPath);
  uninstallCockpitEntries(settings);
  writeSettings(settingsPath, settings);
  console.log(`Cockpit hooks removed from ${settingsPath}.`);
}

// ---------------------------------------------------------------------------
// Self-test (acceptance criteria: non-clobber, idempotent, repair/uninstall
// — ALWAYS against a throwaway fixture, NEVER the real settings.json)
// ---------------------------------------------------------------------------

function assert(cond, label, failures) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures.push(label);
  }
}

export function runSelfTest() {
  const failures = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-installer-test-"));
  const settingsPath = path.join(tmpDir, "settings.json");

  // Guard rail: self-test must never resolve to a real-looking home path.
  if (!settingsPath.startsWith(os.tmpdir())) {
    throw new Error("REFUSING to self-test outside os.tmpdir() — safety invariant violated");
  }

  console.log(`--self-test fixture: ${settingsPath} (temp dir, NOT the real ~/.claude/settings.json)`);

  // --- Fixture: a settings.json with the user's OWN pre-existing hooks ---
  const fixture = {
    otherTopLevelUserSetting: true,
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "echo", args: ["user-session-start-hook"] }],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "/home/user/.claude/hooks/block-rm.sh" }],
        },
      ],
    },
  };
  writeSettings(settingsPath, fixture);

  // --- Step 1: install ---
  let settings = loadSettings(settingsPath);
  let cockpitBlock = buildCockpitHooksBlock({
    port: 9427,
    token: "TEST-TOKEN-ONE",
    nodePath: "node",
    wrapperPath: "/fake/repo/hook-client/pretooluse-wrapper.cjs",
  });
  mergeInstallEntries(settings, cockpitBlock);
  writeSettings(settingsPath, settings);

  settings = loadSettings(settingsPath);
  assert(settings.otherTopLevelUserSetting === true, "install: preserves unrelated top-level settings", failures);
  assert(
    settings.hooks.SessionStart.length === 2 &&
      settings.hooks.SessionStart[0].hooks[0].command === "echo",
    "install: preserves the user's pre-existing SessionStart hook",
    failures,
  );
  assert(
    settings.hooks.PreToolUse.length === 2 &&
      settings.hooks.PreToolUse.some((g) => g.matcher === "Bash" && g.hooks[0].command.includes("block-rm.sh")),
    "install: preserves the user's pre-existing PreToolUse (Bash matcher) hook",
    failures,
  );
  assert(countCockpitHandlers(settings) === Object.keys(cockpitBlock).length, "install: adds exactly one Cockpit entry per managed event", failures);
  assert(
    JSON.stringify(settings.hooks.SessionStart.find((g) => countCockpitInGroup(g)).hooks[0].headers.Authorization) ===
      JSON.stringify("Bearer TEST-TOKEN-ONE"),
    "install: http entry carries Authorization: Bearer <token>",
    failures,
  );

  // --- Step 2: install again with a REFRESHED token (idempotency + repair) ---
  settings = loadSettings(settingsPath);
  cockpitBlock = buildCockpitHooksBlock({
    port: 9427,
    token: "TEST-TOKEN-TWO-REFRESHED",
    nodePath: "node",
    wrapperPath: "/fake/repo/hook-client/pretooluse-wrapper.cjs",
  });
  mergeInstallEntries(settings, cockpitBlock);
  writeSettings(settingsPath, settings);

  settings = loadSettings(settingsPath);
  assert(countCockpitHandlers(settings) === Object.keys(cockpitBlock).length, "re-install: does not duplicate Cockpit entries (idempotent)", failures);
  assert(settings.hooks.SessionStart.length === 2, "re-install: SessionStart still has exactly 2 groups (user's + Cockpit's), not 3", failures);
  assert(
    JSON.stringify(settings.hooks.SessionStart.find((g) => countCockpitInGroup(g)).hooks[0].headers.Authorization) ===
      JSON.stringify("Bearer TEST-TOKEN-TWO-REFRESHED"),
    "repair: refreshes the token embedded in the Cockpit entry",
    failures,
  );
  assert(
    settings.hooks.SessionStart[0].hooks[0].command === "echo",
    "re-install: user's pre-existing hook still untouched by the second run",
    failures,
  );

  // --- Step 3: uninstall ---
  settings = loadSettings(settingsPath);
  uninstallCockpitEntries(settings);
  writeSettings(settingsPath, settings);

  settings = loadSettings(settingsPath);
  assert(countCockpitHandlers(settings) === 0, "uninstall: removes every Cockpit-tagged handler", failures);
  assert(
    settings.hooks.SessionStart.length === 1 && settings.hooks.SessionStart[0].hooks[0].command === "echo",
    "uninstall: user's SessionStart hook survives, Cockpit's own group is gone",
    failures,
  );
  assert(
    settings.hooks.PreToolUse.length === 1 && settings.hooks.PreToolUse[0].matcher === "Bash",
    "uninstall: user's PreToolUse (Bash matcher) hook survives, Cockpit's own group is gone",
    failures,
  );
  assert(
    !("UserPromptSubmit" in settings.hooks) &&
      !("PostToolUse" in settings.hooks) &&
      !("Notification" in settings.hooks) &&
      !("Stop" in settings.hooks) &&
      !("SubagentStop" in settings.hooks) &&
      !("SessionEnd" in settings.hooks),
    "uninstall: event keys that ONLY ever held Cockpit's entry are removed entirely (no empty litter)",
    failures,
  );
  assert(settings.otherTopLevelUserSetting === true, "uninstall: unrelated top-level settings still preserved", failures);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("");
  console.log(`--self-test: ${failures.length === 0 ? "ALL PASSED" : `${failures.length} FAILED`}`);
  console.log("Real ~/.claude/settings.json was never opened or written by this self-test.");
  return failures.length === 0;
}

function countCockpitInGroup(group) {
  return (group.hooks || []).some((h) => isCockpitHandler(h));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--self-test") {
    const ok = runSelfTest();
    process.exit(ok ? 0 : 1);
  }

  if (!["install", "repair", "uninstall"].includes(cmd)) {
    printUsage();
    process.exit(1);
  }

  const opts = parseOpts(argv.slice(1));

  try {
    if (cmd === "uninstall") {
      runUninstall(opts);
    } else {
      runInstallLike(cmd, opts);
    }
  } catch (err) {
    console.error(`install.mjs ${cmd} failed: ${err.message}`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by a test harness).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
