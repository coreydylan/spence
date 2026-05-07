// Ripple solver: the engine that lets plans flow.
//
// A proposal expresses a user intent ("add hummus party Friday for 8",
// "move pizza night to Sunday", "we used all the mayo"). The solver computes
// both directions of the ripple:
//
//   ripple_up   — upstream events that need to change to support the new state
//                 (grocery items added, prep tasks scheduled, cook windows
//                  expanded). If an upstream event is locked (already shopped
//                  / cooked), the change routes to the next mutable event
//                  downstream from it.
//
//   ripple_down — downstream events that change because of the new state
//                 (leftover seeded into next-day lunch, future meals lose
//                 a reservation, future plans inherit projected inventory).
//
// The solver does NOT mutate ledger.ts. It mutates the plan object in
// memory, then runs the existing repair pass to compile + validate. Result
// is persisted as a row in mise_plan_proposals + a new revision.

import type { MiseGraphEnv } from "./types";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MiseSnackBox,
	MiseMealSlot,
	MisePlanComponentBatch,
	MisePlanTask,
} from "./planner";
import { saveMiseWeeklyPlan } from "./planner";
import { repairMisePlan, saveMiseRepairResult } from "./repair";
import { loadMiseFormulas } from "./ledger";
import { loadMiseObservations } from "./observations";
import { loadComposerContext } from "./composer-context";
import { composeMenuWithLlm, type ComposedMeal } from "./menu-composer";
import type { MeshClaudeEnv } from "./llm-bridge";

export type ProposalKind =
	| "add_meal"
	| "replace_meal"
	| "remove_meal"
	| "shorten_cook"
	| "move_event"
	| "audit_response"
	| "compose_window"
	| "user_edit"
	| "rollforward";

export type EventLockState = "mutable" | "in_flight" | "locked" | "released";

export interface ProposalIntent {
	kind: ProposalKind;
	intent_text?: string;
	target_event_id?: string | null;
	target_date?: string | null;
	target_slot?: MiseMealSlot | null;
	new_meal_request?: NewMealRequest;
	move_to_date?: string | null;
	move_to_time?: string | null;
	cook_max_minutes?: number | null;
	apply?: boolean;          // default true — apply immediately
}

export interface NewMealRequest {
	title?: string;
	format?: string;
	cuisine?: string[];
	people?: number;
	notes?: string;
}

export interface ProposalResult {
	id: string;
	plan_id: string;
	kind: ProposalKind;
	intent: string;
	status: "applied" | "draft" | "rejected";
	proposed_changes: ProposedChanges;
	ripple_up: RippleSet;
	ripple_down: RippleSet;
	conflicts: string[];
	repair_summary?: { initial_hard_errors: number; final_hard_errors: number; iterations: number; actions: number };
}

export interface ProposedChanges {
	added_meals: Array<{ id: string; date: string; slot: MiseMealSlot; title: string }>;
	removed_meals: Array<{ id: string; date: string; slot: MiseMealSlot; title: string }>;
	moved_events: Array<{ id: string; from_date: string; to_date: string; from_time?: string; to_time?: string }>;
	updated_components: Array<{ id: string; label: string; field: string; before: unknown; after: unknown }>;
}

export interface RippleSet {
	added_grocery_items: Array<{ name: string; qty?: number; unit?: string; routed_to?: string }>;
	added_prep_tasks: Array<{ component_id: string; label: string; date: string; reason: string }>;
	released_reservations: Array<{ event_id: string; component_id: string; reason: string }>;
	released_grocery_items: Array<{ name: string; reason: string }>;
	leftovers_routed: Array<{ from_meal_id: string; to_date: string; to_slot: MiseMealSlot }>;
	notes: string[];
}

export interface ApplyProposalContext {
	env: MiseGraphEnv;
	plan: MiseWeeklyPlanDraft;
	intent: ProposalIntent;
	lockMap: Map<string, EventLockState>;
}

