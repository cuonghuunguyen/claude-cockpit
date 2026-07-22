import { describe, expect, it } from "vitest";
import { buildDecisionPayload } from "./SessionCard";

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
