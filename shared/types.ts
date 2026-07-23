/**
 * Shared cross-cutting type contracts for Claude Cockpit.
 *
 * These types are consumed by the frontend (Tauri webview) and mirror the
 * session/event model the WSL-hosted daemon persists and pushes. They are
 * the single source of truth for the shape of a "session" and its timeline
 * — do not redefine these ad hoc elsewhere.
 *
 * See SKELETON.md for the architectural decisions this file encodes.
 */

/**
 * Fixed daemon port. Locked per SKELETON.md: the daemon binds
 * `0.0.0.0:9427` inside WSL (not `127.0.0.1` — see Pitfall A in
 * 01-RESEARCH.md) so Windows' default NAT-mode localhost-forwarding proxy
 * can reach it from native-Windows and VS Code sessions, while WSL-origin
 * sessions reach it via ordinary same-host loopback.
 *
 * The daemon base URL as seen by any client (Windows-native, WSL-native, or
 * the Tauri Rust backend) is `http://127.0.0.1:9427`.
 */
export const COCKPIT_PORT = 9427;

/** Base URL every daemon client should target. */
export const COCKPIT_DAEMON_BASE_URL = `http://127.0.0.1:${COCKPIT_PORT}`;

/**
 * Live status of a Claude Code session, as derived from its hook event
 * stream (see 01-RESEARCH.md "Hook Payload → Session-State Mapping").
 *
 * - `running`            — actively working, not blocked on the user.
 * - `waiting-permission`  — a permission prompt is showing (Notification
 *   hook, permission-request variant).
 * - `waiting-input`       — Claude Code is idle, waiting on the user
 *   (Notification hook, idle variant).
 * - `done`                — the agent turn ended (Stop/SubagentStop); a
 *   response moment per D-05 — stays prominent until acted on or dismissed.
 */
export type SessionStatus =
  | "running"
  | "waiting-permission"
  | "waiting-input"
  | "done";

/**
 * Discriminates which hook-decision contract a {@link PendingDecision}
 * belongs to (03-RESEARCH.md Pattern 2/3/4):
 * - `permission`        — an ordinary `PreToolUse` allow/deny (this plan,
 *   03-01).
 * - `ask-user-question` — `AskUserQuestion`'s answer-injection contract
 *   (03-03).
 * - `plan-mode`          — the `PermissionRequest`/`ExitPlanMode` 3-way
 *   contract (03-05).
 */
export type DecisionKind = "permission" | "ask-user-question" | "plan-mode";

/**
 * The ONE general session-decision abstraction every response surface
 * (in-app card controls, the toast window) round-trips — see this phase's
 * `<assumption_delta_decision>` (03-01-PLAN.md): a single discriminated
 * union rather than three parallel ad-hoc code paths. The daemon owns the
 * single mapping `Decision + PendingDecision.kind -> hookSpecificOutput JSON`
 * (`buildHookDecisionOutput` in `daemon-ts/src/decisions.ts`). 03-01
 * implements the `approve`/`deny` variants end-to-end; 03-03 implements
 * `answer` (`AskUserQuestion`, ACT-02); the `plan-*` variants remain
 * reserved for 03-05.
 */
export type Decision =
  | { type: "approve" }
  | { type: "deny"; reason?: string }
  | { type: "answer"; answers: string[] }
  | { type: "plan-allow" }
  | { type: "plan-allow-accept-edits" }
  | { type: "plan-deny"; message?: string };

/** One selectable response option rendered by the card/toast for a pending decision. */
export interface PendingOption {
  label: string;
  description?: string;
  decision: Decision;
  /** True when selecting this option should reveal a free-text reason box (ACT-03, D-09) rather than submitting immediately. */
  revealReasonOnSelect?: boolean;
}

/**
 * The pending ask a held session is waiting on, surfaced on {@link Session}
 * so the card/toast can render it without a second round-trip. `null` means
 * the session is not currently holding a decision open.
 */
export interface PendingDecision {
  kind: DecisionKind;
  toolName: string | null;
  /**
   * Concise, opaque, length-bounded summary of the tool's input (e.g. the
   * Bash command string) — built via `condensedJsonSummary` (same discipline
   * used elsewhere in the ingest path). Never interpreted, only displayed
   * verbatim via plain text interpolation (T-01-05f). `null` when the
   * originating `PreToolUse` payload had no `tool_input` to summarize.
   */
  toolInputSummary: string | null;
  prompt: string;
  options: PendingOption[];
  /**
   * `true` when this `ask-user-question` decision's underlying question
   * accepts multiple selected options (03-03, ACT-02) — the card
   * accumulates clicked options and submits a single confirmed `answer`
   * carrying all selected labels, rather than submitting on the first
   * click. `undefined`/absent for `permission`-kind decisions (always
   * single-select Approve/Deny).
   */
  multiSelect?: boolean;
}

/**
 * A single Claude Code session, keyed by its stable `session_id` across the
 * session's whole lifecycle and across all three origin environments (WSL
 * shell, native Windows terminal, VS Code integrated terminal).
 */
export interface Session {
  /** Claude Code's own stable session identifier — the primary key. */
  sessionId: string;
  /** Working directory / repo root the session is running in (MON-02). */
  workspace: string;
  /** Git branch active in `workspace`, if resolvable (MON-02). */
  branch: string | null;
  /** Current derived status (MON-01). */
  status: SessionStatus;
  /** One-line summary derived from the session's first user prompt (D-08). */
  taskSummary: string | null;
  /** Name of the tool currently in flight, if `status` is `running`. */
  currentTool: string | null;
  /** ISO 8601 timestamp — when the session was first observed. */
  startedAt: string;
  /** ISO 8601 timestamp — most recent hook event for this session. */
  lastActivityAt: string;
  /** ISO 8601 timestamp — set when SessionEnd fires; null while active. */
  endedAt: string | null;
  /**
   * ISO 8601 timestamp — set when the user explicitly dismisses this
   * session from the active queue (D-06). Null means it is still active
   * (or, per D-07, rehydrated as unresolved after a restart).
   */
  dismissedAt: string | null;
  /** Which environment this session originated from. */
  source: "wsl" | "windows" | "vscode";
  /**
   * The pending ask this session is currently holding open (FND-04/ACT-01),
   * or `null` when nothing is held. Derived server-side from `status` +
   * `currentTool` — never persisted separately (daemon-ts/src/store.ts's
   * `getSessionApi`).
   */
  pendingDecision: PendingDecision | null;
}

/** Discriminates the kind of entry appearing in a session's timeline. */
export type TimelineEventKind =
  | "user_prompt"
  | "tool_use"
  | "tool_result"
  | "permission_request"
  | "notification"
  | "completion"
  | "error";

/**
 * One entry in a session's condensed/grouped timeline (D-09). Runs of
 * similar routine events (e.g. several tool calls in a row) may be
 * collapsed into a single grouped entry by the daemon before this type is
 * populated — grouping itself is a daemon-side concern, not part of this
 * contract.
 */
export interface TimelineEvent {
  kind: TimelineEventKind;
  /** Name of the tool involved, when `kind` is `tool_use` or `tool_result`. */
  toolName: string | null;
  /** Human-readable summary of the event, ready to render directly. */
  summary: string;
  /**
   * Errors are visible in the timeline only (D-10) — they never fire a
   * notification and never affect queue ordering (MON-05).
   */
  isError: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}
