/**
 * `GET /events` byte-exact SSE encoder + connection registry (MON-04).
 *
 * Port of `daemon/src/events_sse.rs` (43 lines). Rust modeled fan-out with a
 * `tokio::sync::broadcast::Sender<String>` because multiple async tasks (one
 * per `/events` connection) needed independently-paced reads with a
 * "lagged consumer drops frames" policy. Node's single-threaded event loop
 * needs no channel type for that: a plain `Set<ServerResponse>` registry,
 * drained by a synchronous `for` loop on every mutation, reproduces the same
 * fan-out -- and a per-subscriber drop-oldest queue (below) reproduces the
 * broadcast channel's "a lagging receiver drops missed frames rather than
 * blocking the sender" policy (RESEARCH.md Pattern 2; `events_sse.rs` lines
 * 32-39's `filter_map` swallowing `Err(_lagged)`).
 *
 * The frame format is the single highest-risk excerpt in this phase: the
 * unchanged Tauri consumer (`app/src-tauri/src/daemon_client.rs::emit_sse_frame`)
 * is a raw byte-level `\n\n` splitter that only recognizes a literal `data:`
 * prefix -- no `event:`/`id:`/`retry:` field may ever appear, and this file
 * must never depend on an SSE framework plugin (RESEARCH.md Don't Hand-Roll,
 * Anti-Patterns).
 */

import type { ServerResponse } from "node:http";
import type { SessionApi } from "./store.js";

interface SubscriberState {
  /**
   * The single most-recent frame withheld from a backpressured subscriber.
   * A newer `publish()` call overwrites (never appends to) this slot --
   * drop-oldest, matching the Rust broadcast channel's "a lagging receiver
   * loses missed frames, it does not fall further and further behind".
   */
  pendingFrame: string | null;
  /** True from the moment `res.write()` returns `false` until the next `'drain'`. */
  backpressured: boolean;
}

const subscribers = new Set<ServerResponse>();
const stateByResponse = new WeakMap<ServerResponse, SubscriberState>();

/**
 * `data: <compact-JSON>\n\n` -- exactly one `data: ` line (single space
 * after the colon), blank-line terminated, no `event:`/`id:`/`retry:` field.
 * `JSON.stringify` escapes any control character (including a literal
 * newline inside a string field) into the two ASCII characters `\` `n`,
 * never an actual line-feed byte -- so a payload can never accidentally
 * inject a second frame boundary into the stream.
 */
export function encodeFrame(api: SessionApi): string {
  return `data: ${JSON.stringify(api)}\n\n`;
}

/**
 * Registers `res` as an `/events` subscriber and arms its `'drain'` handler
 * (flushes a withheld frame once the underlying socket buffer clears).
 * Idempotent for the same `res` (Set/WeakMap keys are reference-identity).
 */
export function subscribe(res: ServerResponse): void {
  subscribers.add(res);
  if (!stateByResponse.has(res)) {
    stateByResponse.set(res, { pendingFrame: null, backpressured: false });
  }
  res.on("drain", () => flushPending(res));
}

/** Removes `res` from the subscriber registry (call on client disconnect). */
export function unsubscribe(res: ServerResponse): void {
  subscribers.delete(res);
}

/** Number of currently-registered subscribers -- test/diagnostic seam. */
export function subscriberCount(): number {
  return subscribers.size;
}

function writeFrame(res: ServerResponse, state: SubscriberState, frame: string): void {
  let ok = true;
  try {
    ok = res.write(frame);
  } catch {
    // A write throwing (e.g. a socket already torn down) must never affect
    // any other subscriber -- swallow it and rely on the route's 'close'
    // handler to unsubscribe() this one.
    return;
  }
  state.backpressured = !ok;
}

function flushPending(res: ServerResponse): void {
  const state = stateByResponse.get(res);
  if (!state || !subscribers.has(res)) {
    return;
  }
  state.backpressured = false;
  const frame = state.pendingFrame;
  if (frame !== null) {
    state.pendingFrame = null;
    writeFrame(res, state, frame);
  }
}

/**
 * Publishes `api` as one SSE frame to every open subscriber. A subscriber
 * currently backpressured (its last `res.write()` returned `false`) is not
 * written to directly -- the newest frame simply replaces whatever frame was
 * already withheld for it (drop-oldest), to be flushed on the next
 * `'drain'`. Zero subscribers is a valid no-op, mirroring
 * `ingest/mod.rs::publish_session_update`'s best-effort `Sender::send`
 * (which errors only on zero receivers -- an error this daemon never
 * surfaces to its caller).
 */
export function publish(api: SessionApi): void {
  const frame = encodeFrame(api);
  for (const res of subscribers) {
    const state = stateByResponse.get(res);
    if (!state) {
      continue;
    }
    if (state.backpressured) {
      state.pendingFrame = frame;
      continue;
    }
    writeFrame(res, state, frame);
  }
}
