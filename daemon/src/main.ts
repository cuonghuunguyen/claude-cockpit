/**
 * Claude Cockpit daemon — WSL-hosted Fastify service (Node/TypeScript
 * re-platform of the Rust/axum daemon, Phase 2.1).
 *
 * Binds `0.0.0.0:9427` inside WSL, generates/loads a per-install CSPRNG
 * token, opens a WAL-mode SQLite store on the WSL-native filesystem, and
 * wires the token-gated read routes (`/sessions`, `/sessions?active=true`,
 * `/sessions/:id/events`), the ingest (`POST /hooks/*`) and dismiss routes,
 * and the `/events` SSE stream. Port of `daemon/src/main.rs`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { COCKPIT_PORT } from "../../shared/types.js";
import { openDb, rehydrateActiveSessions } from "./store.js";
import { registerRoutes } from "./routes.js";

/** CSPRNG token length in bytes (>= 32 per FND-05 / Don't-Hand-Roll table). */
const TOKEN_BYTES = 32;

/**
 * Resolves `~/.cockpit`, refusing to proceed if `$HOME` resolves under
 * `/mnt/...` (DrvFs) — SQLite's locking model is unreliable on DrvFs
 * cross-OS mounts (D-04). Mirrors `daemon/src/main.rs::cockpit_dir`.
 */
export function cockpitDir(): string {
  const home = process.env.HOME ?? homedir();
  if (!home) {
    throw new Error("HOME env var must be set (WSL-native filesystem)");
  }
  if (home.startsWith("/mnt/")) {
    throw new Error(
      `refusing to run with $HOME (${home}) under /mnt/ (DrvFs) — ` +
        "cockpit.db must live on the WSL-native filesystem, see " +
        "02.1-RESEARCH.md D-04",
    );
  }
  return join(home, ".cockpit");
}

/**
 * Loads the per-install token from `~/.cockpit/token`, generating one via a
 * CSPRNG (`crypto.randomBytes`, 32 bytes, hex-encoded) and persisting it
 * with `0600` permissions if it does not already exist.
 *
 * Load-or-create, NEVER regenerate an existing file — `daemon_client.rs`'s
 * `read_token()` shells into WSL and just `cat`s this file regardless of
 * which daemon binary wrote it (D-03).
 */
export function loadOrCreateToken(dir: string): string {
  const tokenPath = join(dir, "token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeFileSync(tokenPath, token);
  chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * Builds the Fastify app. `/health` is unauthenticated (liveness only, no
 * data, plain-text `ok`); every other route requires the per-install token
 * via the auth preHandler wired in `registerRoutes` (FND-05 — this daemon
 * emits no permissive CORS headers on any route).
 */
export function buildApp(db: DatabaseType, token: string): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async (_req, reply) => {
    reply.header("Content-Type", "text/plain").code(200).send("ok");
  });

  registerRoutes(app, db, token);

  return app;
}

async function main(): Promise<void> {
  const dir = cockpitDir();
  mkdirSync(dir, { recursive: true });

  const token = loadOrCreateToken(dir);

  const dbPath = join(dir, "cockpit.db");
  const db = openDb(dbPath);

  // Startup rehydration (FND-03/D-07): log what would repopulate the active
  // queue after this restart. No separate in-memory session cache exists —
  // GET /sessions(?active=true) and /events always read straight from this
  // same SQLite connection, so once WAL persistence has the row,
  // rehydration is automatic; this call exists to prove/verify the specific
  // unresolved+undismissed query on every startup and surface the count for
  // operators.
  const rehydrated = rehydrateActiveSessions(db);
  console.log(
    `cockpit-daemon rehydrated ${rehydrated.length} unresolved session(s) from a prior run`,
  );

  const app = buildApp(db, token);

  await app.listen({ host: "0.0.0.0", port: COCKPIT_PORT });
  console.log(`cockpit-daemon listening on 0.0.0.0:${COCKPIT_PORT}`);
}

// Only auto-start when this module is the process entrypoint (not when
// imported by tests via `buildApp`/`openDb` directly).
const entry = process.argv[1] ?? "";
if (entry.endsWith("main.js") || entry.endsWith("main.ts")) {
  main().catch((err) => {
    console.error("cockpit-daemon failed to start:", err);
    process.exit(1);
  });
}
