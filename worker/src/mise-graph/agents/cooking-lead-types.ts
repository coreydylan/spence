// Wave 8 foundation — CookingLeadAgent type contracts.
//
// CookingLeadAgent is the ephemeral DO spawned at MealAgent.active_cook to run
// brigade-mode cooking. It owns:
//   - per-phone WebSocket sessions (multiplexed across household members)
//   - a scheduler tick that consumes the meal's task graph + member presence
//     and emits per-member assignments
//   - an append-only event log replayed for debug + observability
//
// Wave 8B fills in the heuristics (assignment scoring, photo flow, recipe
// iteration). Wave 8 (this layer) just locks the contract shapes so nothing
// downstream has to reshape data.
//
// The contracts in this file are **load-bearing**: the iOS phone client, the
// Wave 8B scheduler, the photo capture endpoint, and the event log replay UI
// all serialize against these shapes. Don't churn them.

import type { TaskGraph, TaskNode } from "../task-graph-types";

// ─── Lifecycle state ────────────────────────────────────────────────────────

/**
 * Brigade session lifecycle. Mirrors the D1 `mise_cook_sessions.status`
 * column for the "Wave 8" rows; the legacy rows continue to use the
 * `state` column with values "started"|"stale"|"ended".
 */
export type BrigadeStatus =
	| "planned"     // session row exists, DO not yet started
	| "active"     // DO is running, members can connect
	| "completed"  // session ended cleanly
	| "abandoned"; // session closed without completion (e.g. 4h timeout)

// ─── DO state shape ─────────────────────────────────────────────────────────

/**
 * Hibernation-safe state for a CookingLeadAgent. Kept small — the heavy
 * data (assignments, events, photos) lives in embedded SQLite so the DO
 * can hibernate cheaply.
 */
export interface CookingLeadState {
	cook_session_id: string;
	meal_id: string;
	plan_id: string;
	household_id: string | null;
	status: BrigadeStatus;
	started_at_ms: number | null;
	completed_at_ms: number | null;
	last_tick_at_ms: number | null;
	expected_duration_min: number;
	task_graph_id: string | null;
	// Wave 8B will hydrate the graph into memory from D1; foundation just
	// records the id so the scheduler can find it.

	// ─── Wave 8B Track C — manual control ─────────────────────────────
	/**
	 * When true, the scheduler tick is a no-op (still re-arms, but emits
	 * zero new assignments). Used by lead/admin to freeze the brigade
	 * mid-cook (e.g. for a debrief / safety pause). Resume flips it back.
	 */
	paused?: boolean;
	paused_at_ms?: number | null;
	last_pause_reason?: string | null;
}

// ─── Brigade message envelope (DO ↔ phone) ──────────────────────────────────
//
// Every message exchanged over the WebSocket is JSON with a discriminator
// `kind`. Two flavours exist:
//   * INBOUND  — phone → DO  (e.g. "task_complete", "photo_uploaded")
//   * OUTBOUND — DO → phone  (e.g. "task_assigned", "phase_progress")
// Both share the same envelope shape so a generic listener can route by
// `kind` without per-direction branches.

export interface BrigadeEnvelope {
	kind: BrigadeMessageKind;
	emitted_at_ms: number;
	cook_session_id: string;
	member_id?: string;
	correlation_id?: string;
	// Free-form payload. Each `kind` documents its expected shape below.
	data?: Record<string, unknown>;
}

export type BrigadeMessageKind =
	// Outbound (DO → phone)
	| "welcome"                // first message after WS connect; echoes session id + member id
	| "task_assigned"          // new task pushed to a specific member
	| "task_unassigned"        // assignment retracted (e.g. member stepped away)
	| "phase_progress"         // brigade-wide progress update (X of Y tasks done)
	| "recipe_iteration_suggested" // vision flow suggested a tweak
	| "lead_message"           // free-text lead-agent prompt for the cook
	| "session_ended"          // DO is wrapping up; final state attached
	// Inbound (phone → DO)
	| "hello"                  // optional handshake; phone announces app version
	| "presence_update"        // in_kitchen_idle / busy_assigned / stepped_away
	| "task_started"           // member began the task they were assigned
	| "task_completed"         // member finished a task (with notes / outcome)
	| "task_help_requested"    // member is stuck and wants reassignment / advice
	| "photo_uploaded"         // member sent a photo (R2 key in payload)
	| "ping";                  // keepalive

export type BrigadeMessage = BrigadeEnvelope;

// ─── Event log shapes (D1 mise_brigade_events + DO sqlite lead_events) ──────
//
// Append-only. Two stores:
//   * D1.mise_brigade_events — durable replay across sessions, queryable
//     by cook_session_id. Used by the timeline UI.
//   * DO.lead_events — fast in-DO read for the scheduler tick + recovery.
//
// The kinds below are stable. Wave 8B may add new kinds — DO NOT renumber
// existing ones.

export type BrigadeEventKind =
	| "session_initialized"
	| "session_started"
	| "session_completed"
	| "session_abandoned"
	| "member_joined"
	| "member_left"
	| "task_assigned"
	| "task_started"
	| "task_completed"
	| "task_unassigned"
	| "task_help_requested"
	| "photo_uploaded"
	| "vision_response_received"
	| "recipe_iteration_suggested"
	| "phase_progress"
	| "scheduler_tick";

