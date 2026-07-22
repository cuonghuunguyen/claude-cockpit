import { describe, expect, it } from "vitest";
import {
  buildDecisionPayload,
  decisionDetailText,
  shouldClearOptimisticDecision,
} from "./SessionCard";
import type { PendingDecision } from "../../shared/types";

describe("buildDecisionPayload (ACT-01/ACT-03 decision-payload construction)", () => {
  it("approve always yields { type: 'approve' } with no other keys", () => {
    const payload = buildDecisionPayload("approve");
    expect(payload).toEqual({ type: "approve" });
    expect(Object.keys(payload)).toEqual(["type"]);
  });

  it("approve ignores any reason argument", () => {
    const payload = buildDecisionPayload("approve", "ignored");
    expect(payload).toEqual({ type: "approve" });
  });

  it("deny with a non-blank reason yields { type: 'deny', reason } (trimmed)", () => {
    const payload = buildDecisionPayload("deny", "  looks risky  ");
    expect(payload).toEqual({ type: "deny", reason: "looks risky" });
  });

  it("deny with an absent reason omits the reason key entirely", () => {
    const payload = buildDecisionPayload("deny");
    expect(payload).toEqual({ type: "deny" });
    expect(Object.keys(payload)).toEqual(["type"]);
    expect("reason" in payload).toBe(false);
  });

  it("deny with a whitespace-only reason omits the reason key entirely (never an empty string)", () => {
    const payload = buildDecisionPayload("deny", "   ");
    expect(payload).toEqual({ type: "deny" });
    expect("reason" in payload).toBe(false);
  });

  it("deny with an empty-string reason omits the reason key entirely", () => {
    const payload = buildDecisionPayload("deny", "");
    expect(payload).toEqual({ type: "deny" });
    expect("reason" in payload).toBe(false);
  });
});

describe("decisionDetailText (defect-B fix: card must show WHICH tool/command is pending)", () => {
  function makePending(overrides: Partial<PendingDecision> = {}): PendingDecision {
    return {
      kind: "permission",
      toolName: "Bash",
      toolInputSummary: '{"command":"rm -rf /tmp/x"}',
      prompt: "Approve Bash?",
      options: [],
      ...overrides,
    };
  }

  it("returns null when there is no pending decision", () => {
    expect(decisionDetailText(null)).toBeNull();
  });

  it("returns null for a non-permission pending decision kind", () => {
    expect(decisionDetailText(makePending({ kind: "ask-user-question" }))).toBeNull();
  });

  it("joins toolName and toolInputSummary as 'toolName: summary' when both are present", () => {
    expect(decisionDetailText(makePending())).toBe('Bash: {"command":"rm -rf /tmp/x"}');
  });

  it("falls back to toolName alone when toolInputSummary is null", () => {
    expect(decisionDetailText(makePending({ toolInputSummary: null }))).toBe("Bash");
  });

  it("falls back to toolInputSummary alone when toolName is null", () => {
    expect(decisionDetailText(makePending({ toolName: null }))).toBe(
      '{"command":"rm -rf /tmp/x"}',
    );
  });

  it("returns null when neither toolName nor toolInputSummary is present", () => {
    expect(decisionDetailText(makePending({ toolName: null, toolInputSummary: null }))).toBeNull();
  });
});

describe("shouldClearOptimisticDecision (fixes: card stuck at 'Approved — unblocking…' + Done badge forever)", () => {
  const livePendingDecision: PendingDecision = {
    kind: "permission",
    toolName: "Bash",
    toolInputSummary: '{"command":"rm -rf /tmp/x"}',
    prompt: "Approve Bash?",
    options: [],
  };

  it("returns true once the daemon reports no pending decision (hold consumed/timed out/dismissed)", () => {
    expect(shouldClearOptimisticDecision(null)).toBe(true);
  });

  it("returns false while a pending decision is still live for this session", () => {
    expect(shouldClearOptimisticDecision(livePendingDecision)).toBe(false);
  });
});
