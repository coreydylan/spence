import {
	compileMisePlanLedger,
	EMPTY_FORMULA_INDEX,
	saveMiseLedgerCompile,
	type MiseFormulaIndex,
	type MiseLedgerCompileResult,
	type MisePlanLedgerEvent,
	type MiseValidationIssue,
} from "./ledger";
import {
	saveMiseWeeklyPlan,
	type MiseMealSlot,
	type MisePlanComponentBatch,
	type MisePlanMeal,
	type MisePlanTask,
	type MiseSnackBox,
	type MiseWeeklyPlanDraft,
} from "./planner";
import { getEntityLock, isLocked } from "./locks";
import type { MiseGraphEnv } from "./types";

export interface MiseRepairOptions {
	max_iterations?: number;
	formulas?: MiseFormulaIndex;
	observations?: import("./observations").MiseObservation[];
}

export interface MiseRepairAction {
	id: string;
	type: string;
	issue_type: string | null;
	severity: string | null;
	event_id: string | null;
	component_id: string | null;
	resource_lot_id: string | null;
	title: string;
	detail: string;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
}

export interface MiseRepairIteration {
	iteration: number;
	before_summary: MiseLedgerCompileResult["summary"];
	after_summary: MiseLedgerCompileResult["summary"];
	actions: MiseRepairAction[];
}

export interface MiseRepairResult {
	plan_id: string;
	changed: boolean;
	converged: boolean;
	initial_compiled: MiseLedgerCompileResult;
	final_compiled: MiseLedgerCompileResult;
	repaired_plan: MiseWeeklyPlanDraft;
	iterations: MiseRepairIteration[];
	remaining_issues: MiseValidationIssue[];
	summary: {
		initial_hard_errors: number;
		final_hard_errors: number;
		initial_warnings: number;
		final_warnings: number;
		iterations: number;
		actions: number;
	};
}

export interface SaveMiseRepairResult {
	plan_id: string;
	repair_run_id: string;
	plan_saved: {
		plan_id: string;
		components_saved: number;
		tasks_saved: number;
	};
	ledger_saved: {
		plan_id: string;
		resources_saved: number;
		events_saved: number;
		inputs_saved: number;
		outputs_saved: number;
		reservations_saved: number;
		validation_run_id: string;
		issues_saved: number;
	};
}

type PlanEventSource =
	| { kind: "meal"; meal: MisePlanMeal }
	| { kind: "breakfast"; meal: MisePlanMeal }
	| { kind: "snack"; snack: MiseSnackBox };

interface RepairContext {
	plan: MiseWeeklyPlanDraft;
	compiled: MiseLedgerCompileResult;
	eventsById: Map<string, MisePlanLedgerEvent>;
	componentsById: Map<string, MisePlanComponentBatch>;
	tasksByComponentId: Map<string, MisePlanTask>;
	actions: MiseRepairAction[];
}

export function repairMisePlan(inputPlan: MiseWeeklyPlanDraft, options: MiseRepairOptions = {}): MiseRepairResult {
	const maxIterations = clamp(Math.floor(Number(options.max_iterations || 4)), 1, 8);
	const formulas = options.formulas || EMPTY_FORMULA_INDEX;
	const observations = options.observations || [];
	const plan = clonePlan(inputPlan);
	normalizePlanAfterRepair(plan);

	const initialCompiled = compileMisePlanLedger(plan, formulas, observations);
	let before = initialCompiled;
	const iterations: MiseRepairIteration[] = [];
	let changed = false;
	let previousFingerprint = JSON.stringify(plan);

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		const actions = applyRepairPass(plan, before);
		if (!actions.length) break;

		changed = true;
		normalizePlanAfterRepair(plan);
		const after = compileMisePlanLedger(plan, formulas, observations);
		iterations.push({
			iteration,
			before_summary: before.summary,
			after_summary: after.summary,
			actions,
		});

		const nextFingerprint = JSON.stringify(plan);
		if (nextFingerprint === previousFingerprint) break;
		previousFingerprint = nextFingerprint;
		before = after;

		if (after.summary.hard_errors === 0 && !hasRepairableWarnings(after.validation_issues)) break;
	}

	normalizePlanAfterRepair(plan);
	const finalCompiled = compileMisePlanLedger(plan, formulas, observations);
	plan.meta = {
		...plan.meta,
		repaired_by: "mise_graph_repair",
		repair_count: Number(plan.meta.repair_count || 0) + (changed ? 1 : 0),
		repair_notes: [
			`Initial hard errors: ${initialCompiled.summary.hard_errors}`,
			`Final hard errors: ${finalCompiled.summary.hard_errors}`,
		],
	};

	return {
		plan_id: plan.id,
		changed,
		converged: finalCompiled.summary.hard_errors === 0,
		initial_compiled: initialCompiled,
		final_compiled: finalCompiled,
		repaired_plan: plan,
		iterations,
		remaining_issues: finalCompiled.validation_issues,
		summary: {
			initial_hard_errors: initialCompiled.summary.hard_errors,
			final_hard_errors: finalCompiled.summary.hard_errors,
			initial_warnings: initialCompiled.summary.warnings,
			final_warnings: finalCompiled.summary.warnings,
			iterations: iterations.length,
			actions: iterations.reduce((total, item) => total + item.actions.length, 0),
		},
	};
}

