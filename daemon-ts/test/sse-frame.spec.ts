import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { encodeFrame, publish, subscribe, subscriberCount, unsubscribe } from "../src/sse.js";
import type { SessionApi } from "../src/store.js";

/** Minimal fake standing in for `http.ServerResponse` in these unit tests --
 * only `write`/`on` are used by `sse.ts`. */
function makeFakeResponse(writeImpl: (chunk: string) => boolean = () => true) {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    write: (chunk: string) => writeImpl(chunk),
    on: (event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return res;
    },
    emit(event: string): void {
      for (const cb of listeners[event] ?? []) cb();
    },
  };
  return res as unknown as ServerResponse & { emit(event: string): void };
}

const SAMPLE_API: SessionApi = {
  sessionId: "s1",
  workspace: "cockpit",
  branch: "master",
  status: "running",
  taskSummary: "build the dashboard",
  currentTool: null,
  startedAt: "2026-07-21T12:00:00.000Z",
  lastActivityAt: "2026-07-21T12:00:01.000Z",
  endedAt: null,
  dismissedAt: null,
  source: "startup",
  pendingDecision: null,
};

describe("sse.ts encodeFrame (byte-exact framing)", () => {
  it("equals exactly `data: ` + compact JSON + `\\n\\n`", () => {
    const frame = encodeFrame(SAMPLE_API);
    expect(frame).toBe(`data: ${JSON.stringify(SAMPLE_API)}\n\n`);
  });

  it("contains exactly one `data:` line and no event:/id:/retry: field", () => {
    const frame = encodeFrame(SAMPLE_API);
    expect(frame.match(/data:/g)).toHaveLength(1);
    expect(frame).not.toMatch(/event:/);
    expect(frame).not.toMatch(/id:/);
    expect(frame).not.toMatch(/retry:/);
  });

  it("escapes an embedded newline in a string field to backslash-n, never a real line-feed byte", () => {
    const api: SessionApi = { ...SAMPLE_API, taskSummary: "line one\nline two" };
    const frame = encodeFrame(api);

    // Exactly one data: line -- an actual LF byte inside the JSON would
    // split it into a second (unprefixed) line, which the Tauri consumer's
    // raw \n\n splitter would then silently corrupt.
    expect(frame.match(/data:/g)).toHaveLength(1);
    // Only the trailing blank-line terminator contributes real LF bytes.
    expect((frame.match(/\n/g) ?? []).length).toBe(2);
    // The escaped form is present as the two ASCII characters backslash, n.
    expect(frame).toContain("line one\\nline two");
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("sse.ts publish/subscribe (connection registry)", () => {
  it("publish with zero subscribers is a no-op", () => {
    expect(() => publish(SAMPLE_API)).not.toThrow();
  });

  it("publish writes the encoded frame to every subscribed response", () => {
    const written: string[] = [];
    const res = makeFakeResponse((chunk) => {
      written.push(chunk);
      return true;
    });
    subscribe(res);
    publish(SAMPLE_API);
    expect(written).toEqual([encodeFrame(SAMPLE_API)]);
    unsubscribe(res);
  });

  it("a write returning false (backpressure) does not throw and does not block other subscribers", () => {
    const laggingWritten: string[] = [];
    const healthyWritten: string[] = [];
    const lagging = makeFakeResponse((chunk) => {
      laggingWritten.push(chunk);
      return false; // backpressured -- next publish() must drop-oldest, not throw
    });
    const healthy = makeFakeResponse((chunk) => {
      healthyWritten.push(chunk);
      return true;
    });

    subscribe(lagging);
    subscribe(healthy);

    expect(() => publish(SAMPLE_API)).not.toThrow();
    const second: SessionApi = { ...SAMPLE_API, status: "waiting-input" };
    expect(() => publish(second)).not.toThrow();

    // The lagging subscriber's write() was only invoked once (the initial
    // attempt that reported backpressure) -- the second frame replaced the
    // pending slot (drop-oldest) instead of being written directly.
    expect(laggingWritten).toEqual([encodeFrame(SAMPLE_API)]);
    // The healthy subscriber received both frames, unaffected by the other
    // subscriber's backpressure.
    expect(healthyWritten).toEqual([encodeFrame(SAMPLE_API), encodeFrame(second)]);

    unsubscribe(lagging);
    unsubscribe(healthy);
  });

  it("flushes the withheld pending frame on 'drain', dropping the older frame", () => {
    let allowWrite = false;
    const written: string[] = [];
    const res = makeFakeResponse((chunk) => {
      written.push(chunk);
      return allowWrite;
    });

    subscribe(res);
    publish(SAMPLE_API); // write returns false -> backpressured, frame recorded as written attempt
    const second: SessionApi = { ...SAMPLE_API, status: "waiting-input" };
    publish(second); // dropped-oldest: replaces the pending frame, no direct write

    expect(written).toEqual([encodeFrame(SAMPLE_API)]);

    allowWrite = true;
    (res as unknown as { emit(event: string): void }).emit("drain");

    // Only the newest (second) frame is flushed -- the first was dropped.
    expect(written).toEqual([encodeFrame(SAMPLE_API), encodeFrame(second)]);

    unsubscribe(res);
  });

  it("unsubscribe removes the response from the registry (subscriberCount reflects it)", () => {
    const before = subscriberCount();
    const res = makeFakeResponse();
    subscribe(res);
    expect(subscriberCount()).toBe(before + 1);
    unsubscribe(res);
    expect(subscriberCount()).toBe(before);
  });

  it("a write that throws does not propagate and does not affect other subscribers", () => {
    const throwing = makeFakeResponse(() => {
      throw new Error("socket destroyed");
    });
    const healthyWritten: string[] = [];
    const healthy = makeFakeResponse((chunk) => {
      healthyWritten.push(chunk);
      return true;
    });

    subscribe(throwing);
    subscribe(healthy);

    expect(() => publish(SAMPLE_API)).not.toThrow();
    expect(healthyWritten).toEqual([encodeFrame(SAMPLE_API)]);

    unsubscribe(throwing);
    unsubscribe(healthy);
  });
});
