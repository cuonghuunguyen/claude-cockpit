/**
 * Per-install token auth middleware (FND-05). Port of `daemon/src/auth.rs`.
 *
 * Accepts the token via `Authorization: Bearer <token>` OR `?token=<token>`
 * (the query-param path exists because some hook clients / `EventSource`
 * cannot set custom headers). Applied to every route except `/health` (see
 * `routes.ts`). Never emits a permissive CORS header — this daemon has zero
 * cross-origin support by design; the webview never talks to it directly
 * (the Tauri Rust backend is the sole client), so no browser origin should
 * ever be able to read a response.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * Extracts the caller's token: `Authorization: Bearer <token>` header first,
 * then `?token=<token>` query param. Header wins if both are present
 * (mirrors `auth.rs::extract_token`'s check order).
 */
export function extractToken(req: FastifyRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  const query = req.query as Record<string, unknown> | undefined;
  const q = query?.token;
  if (typeof q === "string") {
    return q;
  }
  return undefined;
}

/**
 * Constant-time comparison, length-guarded BEFORE calling
 * `crypto.timingSafeEqual` — unlike Rust's hand-rolled `constant_time_eq`,
 * Node's `timingSafeEqual` THROWS on a length mismatch rather than
 * returning `false` (Pitfall 1). The token's length is not itself a secret,
 * so checking it first does not reintroduce a meaningful timing side
 * channel.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false; // must guard: timingSafeEqual throws on length mismatch
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Fastify preHandler hook: 401s any request whose token (header or query)
 * does not constant-time-match the loaded per-install token. Register on
 * every route except `/health`.
 */
export function requireToken(serverToken: string) {
  return async function authPreHandler(
    req: FastifyRequest,
    reply: import("fastify").FastifyReply,
  ): Promise<void> {
    const provided = extractToken(req);
    const ok = provided !== undefined && constantTimeEqual(provided, serverToken);
    if (!ok) {
      reply.code(401).send();
    }
  };
}