export async function applyProposal(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft, intent: ProposalIntent): Promise<ProposalResult> {
	const lockMap = await loadEventLocks(env, plan.id);
	const ctx: ApplyProposalContext = { env, plan, intent, lockMap };

	const proposed: ProposedChanges = {
		added_meals: [],
		removed_meals: [],
		moved_events: [],
		updated_components: [],
	};
	const rippleUp: RippleSet = emptyRipple();
	const rippleDown: RippleSet = emptyRipple();
	const conflicts: string[] = [];

	switch (intent.kind) {
		case "add_meal":
			await applyAddMeal(ctx, proposed, rippleUp, rippleDown, conflicts);
			break;
		case "remove_meal":
			applyRemoveMeal(ctx, proposed, rippleUp, rippleDown, conflicts);
			break;
		case "replace_meal":
			await applyReplaceMeal(ctx, proposed, rippleUp, rippleDown, conflicts);
			break;
		case "move_event":
			applyMoveEvent(ctx, proposed, rippleUp, rippleDown, conflicts);
			break;
		case "shorten_cook":
			applyShortenCook(ctx, proposed, rippleUp, rippleDown, conflicts);
			break;
		default:
			conflicts.push(`Unhandled proposal kind: ${intent.kind}`);
	}

	// Run repair to absorb the proposal's changes into a valid ledger.
	const formulas = await loadMiseFormulas(env);
	const observations = await loadMiseObservations(env, plan.id);
	const repair = repairMisePlan(plan, { formulas, observations, max_iterations: 6 });
	const apply = intent.apply !== false;
	if (apply) {
		await saveMiseWeeklyPlan(env, repair.repaired_plan);
		await saveMiseRepairResult(env, repair);
	}

	const proposalId = slugId("proposal", plan.id, intent.kind, Date.now());
	const status: "applied" | "draft" = apply ? "applied" : "draft";

	if (apply) {
		await env.DB.prepare(`
			INSERT INTO mise_plan_proposals
			(id, plan_id, household_id, parent_revision_id, kind, intent, status,
			 proposed_changes_json, ripple_up_json, ripple_down_json,
			 conflict_log_json, meta_json, applied_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			proposalId,
			plan.id,
			plan.household_id,
			null,
			intent.kind,
			intent.intent_text || `${intent.kind}`,
			status,
			JSON.stringify(proposed),
			JSON.stringify(rippleUp),
			JSON.stringify(rippleDown),
			JSON.stringify(conflicts),
			JSON.stringify({ repair_summary: repair.summary, target_event_id: intent.target_event_id }),
		).run();
	}

	return {
		id: proposalId,
		plan_id: plan.id,
		kind: intent.kind,
		intent: intent.intent_text || `${intent.kind}`,
		status,
		proposed_changes: proposed,
		ripple_up: rippleUp,
		ripple_down: rippleDown,
		conflicts,
		repair_summary: repair.summary,
	};
}

async function applyAddMeal(ctx: ApplyProposalContext, proposed: ProposedChanges, rippleUp: RippleSet, rippleDown: RippleSet, conflicts: string[]): Promise<void> {
	const { plan, intent } = ctx;
	const date = stringValue(intent.target_date);
	const slot = intent.target_slot;
	if (!date || !slot) {
		conflicts.push("add_meal requires target_date + target_slot");
		return;
	}
	if (date < plan.start_date || date > plan.end_date) {
		conflicts.push(`target_date ${date} outside plan window ${plan.start_date}–${plan.end_date}`);
		return;
	}
	const mealRequest = intent.new_meal_request || {};
	const people = mealRequest.people || plan.people;

	// Compose the new meal via LLM if available, else use a deterministic stub.
	let composed: ComposedMeal | null = null;
	if (isMeshConfigured(ctx.env)) {
		composed = await composeSingleMeal(ctx, date, slot, mealRequest);
	}

	const mealId = slugId("meal", date, slot, mealRequest.title || mealRequest.format || "added", Date.now());
	const newMeal: MisePlanMeal = {
		id: mealId,
		date,
		slot,
		title: composed?.title || mealRequest.title || `${titleCase(slot)} on ${date}`,
		format: composed?.format || mealRequest.format || slot,
		component_ids: [],   // resolved below by mapping formula_ids → component_batch.id
		ingredient_names: [],
		source: "proposal_add_meal",
		notes: composed?.notes || (mealRequest.notes ? [mealRequest.notes] : []),
		people,
		cuisine: composed?.cuisine || mealRequest.cuisine || [],
		locked: false,
		raw_ingredients: composed?.raw_ingredients || [],
		method_summary: composed?.method_summary || null,
		lineage: composed?.lineage || [],
	};

	// Map composed.formula_ids → existing or newly-created component batches.
	const formulasUsed = composed?.formula_ids || [];
	for (const formulaId of formulasUsed) {
		const componentId = await ensureComponentForFormula(ctx, formulaId);
		if (componentId) newMeal.component_ids.push(componentId);
	}

	// Insert into plan: pick the right place.
	if (slot === "breakfast") {
		plan.breakfasts.push(newMeal);
	} else {
		let day = plan.meals_by_day.find(d => d.date === date);
		if (!day) {
			day = { date, day_index: plan.meals_by_day.length, meals: [] };
			plan.meals_by_day.push(day);
			plan.meals_by_day.sort((a, b) => a.date.localeCompare(b.date));
			plan.meals_by_day.forEach((d, i) => { d.day_index = i; });
		}
		day.meals.push(newMeal);
	}
	proposed.added_meals.push({ id: newMeal.id, date, slot, title: newMeal.title });

	// Ripple UP: each new component implies upstream prep + grocery additions.
	// Ripple is realized by the repair pass — it'll detect the new meal needs
	// component lots, schedule remakes/prep, and add grocery items.
	for (const ing of newMeal.raw_ingredients || []) {
		const groceryEvent = findGroceryEvent(ctx);
		if (groceryEvent && (ctx.lockMap.get(groceryEvent) ?? "mutable") === "mutable") {
			rippleUp.added_grocery_items.push({ name: ing.name, qty: ing.qty ?? undefined, unit: ing.unit ?? undefined, routed_to: groceryEvent });
		} else {
			// Locked grocery — route to a synthetic top-up note.
			rippleUp.added_grocery_items.push({ name: ing.name, qty: ing.qty ?? undefined, unit: ing.unit ?? undefined, routed_to: "needs_top_up_trip" });
			rippleUp.notes.push(`${ing.name} routed to top-up (main grocery already in_flight/locked)`);
		}
	}
	for (const fid of formulasUsed) {
		rippleUp.added_prep_tasks.push({ component_id: fid, label: fid, date, reason: `serving ${newMeal.title}` });
	}

	// Ripple DOWN: if leftover-friendly format, seed next-day lunch hint.
	if (slot === "dinner" && composed?.leftovers_to?.length) {
		for (const leftoverHint of composed.leftovers_to) {
			rippleDown.leftovers_routed.push({ from_meal_id: newMeal.id, to_date: leftoverHint.split(" ")[0] || date, to_slot: "lunch" });
		}
	}
}

function applyRemoveMeal(ctx: ApplyProposalContext, proposed: ProposedChanges, rippleUp: RippleSet, rippleDown: RippleSet, conflicts: string[]): void {
	const { plan, intent } = ctx;
	const targetId = stringValue(intent.target_event_id);
	if (!targetId) { conflicts.push("remove_meal requires target_event_id"); return; }
	let removed: MisePlanMeal | null = null;
	for (const day of plan.meals_by_day) {
		const idx = day.meals.findIndex(m => m.id === targetId);
		if (idx >= 0) {
			removed = day.meals[idx];
			day.meals.splice(idx, 1);
			break;
		}
	}
	if (!removed) {
		const idx = plan.breakfasts.findIndex(m => m.id === targetId);
		if (idx >= 0) {
			removed = plan.breakfasts[idx];
			plan.breakfasts.splice(idx, 1);
		}
	}
	if (!removed) { conflicts.push(`meal ${targetId} not found`); return; }
	proposed.removed_meals.push({ id: removed.id, date: removed.date, slot: removed.slot, title: removed.title });
	for (const componentId of removed.component_ids) {
		rippleUp.released_reservations.push({ event_id: removed.id, component_id: componentId, reason: "meal removed" });
	}
	for (const ing of removed.raw_ingredients || []) {
		rippleUp.released_grocery_items.push({ name: ing.name, reason: `no longer needed for ${removed.title}` });
	}
}

async function applyReplaceMeal(ctx: ApplyProposalContext, proposed: ProposedChanges, rippleUp: RippleSet, rippleDown: RippleSet, conflicts: string[]): Promise<void> {
	const { intent } = ctx;
	if (!intent.target_event_id) { conflicts.push("replace_meal requires target_event_id"); return; }
	// Capture original date/slot so add_meal can target them.
	const original = findMealById(ctx.plan, intent.target_event_id);
	if (!original) { conflicts.push(`meal ${intent.target_event_id} not found`); return; }
	applyRemoveMeal(ctx, proposed, rippleUp, rippleDown, conflicts);
	const merged: ProposalIntent = {
		...intent,
		kind: "add_meal",
		target_date: original.date,
		target_slot: original.slot,
	};
	const subCtx: ApplyProposalContext = { ...ctx, intent: merged };
	await applyAddMeal(subCtx, proposed, rippleUp, rippleDown, conflicts);
}

function applyMoveEvent(ctx: ApplyProposalContext, proposed: ProposedChanges, rippleUp: RippleSet, _rippleDown: RippleSet, conflicts: string[]): void {
	const { plan, intent } = ctx;
	const eventId = stringValue(intent.target_event_id);
	if (!eventId) { conflicts.push("move_event requires target_event_id"); return; }
	const newDate = stringValue(intent.move_to_date);
	if (!newDate) { conflicts.push("move_event requires move_to_date"); return; }
	const meal = findMealById(plan, eventId);
	if (meal) {
		const oldDate = meal.date;
		meal.date = newDate;
		// rebucket
		if (meal.slot !== "breakfast") {
			for (const day of plan.meals_by_day) {
				const idx = day.meals.findIndex(m => m.id === eventId);
				if (idx >= 0) day.meals.splice(idx, 1);
			}
			let newDay = plan.meals_by_day.find(d => d.date === newDate);
			if (!newDay) {
				newDay = { date: newDate, day_index: plan.meals_by_day.length, meals: [] };
				plan.meals_by_day.push(newDay);
				plan.meals_by_day.sort((a, b) => a.date.localeCompare(b.date));
				plan.meals_by_day.forEach((d, i) => { d.day_index = i; });
			}
			newDay.meals.push(meal);
		}
		proposed.moved_events.push({ id: eventId, from_date: oldDate, to_date: newDate });
		return;
	}
	// Future: also handle moving prep_tasks, grocery_trips
	conflicts.push(`move_event: only meal events supported in this build (${eventId})`);
	rippleUp.notes.push("prep + grocery moves coming next");
}

function applyShortenCook(ctx: ApplyProposalContext, proposed: ProposedChanges, rippleUp: RippleSet, _rippleDown: RippleSet, conflicts: string[]): void {
	const { intent } = ctx;
	const target = stringValue(intent.target_event_id);
	const max = intent.cook_max_minutes ?? null;
	if (!target || !max) { conflicts.push("shorten_cook requires target_event_id + cook_max_minutes"); return; }
	const task = ctx.plan.prep_tasks.find(t => t.id === target);
	if (!task) { conflicts.push(`prep task ${target} not found`); return; }
	if (task.active_time_min <= max) {
		conflicts.push(`task ${target} already ≤ ${max}min active`);
		return;
	}
	const before = task.active_time_min;
	const overflow = task.active_time_min - max;
	task.active_time_min = max;
	task.meta = { ...task.meta, shortened_at: new Date().toISOString(), shortened_overflow_min: overflow };
	proposed.updated_components.push({ id: target, label: task.title, field: "active_time_min", before, after: max });
	rippleUp.notes.push(`overflow ${overflow}min — repair will route to nearest mutable cook window`);
}

async function composeSingleMeal(ctx: ApplyProposalContext, date: string, slot: MiseMealSlot, request: NewMealRequest): Promise<ComposedMeal | null> {
	try {
		const formulas = await loadMiseFormulas(ctx.env);
		const formulaCatalog = Array.from(formulas.by_label.values());
		const constraintsRecord = (ctx.plan.constraints as Record<string, unknown> | undefined) || {};
		const dietary = parseStringList(constraintsRecord.dietary as unknown);
		const cuisine = request.cuisine || [];
		const context = await loadComposerContext(ctx.env, {
			anchors: ctx.plan.selected_ingredients,
			plan_dates: [date],
			household_id: ctx.plan.household_id,
			location_region: stringValue((constraintsRecord.location as Record<string, unknown> | undefined)?.region) || null,
			cuisine_direction: cuisine,
			per_section_limit: 12,
		});
		const composed = await composeMenuWithLlm(ctx.env as unknown as MeshClaudeEnv, {
			start_date: date,
			end_date: date,
			people_default: ctx.plan.people,
			prompt: ctx.intent.intent_text || null,
			cuisine_direction: cuisine,
			anchor_ingredients: ctx.plan.selected_ingredients,
			pantry: [],
			equipment: [],
			household_id: ctx.plan.household_id,
			dietary,
			slots: [{
				date,
				slot,
				people: request.people || ctx.plan.people,
				cuisine,
				format: request.format || null,
				title_hint: request.title || null,
				locked: false,
				notes: request.notes ? [request.notes] : [],
			}],
			formulas: formulaCatalog,
			context,
		});
		if (composed.ok && composed.meals.length > 0) return composed.meals[0];
	} catch {
		// fall through
	}
	return null;
}

async function ensureComponentForFormula(ctx: ApplyProposalContext, formulaId: string): Promise<string | null> {
	// First, look in the plan for an existing batch with this formula_id.
	for (const batch of ctx.plan.component_batches) {
		const meta = (batch.meta as Record<string, unknown> | undefined) || {};
		if (meta.formula_id === formulaId) return batch.id;
	}
	// Otherwise, create a new batch from the formula spec.
	const formulas = await loadMiseFormulas(ctx.env);
	const formula = Array.from(formulas.by_label.values()).find(f => f.id === formulaId);
	if (!formula) return null;
	const canonical = formula.output_canonical_name || formula.id.replace(/^mise_formula_/, "").replace(/_/g, " ");
	const componentId = `mise_component:${normalizeName(canonical).replace(/\s+/g, "_")}:proposal`;
	const newBatch: MisePlanComponentBatch = {
		id: componentId,
		state_id: formula.output_state_id,
		label: formula.output_label,
		quantity: formula.batch_qty,
		unit: formula.batch_unit,
		storage: "refrigerator",
		container: null,
		quality_window_hours: formula.shelf_life_hours_fridge ?? 96,
		planned_uses: [],
		station_tags: ["proposal"],
		equipment: formula.equipment,
		active_time_min: formula.active_time_min ?? 15,
		idle_time_min: formula.idle_time_min ?? 0,
		input_names: formula.inputs.map(i => i.canonical_name),
		meta: { source: "proposal", formula_id: formulaId, formula },
	};
	ctx.plan.component_batches.push(newBatch);
	// Add a placeholder prep task; repair will move it to the right date.
	const newTask: MisePlanTask = {
		id: `mise_task:proposal:${formulaId}:${Date.now()}`,
		scheduled_date: ctx.plan.start_date,
		session_order: 999,
		task_type: "component_batch",
		title: `Make ${formula.output_label} (proposal)`,
		station_tags: ["proposal"],
		equipment: formula.equipment,
		depends_on: [],
		state_inputs: [],
		state_outputs: [componentId],
		active_time_min: formula.active_time_min ?? 15,
		idle_time_min: formula.idle_time_min ?? 0,
		instructions: [],
		status: "planned",
		meta: { source: "proposal", component_id: componentId, formula_id: formulaId },
	};
	ctx.plan.prep_tasks.push(newTask);
	return componentId;
}

function findMealById(plan: MiseWeeklyPlanDraft, id: string): MisePlanMeal | null {
	for (const day of plan.meals_by_day) {
		const m = day.meals.find(meal => meal.id === id);
		if (m) return m;
	}
	return plan.breakfasts.find(m => m.id === id) || null;
}

function findGroceryEvent(ctx: ApplyProposalContext): string | null {
	for (const [eventId, lockState] of ctx.lockMap) {
		if (eventId.includes(":grocery:") && lockState === "mutable") return eventId;
	}
	return null;
}

async function loadEventLocks(env: MiseGraphEnv, planId: string): Promise<Map<string, EventLockState>> {
	const map = new Map<string, EventLockState>();
	try {
		const result = await env.DB.prepare("SELECT event_id, lock_state FROM mise_event_locks WHERE plan_id = ?").bind(planId).all<{ event_id: string; lock_state: string }>();
		for (const row of result.results || []) {
			map.set(row.event_id, (row.lock_state as EventLockState) || "mutable");
		}
	} catch {
		// table may not exist on first run
	}
	return map;
}

export async function setEventLock(env: MiseGraphEnv, planId: string, eventId: string, lockState: EventLockState, lockedBy?: string): Promise<void> {
	await env.DB.prepare(`
		INSERT OR REPLACE INTO mise_event_locks
		(event_id, plan_id, lock_state, locked_at, locked_by, meta_json)
		VALUES (?, ?, ?, datetime('now'), ?, ?)
	`).bind(eventId, planId, lockState, lockedBy || null, "{}").run();
}

function emptyRipple(): RippleSet {
	return {
		added_grocery_items: [],
		added_prep_tasks: [],
		released_reservations: [],
		released_grocery_items: [],
		leftovers_routed: [],
		notes: [],
	};
}

function isMeshConfigured(env: Partial<MeshClaudeEnv>): boolean {
	return !!env.MESH && !!env.BRIDGE_HOST && !!env.BRIDGE_PORT && !!env.BRIDGE_SECRET;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((i): i is string => typeof i === "string");
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed.filter((i): i is string => typeof i === "string");
		} catch { /* not JSON */ }
		return value.split(",").map(s => s.trim()).filter(Boolean);
	}
	return [];
}

function normalizeName(value: unknown): string {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function titleCase(value: string): string {
	return normalizeName(value).replace(/\b\w/g, char => char.toUpperCase());
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(part => String(part || "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}
