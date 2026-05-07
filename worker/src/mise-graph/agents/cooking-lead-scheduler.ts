// Wave 8B Track A — brigade scheduler heuristic.
//
// PURE FUNCTION. No Date.now, no Math.random, no I/O. The CookingLeadAgent
// calls `tickScheduler` every ~10s on its alarm and applies the result via
// broadcast + assignment row writes. All inputs are explicit so the
// scheduler is trivially unit-testable.
//
// Algorithm
// ─────────
// 1. DAG-ready tasks: dependencies all completed, not in-flight, not done.
// 2. Eligible members: presence === "in_kitchen_idle" AND
//    skills[task.skill] >= task.skill_floor.
// 3. Equipment availability: a candidate is rejected if any of its equipment
//    is fully booked at `now_ms` (per current_equipment_claims) or if a
//    higher-scored sibling already in this batch claimed an exclusive slot.
// 4. Score every (task, member) pair via `scoreAssignment` (see
//    scheduler-scoring.ts):
//        + skill fit          (member.skills[skill] − skill_floor)
//        + critical path      bonus +0.5 if task is on the critical path
//        + DAG affinity       bonus +0.2 if member completed a parent
//        − churn penalty      −0.1 if member completed something < 30s ago
//        + passive batching   +0.3 for passive tasks (let them simmer in
//                             the background, don't burn a cook on them
//                             unless idle)
// 5. Greedy allocation: sort candidates by score desc; pick top-K up to
//    `max_concurrent_assignments`. Each member can take only ONE task per
//    tick. Each exclusive equipment slug can only be claimed once per tick.
// 6. Unassignable: DAG-ready tasks that produced ZERO candidates (no
//    eligible member). These need lead attention (skill swap, recipe
//    iteration, or "wait for a member to free up").
// 7. Completion checks: in-flight assignments whose
//    started_at_ms + (active_min + passive_min) * 60_000 < now_ms.

import type {
	BrigadeAssignmentDecision,
	BrigadeSchedulerInput,
	BrigadeSchedulerOutput,
	EquipmentClaimSnapshot,
	EquipmentDefSnapshot,
} from "./cooking-lead-types";
import type { TaskNode } from "../task-graph-types";
import {
	criticalPathTaskIds,
	scoreAssignment,
	type ScoringContext,
} from "./scheduler-scoring";

const STALE_MS_FALLBACK = 30 * 60 * 1000; // 30 min if task duration unknown
const DEFAULT_MAX_CONCURRENT = 4;
const MIN_ACCEPTABLE_SCORE = -0.5; // below this, treat as unassignable

/**
 * Tick the brigade scheduler. PURE — no I/O, no Date.now (caller injects
 * `now_ms`). Returns the decisions to broadcast/persist.
 */