export async function saveMiseRepairResult(env: MiseGraphEnv, result: MiseRepairResult): Promise<SaveMiseRepairResult> {
	const planSaved = await saveMiseWeeklyPlan(env, result.repaired_plan);
	const ledgerSaved = await saveMiseLedgerCompile(env, result.final_compiled);
	const repairRunId = slugId("repair_run", result.plan_id, Date.now());
	const actions = result.iterations.flatMap(iteration => iteration.actions.map(action => ({ ...action, iteration: iteration.iteration })));

	await env.DB.prepare(`
		INSERT INTO mise_repair_runs
		(id, plan_id, status, iteration_count, before_hard_errors, after_hard_errors,
		 before_warnings, after_warnings, actions_json, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		repairRunId,
		result.plan_id,
		result.converged ? "converged" : "needs_attention",
		result.iterations.length,
		result.summary.initial_hard_errors,
		result.summary.final_hard_errors,
		result.summary.initial_warnings,
		result.summary.final_warnings,
		JSON.stringify(actions),
		JSON.stringify({ changed: result.changed, remaining_issues: summarizeIssues(result.remaining_issues) }),
	).run();

	return {
		plan_id: result.plan_id,
		repair_run_id: repairRunId,
		plan_saved: planSaved,
		ledger_saved: ledgerSaved,
	};
}

function applyRepairPass(plan: MiseWeeklyPlanDraft, compiled: MiseLedgerCompileResult): MiseRepairAction[] {
	const context: RepairContext = {
		plan,
		compiled,
		eventsById: new Map(compiled.events.map(event => [event.id, event])),
		componentsById: new Map(plan.component_batches.map(component => [component.id, component])),
		tasksByComponentId: componentTaskMap(plan),
		actions: [],
	};

	repairGenericSnackItems(context);

	for (const validationIssue of repairableIssues(compiled.validation_issues)) {
		if (skipIfLocked(context, validationIssue)) continue;
		if (validationIssue.issue_type === "format_incompatible" || validationIssue.issue_type === "inedible_intermediate_consumed") {
			repairInvalidComponentUse(context, validationIssue);
		} else if (validationIssue.issue_type === "resource_not_ready") {
			repairNotReadyUse(context, validationIssue);
		} else if (validationIssue.issue_type === "resource_expired" || validationIssue.issue_type === "resource_consumed") {
			repairExpiredUse(context, validationIssue);
		} else if (validationIssue.issue_type === "generic_resource_label") {
			repairGenericSnackItems(context);
		}
	}

	return uniqueActions(context.actions);
}

/**
 * Optimistic-lock guard. If the entity tied to this validation issue is hard-
 * locked (meal, batch, or prep task), record a `skipped_locked` action and
 * tell the caller to skip the standard repair. Soft locks pass through —
 * they let the repair proceed and just signal a downstream warning.
 */
function skipIfLocked(context: RepairContext, validationIssue: MiseValidationIssue): boolean {
	const reasons: string[] = [];

	if (validationIssue.event_id) {
		const source = findPlanEventSource(context.plan, validationIssue.event_id);
		if (source) {
			const meal = source.kind === "snack" ? source.snack : source.meal;
			const lock = getEntityLock((meal as { meta?: Record<string, unknown> }).meta);
			if (isLocked(lock) && lock?.lock_scope !== "soft") {
				reasons.push(`meal/snack ${meal.id} is locked (${lock?.lock_reason || "no reason"})`);
			}
		}
	}

	if (validationIssue.component_id) {
		const batch = context.componentsById.get(validationIssue.component_id);
		const batchLock = getEntityLock(batch?.meta);
		if (isLocked(batchLock) && batchLock?.lock_scope !== "soft") {
			reasons.push(`batch ${validationIssue.component_id} is locked (${batchLock?.lock_reason || "no reason"})`);
		}
		const task = context.tasksByComponentId.get(validationIssue.component_id);
		const taskLock = getEntityLock(task?.meta);
		if (isLocked(taskLock) && taskLock?.lock_scope !== "soft") {
			reasons.push(`prep task ${task?.id} is locked (${taskLock?.lock_reason || "no reason"})`);
		}
	}

	if (reasons.length === 0) return false;

	context.actions.push(action("skipped_locked", validationIssue, {
		eventId: validationIssue.event_id,
		componentId: validationIssue.component_id,
		resourceLotId: validationIssue.resource_lot_id,
		title: `Skipped repair on locked entity (issue=${validationIssue.issue_type})`,
		detail: `Repair pass refused to mutate locked entities: ${reasons.join("; ")}. The grievance remains in the plan and must be addressed by unlocking or via the revision loop.`,
		before: { lock_reasons: reasons },
		after: { skipped: true },
	}));
	return true;
}

function repairGenericSnackItems(context: RepairContext): void {
	for (const snack of context.plan.snack_boxes) {
		const lock = getEntityLock((snack as { meta?: Record<string, unknown> }).meta);
		if (isLocked(lock) && lock?.lock_scope !== "soft") {
			const before = [...snack.items];
			const after = unique(snack.items.map(item => specificSnackItem(context.plan, item)).filter(Boolean));
			if (arraysEqual(before, after)) continue;
			context.actions.push(action("skipped_locked", null, {
				eventId: snack.id,
				title: `Skipped generic-snack repair for locked snack ${snack.title}`,
				detail: `Snack ${snack.id} is locked (${lock?.lock_reason || "no reason"}); leaving items as-is.`,
				before: { items: before },
				after: { items: before, skipped: true },
			}));
			continue;
		}
		const before = [...snack.items];
		const after = unique(snack.items.map(item => specificSnackItem(context.plan, item)).filter(Boolean));
		if (arraysEqual(before, after)) continue;
		snack.items = after;
		context.actions.push(action("specific_snack_items", null, {
			eventId: snack.id,
			title: `Resolved generic snack items for ${snack.title}`,
			detail: "Generic snack resources were replaced with concrete household ingredients/components.",
			before: { items: before },
			after: { items: after },
		}));
	}
}

function repairInvalidComponentUse(context: RepairContext, validationIssue: MiseValidationIssue): void {
	if (!validationIssue.event_id || !validationIssue.component_id) return;
	const event = context.eventsById.get(validationIssue.event_id);
	if (!event) return;

	const source = findPlanEventSource(context.plan, event.id);
	if (!source) return;

	const slot = eventSlot(source);
	const replacement = bestReplacementComponent(context.plan, slot, validationIssue.component_id);
	const before = componentIdsForSource(source);
	const changed = replaceComponentInSource(source, validationIssue.component_id, replacement?.id || null);
	if (!changed) return;

	context.actions.push(action(replacement ? "replace_invalid_component" : "remove_invalid_component", validationIssue, {
		eventId: event.id,
		componentId: validationIssue.component_id,
		resourceLotId: validationIssue.resource_lot_id,
		title: `${replacement ? "Replaced" : "Removed"} ${componentLabel(context.plan, validationIssue.component_id)} for ${event.title}`,
		detail: replacement
			? `${componentLabel(context.plan, validationIssue.component_id)} was not compatible with this slot, so ${replacement.label} now fills that role.`
			: `${componentLabel(context.plan, validationIssue.component_id)} was not compatible with this slot and no safe replacement was available in the current plan.`,
		before: { component_ids: before },
		after: { component_ids: componentIdsForSource(source) },
	}));
}

function repairNotReadyUse(context: RepairContext, validationIssue: MiseValidationIssue): void {
	if (!validationIssue.event_id || !validationIssue.component_id) return;
	const event = context.eventsById.get(validationIssue.event_id);
	if (!event) return;
	const component = context.componentsById.get(validationIssue.component_id);
	const task = context.tasksByComponentId.get(validationIssue.component_id);
	if (!component || !task) {
		removeUnavailableComponentFromMealLikeEvent(context, validationIssue, event);
		return;
	}

	const scheduledDate = prepDateBeforeEvent(context.plan, task, event);
	if (!scheduledDate || scheduledDate < context.plan.start_date) {
		removeUnavailableComponentFromMealLikeEvent(context, validationIssue, event);
		return;
	}

	if (task.scheduled_date <= scheduledDate && canLikelyFinishSameDay(task, event)) return;
	const beforeDate = task.scheduled_date;
	task.scheduled_date = scheduledDate;
	task.meta = {
		...task.meta,
		repair_reason: "resource_not_ready",
		repair_event_id: event.id,
	};
	context.actions.push(action("move_prep_earlier", validationIssue, {
		eventId: event.id,
		componentId: component.id,
		resourceLotId: validationIssue.resource_lot_id,
		title: `Moved ${component.label} prep before ${event.title}`,
		detail: `${component.label} is now scheduled on ${scheduledDate} so it can be ready for ${event.start_at}.`,
		before: { scheduled_date: beforeDate },
		after: { scheduled_date: scheduledDate },
	}));
}

function repairExpiredUse(context: RepairContext, validationIssue: MiseValidationIssue): void {
	if (!validationIssue.event_id || !validationIssue.component_id) return;
	const event = context.eventsById.get(validationIssue.event_id);
	if (!event) return;

	const original = context.componentsById.get(validationIssue.component_id);
	if (!original) return;

	const clone = cloneComponentForEvent(context, original, event, validationIssue);
	if (!clone) return;

	const source = findPlanEventSource(context.plan, event.id);
	if (source) {
		const before = componentIdsForSource(source);
		const changed = replaceComponentInSource(source, original.id, clone.id);
		if (!changed) return;
		context.actions.push(action("remake_expired_component", validationIssue, {
			eventId: event.id,
			componentId: original.id,
			resourceLotId: validationIssue.resource_lot_id,
			title: `Remade ${original.label} for ${event.title}`,
			detail: `${original.label} was outside its quality window, so a fresh batch is now assigned to this event.`,
			before: { component_ids: before },
			after: { component_ids: componentIdsForSource(source), remake_component_id: clone.id },
		}));
		return;
	}

	context.actions.push(action("remake_upstream_component", validationIssue, {
		eventId: event.id,
		componentId: original.id,
		resourceLotId: validationIssue.resource_lot_id,
		title: `Added fresh ${original.label} before ${event.title}`,
		detail: `${event.title} needed an expired upstream resource, so a fresh batch was inserted before that prep task.`,
		before: { component_id: original.id },
		after: { remake_component_id: clone.id },
	}));
}

function removeUnavailableComponentFromMealLikeEvent(context: RepairContext, validationIssue: MiseValidationIssue, event: MisePlanLedgerEvent): void {
	const source = findPlanEventSource(context.plan, event.id);
	if (!source || !validationIssue.component_id) return;
	const before = componentIdsForSource(source);
	if (!replaceComponentInSource(source, validationIssue.component_id, null)) return;
	context.actions.push(action("remove_unavailable_component", validationIssue, {
		eventId: event.id,
		componentId: validationIssue.component_id,
		resourceLotId: validationIssue.resource_lot_id,
		title: `Removed unavailable ${componentLabel(context.plan, validationIssue.component_id)} from ${event.title}`,
		detail: `${componentLabel(context.plan, validationIssue.component_id)} cannot be made before this slot within the current plan window.`,
		before: { component_ids: before },
		after: { component_ids: componentIdsForSource(source) },
	}));
}

function cloneComponentForEvent(
	context: RepairContext,
	original: MisePlanComponentBatch,
	event: MisePlanLedgerEvent,
	validationIssue: MiseValidationIssue,
): MisePlanComponentBatch | null {
	const originalTask = context.tasksByComponentId.get(original.id);
	if (!originalTask) return null;
	const baseComponentId = original.id.split(":repair:")[0];
	const baseTaskId = originalTask.id.split(":repair:")[0];
	const scheduledDate = prepDateForClone(context.plan, originalTask, event, original.quality_window_hours);
	if (!scheduledDate || scheduledDate < context.plan.start_date) return null;
	// Bucket-keyed clone id: events on the same bucketed prep date share one batch.
	const cloneId = slugId(baseComponentId, "repair", scheduledDate);
	const existing = context.componentsById.get(cloneId);
	if (existing) {
		existing.meta = { ...((existing.meta as Record<string, unknown> | undefined) || {}), desired_prep_date: scheduledDate };
		const existingTask = context.tasksByComponentId.get(existing.id);
		if (existingTask) {
			// Track that this clone now serves another consuming event.
			const meta = existingTask.meta as Record<string, unknown>;
			const consumers = Array.isArray(meta.batch_consumers) ? [...(meta.batch_consumers as string[])] : [];
			if (!consumers.includes(event.id)) consumers.push(event.id);
			existingTask.meta = { ...meta, batch_consumers: consumers, desired_prep_date: scheduledDate, batch_scheduled_date: scheduledDate };
			if (existingTask.scheduled_date !== scheduledDate) existingTask.scheduled_date = scheduledDate;
		}
		return existing;
	}

	const clone: MisePlanComponentBatch = {
		...cloneJson(original),
		id: cloneId,
		planned_uses: [],
		meta: {
			...original.meta,
			desired_prep_date: scheduledDate,
			repaired_from_component_id: original.id,
			repair_event_id: event.id,
			repair_issue_type: validationIssue.issue_type,
		},
	};
	const task: MisePlanTask = {
		...cloneJson(originalTask),
		id: slugId(baseTaskId, "repair", scheduledDate),
		scheduled_date: scheduledDate,
		session_order: 999,
		title: `Remake ${original.label} (batch ${scheduledDate})`,
		state_outputs: [clone.id],
		meta: {
			...originalTask.meta,
			component_id: clone.id,
			repaired_from_task_id: originalTask.id,
			repair_event_id: event.id,
			repair_issue_type: validationIssue.issue_type,
			batch_consumers: [event.id],
			desired_prep_date: scheduledDate,
			batch_scheduled_date: scheduledDate,
		},
	};

	context.plan.component_batches.push(clone);
	context.plan.prep_tasks.push(task);
	context.componentsById.set(clone.id, clone);
	context.tasksByComponentId.set(clone.id, task);
	return clone;
}

function normalizePlanAfterRepair(plan: MiseWeeklyPlanDraft): void {
	const componentIds = new Set(plan.component_batches.map(component => component.id));
	for (const meal of allMeals(plan)) {
		meal.component_ids = unique(meal.component_ids.filter(id => componentIds.has(id)));
	}
	for (const snack of plan.snack_boxes) {
		snack.component_ids = unique(snack.component_ids.filter(id => componentIds.has(id)));
		snack.items = unique(snack.items.map(item => titleCase(item)).filter(Boolean));
	}

	for (const component of plan.component_batches) {
		component.planned_uses = [];
	}
	for (const meal of allMeals(plan)) {
		for (const componentId of meal.component_ids) {
			const component = plan.component_batches.find(candidate => candidate.id === componentId);
			if (component) component.planned_uses.push({ date: meal.date, slot: meal.slot, meal_id: meal.id, title: meal.title });
		}
	}
	for (const snack of plan.snack_boxes) {
		for (const componentId of snack.component_ids) {
			const component = plan.component_batches.find(candidate => candidate.id === componentId);
			if (component) component.planned_uses.push({ date: snack.date, slot: "snack", meal_id: snack.id, title: snack.title });
		}
	}

	pruneUnusedLeafComponents(plan);

	const earliestUseByComponent = new Map<string, string>();
	for (const component of plan.component_batches) {
		const firstUse = component.planned_uses
			.map(use => dateTime(use.date, slotTime(use.slot)))
			.sort()[0];
		if (firstUse) earliestUseByComponent.set(component.id, firstUse);
	}

	plan.prep_tasks = uniqueBy(plan.prep_tasks, task => task.id)
		.sort((a, b) => {
			const aComponent = taskComponentId(a);
			const bComponent = taskComponentId(b);
			return a.scheduled_date.localeCompare(b.scheduled_date)
				|| (earliestUseByComponent.get(aComponent || "") || "9999").localeCompare(earliestUseByComponent.get(bComponent || "") || "9999")
				|| taskPriority(plan, a) - taskPriority(plan, b)
				|| a.title.localeCompare(b.title);
		});

	const countByDate = new Map<string, number>();
	for (const task of plan.prep_tasks) {
		const next = (countByDate.get(task.scheduled_date) || 0) + 1;
		countByDate.set(task.scheduled_date, next);
		task.session_order = next;
	}

	plan.storage_labels = plan.component_batches.map(component => ({
		id: slugId("mise_label", component.id),
		component_id: component.id,
		label: component.label,
		storage: component.storage || "refrigerate or store by food-safety needs",
		use_by_date: component.quality_window_hours && component.planned_uses.length
			? addDays(component.planned_uses.map(use => use.date).sort()[0], Math.max(0, Math.floor(component.quality_window_hours / 24)))
			: null,
		notes: [
			component.container ? `Container: ${component.container}` : "Use a sealed labeled container.",
			component.planned_uses.length ? `Planned uses: ${component.planned_uses.map(use => use.date).join(", ")}` : "No fixed use yet.",
		],
	}));

	ensureShoppingItems(plan);
}

function ensureShoppingItems(plan: MiseWeeklyPlanDraft): void {
	const componentLabels = new Set(plan.component_batches.map(component => normalizeName(component.label)));
	for (const section of plan.shopping_list) {
		section.items = section.items.flatMap(item => {
			const normalized = normalizeName(item.name);
			if (normalized !== "dip" && normalized !== "fruit" && normalized !== "crunchy vegetables") return [item];
			const replacement = specificSnackItem(plan, item.name);
			if (componentLabels.has(normalizeName(replacement))) return [];
			return [{ ...item, name: replacement, source: unique([...item.source, "mise_repair"]) }];
		});
	}
	const existing = new Set(plan.shopping_list.flatMap(section => section.items.map(item => normalizeName(item.name))));
	const needed = unique([
		...plan.selected_ingredients,
		...plan.snack_boxes.flatMap(snack => snack.items),
		...allMeals(plan).flatMap(meal => meal.ingredient_names),
		...plan.component_batches.flatMap(component => component.input_names),
	].map(normalizeName).filter(name => name && !componentLabels.has(name)));

	for (const name of needed) {
		if (existing.has(name)) continue;
		const category = shoppingCategory(name);
		let section = plan.shopping_list.find(candidate => candidate.category === category);
		if (!section) {
			section = { category, items: [] };
			plan.shopping_list.push(section);
		}
		section.items.push({ name: titleCase(name), quantity: null, unit: null, source: ["mise_repair"] });
		existing.add(name);
	}
	for (const section of plan.shopping_list) {
		section.items = uniqueBy(section.items, item => normalizeName(item.name)).sort((a, b) => a.name.localeCompare(b.name));
	}
	plan.shopping_list.sort((a, b) => a.category.localeCompare(b.category));
}

function repairableIssues(issues: MiseValidationIssue[]): MiseValidationIssue[] {
	const ranks: Record<string, number> = {
		format_incompatible: 10,
		inedible_intermediate_consumed: 20,
		resource_consumed: 25,
		resource_not_ready: 30,
		resource_expired: 40,
		generic_resource_label: 50,
	};
	return issues
		.filter(issue => ranks[issue.issue_type] !== undefined)
		.sort((a, b) => ranks[a.issue_type] - ranks[b.issue_type] || (a.event_id || "").localeCompare(b.event_id || ""));
}

function hasRepairableWarnings(issues: MiseValidationIssue[]): boolean {
	return issues.some(issue => issue.severity === "warning" && issue.issue_type === "generic_resource_label");
}

function findPlanEventSource(plan: MiseWeeklyPlanDraft, eventId: string): PlanEventSource | null {
	for (const day of plan.meals_by_day) {
		for (const meal of day.meals) {
			if (meal.id === eventId) return { kind: "meal", meal };
		}
	}
	for (const meal of plan.breakfasts) {
		if (meal.id === eventId) return { kind: "breakfast", meal };
	}
	for (const snack of plan.snack_boxes) {
		if (snack.id === eventId) return { kind: "snack", snack };
	}
	return null;
}

function eventSlot(source: PlanEventSource): MiseMealSlot {
	if (source.kind === "snack") return "snack";
	return source.meal.slot;
}

function componentIdsForSource(source: PlanEventSource): string[] {
	return source.kind === "snack" ? [...source.snack.component_ids] : [...source.meal.component_ids];
}

function replaceComponentInSource(source: PlanEventSource, componentId: string, replacementId: string | null): boolean {
	const before = componentIdsForSource(source);
	const after = replacementId
		? unique(before.map(id => id === componentId ? replacementId : id))
		: before.filter(id => id !== componentId);
	if (arraysEqual(before, after)) return false;
	if (source.kind === "snack") source.snack.component_ids = after;
	else source.meal.component_ids = after;
	return true;
}

function bestReplacementComponent(plan: MiseWeeklyPlanDraft, slot: MiseMealSlot, excludedComponentId: string): MisePlanComponentBatch | null {
	const candidates = plan.component_batches
		.filter(component => component.id !== excludedComponentId)
		.filter(component => isComponentCompatibleWithSlot(component.label, slot));
	const sorted = candidates.sort((a, b) => replacementScore(b, slot) - replacementScore(a, slot) || a.label.localeCompare(b.label));
	return sorted[0] || null;
}

function isComponentCompatibleWithSlot(label: string, slot: MiseMealSlot): boolean {
	const normalized = normalizeName(label);
	if (/soaked chickpea|falafel mix/.test(normalized)) return false;
	if (slot === "breakfast") return /chia|oat|yogurt|fruit|berry|strawberry|jam|granola|milk/.test(normalized);
	if (/jam|syrup|sweet/.test(normalized)) return slot === "snack";
	return true;
}

function replacementScore(component: MisePlanComponentBatch, slot: MiseMealSlot): number {
	const label = normalizeName(component.label);
	let score = component.planned_uses.length ? 2 : 1;
	if (slot === "breakfast" && /chia|oat|yogurt|fruit|berry|strawberry|jam/.test(label)) score += 10;
	if (slot === "snack" && /hummus|dip|pickle|cucumber|radish|fruit|berry|flatbread|sauce/.test(label)) score += 8;
	if ((slot === "lunch" || slot === "dinner") && /hummus|crispy|cooked|pickle|sauce|herb|flatbread|lentil|chickpea/.test(label)) score += 8;
	if (/soaked|falafel mix/.test(label)) score -= 20;
	return score;
}

function prepDateBeforeEvent(plan: MiseWeeklyPlanDraft, task: MisePlanTask, event: MisePlanLedgerEvent): string | null {
	const slot = inferredEventSlot(event);
	const totalMinutes = Math.max(0, Number(task.active_time_min || 0)) + Math.max(0, Number(task.idle_time_min || 0));
	let daysBack = 0;
	if (slot === "breakfast" || slot === "lunch" || slot === "snack") daysBack = 1;
	if (slot === "dinner" && totalMinutes > 135) daysBack = 1;
	if (totalMinutes > 20 * 60) daysBack = Math.max(daysBack, Math.ceil(totalMinutes / (24 * 60)));
	const date = addDays(event.event_date, -daysBack);
	return date < plan.start_date ? null : date;
}

function prepDateForClone(plan: MiseWeeklyPlanDraft, task: MisePlanTask, event: MisePlanLedgerEvent, qualityWindowHours?: number | null): string | null {
	const totalMinutes = Math.max(0, Number(task.active_time_min || 0)) + Math.max(0, Number(task.idle_time_min || 0));
	let naturalDate: string | null = null;
	if (event.event_type === "prep_task" && totalMinutes > 180) {
		const previousDate = addDays(event.event_date, -1);
		if (previousDate >= plan.start_date) naturalDate = previousDate;
	}
	if (!naturalDate) naturalDate = prepDateBeforeEvent(plan, task, event);
	if (!naturalDate) return null;

	// Snap natural prep date into a quality-window bucket so multiple events
	// within the same window share one remake batch. Components with shelf
	// life ≥ 48h are eligible; shorter shelf life can't safely batch.
	const qhours = qualityWindowHours ?? 24;
	if (qhours < 48) return naturalDate;
	const bucketDays = Math.max(1, Math.floor(qhours / 24) - 1);
	return snapToBucketDate(plan.start_date, naturalDate, bucketDays);
}

function snapToBucketDate(startDate: string, targetDate: string, bucketDays: number): string {
	if (bucketDays <= 1) return targetDate;
	const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
	const targetMs = Date.parse(`${targetDate}T00:00:00.000Z`);
	if (!Number.isFinite(startMs) || !Number.isFinite(targetMs)) return targetDate;
	const dayMs = 86400000;
	const offsetDays = Math.max(0, Math.floor((targetMs - startMs) / dayMs));
	const bucketIndex = Math.floor(offsetDays / bucketDays);
	const snappedMs = startMs + bucketIndex * bucketDays * dayMs;
	return new Date(snappedMs).toISOString().slice(0, 10);
}

function canLikelyFinishSameDay(task: MisePlanTask, event: MisePlanLedgerEvent): boolean {
	if (task.scheduled_date < event.event_date) return true;
	if (task.scheduled_date > event.event_date) return false;
	const slot = inferredEventSlot(event);
	if (slot !== "dinner") return false;
	const startMinute = 16 * 60;
	const finishMinute = startMinute + Math.max(0, Number(task.active_time_min || 0)) + Math.max(0, Number(task.idle_time_min || 0));
	return finishMinute <= 18 * 60 + 15;
}

function inferredEventSlot(event: MisePlanLedgerEvent): MiseMealSlot {
	const metaSlot = normalizeName(event.meta.slot);
	if (metaSlot === "breakfast" || metaSlot === "lunch" || metaSlot === "snack" || metaSlot === "dinner") return metaSlot;
	if (event.event_type === "snack_pack") return "snack";
	if (event.start_at.slice(11, 16) < "10:00") return "breakfast";
	if (event.start_at.slice(11, 16) < "14:00") return "lunch";
	if (event.start_at.slice(11, 16) < "17:00") return "snack";
	return "dinner";
}

function pruneUnusedLeafComponents(plan: MiseWeeklyPlanDraft): void {
	const usedComponentIds = new Set(allMeals(plan).flatMap(meal => meal.component_ids).concat(plan.snack_boxes.flatMap(snack => snack.component_ids)));
	const inputStateIds = new Set(plan.component_batches.map(component => {
		const edge = recordValue(component.meta.edge);
		return typeof edge.from_state_id === "string" ? edge.from_state_id : "";
	}).filter(Boolean));
	const beforeIds = new Set(plan.component_batches.map(component => component.id));
	plan.component_batches = plan.component_batches.filter(component => {
		if (usedComponentIds.has(component.id)) return true;
		if (component.state_id && inputStateIds.has(component.state_id)) return true;
		return !isLeafIntermediate(component.label);
	});
	const afterIds = new Set(plan.component_batches.map(component => component.id));
	if (afterIds.size === beforeIds.size) return;
	plan.prep_tasks = plan.prep_tasks.filter(task => {
		const componentId = taskComponentId(task);
		return !componentId || afterIds.has(componentId);
	});
}

function isLeafIntermediate(label: string): boolean {
	return /falafel mix|soaked chickpea/.test(normalizeName(label));
}

function specificSnackItem(plan: MiseWeeklyPlanDraft, item: string): string {
	const normalized = normalizeName(item);
	if (normalized === "dip") {
		return findComponentLabel(plan, /hummus|dip|yogurt sauce|tahini sauce/) || "Hummus";
	}
	if (normalized === "fruit") {
		return findSelectedIngredient(plan, /strawberr|berry|apple|pear|peach|plum|apricot|orange|citrus|grape/)
			|| "Seasonal Fruit";
	}
	if (/^crunchy vegetables$/.test(normalized)) {
		return findSelectedIngredient(plan, /radish|cucumber|carrot|celery|snap pea|pepper/)
			|| "Radishes";
	}
	return titleCase(item);
}

function findComponentLabel(plan: MiseWeeklyPlanDraft, pattern: RegExp): string | null {
	return plan.component_batches.find(component => pattern.test(normalizeName(component.label)))?.label || null;
}

function findSelectedIngredient(plan: MiseWeeklyPlanDraft, pattern: RegExp): string | null {
	const match = plan.selected_ingredients.find(ingredient => pattern.test(normalizeName(ingredient)));
	return match ? titleCase(match) : null;
}

function componentTaskMap(plan: MiseWeeklyPlanDraft): Map<string, MisePlanTask> {
	const map = new Map<string, MisePlanTask>();
	for (const task of plan.prep_tasks) {
		const componentId = taskComponentId(task);
		if (componentId) map.set(componentId, task);
	}
	return map;
}

function taskComponentId(task: MisePlanTask): string | null {
	const metaComponent = task.meta.component_id;
	if (typeof metaComponent === "string") return metaComponent;
	return task.state_outputs.find(output => output.startsWith("mise_component:")) || null;
}

function allMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	return [...plan.meals_by_day.flatMap(day => day.meals), ...plan.breakfasts];
}

function taskPriority(plan: MiseWeeklyPlanDraft, task: MisePlanTask): number {
	const component = plan.component_batches.find(candidate => candidate.id === taskComponentId(task));
	const label = normalizeName(component?.label || task.title);
	if (/soaked/.test(label)) return 10;
	if (/cooked whole|pressure|simmer/.test(label)) return 20;
	if (/hummus|dip|puree/.test(label)) return 30;
	if (/crispy|roast/.test(label)) return 35;
	if (/sauce|dressing/.test(label)) return 40;
	if (/pickle|salted/.test(label)) return 45;
	if (/dough|ferment/.test(label)) return 50;
	return 60;
}

function action(
	type: string,
	validationIssue: MiseValidationIssue | null,
	input: {
		eventId?: string | null;
		componentId?: string | null;
		resourceLotId?: string | null;
		title: string;
		detail: string;
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
	},
): MiseRepairAction {
	return {
		id: slugId("repair_action", type, input.eventId || validationIssue?.event_id || "plan", input.componentId || validationIssue?.component_id || input.title),
		type,
		issue_type: validationIssue?.issue_type || null,
		severity: validationIssue?.severity || null,
		event_id: input.eventId ?? validationIssue?.event_id ?? null,
		component_id: input.componentId ?? validationIssue?.component_id ?? null,
		resource_lot_id: input.resourceLotId ?? validationIssue?.resource_lot_id ?? null,
		title: input.title,
		detail: input.detail,
		before: input.before,
		after: input.after,
	};
}

function uniqueActions(actions: MiseRepairAction[]): MiseRepairAction[] {
	return uniqueBy(actions, item => `${item.type}:${item.event_id}:${item.component_id}:${JSON.stringify(item.after || {})}`);
}

function summarizeIssues(issues: MiseValidationIssue[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const issue of issues) {
		const key = `${issue.severity}:${issue.issue_type}`;
		counts[key] = (counts[key] || 0) + 1;
	}
	return counts;
}

function componentLabel(plan: MiseWeeklyPlanDraft, componentId: string): string {
	return plan.component_batches.find(component => component.id === componentId)?.label || componentId;
}

function shoppingCategory(name: string): string {
	const normalized = normalizeName(name);
	if (/apple|berry|citrus|orange|lemon|lime|grape|fruit|strawberry/.test(normalized)) return "fruit";
	if (/cucumber|radish|carrot|greens|herb|onion|garlic|pepper|tomato|vegetable/.test(normalized)) return "produce";
	if (/yogurt|milk|cheese|egg|butter|cream/.test(normalized)) return "dairy";
	if (/chickpea|lentil|bean|tofu/.test(normalized)) return "protein";
	if (/rice|oat|flour|bread|pita|pasta|grain/.test(normalized)) return "grains";
	if (/tahini|oil|vinegar|spice|salt|nut|seed/.test(normalized)) return "pantry";
	return "other";
}

function dateTime(date: string, time: string): string {
	return `${date}T${time}:00`;
}

function slotTime(slot: MiseMealSlot): string {
	if (slot === "breakfast") return "08:00";
	if (slot === "lunch") return "12:00";
	if (slot === "snack") return "15:00";
	return "18:30";
}

function addDays(date: string, days: number): string {
	const parsed = new Date(`${date}T00:00:00.000Z`);
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
}

function clonePlan(plan: MiseWeeklyPlanDraft): MiseWeeklyPlanDraft {
	return cloneJson(plan);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const results: T[] = [];
	for (const item of items) {
		const itemKey = key(item);
		if (seen.has(itemKey)) continue;
		seen.add(itemKey);
		results.push(item);
	}
	return results;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(value, min), max);
}

function normalizeName(value: unknown): string {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
