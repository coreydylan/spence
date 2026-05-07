// Shared summary / formatting helpers for the replan webhook. Kept apart from
// replan-events.ts so that file stays well under the 400-line budget.

import type { Mutation, RipplePreview } from "./ripple-preview";
import type { ReplanEvent, ReplanResult } from "./replan-events";

/**
 * Compose a 1-2 sentence natural-language summary of what an event did.
 * Template-based; intentionally LLM-free for now.
 */
export function composeHumanSummary(
	event: ReplanEvent,
	applied: boolean,
	summary: ReplanResult["ripple_summary"],
	dry: boolean,
): string {
	const verb = dry ? "would" : (applied ? "did" : "could not");
	const head = describeEvent(event, verb);
	const tail: string[] = [];
	if (summary.resolved_grievances > 0) tail.push(`${summary.resolved_grievances} grievance(s) resolved`);
	if (summary.new_grievances > 0) tail.push(`${summary.new_grievances} new grievance(s)`);
	if (summary.affected_meals > 0) tail.push(`${summary.affected_meals} meal(s) touched`);
	if (summary.affected_cooks > 0) tail.push(`${summary.affected_cooks} cook session(s) touched`);
	if (summary.affected_shop_items > 0) tail.push(`${summary.affected_shop_items} shopping item(s) changed`);
	return tail.length === 0 ? `${head}.` : `${head}: ${tail.join("; ")}.`;
}

function describeEvent(event: ReplanEvent, verb: string): string {
	switch (event.kind) {
		case "skip_meal":
			return `${verb} skip ${event.slot.date} ${event.slot.slot}` + (event.reason ? ` (${event.reason})` : "");
		case "add_meal":
			return `${verb} add a ${event.meal_proposal?.title || "TBD"} for ${event.slot.date} ${event.slot.slot}`;
		case "move_meal":
			return `${verb} move ${event.from.date} ${event.from.slot} → ${event.to.date} ${event.to.slot}`;
		case "cancel_cook":
			return `${verb} cancel cook session ${event.cook_id}`;
		case "move_cook":
			return `${verb} move cook ${event.cook_id} to ${event.new_date}`;
		case "skip_shop":
			return `${verb} skip shopping run ${event.run_id}`;
		case "move_shop":
			return `${verb} move shopping run ${event.run_id} to ${event.new_date}`;
		case "change_anchors": {
			const adds = (event.add || []).join(", ");
			const removes = (event.remove || []).join(", ");
			const parts: string[] = [];
			if (adds) parts.push(`add ${adds}`);
			if (removes) parts.push(`drop ${removes}`);
			return `${verb} ${parts.join(" and ") || "update"} the anchors`;
		}
		case "change_people":
			return `${verb} change headcount to ${event.new_count}`
				+ (event.for_dates?.length ? ` for ${event.for_dates.join(", ")}` : "");
		case "lock_slot":
			return `${verb} lock ${event.slot.date} ${event.slot.slot} (${event.reason})`;
		case "mark_cooked":
			return `${verb} mark ${event.slot.date} ${event.slot.slot} as cooked`;
		case "report_inventory":
			return `${verb} record ${event.items.length} pantry observation${event.items.length === 1 ? "" : "s"}`;
	}
}

/**
 * Build a degraded "no-op" preview for a mutation we don't dispatch. Lets the
 * caller treat it uniformly with real previews (zero deltas, single warning).
 */
export function makeSyntheticNoOp(mutation: Mutation, warnings: string[]): RipplePreview {
	return {
		proposed_change: mutation,
		affected_meals: [],
		affected_batches: [],
		affected_prep_tasks: [],
		affected_shopping: { added: [], removed: [], qty_changed: [], runs_changed: [] },
		affected_edges: { added: [], removed: [], status_changed: [] },
		new_grievances: [],
		resolved_grievances: [],
		scores: { waste_delta: 0, variety_delta: 0, effort_delta: 0, reuse_delta: 0, net_delta: 0 },
		cascade_proposals: [],
		reversible: true,
		warnings,
		proposal_id: `synthetic_noop_${Date.now().toString(36)}`,
	};
}

/**
 * Convenience: a fully-formed ReplanResult representing failure (e.g. plan
 * not found). Keeps replan-events.ts trim.
 */
export function makeFailureResult(
	plan_id: string,
	event: ReplanEvent,
	warnings: string[],
): ReplanResult {
	return {
		plan_id,
		event,
		applied: false,
		ripple_summary: {
			affected_meals: 0,
			affected_cooks: 0,
			affected_shop_items: 0,
			new_grievances: 0,
			resolved_grievances: 0,
		},
		details: { new_grievance_messages: [], resolved_grievance_messages: [] },
		warnings,
		human_summary: warnings[0] || "no-op",
	};
}
