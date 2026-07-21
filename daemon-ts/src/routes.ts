/**
 * Route registration: token-gated read routes. Port of the read half of
 * `daemon/src/ingest/mod.rs::routes` (`GET /sessions`, `GET
 * /sessions?active=true`, `GET /sessions/:id/events`). Ingest (`POST
 * /hooks/*`), dismiss, and the `/events` SSE stream are Wave 2/3 — not
 * registered here.
 */

import type { FastifyInstance } from "fastify";
import type { Database as DatabaseType } from "better-sqlite3";

import { requireToken } from "./auth.js";
import { isTruthy, listSessionEvents, listSessions } from "./store.js";

interface ListSessionsQuery {
  /** `?active=true` (or `1`/`TRUE`/`yes`) restricts to the active queue. */
  active?: string;
}

interface SessionIdParams {
  id: string;
}

/**
 * Registers the token-gated read routes on `app`. `/health` is registered
 * separately in `main.ts` and is NOT behind this auth hook.
 */
export function registerRoutes(app: FastifyInstance, db: DatabaseType, token: string): void {
  const auth = requireToken(token);

  app.get<{ Querystring: ListSessionsQuery }>(
    "/sessions",
    { preHandler: auth },
    async (req, reply) => {
      const activeOnly = req.query.active !== undefined && isTruthy(req.query.active);
      const sessions = listSessions(db, { active: activeOnly });
      reply.send(sessions);
    },
  );

  app.get<{ Params: SessionIdParams }>(
    "/sessions/:id/events",
    { preHandler: auth },
    async (req, reply) => {
      const events = listSessionEvents(db, req.params.id);
      reply.send(events);
    },
  );
}
