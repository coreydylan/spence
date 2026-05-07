import type {
	MiseMealSlot,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseSnackBox,
	MiseWeeklyPlanDraft,
} from "./planner";
import type { MiseGraphEnv } from "./types";

export interface MiseFormulaInput {
	canonical_name: string;
	role: string;
	required: boolean;
	qty: number;
	unit: string;
	grams: number;
	notes?: string;
}

export interface MiseFormula {
	id: string;
	output_state_id: string | null;
	output_label: string;
	output_canonical_name: string | null;
	batch_qty: number;
	batch_unit: string;
	batch_grams: number;
	serves: number | null;
	yield_ratio: number | null;
	inputs: MiseFormulaInput[];
	shelf_life_hours_fridge: number | null;
	shelf_life_hours_pantry: number | null;
	shelf_life_hours_freezer: number | null;
	make_ahead_days_min: number | null;
	make_ahead_days_max: number | null;
	make_ahead_best_min: number | null;
	make_ahead_best_max: number | null;
	active_time_min: number | null;
	idle_time_min: number | null;
	equipment: string[];
}

export interface MiseFormulaIndex {
	by_state_id: Map<string, MiseFormula>;
	by_label: Map<string, MiseFormula>;
	by_canonical: Map<string, MiseFormula>;
	unit_conversions: Map<string, Map<string, number>>;
}

export const EMPTY_FORMULA_INDEX: MiseFormulaIndex = {
	by_state_id: new Map(),
	by_label: new Map(),
	by_canonical: new Map(),
	unit_conversions: new Map(),
};

export type MisePlanEventType =
	| "grocery_trip"
	| "prep_task"
	| "meal_service"
	| "snack_pack"
	| "audit_prompt"
	| "resource_expiry";

export type MiseValidationSeverity = "hard_error" | "warning" | "info";

export interface MiseResourceLot {
	id: string;
	plan_id: string;
	household_id: string | null;
	label: string;
	resource_kind: "raw" | "component" | "leftover";
	state_id: string | null;
	source_component_id: string | null;
	source_event_id: string | null;
	quantity: number | null;
	unit: string | null;
	storage: string | null;
	container: string | null;
	created_at_time: string | null;
	best_until: string | null;
	safe_until: string | null;
	confidence: number;
	source: "projected" | "observed" | "corrected";
	status: "available" | "reserved" | "consumed" | "expired";
	meta: Record<string, unknown>;
}

export interface MisePlanLedgerEvent {
	id: string;
	plan_id: string;
	event_type: MisePlanEventType;
	title: string;
	event_date: string;
	start_at: string;
	end_at: string;
	sort_order: number;
	status: "planned" | "proposed" | "completed";
	active_time_min: number;
	idle_time_min: number;
	parent_event_id: string | null;
	source_id: string | null;
	locked: boolean;
	meta: Record<string, unknown>;
}

export interface MiseEventIO {
	id: string;
	plan_id: string;
	event_id: string;
	resource_lot_id: string | null;
	resource_ref: string | null;
	label: string;
	quantity: number | null;
	unit: string | null;
	required?: boolean;
	role: string | null;
	meta: Record<string, unknown>;
}

export interface MiseResourceReservation {
	id: string;
	plan_id: string;
	event_id: string;
	resource_lot_id: string | null;
	component_id: string;
	reservation_type: "hard" | "soft" | "opportunistic";
	quantity: number | null;
	unit: string | null;
	status: "reserved" | "broken" | "released";
	meta: Record<string, unknown>;
}

export interface MiseValidationIssue {
	id: string;
	run_id?: string | null;
	plan_id: string;
	severity: MiseValidationSeverity;
	issue_type: string;
	title: string;
	detail: string;
	event_id: string | null;
	resource_lot_id: string | null;
	component_id: string | null;
	repair_hint: string | null;
	meta: Record<string, unknown>;
}

export interface MiseLedgerCompileResult {
	plan_id: string;
	compiled_at: string;
	resources: MiseResourceLot[];
	events: MisePlanLedgerEvent[];
	inputs: MiseEventIO[];
	outputs: MiseEventIO[];
	reservations: MiseResourceReservation[];
	validation_issues: MiseValidationIssue[];
	summary: {
		resource_count: number;
		event_count: number;
		reservation_count: number;
		hard_errors: number;
		warnings: number;
		infos: number;
	};
	observation_overlay?: {
		affected_lots: string[];
		added_lots: string[];
	};
}

interface CompileContext {
	plan: MiseWeeklyPlanDraft;
	formulas: MiseFormulaIndex;
	events: MisePlanLedgerEvent[];
	resources: MiseResourceLot[];
	inputs: MiseEventIO[];
	outputs: MiseEventIO[];
	reservations: MiseResourceReservation[];
	resourceByComponentId: Map<string, MiseResourceLot>;
	resourceByStateId: Map<string, MiseResourceLot>;
	rawResourceByLabel: Map<string, MiseResourceLot>;
	rawResourceByCanonical: Map<string, MiseResourceLot>;
	componentResourcesByCanonical: Map<string, MiseResourceLot[]>;
	taskEventByComponentId: Map<string, MisePlanLedgerEvent>;
	currentStartMinuteByDate: Map<string, number>;
	groceryEvent: MisePlanLedgerEvent | null;
}

const SLOT_TIMES: Record<MiseMealSlot, string> = {
	breakfast: "08:00",
	lunch: "12:00",
	dinner: "18:30",
	snack: "15:00",
};

const DEFAULT_PREP_START_MINUTE = 16 * 60;

export function compileMisePlanLedger(
	plan: MiseWeeklyPlanDraft,
	formulas: MiseFormulaIndex = EMPTY_FORMULA_INDEX,
	observations: import("./observations").MiseObservation[] = [],
): MiseLedgerCompileResult {
	const context: CompileContext = {
		plan,
		formulas,
		events: [],
		resources: [],
		inputs: [],
		outputs: [],
		reservations: [],
		resourceByComponentId: new Map(),
		resourceByStateId: new Map(),
		rawResourceByLabel: new Map(),
		rawResourceByCanonical: new Map(),
		componentResourcesByCanonical: new Map(),
		taskEventByComponentId: new Map(),
		currentStartMinuteByDate: new Map(),
		groceryEvent: null,
	};

	addGroceryEvent(context);
	addPrepEventsAndComponentLots(context);
	addMealEvents(context);
	addBreakfastEvents(context);
	addSnackEvents(context);
	addExpiryEvents(context);
	aggregateShoppingQuantities(context);

	const overlay = observations.length
		? applyObservationsToLedgerInternal(context, observations)
		: { affected_lots: [] as string[], added_lots: [] as MiseResourceLot[] };

	context.events.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.sort_order - b.sort_order || a.title.localeCompare(b.title));

	const issues = validateCompiledLedger({
		plan_id: plan.id,
		compiled_at: new Date().toISOString(),
		resources: context.resources,
		events: context.events,
		inputs: context.inputs,
		outputs: context.outputs,
		reservations: context.reservations,
	});

	return withSummary({
		plan_id: plan.id,
		compiled_at: new Date().toISOString(),
		resources: context.resources,
		events: context.events,
		inputs: context.inputs,
		outputs: context.outputs,
		reservations: context.reservations,
		validation_issues: issues,
		summary: emptySummary(),
		observation_overlay: overlay.affected_lots.length || overlay.added_lots.length ? {
			affected_lots: overlay.affected_lots,
			added_lots: overlay.added_lots.map(lot => lot.id),
		} : undefined,
	} as MiseLedgerCompileResult);
}