export interface BrigadeEvent {
	id: string;
	cook_session_id: string;
	kind: BrigadeEventKind;
	member_id: string | null;
	payload: Record<string, unknown>;
	emitted_at_ms: number;
}

// ─── Task assignment shape ──────────────────────────────────────────────────

export type TaskAssignmentOutcome =
	| "succeeded"
	| "abandoned"
	| "reassigned"
	| "skipped"
	| "failed";

export interface TaskAssignmentRow {
	task_id: string;
	member_id: string;
	assigned_at_ms: number;
	started_at_ms: number | null;
	completed_at_ms: number | null;
	outcome: TaskAssignmentOutcome | null;
}

// ─── Photo upload shape ─────────────────────────────────────────────────────

export interface PhotoUploadRow {
	id: string;
	member_id: string;
	task_id: string | null;
	r2_key: string | null;
	uploaded_at_ms: number;
	vision_response: Record<string, unknown> | null;
	vision_response_at_ms: number | null;
}

// ─── Token grant API ────────────────────────────────────────────────────────
//
// One-time, member-bound, short-lived. The token is the single piece of
// auth the phone uses to upgrade the WS — it carries no other context.

export const BRIGADE_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface GrantTokenRequest {
	cook_session_id: string;
	member_id: string;
}

export interface GrantTokenResponse {
	token: string;
	expires_at_ms: number;
	cook_session_id: string;
	member_id: string;
}

export interface VerifyTokenSuccess {
	ok: true;
	cook_session_id: string;
	member_id: string;
}

export interface VerifyTokenFailure {
	ok: false;
	reason: "missing" | "not_found" | "consumed" | "expired" | "session_mismatch";
}

export type VerifyTokenResult = VerifyTokenSuccess | VerifyTokenFailure;

// ─── Scheduler input/output (mirrors cooking-lead-scheduler.ts contract) ────
//
// Re-exported here so the Wave 8B implementer can change the scheduler
// internals without touching the DO contract. The runtime of the scheduler
// lives in cooking-lead-scheduler.ts.

export interface BrigadeMember {
	member_id: string;
	skills: Partial<Record<string, number>>;
	presence: "absent" | "in_kitchen_idle" | "busy_assigned" | "stepped_away" | "unknown";
	current_task_id?: string;
	current_task_started_at_ms?: number;
}

export interface InFlightAssignment {
	task_id: string;
	member_id: string;
	started_at_ms: number | null;
	assigned_at_ms: number;
}

export interface BrigadeSchedulerInput {
	graph: TaskGraph;
	members: BrigadeMember[];
	completed_task_ids: ReadonlySet<string>;
	in_flight_assignments: ReadonlyArray<InFlightAssignment>;
	now_ms: number;

	// ── Wave 8B additive inputs ─────────────────────────────────────────
	// All of the following are optional. The DO populates them from D1
	// + embedded SQLite at tick time. Older callers that omit them get
	// safe defaults (no equipment conflicts, no churn penalty, no DAG
	// affinity bonus, capacity = 4).

	/**
	 * Equipment claims currently held — used to detect conflicts before
	 * pinning a member to a task that needs busy hardware. The scheduler
	 * itself does NOT acquire claims; it merely refuses to assign a task
	 * whose equipment is fully booked at `now_ms`.
	 */
	current_equipment_claims?: ReadonlyArray<EquipmentClaimSnapshot>;

	/**
	 * Equipment definitions (capacity / exclusivity). Slugs not present in
	 * this list default to exclusive (capacity 1) — the safer assumption.
	 */
	equipment_defs?: ReadonlyArray<EquipmentDefSnapshot>;

	/**
	 * Members who completed a task in the recent past — used to apply a
	 * small churn penalty so a single member doesn't get pinned to back-
	 * to-back tasks without breathing room. Recency is < 30s by convention.
	 */
	recently_completed?: ReadonlyArray<RecentlyCompleted>;

	/**
	 * Per-member set of completed task ids, used for DAG-affinity bonus:
	 * if member M completed a parent of task T, prefer M for T.
	 */
	member_completed_dag_neighbors?: ReadonlyMap<string, ReadonlySet<string>>;

	/**
	 * Maximum number of new assignments to emit per tick. Caps brigade
	 * churn: even if 12 tasks are ready, we only push 4 in one go.
	 */
	max_concurrent_assignments?: number;
}

export interface EquipmentClaimSnapshot {
	slug: string;
	start_ts: number;
	end_ts: number;
	claim_for_id: string;
}

export interface EquipmentDefSnapshot {
	slug: string;
	exclusive: boolean;
	capacity?: number;
}

export interface RecentlyCompleted {
	task_id: string;
	member_id: string;
	completed_at_ms: number;
}

export interface BrigadeAssignmentDecision {
	task_id: string;
	member_id: string;
	reason: string;
	score?: number;
}

export interface BrigadeSchedulerOutput {
	new_assignments: BrigadeAssignmentDecision[];
	unassignable_tasks: TaskNode[];
	ready_for_completion_check: string[];
	notes: string[];
}
