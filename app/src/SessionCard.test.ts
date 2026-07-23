import { describe, expect, it } from "vitest";
import {
  buildAnswerDecision,
  buildDecisionPayload,
  decisionDetailText,
  decisionWithReason,
  shouldClearOptimisticDecision,
  toggleSelectedLabel,
} from "./SessionCard";
import type { Decision, PendingDecision, PendingOption } from "../../shared/types";

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

describe("toggleSelectedLabel (Task 3, ACT-02: multiSelect accumulation)", () => {
  it("adds a label not yet selected, preserving prior order", () => {
    expect(toggleSelectedLabel(["React"], "Svelte")).toEqual(["React", "Svelte"]);
  });

  it("removes a label that is already selected", () => {
    expect(toggleSelectedLabel(["React", "Svelte"], "React")).toEqual(["Svelte"]);
  });

  it("starting from empty, a single click selects exactly that label", () => {
    expect(toggleSelectedLabel([], "React")).toEqual(["React"]);
  });
});

describe("buildAnswerDecision (Task 3, ACT-02: multiSelect confirm payload)", () => {
  it("wraps the accumulated labels in an { type: 'answer', answers } Decision", () => {
    expect(buildAnswerDecision(["React", "Svelte"])).toEqual({
      type: "answer",
      answers: ["React", "Svelte"],
    });
  });

  it("a single-label array yields a single-element answers array (not comma-joined client-side)", () => {
    expect(buildAnswerDecision(["React"])).toEqual({ type: "answer", answers: ["React"] });
  });
});

describe("decisionWithReason (D-09 pattern, generalized for the generic option renderer)", () => {
  it("merges a trimmed reason into a deny Decision", () => {
    const decision: Decision = { type: "deny" };
    expect(decisionWithReason(decision, "  not now  ")).toEqual({ type: "deny", reason: "not now" });
  });

  it("omits the reason key on a deny Decision when the text is blank", () => {
    const decision: Decision = { type: "deny" };
    expect(decisionWithReason(decision, "   ")).toEqual({ type: "deny" });
  });

  it("merges a trimmed reason into a plan-deny Decision's message field", () => {
    const decision: Decision = { type: "plan-deny" };
    expect(decisionWithReason(decision, " keep planning ")).toEqual({
      type: "plan-deny",
      message: "keep planning",
    });
  });

  it("returns an answer Decision unchanged (no reason field to merge into)", () => {
    const decision: Decision = { type: "answer", answers: ["Fast"] };
    expect(decisionWithReason(decision, "ignored")).toEqual({ type: "answer", answers: ["Fast"] });
  });
});

describe("generic option rendering data shape (Task 3, D-11: an option click submits its carried Decision)", () => {
  function makeAskUserQuestionPending(overrides: Partial<PendingDecision> = {}): PendingDecision {
    return {
      kind: "ask-user-question",
      toolName: null,
      toolInputSummary: null,
      prompt: "Which approach should we take?",
      options: [
        { label: "Fast", description: "Ship quickly", decision: { type: "answer", answers: ["Fast"] } },
        { label: "Careful", description: "Take more time", decision: { type: "answer", answers: ["Careful"] } },
      ],
      multiSelect: false,
      ...overrides,
    };
  }

  it("a single-select option's carried decision is exactly what a click submits (no client-side derivation)", () => {
    const pending = makeAskUserQuestionPending();
    const clicked = pending.options[0] as PendingOption;
    expect(clicked.decision).toEqual({ type: "answer", answers: ["Fast"] });
  });

  it("a multiSelect confirm submits buildAnswerDecision(selectedLabels), not any single option's carried decision", () => {
    const pending = makeAskUserQuestionPending({ multiSelect: true });
    let selected: string[] = [];
    for (const label of ["Fast", "Careful"]) {
      selected = toggleSelectedLabel(selected, label);
    }
    expect(pending.options.map((o) => o.label)).toEqual(["Fast", "Careful"]);
    expect(buildAnswerDecision(selected)).toEqual({ type: "answer", answers: ["Fast", "Careful"] });
  });
});