export function tickScheduler(
	input: BrigadeSchedulerInput,
): BrigadeSchedulerOutput {
	const notes: string[] = [];

	// Validate input shape — fail soft.
	if (!input || !input.graph || !Array.isArray(input.graph.tasks)) {
		return {
			new_assignments: [],
			unassignable_tasks: [],
			ready_for_completion_check: [],
			notes: ["scheduler_skipped:no_graph"],
		};
	}
	if (!Array.isArray(input.members)) {
		return {
			new_assignments: [],
			unassignable_tasks: [],
			ready_for_completion_check: [],
			notes: ["scheduler_skipped:no_members"],
		};
	}

	const now_ms = input.now_ms;
	const max_concurrent = input.max_concurrent_assignments ?? DEFAULT_MAX_CONCURRENT;
	const equipment_claims = input.current_equipment_claims ?? [];
	const equipment_defs = input.equipment_defs ?? [];
	const recently_completed = input.recently_completed ?? [];
	const dag_neighbors = input.member_completed_dag_neighbors;

	notes.push(
		`tick: tasks=${input.graph.tasks.length} ` +
		`members=${input.members.length} ` +
		`completed=${input.completed_task_ids.size} ` +
		`in_flight=${input.in_flight_assignments.length} ` +
		`max=${max_concurrent}`,
	);

	// ── 1. DAG-ready tasks ─────────────────────────────────────────────
	const ready = readyTasks(input);
	notes.push(`ready_tasks=${ready.length}`);

	// ── 2. Pre-compute critical path for the bonus ──────────────────────
	const cp_ids = criticalPathTaskIds(input.graph);

	// Map for equipment def lookup. Default exclusive=true (safer).
	const def_by_slug = new Map<string, EquipmentDefSnapshot>();
	for (const d of equipment_defs) def_by_slug.set(d.slug, d);

	// Index existing claims by slug.
	const claims_by_slug = new Map<string, EquipmentClaimSnapshot[]>();
	for (const c of equipment_claims) {
		const arr = claims_by_slug.get(c.slug) ?? [];
		arr.push(c);
		claims_by_slug.set(c.slug, arr);
	}

	// Index recently-completed by member for fast churn lookup.
	const churn_by_member = new Map<string, number>();
	for (const r of recently_completed) {
		const prev = churn_by_member.get(r.member_id) ?? 0;
		if (r.completed_at_ms > prev) churn_by_member.set(r.member_id, r.completed_at_ms);
	}

	// ── 3. Build candidate pairs ───────────────────────────────────────
	interface Candidate {
		task: TaskNode;
		member_id: string;
		score: number;
		reason: string;
	}
	const candidates: Candidate[] = [];

	for (const task of ready) {
		// For each task collect *member* candidates that pass the gate.
		for (const m of input.members) {
			if (m.presence !== "in_kitchen_idle") continue;
			// supervision_only is a special slot — no skill floor.
			const conf = m.skills[task.skill] ?? 0;
			if (task.skill !== "supervision_only" && conf < task.skill_floor) continue;
			// Equipment available right now? (capacity-aware check)
			if (!equipmentAvailable(task, claims_by_slug, def_by_slug, now_ms)) {
				continue;
			}

			const ctx: ScoringContext = {
				task,
				member: m,
				is_on_critical_path: cp_ids.has(task.id),
				member_completed_neighbors: dag_neighbors?.get(m.member_id),
				member_last_completed_at_ms: churn_by_member.get(m.member_id),
				now_ms,
			};
			const { score, reason } = scoreAssignment(ctx);
			if (score < MIN_ACCEPTABLE_SCORE) continue;
			candidates.push({ task, member_id: m.member_id, score, reason });
		}
	}

	notes.push(`candidates=${candidates.length}`);

	// ── 4. Greedy allocation ───────────────────────────────────────────
	candidates.sort((a, b) => b.score - a.score);

	const assigned: BrigadeAssignmentDecision[] = [];
	const used_members = new Set<string>();
	const used_exclusive_eq = new Set<string>();
	// Track "shared" equipment usage in this tick so two simultaneous
	// claims on a shared slug don't exceed remaining capacity.
	const used_shared_eq = new Map<string, number>();
	const assigned_task_ids = new Set<string>();

	for (const c of candidates) {
		if (assigned.length >= max_concurrent) break;
		if (used_members.has(c.member_id)) continue;
		if (assigned_task_ids.has(c.task.id)) continue;

		// Equipment check against this batch's pending claims.
		let conflict = false;
		for (const slug of c.task.equipment) {
			const def = def_by_slug.get(slug);
			const exclusive = def ? def.exclusive : true;
			if (exclusive) {
				if (used_exclusive_eq.has(slug)) { conflict = true; break; }
			} else {
				const cap = def?.capacity ?? 1;
				const inUse = used_shared_eq.get(slug) ?? 0;
				const otherClaims = (claims_by_slug.get(slug) ?? [])
					.filter(cl => cl.start_ts <= now_ms && cl.end_ts > now_ms).length;
				if (inUse + otherClaims >= cap) { conflict = true; break; }
			}
		}
		if (conflict) continue;

		assigned.push({
			task_id: c.task.id,
			member_id: c.member_id,
			reason: c.reason,
			score: roundScore(c.score),
		});
		used_members.add(c.member_id);
		assigned_task_ids.add(c.task.id);
		for (const slug of c.task.equipment) {
			const def = def_by_slug.get(slug);
			const exclusive = def ? def.exclusive : true;
			if (exclusive) {
				used_exclusive_eq.add(slug);
			} else {
				used_shared_eq.set(slug, (used_shared_eq.get(slug) ?? 0) + 1);
			}
		}
	}

	notes.push(`assigned=${assigned.length}`);

	// ── 5. Unassignable: ready but no candidate generated ──────────────
	const candidate_task_ids = new Set(candidates.map(c => c.task.id));
	const unassignable: TaskNode[] = ready.filter(t => !candidate_task_ids.has(t.id));
	if (unassignable.length > 0) {
		notes.push(`unassignable=${unassignable.length}`);
	}

	// ── 6. Completion checks ───────────────────────────────────────────
	const ready_for_completion_check: string[] = [];
	const task_by_id = new Map<string, TaskNode>();
	for (const t of input.graph.tasks) task_by_id.set(t.id, t);

	for (const a of input.in_flight_assignments) {
		const startedAt = a.started_at_ms ?? a.assigned_at_ms;
		if (!startedAt) continue;
		const task = task_by_id.get(a.task_id);
		const expected_ms = task
			? Math.max(60_000, (task.active_min + task.passive_min) * 60_000)
			: STALE_MS_FALLBACK;
		if (now_ms - startedAt > expected_ms) {
			ready_for_completion_check.push(a.task_id);
		}
	}

	return {
		new_assignments: assigned,
		unassignable_tasks: unassignable,
		ready_for_completion_check,
		notes,
	};
}

/**
 * Helper Wave 8B + tests use: enumerate tasks whose dependencies are all
 * complete and that aren't already in-flight or completed.
 */
export function readyTasks(
	input: BrigadeSchedulerInput,
): BrigadeSchedulerInput["graph"]["tasks"] {
	const inFlight = new Set(input.in_flight_assignments.map(a => a.task_id));
	return input.graph.tasks.filter(t => {
		if (input.completed_task_ids.has(t.id)) return false;
		if (inFlight.has(t.id)) return false;
		return t.depends_on.every(dep => input.completed_task_ids.has(dep));
	});
}

// ─── Equipment availability ─────────────────────────────────────────────────
//
// "Right now" check at `now_ms`. A claim is occupying a slug iff
// `start_ts <= now_ms < end_ts`. For exclusive slugs any active claim
// blocks. For shared slugs we count active claims and compare to capacity.

function equipmentAvailable(
	task: TaskNode,
	claims_by_slug: Map<string, EquipmentClaimSnapshot[]>,
	def_by_slug: Map<string, EquipmentDefSnapshot>,
	now_ms: number,
): boolean {
	for (const slug of task.equipment) {
		const claims = claims_by_slug.get(slug);
		if (!claims || claims.length === 0) continue;
		const def = def_by_slug.get(slug);
		const exclusive = def ? def.exclusive : true;
		const capacity = def?.capacity ?? 1;
		let active = 0;
		for (const c of claims) {
			if (c.start_ts <= now_ms && c.end_ts > now_ms) active++;
		}
		if (exclusive && active >= 1) return false;
		if (!exclusive && active >= capacity) return false;
	}
	return true;
}

function roundScore(s: number): number {
	return Math.round(s * 1000) / 1000;
}