function applyObservationsToLedgerInternal(context: CompileContext, observations: import("./observations").MiseObservation[]): { affected_lots: string[]; added_lots: MiseResourceLot[] } {
	const affected: string[] = [];
	const added: MiseResourceLot[] = [];
	for (const observation of observations) {
		const matches = findMatchingLotsInContext(context, observation);
		switch (observation.observation_kind) {
			case "consumed":
			case "missing": {
				if (matches.length === 0) continue;
				for (const lot of matches) {
					lot.status = "consumed";
					lot.quantity = 0;
					lot.confidence = Math.max(observation.confidence, lot.confidence);
					lot.source = "observed";
					lot.meta = {
						...recordValue(lot.meta),
						observed_kind: observation.observation_kind,
						observation_id: observation.id,
						observation_text: observation.text,
					};
					affected.push(lot.id);
				}
				break;
			}
			case "remaining": {
				const target = matches[0];
				if (!target) continue;
				if (observation.quantity != null) target.quantity = observation.quantity;
				if (observation.unit) target.unit = observation.unit;
				target.confidence = Math.max(observation.confidence, target.confidence);
				target.source = "observed";
				target.meta = {
					...recordValue(target.meta),
					observed_kind: observation.observation_kind,
					observation_id: observation.id,
				};
				affected.push(target.id);
				break;
			}
			case "gained": {
				const lot: MiseResourceLot = {
					id: `lot_obs:${observation.id}`,
					plan_id: context.plan.id,
					household_id: context.plan.household_id,
					label: observation.target_canonical_name ? titleCase(observation.target_canonical_name) : "Observed Gain",
					resource_kind: "raw",
					state_id: observation.target_state_id,
					source_component_id: null,
					source_event_id: null,
					quantity: observation.quantity ?? observation.grams ?? null,
					unit: observation.unit,
					storage: null,
					container: null,
					created_at_time: observation.observed_at,
					best_until: null,
					safe_until: null,
					confidence: observation.confidence,
					source: "observed",
					status: "available",
					meta: { observation_id: observation.id, observation_text: observation.text },
				};
				context.resources.push(lot);
				added.push(lot);
				affected.push(lot.id);
				break;
			}
			case "condition": {
				for (const lot of matches) {
					lot.confidence = Math.min(lot.confidence, observation.confidence * 0.8);
					lot.meta = { ...recordValue(lot.meta), observed_kind: observation.observation_kind, observation_id: observation.id };
					affected.push(lot.id);
				}
				break;
			}
		}
	}
	return { affected_lots: Array.from(new Set(affected)), added_lots: added };
}

function findMatchingLotsInContext(context: CompileContext, observation: import("./observations").MiseObservation): MiseResourceLot[] {
	if (observation.target_resource_lot_id) {
		return context.resources.filter(lot => lot.id === observation.target_resource_lot_id);
	}
	const canonical = (observation.target_canonical_name || "").toLowerCase().trim();
	if (!canonical) return [];
	return context.resources.filter(lot => {
		if (lot.status === "consumed") return false;
		// Skip lots that are repair clones (created in response to this or prior observations).
		// "We used all the hummus" applies to the *original* batch, not future remakes scheduled to compensate.
		if (lot.source_component_id && lot.source_component_id.includes(":repair:")) return false;
		const labelNorm = (lot.label || "").toLowerCase().trim();
		return labelNorm === canonical || labelNorm.includes(canonical) || canonical.includes(labelNorm);
	});
}

export function validateCompiledLedger(compiled: Omit<MiseLedgerCompileResult, "validation_issues" | "summary">): MiseValidationIssue[] {
	const issues: MiseValidationIssue[] = [];
	const resourcesById = new Map(compiled.resources.map(resource => [resource.id, resource]));
	const eventsById = new Map(compiled.events.map(event => [event.id, event]));
	const inputsByEvent = groupBy(compiled.inputs, input => input.event_id);
	const reservationsByEvent = groupBy(compiled.reservations, reservation => reservation.event_id);
	const activeByDate = new Map<string, number>();

	for (const event of compiled.events) {
		if (event.event_type === "prep_task") {
			activeByDate.set(event.event_date, (activeByDate.get(event.event_date) || 0) + event.active_time_min);
		}

		for (const input of inputsByEvent.get(event.id) || []) {
			const resource = input.resource_lot_id ? resourcesById.get(input.resource_lot_id) : null;
			if (!resource) {
				issues.push(issue(compiled.plan_id, "hard_error", "missing_resource", `Missing resource for ${event.title}`, `${event.title} requires ${input.label}, but no resource lot is available.`, event.id, null, input.resource_ref, "Add a grocery/prep event upstream or change the meal."));
				continue;
			}
			if (resource.status === "consumed" && event.event_type !== "resource_expiry") {
				issues.push(issue(compiled.plan_id, "hard_error", "resource_consumed", `${resource.label} was already consumed before ${event.title}`, `${resource.label} is marked consumed (observation), but ${event.title} expects it.`, event.id, resource.id, resource.source_component_id, "Remake the component, substitute, or remove from this event."));
				continue;
			}
			if (resource.created_at_time && resource.created_at_time > event.start_at) {
				issues.push(issue(compiled.plan_id, "hard_error", "resource_not_ready", `${resource.label} is not ready for ${event.title}`, `${resource.label} is created at ${resource.created_at_time}, after ${event.title} starts at ${event.start_at}.`, event.id, resource.id, resource.source_component_id, "Move the prep earlier or remove this resource from the event."));
			}
			if (resource.safe_until && event.start_at > resource.safe_until) {
				issues.push(issue(compiled.plan_id, "hard_error", "resource_expired", `${resource.label} expires before ${event.title}`, `${resource.label} is safe/best until ${resource.safe_until}, but ${event.title} starts at ${event.start_at}.`, event.id, resource.id, resource.source_component_id, "Move use earlier, remake the component, or replace the meal component."));
			}
		}

		for (const reservation of reservationsByEvent.get(event.id) || []) {
			const resource = reservation.resource_lot_id ? resourcesById.get(reservation.resource_lot_id) : null;
			if (!resource) continue;
			const compatibility = compatibilityIssue(resource.label, event);
			if (compatibility) {
				issues.push(issue(compiled.plan_id, compatibility.severity, compatibility.type, compatibility.title, compatibility.detail, event.id, resource.id, reservation.component_id, compatibility.repair_hint));
			}
		}
	}

	for (const [date, activeMinutes] of activeByDate) {
		if (activeMinutes > 75) {
			issues.push(issue(compiled.plan_id, "warning", "prep_window_overloaded", `Prep on ${date} is over 75 active minutes`, `The compiled prep tasks total ${activeMinutes} active minutes on ${date}.`, null, null, null, "Move make-ahead tasks to another cook window or simplify the plan."));
		}
	}

	for (const resource of compiled.resources) {
		if (resource.resource_kind === "component" && !hasFormulaInputs(resource)) {
			issues.push(issue(compiled.plan_id, "warning", "missing_formula_inputs", `${resource.label} has no formula inputs`, `${resource.label} was created from a prep edge but does not yet carry required ingredient quantities.`, null, resource.id, resource.source_component_id, "Add a transformation formula with required inputs and yield."));
		}
		if (/^dip$|^fruit$|crunchy vegetables/i.test(resource.label)) {
			issues.push(issue(compiled.plan_id, "warning", "generic_resource_label", `${resource.label} is too generic`, `${resource.label} should be resolved to actual ingredients/components before shopping or packing.`, null, resource.id, resource.source_component_id, "Resolve generic labels into specific household resources."));
		}
	}

	return uniqueIssues(issues);
}

