// Wave 8B Track A — scheduler scoring helpers.
//
// Pure functions used by tickScheduler. Extracted into their own module so
// each weighting rule can be unit-tested in isolation without spinning up
// the full scheduler harness.
//
// Score composition (all additive):
//   skill_fit        = (member.skills[skill] - skill_floor)        ∈ [-floor, 1-floor]
//   critical_path    = +0.5 if task is on the critical path        ∈ {0, 0.5}
//   dag_affinity     = +0.2 if member completed an immediate parent ∈ {0, 0.2}
//   churn_penalty    = -0.1 if member completed task < CHURN_MS ago ∈ {0, -0.1}
//   passive_bonus    = +0.3 if task.kind === "passive"             ∈ {0, 0.3}
//
// Total range is roughly [-0.6, +1.5]. The scheduler's
// MIN_ACCEPTABLE_SCORE filter (-0.5) keeps only candidates whose
// skill fit is at least nearly meeting the floor.
//
// `supervision_only` tasks bypass the floor — confidence is treated as
// 1.0 in that branch so any present member can supervise.

import type { TaskGraph, TaskNode } from "../task-graph-types";
import type { BrigadeMember } from "./cooking-lead-types";

export const CHURN_WINDOW_MS = 30_000;            // 30 s breathing room
export const CRITICAL_PATH_BONUS = 0.5;
export const DAG_AFFINITY_BONUS = 0.2;
export const CHURN_PENALTY = -0.1;
export const PASSIVE_BONUS = 0.3;

export interface ScoringContext {
	task: TaskNode;
	member: BrigadeMember;
	is_on_critical_path: boolean;
	member_completed_neighbors?: ReadonlySet<string>;
	member_last_completed_at_ms?: number;
	now_ms: number;
}

export interface ScoredAssignment {
	score: number;
	reason: string;
}

export function scoreAssignment(ctx: ScoringContext): ScoredAssignment {
	const reasons: string[] = [];

	// Skill fit. supervision_only is special — a member with confidence 0
	// in some other skill can still safely supervise; we treat the fit as
	// flat 0.5 (neutral but positive) so scoring still differentiates by
	// the other bonuses.
	let skillFit: number;
	if (ctx.task.skill === "supervision_only") {
		skillFit = 0.5;
	} else {
		const conf = ctx.member.skills[ctx.task.skill] ?? 0;
		skillFit = conf - ctx.task.skill_floor;
	}
	reasons.push(`skill_fit=${formatFixed(skillFit)}`);

	let total = skillFit;

	if (ctx.is_on_critical_path) {
		total += CRITICAL_PATH_BONUS;
		reasons.push(`critical_path+${formatFixed(CRITICAL_PATH_BONUS)}`);
	}

	if (
		ctx.member_completed_neighbors &&
		ctx.task.depends_on.some(d => ctx.member_completed_neighbors!.has(d))
	) {
		total += DAG_AFFINITY_BONUS;
		reasons.push(`dag_affinity+${formatFixed(DAG_AFFINITY_BONUS)}`);
	}

	if (
		ctx.member_last_completed_at_ms !== undefined &&
		ctx.now_ms - ctx.member_last_completed_at_ms < CHURN_WINDOW_MS
	) {
		total += CHURN_PENALTY;
		reasons.push(`churn${formatFixed(CHURN_PENALTY)}`);
	}

	if (ctx.task.kind === "passive") {
		total += PASSIVE_BONUS;
		reasons.push(`passive+${formatFixed(PASSIVE_BONUS)}`);
	}

	return {
		score: total,
		reason: reasons.join(" "),
	};
}

// ─── Critical-path id set ───────────────────────────────────────────────────
//
// We re-derive the critical path inside the scheduler tick rather than rely
// on a pre-computed flag on TaskNode — the graph's `critical_path_min` is
// stored but the per-node flag is not. This implementation mirrors
// task-graph.ts#criticalPath but only returns the SET of ids on the path
// (no caller in the scheduler needs the full list with order). Pure DP, O(V+E).

export function criticalPathTaskIds(graph: TaskGraph): Set<string> {
	const byId = new Map<string, TaskNode>();
	for (const t of graph.tasks) byId.set(t.id, t);
	const order = topoSort(graph.tasks);
	const distance = new Map<string, number>();
	const predecessor = new Map<string, string | null>();

	for (const id of order) {
		const node = byId.get(id);
		if (!node) continue;
		const own = node.active_min + node.passive_min;
		let best = own;
		let bestPred: string | null = null;
		for (const dep of node.depends_on) {
			const prev = distance.get(dep);
			if (prev === undefined) continue;
			const candidate = prev + own;
			if (candidate > best) {
				best = candidate;
				bestPred = dep;
			}
		}
		distance.set(id, best);
		predecessor.set(id, bestPred);
	}

	let endId: string | null = null;
	let endDist = -1;
	for (const [id, dist] of distance) {
		if (dist > endDist) {
			endDist = dist;
			endId = id;
		}
	}
	const cp = new Set<string>();
	if (!endId) return cp;
	let cursor: string | null = endId;
	while (cursor && !cp.has(cursor)) {
		cp.add(cursor);
		cursor = predecessor.get(cursor) ?? null;
	}
	return cp;
}

// ─── topological sort (local copy to keep this module dependency-free) ─────
function topoSort(tasks: TaskNode[]): string[] {
	const indeg = new Map<string, number>();
	const byId = new Map<string, TaskNode>();
	for (const t of tasks) {
		byId.set(t.id, t);
		indeg.set(t.id, 0);
	}
	for (const t of tasks) {
		for (const dep of t.depends_on) {
			if (!byId.has(dep)) continue;
			indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
		}
	}
	const queue: string[] = [];
	for (const [id, deg] of indeg) if (deg === 0) queue.push(id);
	queue.sort((a, b) => {
		const ai = byId.get(a)?.step_idx ?? 0;
		const bi = byId.get(b)?.step_idx ?? 0;
		return ai - bi;
	});

	const order: string[] = [];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const next = queue.shift()!;
		if (visited.has(next)) continue;
		visited.add(next);
		order.push(next);
		for (const t of tasks) {
			if (t.depends_on.includes(next)) {
				indeg.set(t.id, (indeg.get(t.id) ?? 1) - 1);
				if ((indeg.get(t.id) ?? 0) === 0 && !visited.has(t.id)) {
					queue.push(t.id);
				}
			}
		}
		queue.sort((a, b) => {
			const ai = byId.get(a)?.step_idx ?? 0;
			const bi = byId.get(b)?.step_idx ?? 0;
			return ai - bi;
		});
	}
	for (const t of tasks) if (!visited.has(t.id)) order.push(t.id);
	return order;
}

function formatFixed(n: number): string {
	const s = n.toFixed(2);
	return n >= 0 ? s : s; // sign already in negative numbers
}