export async function saveMiseLedgerCompile(env: MiseGraphEnv, compiled: MiseLedgerCompileResult): Promise<{
	plan_id: string;
	resources_saved: number;
	events_saved: number;
	inputs_saved: number;
	outputs_saved: number;
	reservations_saved: number;
	validation_run_id: string;
	issues_saved: number;
}> {
	const runId = slugId("validation_run", compiled.plan_id, Date.now());
	await env.DB.prepare("DELETE FROM mise_validation_issues WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_validation_runs WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_event_inputs WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_event_outputs WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_resource_reservations WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_plan_events WHERE plan_id = ?").bind(compiled.plan_id).run();
	await env.DB.prepare("DELETE FROM mise_resource_lots WHERE plan_id = ?").bind(compiled.plan_id).run();

	for (const resource of compiled.resources) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_resource_lots
			(id, plan_id, household_id, label, resource_kind, state_id, source_component_id,
			 source_event_id, quantity, unit, storage, container, created_at_time, best_until,
			 safe_until, confidence, source, status, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			resource.id,
			resource.plan_id,
			resource.household_id,
			resource.label,
			resource.resource_kind,
			resource.state_id,
			resource.source_component_id,
			resource.source_event_id,
			resource.quantity,
			resource.unit,
			resource.storage,
			resource.container,
			resource.created_at_time,
			resource.best_until,
			resource.safe_until,
			resource.confidence,
			resource.source,
			resource.status,
			JSON.stringify(resource.meta),
		).run();
	}

	for (const event of compiled.events) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_plan_events
			(id, plan_id, event_type, title, event_date, start_at, end_at, sort_order,
			 status, active_time_min, idle_time_min, parent_event_id, source_id, locked, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			event.id,
			event.plan_id,
			event.event_type,
			event.title,
			event.event_date,
			event.start_at,
			event.end_at,
			event.sort_order,
			event.status,
			event.active_time_min,
			event.idle_time_min,
			event.parent_event_id,
			event.source_id,
			event.locked ? 1 : 0,
			JSON.stringify(event.meta),
		).run();
	}

	for (const input of compiled.inputs) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_event_inputs
			(id, plan_id, event_id, resource_lot_id, resource_ref, label, quantity, unit, required, role, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			input.id,
			input.plan_id,
			input.event_id,
			input.resource_lot_id,
			input.resource_ref,
			input.label,
			input.quantity,
			input.unit,
			input.required === false ? 0 : 1,
			input.role,
			JSON.stringify(input.meta),
		).run();
	}

	for (const output of compiled.outputs) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_event_outputs
			(id, plan_id, event_id, resource_lot_id, resource_ref, label, quantity, unit, role, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			output.id,
			output.plan_id,
			output.event_id,
			output.resource_lot_id,
			output.resource_ref,
			output.label,
			output.quantity,
			output.unit,
			output.role,
			JSON.stringify(output.meta),
		).run();
	}

	for (const reservation of compiled.reservations) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_resource_reservations
			(id, plan_id, event_id, resource_lot_id, component_id, reservation_type, quantity, unit, status, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			reservation.id,
			reservation.plan_id,
			reservation.event_id,
			reservation.resource_lot_id,
			reservation.component_id,
			reservation.reservation_type,
			reservation.quantity,
			reservation.unit,
			reservation.status,
			JSON.stringify(reservation.meta),
		).run();
	}

	await env.DB.prepare(`
		INSERT INTO mise_validation_runs
		(id, plan_id, run_kind, status, hard_error_count, warning_count, info_count, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		runId,
		compiled.plan_id,
		"ledger_compile",
		"completed",
		compiled.summary.hard_errors,
		compiled.summary.warnings,
		compiled.summary.infos,
		JSON.stringify({ compiled_at: compiled.compiled_at }),
	).run();

	for (const validationIssue of compiled.validation_issues) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_validation_issues
			(id, run_id, plan_id, severity, issue_type, title, detail, event_id,
			 resource_lot_id, component_id, repair_hint, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			validationIssue.id,
			runId,
			validationIssue.plan_id,
			validationIssue.severity,
			validationIssue.issue_type,
			validationIssue.title,
			validationIssue.detail,
			validationIssue.event_id,
			validationIssue.resource_lot_id,
			validationIssue.component_id,
			validationIssue.repair_hint,
			JSON.stringify(validationIssue.meta),
		).run();
	}

	return {
		plan_id: compiled.plan_id,
		resources_saved: compiled.resources.length,
		events_saved: compiled.events.length,
		inputs_saved: compiled.inputs.length,
		outputs_saved: compiled.outputs.length,
		reservations_saved: compiled.reservations.length,
		validation_run_id: runId,
		issues_saved: compiled.validation_issues.length,
	};
}

export async function readMiseLedger(env: MiseGraphEnv, planId: string): Promise<{
	resources: unknown[];
	events: unknown[];
	inputs: unknown[];
	outputs: unknown[];
	reservations: unknown[];
	validation_runs: unknown[];
	validation_issues: unknown[];
}> {
	const [resources, events, inputs, outputs, reservations, validationRuns, validationIssues] = await Promise.all([
		readRows(env, "mise_resource_lots", planId, "created_at_time, label"),
		readRows(env, "mise_plan_events", planId, "start_at, sort_order, title"),
		readRows(env, "mise_event_inputs", planId, "event_id, label"),
		readRows(env, "mise_event_outputs", planId, "event_id, label"),
		readRows(env, "mise_resource_reservations", planId, "event_id, component_id"),
		readRows(env, "mise_validation_runs", planId, "created_at DESC"),
		readRows(env, "mise_validation_issues", planId, "severity, issue_type, title"),
	]);
	return { resources, events, inputs, outputs, reservations, validation_runs: validationRuns, validation_issues: validationIssues };
}

export async function readMiseTimeline(env: MiseGraphEnv, planId: string): Promise<{
	events: unknown[];
	validation_issues: unknown[];
}> {
	const ledger = await readMiseLedger(env, planId);
	const issues = ledger.validation_issues as Array<Record<string, unknown>>;
	return {
		events: (ledger.events as Array<Record<string, unknown>>).map(event => ({
			...event,
			meta: parseJsonObject(event.meta_json),
			issues: issues.filter(issueRow => issueRow.event_id === event.id),
		})),
		validation_issues: issues,
	};
}

function addGroceryEvent(context: CompileContext): void {
	const plan = context.plan;
	const startAt = dateTime(plan.start_date, "10:00");
	const event: MisePlanLedgerEvent = {
		id: slugId("event", plan.id, "grocery", plan.start_date),
		plan_id: plan.id,
		event_type: "grocery_trip",
		title: `Grocery trip for ${plan.title}`,
		event_date: plan.start_date,
		start_at: startAt,
		end_at: addMinutes(startAt, 45),
		sort_order: 0,
		status: "planned",
		active_time_min: 45,
		idle_time_min: 0,
		parent_event_id: null,
		source_id: null,
		locked: false,
		meta: { shopping_list: plan.shopping_list },
	};
	context.events.push(event);
	context.groceryEvent = event;

	for (const section of plan.shopping_list) {
		for (const item of section.items) {
			const label = item.name;
			const resource = resourceLot(context, {
				id: slugId("lot", plan.id, "grocery", label),
				label,
				resource_kind: "raw",
				state_id: null,
				source_component_id: null,
				source_event_id: event.id,
				quantity: item.quantity,
				unit: item.unit,
				storage: inferStorage(label),
				container: null,
				created_at_time: event.end_at,
				best_until: null,
				safe_until: null,
				confidence: 0.55,
				source: "projected",
				status: "available",
				meta: { category: section.category, source: item.source },
			});
			context.rawResourceByLabel.set(normalizeName(label), resource);
			indexRawResourceByCanonical(context, resource);
			addOutput(context, event, resource, item.quantity, item.unit, "grocery_item");
		}
	}
	for (const ingredient of plan.selected_ingredients) {
		const key = normalizeName(ingredient);
		if (context.rawResourceByLabel.has(key)) continue;
		const resource = resourceLot(context, {
			id: slugId("lot", plan.id, "selected", ingredient),
			label: titleCase(ingredient),
			resource_kind: "raw",
			state_id: null,
			source_component_id: null,
			source_event_id: event.id,
			quantity: null,
			unit: null,
			storage: inferStorage(ingredient),
			container: null,
			created_at_time: event.end_at,
			best_until: null,
			safe_until: null,
			confidence: 0.5,
			source: "projected",
			status: "available",
			meta: { source: "selected_ingredient" },
		});
		context.rawResourceByLabel.set(key, resource);
		indexRawResourceByCanonical(context, resource);
		addOutput(context, event, resource, null, null, "selected_ingredient");
	}
}

function indexRawResourceByCanonical(context: CompileContext, resource: MiseResourceLot): void {
	const canonicals = canonicalAliasesForLabel(resource.label);
	for (const name of canonicals) {
		if (!context.rawResourceByCanonical.has(name)) {
			context.rawResourceByCanonical.set(name, resource);
		}
	}
}

function addPrepEventsAndComponentLots(context: CompileContext): void {
	for (const task of context.plan.prep_tasks) {
		const componentId = componentIdForTask(task);
		const component = componentId ? context.plan.component_batches.find(batch => batch.id === componentId) : null;
		const formula = component ? lookupFormula(context.formulas, component) : null;
		const inputResources = component ? inputResourcesForComponent(context, component, formula) : [];
		const startMinute = adjustedPrepStartMinute(
			task.scheduled_date,
			context.currentStartMinuteByDate.get(task.scheduled_date) ?? DEFAULT_PREP_START_MINUTE,
			inputResources,
		);
		const startAt = dateTimeFromMinutes(task.scheduled_date, startMinute);
		const activeFinish = addMinutes(startAt, task.active_time_min);
		const endAt = addMinutes(activeFinish, task.idle_time_min);
		context.currentStartMinuteByDate.set(task.scheduled_date, startMinute + Math.max(5, task.active_time_min));

		const event: MisePlanLedgerEvent = {
			id: task.id,
			plan_id: context.plan.id,
			event_type: task.task_type === "check" ? "audit_prompt" : "prep_task",
			title: task.title,
			event_date: task.scheduled_date,
			start_at: startAt,
			end_at: endAt,
			sort_order: task.session_order,
			status: "planned",
			active_time_min: task.active_time_min,
			idle_time_min: task.idle_time_min,
			parent_event_id: null,
			source_id: task.id,
			locked: false,
			meta: { ...task.meta, station_tags: task.station_tags, equipment: task.equipment, instructions: task.instructions },
		};
		context.events.push(event);

		if (!component) continue;

		const quantity = formula ? formula.batch_qty : component.quantity;
		const unit = formula ? formula.batch_unit : component.unit;
		const grams = formula ? formula.batch_grams : null;
		const shelfHours = formula
			? (formula.shelf_life_hours_fridge ?? formula.shelf_life_hours_pantry ?? component.quality_window_hours ?? null)
			: component.quality_window_hours;

		const resource = resourceLot(context, {
			id: slugId("lot", context.plan.id, component.id),
			label: component.label,
			resource_kind: "component",
			state_id: component.state_id,
			source_component_id: component.id,
			source_event_id: event.id,
			quantity,
			unit,
			storage: component.storage,
			container: component.container,
			created_at_time: endAt,
			best_until: shelfHours ? addHours(endAt, shelfHours) : null,
			safe_until: shelfHours ? addHours(endAt, shelfHours) : null,
			confidence: formula ? 0.85 : 0.7,
			source: "projected",
			status: "available",
			meta: {
				component,
				role_tags: inferRoleTags(component.label),
				edible_directly: edibleDirectly(component.label),
				...(formula ? {
					formula_id: formula.id,
					batch_grams: grams,
					serves: formula.serves,
					yield_ratio: formula.yield_ratio,
					make_ahead_days_min: formula.make_ahead_days_min,
					make_ahead_days_max: formula.make_ahead_days_max,
					inputs: formula.inputs,
					required_grams_total: 0,
				} : {}),
			},
		});
		context.resourceByComponentId.set(component.id, resource);
		if (component.state_id) context.resourceByStateId.set(component.state_id, resource);
		const componentCanonical = formula?.output_canonical_name || normalizeName(component.label);
		if (componentCanonical) {
			const list = context.componentResourcesByCanonical.get(componentCanonical) || [];
			list.push(resource);
			context.componentResourcesByCanonical.set(componentCanonical, list);
		}
		context.taskEventByComponentId.set(component.id, event);
		addOutput(context, event, resource, quantity, unit, "component_output");

		if (formula) {
			for (const formulaInput of formula.inputs) {
				const inputResource = resolveFormulaInputResource(context, formulaInput, event);
				addInput(
					context,
					event,
					inputResource,
					formulaInput.qty,
					formulaInput.unit,
					"transformation_input",
					formulaInput.required,
					inputResource?.source_component_id || formulaInput.canonical_name,
					formulaInput.canonical_name,
					{ grams: formulaInput.grams, role: formulaInput.role, formula_id: formula.id },
				);
			}
		} else {
			for (const inputResource of inputResources) {
				addInput(context, event, inputResource, null, null, "transformation_input", true);
			}
		}
	}
}

function resolveFormulaInputResource(
	context: CompileContext,
	input: MiseFormulaInput,
	prepEvent: MisePlanLedgerEvent,
): MiseResourceLot | null {
	const canonical = normalizeName(input.canonical_name);
	const componentCandidates = context.componentResourcesByCanonical.get(canonical);
	const componentMatch = pickValidComponentLot(componentCandidates, prepEvent.start_at);
	if (componentMatch) return componentMatch;
	const rawMatch = context.rawResourceByCanonical.get(canonical) || context.rawResourceByLabel.get(canonical);
	if (rawMatch) return rawMatch;
	const groceryEvent = context.groceryEvent;
	if (!groceryEvent) return null;
	const resource = resourceLot(context, {
		id: slugId("lot", context.plan.id, "auto", canonical),
		label: titleCase(canonical),
		resource_kind: "raw",
		state_id: null,
		source_component_id: null,
		source_event_id: groceryEvent.id,
		quantity: null,
		unit: null,
		storage: inferStorage(canonical),
		container: null,
		created_at_time: groceryEvent.end_at,
		best_until: null,
		safe_until: null,
		confidence: 0.45,
		source: "projected",
		status: "available",
		meta: { source: "auto_from_formula", added_by_event: prepEvent.id },
	});
	context.rawResourceByLabel.set(canonical, resource);
	context.rawResourceByCanonical.set(canonical, resource);
	addOutput(context, groceryEvent, resource, null, null, "auto_grocery_item");
	return resource;
}

function addMealEvents(context: CompileContext): void {
	for (const day of context.plan.meals_by_day) {
		for (const meal of day.meals) {
			addMealLikeEvent(context, meal, "meal_service");
		}
	}
}

function addBreakfastEvents(context: CompileContext): void {
	for (const breakfast of context.plan.breakfasts) {
		addMealLikeEvent(context, breakfast, "meal_service");
	}
}

function addSnackEvents(context: CompileContext): void {
	for (const snack of context.plan.snack_boxes) {
		const startAt = dateTime(snack.date, SLOT_TIMES.snack);
		const peopleForSnack = snack.people || context.plan.people;
		const event: MisePlanLedgerEvent = {
			id: snack.id,
			plan_id: context.plan.id,
			event_type: "snack_pack",
			title: snack.title,
			event_date: snack.date,
			start_at: startAt,
			end_at: addMinutes(startAt, 10),
			sort_order: 40,
			status: "planned",
			active_time_min: 10,
			idle_time_min: 0,
			parent_event_id: null,
			source_id: snack.id,
			locked: snack.locked,
			meta: { items: snack.items, people: peopleForSnack, slot: "snack" },
		};
		context.events.push(event);
		for (const componentId of snack.component_ids) {
			addReservationForComponent(context, event, componentId, "snack_component");
		}
		for (const item of snack.items) {
			if (/dip|fruit|crunchy vegetables/i.test(item)) {
				const resource = ensureGenericResource(context, item, event);
				addInput(context, event, resource, null, null, "snack_item", false);
			}
		}
	}
}

function addExpiryEvents(context: CompileContext): void {
	for (const resource of context.resources) {
		if (!resource.safe_until || resource.resource_kind !== "component") continue;
		context.events.push({
			id: slugId("event", context.plan.id, "expiry", resource.id),
			plan_id: context.plan.id,
			event_type: "resource_expiry",
			title: `${resource.label} quality window ends`,
			event_date: resource.safe_until.slice(0, 10),
			start_at: resource.safe_until,
			end_at: resource.safe_until,
			sort_order: 90,
			status: "planned",
			active_time_min: 0,
			idle_time_min: 0,
			parent_event_id: null,
			source_id: resource.id,
			locked: false,
			meta: { resource_lot_id: resource.id },
		});
	}
}

function addMealLikeEvent(context: CompileContext, meal: MisePlanMeal, eventType: "meal_service"): void {
	const startAt = dateTime(meal.date, SLOT_TIMES[meal.slot]);
	const peopleForMeal = meal.people || context.plan.people;
	const event: MisePlanLedgerEvent = {
		id: meal.id,
		plan_id: context.plan.id,
		event_type: eventType,
		title: meal.title,
		event_date: meal.date,
		start_at: startAt,
		end_at: addMinutes(startAt, meal.slot === "dinner" ? 45 : 25),
		sort_order: slotSortOrder(meal.slot),
		status: "planned",
		active_time_min: meal.slot === "dinner" ? 20 : 10,
		idle_time_min: 0,
		parent_event_id: null,
		source_id: meal.id,
		locked: meal.locked,
		meta: {
			slot: meal.slot,
			format: meal.format,
			ingredient_names: meal.ingredient_names,
			notes: meal.notes,
			people: peopleForMeal,
			cuisine: meal.cuisine,
		},
	};
	context.events.push(event);
	for (const componentId of meal.component_ids) {
		addReservationForComponent(context, event, componentId, "meal_component");
	}
}

function addReservationForComponent(context: CompileContext, event: MisePlanLedgerEvent, componentId: string, role: string): void {
	const resource = context.resourceByComponentId.get(componentId) ?? null;
	const label = resource?.label || titleCase(componentId.replace(/^mise_component:/, "").replace(/_/g, " "));
	const formulaId = resource ? stringValue(recordValue(resource.meta).formula_id) : "";
	const servingQty = perServingQuantity(resource, event, role);
	const meta: Record<string, unknown> = { role };
	if (formulaId) meta.formula_id = formulaId;
	if (servingQty.grams) meta.grams = servingQty.grams;
	context.reservations.push({
		id: slugId("reservation", event.id, componentId),
		plan_id: context.plan.id,
		event_id: event.id,
		resource_lot_id: resource?.id ?? null,
		component_id: componentId,
		reservation_type: "hard",
		quantity: servingQty.qty,
		unit: servingQty.unit,
		status: resource ? "reserved" : "broken",
		meta,
	});
	addInput(context, event, resource, servingQty.qty, servingQty.unit, role, true, componentId, label, meta);
}

function perServingQuantity(resource: MiseResourceLot | null, event: MisePlanLedgerEvent, role: string): { qty: number | null; unit: string | null; grams: number | null } {
	if (!resource) return { qty: null, unit: null, grams: null };
	const meta = recordValue(resource.meta);
	const serves = numberValue(meta.serves);
	const batchGrams = numberValue(meta.batch_grams);
	if (!serves || !batchGrams) return { qty: resource.quantity, unit: resource.unit, grams: null };
	const eventMeta = recordValue(event.meta);
	const slot = stringValue(eventMeta.slot);
	const isSnack = role === "snack_component" || event.event_type === "snack_pack" || slot === "snack";
	const portionFactor = isSnack ? 0.5 : 1.0;
	const peopleAtMeal = numberValue(eventMeta.people) || 1;
	const gramsPerPerson = batchGrams / serves;
	const totalGrams = gramsPerPerson * peopleAtMeal * portionFactor;
	return { qty: Math.round(totalGrams), unit: "g", grams: Math.round(totalGrams) };
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function addInput(
	context: CompileContext,
	event: MisePlanLedgerEvent,
	resource: MiseResourceLot | null,
	quantity: number | null,
	unit: string | null,
	role: string,
	required: boolean,
	resourceRef?: string | null,
	label?: string,
	meta: Record<string, unknown> = {},
): void {
	context.inputs.push({
		id: slugId("input", event.id, resource?.id || resourceRef || label || role),
		plan_id: context.plan.id,
		event_id: event.id,
		resource_lot_id: resource?.id ?? null,
		resource_ref: resourceRef ?? resource?.source_component_id ?? resource?.state_id ?? null,
		label: label || resource?.label || resourceRef || "unknown resource",
		quantity,
		unit,
		required,
		role,
		meta,
	});
}

function addOutput(context: CompileContext, event: MisePlanLedgerEvent, resource: MiseResourceLot, quantity: number | null, unit: string | null, role: string): void {
	context.outputs.push({
		id: slugId("output", event.id, resource.id),
		plan_id: context.plan.id,
		event_id: event.id,
		resource_lot_id: resource.id,
		resource_ref: resource.source_component_id ?? resource.state_id,
		label: resource.label,
		quantity,
		unit,
		role,
		meta: {},
	});
}

function resourceLot(context: CompileContext, input: Omit<MiseResourceLot, "plan_id" | "household_id">): MiseResourceLot {
	const existing = context.resources.find(resource => resource.id === input.id);
	if (existing) return existing;
	const resource: MiseResourceLot = {
		plan_id: context.plan.id,
		household_id: context.plan.household_id,
		...input,
	};
	context.resources.push(resource);
	return resource;
}

function inputResourcesForComponent(
	context: CompileContext,
	component: MisePlanComponentBatch,
	formula: MiseFormula | null,
): MiseResourceLot[] {
	if (formula) {
		const resources: MiseResourceLot[] = [];
		for (const input of formula.inputs) {
			const canonical = normalizeName(input.canonical_name);
			const componentCandidates = context.componentResourcesByCanonical.get(canonical);
			const componentMatch = pickLatestComponentLot(componentCandidates);
			if (componentMatch) {
				resources.push(componentMatch);
				continue;
			}
			const rawMatch = context.rawResourceByCanonical.get(canonical) || context.rawResourceByLabel.get(canonical);
			if (rawMatch) resources.push(rawMatch);
		}
		if (resources.length) return resources;
	}
	const edge = recordValue(recordValue(component.meta).edge);
	const fromStateId = stringValue(edge.from_state_id);
	if (fromStateId) {
		const stateResource = context.resourceByStateId.get(fromStateId);
		if (stateResource) return [stateResource];
		const fromLabel = stringValue(edge.from_label) || stringValue(edge.from_display_name) || stringValue(edge.from_state_id) || "raw ingredient";
		return [ensureGenericResource(context, fromLabel, context.events[0])];
	}
	return component.input_names.map(name => ensureGenericResource(context, name, context.events[0]));
}

function lookupFormula(formulas: MiseFormulaIndex, component: MisePlanComponentBatch): MiseFormula | null {
	if (component.state_id) {
		const byState = formulas.by_state_id.get(component.state_id);
		if (byState) return byState;
	}
	const labelKey = normalizeName(component.label);
	const byLabel = formulas.by_label.get(labelKey);
	if (byLabel) return byLabel;
	for (const candidate of formulas.by_canonical.values()) {
		if (normalizeName(candidate.output_label) === labelKey) return candidate;
	}
	return null;
}

const CANONICAL_LABEL_ALIASES: Record<string, string[]> = {
	"chickpea": ["chickpea", "chickpeas", "garbanzo", "garbanzo bean", "dry chickpea", "dry chickpeas"],
	"cooked chickpea": ["cooked chickpea", "cooked chickpeas", "cooked whole chickpeas"],
	"tahini": ["tahini", "sesame butter"],
	"olive oil": ["olive oil", "extra virgin olive oil", "evoo"],
	"lemon juice": ["lemon juice", "lemon"],
	"all-purpose flour": ["all-purpose flour", "all purpose flour", "ap flour", "flour", "wheat flour", "bread flour"],
	"parsley": ["parsley", "italian parsley", "flat leaf parsley"],
	"mint": ["mint", "spearmint"],
	"cilantro": ["cilantro", "coriander leaves"],
	"radish": ["radish", "radishes"],
	"asparagus": ["asparagus"],
	"strawberry": ["strawberry", "strawberries"],
	"cucumber": ["cucumber", "cucumbers"],
	"garlic": ["garlic"],
	"rolled oats": ["rolled oats", "oats", "old fashioned oats", "oatmeal"],
	"chia seed": ["chia seed", "chia seeds", "chia"],
	"yogurt": ["yogurt", "plain yogurt", "greek yogurt"],
	"milk": ["milk", "whole milk", "almond milk", "oat milk", "plant milk"],
	"salt": ["salt", "kosher salt", "sea salt", "table salt"],
	"sugar": ["sugar", "granulated sugar", "white sugar"],
	"water": ["water"],
	"vinegar": ["vinegar", "rice vinegar", "white vinegar", "apple cider vinegar"],
	"yeast": ["yeast", "active dry yeast", "instant yeast"],
	"cumin": ["cumin", "ground cumin"],
	"maple syrup": ["maple syrup", "honey", "agave"],
	"hummus": ["hummus"],
	"falafel mix": ["falafel mix"],
	"crispy chickpea": ["crispy chickpea", "crispy chickpeas"],
	"lemon tahini sauce": ["lemon tahini sauce", "tahini sauce"],
	"herb yogurt": ["herb yogurt", "herb yogurt sauce"],
	"quick pickled radish": ["quick pickled radish", "quick pickled radishes", "pickled radish"],
	"fermented dough": ["fermented dough", "cold-fermented dough", "dough", "pizza dough", "pita dough"],
	"chia pudding": ["chia pudding"],
	"overnight oats": ["overnight oats"],
};

function pickValidComponentLot(candidates: MiseResourceLot[] | undefined, atTime: string): MiseResourceLot | null {
	if (!candidates || candidates.length === 0) return null;
	const valid = candidates.filter(lot =>
		(!lot.created_at_time || lot.created_at_time <= atTime)
		&& (!lot.safe_until || lot.safe_until >= atTime)
	);
	if (valid.length) {
		valid.sort((a, b) => (b.created_at_time || "").localeCompare(a.created_at_time || ""));
		return valid[0];
	}
	const upcoming = candidates.filter(lot => lot.created_at_time && lot.created_at_time <= atTime);
	upcoming.sort((a, b) => (b.created_at_time || "").localeCompare(a.created_at_time || ""));
	return upcoming[0] || candidates[0];
}

function pickLatestComponentLot(candidates: MiseResourceLot[] | undefined): MiseResourceLot | null {
	if (!candidates || candidates.length === 0) return null;
	const sorted = [...candidates].sort((a, b) => (b.created_at_time || "").localeCompare(a.created_at_time || ""));
	return sorted[0];
}

function canonicalAliasesForLabel(label: string): string[] {
	const normalized = normalizeName(label);
	const matches = new Set<string>();
	matches.add(normalized);
	for (const [canonical, aliases] of Object.entries(CANONICAL_LABEL_ALIASES)) {
		if (aliases.some(alias => normalized === alias || normalized.includes(alias))) {
			matches.add(canonical);
		}
	}
	return Array.from(matches);
}

function adjustedPrepStartMinute(date: string, currentStartMinute: number, inputResources: MiseResourceLot[]): number {
	let startMinute = currentStartMinute;
	for (const resource of inputResources) {
		if (!resource.created_at_time || resource.created_at_time.slice(0, 10) !== date) continue;
		startMinute = Math.max(startMinute, minuteOfDay(resource.created_at_time));
	}
	return startMinute;
}

function minuteOfDay(value: string): number {
	const time = value.slice(11, 16);
	const [hours, minutes] = time.split(":").map(part => Number(part));
	return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function ensureGenericResource(context: CompileContext, label: string, sourceEvent: MisePlanLedgerEvent): MiseResourceLot {
	const key = normalizeName(label);
	const existing = context.rawResourceByLabel.get(key);
	if (existing) return existing;
	const resource = resourceLot(context, {
		id: slugId("lot", context.plan.id, "generic", label),
		label: titleCase(label),
		resource_kind: "raw",
		state_id: null,
		source_component_id: null,
		source_event_id: sourceEvent.id,
		quantity: null,
		unit: null,
		storage: inferStorage(label),
		container: null,
		created_at_time: sourceEvent.end_at,
		best_until: null,
		safe_until: null,
		confidence: 0.35,
		source: "projected",
		status: "available",
		meta: { source: "generic_requirement" },
	});
	context.rawResourceByLabel.set(key, resource);
	return resource;
}

function componentIdForTask(task: MisePlanTask): string | null {
	const fromMeta = recordValue(task.meta).component_id;
	if (typeof fromMeta === "string") return fromMeta;
	const output = task.state_outputs.find(value => value.startsWith("mise_component:"));
	return output || null;
}

function compatibilityIssue(resourceLabel: string, event: MisePlanLedgerEvent): {
	severity: MiseValidationSeverity;
	type: string;
	title: string;
	detail: string;
	repair_hint: string;
} | null {
	const label = normalizeName(resourceLabel);
	const slot = normalizeName(recordValue(event.meta).slot);
	const format = normalizeName(recordValue(event.meta).format || event.title);
	if (/soaked chickpea|falafel mix/.test(label)) {
		return {
			severity: "hard_error",
			type: "inedible_intermediate_consumed",
			title: `${resourceLabel} is an intermediate, not a ready meal component`,
			detail: `${resourceLabel} is reserved for ${event.title}, but it needs another cook/finish transformation first.`,
			repair_hint: "Schedule the downstream cooking task or swap in a ready edible component.",
		};
	}
	if (slot === "breakfast" && /tahini|hummus|pickle|radish|chickpea|falafel/.test(label)) {
		return {
			severity: "hard_error",
			type: "format_incompatible",
			title: `${resourceLabel} does not fit breakfast`,
			detail: `${resourceLabel} is reserved for ${event.title}, but the component is tagged savory in this prototype.`,
			repair_hint: "Use fruit, oats, yogurt, chia, jam, or another breakfast-compatible component.",
		};
	}
	if ((slot === "lunch" || slot === "dinner") && /jam|syrup|sweet/.test(label) && !/dessert|breakfast|toast|yogurt/.test(format)) {
		return {
			severity: "hard_error",
			type: "format_incompatible",
			title: `${resourceLabel} does not fit ${event.title}`,
			detail: `${resourceLabel} is a sweet component reserved for a savory ${slot}.`,
			repair_hint: "Reserve it for breakfast/snacks or replace it with a savory sauce/pickle/crunch.",
		};
	}
	return null;
}

function hasFormulaInputs(resource: MiseResourceLot): boolean {
	const component = recordValue(resource.meta.component);
	return Array.isArray(component.input_names) && component.input_names.length > 0
		|| Array.isArray(component.core_ingredients) && component.core_ingredients.length > 0
		|| Array.isArray(component.common_ingredients) && component.common_ingredients.length > 0
		|| Array.isArray(recordValue(resource.meta.component).input_names) && Array.isArray(recordValue(resource.meta.component).input_names);
}

function issue(
	planId: string,
	severity: MiseValidationSeverity,
	issueType: string,
	title: string,
	detail: string,
	eventId: string | null,
	resourceLotId: string | null,
	componentId: string | null | undefined,
	repairHint: string | null,
): MiseValidationIssue {
	return {
		id: slugId("issue", planId, issueType, eventId || "plan", resourceLotId || componentId || title).slice(0, 240),
		plan_id: planId,
		severity,
		issue_type: issueType,
		title,
		detail,
		event_id: eventId,
		resource_lot_id: resourceLotId,
		component_id: componentId || null,
		repair_hint: repairHint,
		meta: {},
	};
}

function uniqueIssues(issues: MiseValidationIssue[]): MiseValidationIssue[] {
	const seen = new Set<string>();
	const results: MiseValidationIssue[] = [];
	for (const validationIssue of issues) {
		const key = `${validationIssue.severity}:${validationIssue.issue_type}:${validationIssue.event_id}:${validationIssue.resource_lot_id}:${validationIssue.title}`;
		if (seen.has(key)) continue;
		seen.add(key);
		results.push(validationIssue);
	}
	return results
		.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.issue_type.localeCompare(b.issue_type) || a.title.localeCompare(b.title))
		.map((validationIssue, index) => ({
			...validationIssue,
			id: slugId("issue", validationIssue.plan_id, index + 1, validationIssue.issue_type),
		}));
}

function withSummary(result: MiseLedgerCompileResult): MiseLedgerCompileResult {
	const hardErrors = result.validation_issues.filter(issueRow => issueRow.severity === "hard_error").length;
	const warnings = result.validation_issues.filter(issueRow => issueRow.severity === "warning").length;
	const infos = result.validation_issues.filter(issueRow => issueRow.severity === "info").length;
	return {
		...result,
		summary: {
			resource_count: result.resources.length,
			event_count: result.events.length,
			reservation_count: result.reservations.length,
			hard_errors: hardErrors,
			warnings,
			infos,
		},
	};
}

function emptySummary(): MiseLedgerCompileResult["summary"] {
	return { resource_count: 0, event_count: 0, reservation_count: 0, hard_errors: 0, warnings: 0, infos: 0 };
}

async function readRows(env: MiseGraphEnv, table: string, planId: string, orderBy: string): Promise<unknown[]> {
	const rows = await env.DB.prepare(`
		SELECT *
		FROM ${table}
		WHERE plan_id = ?
		ORDER BY ${orderBy}
	`).bind(planId).all<Record<string, unknown>>();
	return (rows.results || []).map(row => parseJsonColumns(row));
}

function parseJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
	const parsed = { ...row };
	for (const [key, value] of Object.entries(row)) {
		if (key.endsWith("_json")) {
			parsed[key.replace(/_json$/, "")] = parseJsonObjectOrArray(value);
		}
	}
	return parsed;
}

function parseJsonObjectOrArray(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	const parsed = parseJsonObjectOrArray(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const groupKey = key(item);
		const group = groups.get(groupKey) || [];
		group.push(item);
		groups.set(groupKey, group);
	}
	return groups;
}

function inferRoleTags(label: string): string[] {
	const normalized = normalizeName(label);
	if (/hummus|dip/.test(normalized)) return ["dip", "spread"];
	if (/sauce|dressing|tahini/.test(normalized)) return ["sauce", "dressing"];
	if (/pickle|radish/.test(normalized)) return ["pickle", "acid", "crunch"];
	if (/crispy|crunch/.test(normalized)) return ["crunch", "topping"];
	if (/jam|syrup|strawberry/.test(normalized)) return ["sweet", "breakfast"];
	if (/chickpea|lentil|bean/.test(normalized)) return ["protein"];
	return ["component"];
}

function edibleDirectly(label: string): boolean {
	return !/soaked chickpea|falafel mix/.test(normalizeName(label));
}

function inferStorage(label: string): string {
	const normalized = normalizeName(label);
	if (/dry|flour|grain|nut|seed|sugar/.test(normalized)) return "pantry";
	return "refrigerated";
}

function slotSortOrder(slot: MiseMealSlot): number {
	if (slot === "breakfast") return 10;
	if (slot === "lunch") return 20;
	if (slot === "snack") return 30;
	return 40;
}

function dateTime(date: string, time: string): string {
	return `${date}T${time}:00`;
}

function dateTimeFromMinutes(date: string, minutes: number): string {
	const hour = Math.floor(minutes / 60);
	const minute = minutes % 60;
	return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function addMinutes(value: string, minutes: number): string {
	const parsed = new Date(`${value.replace(" ", "T")}.000Z`);
	parsed.setUTCMinutes(parsed.getUTCMinutes() + minutes);
	return parsed.toISOString().slice(0, 19);
}

function addHours(value: string, hours: number): string {
	return addMinutes(value, hours * 60);
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
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

function severityRank(severity: MiseValidationSeverity): number {
	if (severity === "hard_error") return 0;
	if (severity === "warning") return 1;
	return 2;
}

function aggregateShoppingQuantities(context: CompileContext): void {
	const totals = new Map<string, { grams: number; qty: number | null; unit: string | null; events: Set<string> }>();
	for (const input of context.inputs) {
		if (input.role !== "transformation_input") continue;
		const resource = input.resource_lot_id ? context.resources.find(item => item.id === input.resource_lot_id) : null;
		if (!resource || resource.resource_kind !== "raw") continue;
		const meta = recordValue(input.meta);
		const grams = numberValue(meta.grams) || 0;
		const entry = totals.get(resource.id) || { grams: 0, qty: null, unit: null, events: new Set<string>() };
		entry.grams += grams;
		entry.qty = (entry.qty ?? 0) + (input.quantity ?? 0);
		entry.unit = entry.unit || input.unit;
		entry.events.add(input.event_id);
		totals.set(resource.id, entry);
	}
	for (const resource of context.resources) {
		const totalsForResource = totals.get(resource.id);
		if (!totalsForResource) continue;
		const wasteFactor = 1.1;
		const requiredGrams = Math.ceil(totalsForResource.grams * wasteFactor);
		resource.meta = {
			...recordValue(resource.meta),
			required_grams_total: requiredGrams,
			required_consumer_events: Array.from(totalsForResource.events),
			shopping_total_qty: totalsForResource.qty,
			shopping_total_unit: totalsForResource.unit,
		};
		if (resource.quantity == null && totalsForResource.unit && totalsForResource.qty) {
			resource.quantity = Math.ceil(totalsForResource.qty * wasteFactor * 100) / 100;
			resource.unit = totalsForResource.unit;
		}
	}
}

export async function loadMiseFormulas(env: MiseGraphEnv): Promise<MiseFormulaIndex> {
	const index: MiseFormulaIndex = {
		by_state_id: new Map(),
		by_label: new Map(),
		by_canonical: new Map(),
		unit_conversions: new Map(),
	};
	try {
		const formulasResult = await env.DB.prepare(`
			SELECT id, output_state_id, output_label, output_canonical_name,
				batch_qty, batch_unit, batch_grams, serves, yield_ratio, inputs_json,
				shelf_life_hours_fridge, shelf_life_hours_pantry, shelf_life_hours_freezer,
				make_ahead_days_min, make_ahead_days_max, make_ahead_best_min, make_ahead_best_max,
				active_time_min, idle_time_min, equipment_json
			FROM mise_formulas
		`).all<Record<string, unknown>>();
		for (const row of formulasResult.results || []) {
			const formula: MiseFormula = {
				id: stringValue(row.id),
				output_state_id: stringValue(row.output_state_id) || null,
				output_label: stringValue(row.output_label),
				output_canonical_name: stringValue(row.output_canonical_name) || null,
				batch_qty: numberValue(row.batch_qty) ?? 0,
				batch_unit: stringValue(row.batch_unit),
				batch_grams: numberValue(row.batch_grams) ?? 0,
				serves: numberValue(row.serves),
				yield_ratio: numberValue(row.yield_ratio),
				inputs: (parseJsonValue(row.inputs_json) as MiseFormulaInput[] | null) || [],
				shelf_life_hours_fridge: numberValue(row.shelf_life_hours_fridge),
				shelf_life_hours_pantry: numberValue(row.shelf_life_hours_pantry),
				shelf_life_hours_freezer: numberValue(row.shelf_life_hours_freezer),
				make_ahead_days_min: numberValue(row.make_ahead_days_min),
				make_ahead_days_max: numberValue(row.make_ahead_days_max),
				make_ahead_best_min: numberValue(row.make_ahead_best_min),
				make_ahead_best_max: numberValue(row.make_ahead_best_max),
				active_time_min: numberValue(row.active_time_min),
				idle_time_min: numberValue(row.idle_time_min),
				equipment: (parseJsonValue(row.equipment_json) as string[] | null) || [],
			};
			if (formula.output_state_id) index.by_state_id.set(formula.output_state_id, formula);
			index.by_label.set(normalizeName(formula.output_label), formula);
			if (formula.output_canonical_name) index.by_canonical.set(normalizeName(formula.output_canonical_name), formula);
		}
	} catch (error) {
		// Table may not exist yet on a fresh D1; treat as empty index.
	}
	try {
		const conversionsResult = await env.DB.prepare(`
			SELECT canonical_name, unit, grams FROM mise_unit_conversions
		`).all<{ canonical_name: string; unit: string; grams: number }>();
		for (const row of conversionsResult.results || []) {
			const inner = index.unit_conversions.get(row.canonical_name) || new Map<string, number>();
			inner.set(row.unit, row.grams);
			index.unit_conversions.set(row.canonical_name, inner);
		}
	} catch (error) {
		// Table may not exist yet on a fresh D1.
	}
	return index;
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
