// validators-extended.ts
// ----------------------------------------------------------------------------
// Extended structural validators that run after the main ledger compile.
//
// COOKING LOGIC ENCODED HERE
// --------------------------
// The main ledger validator (validateCompiledLedger) checks that every
// resource needed for a meal exists, isn't expired, and is in a compatible
// format. It does NOT check whether a meal is structurally complete as a
// dish — i.e. "does this taste like food?" That's what we add here.
//
// We layer two additional validators on top:
//
//   1. flavor-validator.ts — for every cooked-savory meal, check that the
//      five-element rule (fat / acid / salt / texture contrast / protein +
//      veg-grain anchor) is satisfied. Misses produce hard_error in dinners
//      and warning in lunches/savory breakfasts.
//
//   2. cuisine-grammar.ts — for every meal tagged with a cuisine, check
//      that the dish actually fits that cuisine's required structural
//      elements (e.g. Mexican needs nixtamal grain + chile-driven salsa +
//      lime acid; Indian needs aromatic spice base bloomed in fat).
//
// SCOPE
// -----
//   - Run on every meal in plan.meals_by_day[*].meals[*].
//   - Run on every meal in plan.breakfasts[*].
//   - SKIP plan.snack_boxes[*] entirely. Snack boxes are intentionally
//     small; they don't need protein, fat, acid balance, or cuisine
//     grammar (they're "olives and a chunk of cheese", not a composed
//     dish).
//
// OUTPUT
// ------
// Each issue is wrapped in the shared MiseValidationIssue-compatible shape
// (plan_id + event_id + severity + issue_type + title + detail + repair_hint
// + component_id? + resource_lot_id?). The integrator (next session) merges
// these into the MiseValidationIssue[] flow that route handlers already use.
// ----------------------------------------------------------------------------

import {
	validateMealFlavorStructure,
	type FlavorIssue,
	type FormulaIndex,
	type FormulaLike,
	type MealForValidation,
	type RawIngredientLike,
} from "./flavor-validator";
import { validateMealCuisineGrammar, type CuisineGrammarIssue } from "./cuisine-grammar";

// ---- Output shapes --------------------------------------------------------

export type ExtendedIssueSeverity = "hard_error" | "warning" | "info";

export interface ExtendedValidationIssue {
	plan_id?: string;
	event_id: string;
	severity: ExtendedIssueSeverity;
	issue_type: string;
	title: string;
	detail: string;
	repair_hint?: string;
	component_id?: string;
	resource_lot_id: null;
}

export interface ExtendedValidatorResult {
	flavor_issues: ExtendedValidationIssue[];
	cuisine_issues: ExtendedValidationIssue[];
}

// ---- Loose plan / formulas shapes -----------------------------------------
// We accept `any` at the boundary so callers can pass either the strongly-
// typed MiseWeeklyPlanDraft / MiseFormulaIndex from ledger.ts/planner.ts, or
// a hand-built test fixture, without us depending on those modules.

interface PlanLike {
	id?: string | null;
	meals_by_day?: Array<{ meals?: MealLike[] }>;
	breakfasts?: MealLike[];
	component_batches?: Array<{
		id?: string;
		meta?: { formula_id?: string | null; [k: string]: unknown };
	}>;
}

interface MealLike {
	id?: string;
	title?: string;
	slot?: string;
	cuisine?: string[] | null;
	format?: string | null;
	component_ids?: string[] | null;
	raw_ingredients?: RawIngredientLike[] | null;
	formula_ids?: string[] | null;
	method_summary?: string | null;
}

// What ledger.ts's MiseFormulaIndex looks like — keyed by label / canonical
// / state_id, plus a unit_conversions map. We don't import it directly to
// avoid a hard dependency on ledger.ts (which a sibling session is editing).
interface FormulaIndexLike {
	by_state_id?: Map<string, FormulaIndexEntry>;
	by_label?: Map<string, FormulaIndexEntry>;
	by_canonical?: Map<string, FormulaIndexEntry>;
}

interface FormulaIndexEntry {
	id?: string;
	output_label?: string;
	output_canonical_name?: string | null;
	inputs?: Array<{
		canonical_name?: string;
		role?: string;
		qty?: number;
		unit?: string;
		grams?: number;
	}>;
}

// ---- Public entry point ---------------------------------------------------

export function runExtendedValidators(
	plan: any,
	formulas: any,
): ExtendedValidatorResult {
	const planLike = (plan || {}) as PlanLike;
	const planId = typeof plan?.id === "string" ? plan.id : undefined;

	const formulaByIdIndex = buildFormulaByIdIndex(formulas as FormulaIndexLike | null | undefined);
	const componentIdToFormulaId = buildComponentIdToFormulaId(planLike);

	const flavorIssues: ExtendedValidationIssue[] = [];
	const cuisineIssues: ExtendedValidationIssue[] = [];

	const dinnerMeals: MealLike[] = [];
	for (const day of planLike.meals_by_day || []) {
		for (const meal of day.meals || []) dinnerMeals.push(meal);
	}
	const breakfastMeals = planLike.breakfasts || [];
	const allMeals = [...dinnerMeals, ...breakfastMeals];

	for (const meal of allMeals) {
		const adapted = adaptMeal(meal, componentIdToFormulaId);
		if (!adapted) continue;

		const flavor = validateMealFlavorStructure(adapted, formulaByIdIndex);
		for (const issue of flavor) {
			flavorIssues.push(wrapFlavorIssue(issue, adapted, planId));
		}

		const cuisine = validateMealCuisineGrammar(adapted, formulaByIdIndex);
		for (const issue of cuisine) {
			cuisineIssues.push(wrapCuisineIssue(issue, adapted, planId));
		}
	}

	return {
		flavor_issues: flavorIssues,
		cuisine_issues: cuisineIssues,
	};
}

// ---- Wrapping issues to the shared shape ----------------------------------

function wrapFlavorIssue(
	issue: FlavorIssue,
	meal: MealForValidation,
	planId: string | undefined,
): ExtendedValidationIssue {
	const wrapped: ExtendedValidationIssue = {
		event_id: meal.id,
		severity: issue.severity,
		issue_type: issue.issue_type,
		title: issue.title,
		detail: issue.detail,
		resource_lot_id: null,
	};
	if (planId) wrapped.plan_id = planId;
	if (issue.repair_hint) wrapped.repair_hint = issue.repair_hint;
	return wrapped;
}

function wrapCuisineIssue(
	issue: CuisineGrammarIssue,
	meal: MealForValidation,
	planId: string | undefined,
): ExtendedValidationIssue {
	const severity: ExtendedIssueSeverity = issue.severity === "info" ? "info" : "warning";
	const wrapped: ExtendedValidationIssue = {
		event_id: meal.id,
		severity,
		issue_type: issue.issue_type,
		title: issue.title,
		detail: issue.detail,
		resource_lot_id: null,
	};
	if (planId) wrapped.plan_id = planId;
	if (issue.repair_hint) wrapped.repair_hint = issue.repair_hint;
	return wrapped;
}

// ---- Adapters -------------------------------------------------------------

function adaptMeal(
	meal: MealLike | null | undefined,
	componentIdToFormulaId: Map<string, string>,
): MealForValidation | null {
	if (!meal) return null;
	const id = typeof meal.id === "string" ? meal.id : "";
	if (!id) return null;
	const slot = normalizeSlot(meal.slot);
	if (!slot) return null;

	// Derive formula_ids from component_ids when the meal doesn't carry them.
	let formulaIds = (meal.formula_ids || []).filter((v): v is string => typeof v === "string" && v.length > 0);
	if (formulaIds.length === 0 && meal.component_ids) {
		const derived: string[] = [];
		for (const cid of meal.component_ids) {
			if (typeof cid !== "string") continue;
			const fid = componentIdToFormulaId.get(cid);
			if (fid) derived.push(fid);
		}
		formulaIds = derived;
	}

	return {
		id,
		title: typeof meal.title === "string" ? meal.title : id,
		slot,
		cuisine: Array.isArray(meal.cuisine) ? meal.cuisine.filter((v): v is string => typeof v === "string") : [],
		format: typeof meal.format === "string" ? meal.format : "",
		component_ids: Array.isArray(meal.component_ids) ? meal.component_ids.filter((v): v is string => typeof v === "string") : [],
		raw_ingredients: Array.isArray(meal.raw_ingredients) ? (meal.raw_ingredients as RawIngredientLike[]) : [],
		formula_ids: formulaIds,
		method_summary: typeof meal.method_summary === "string" ? meal.method_summary : null,
	};
}

function normalizeSlot(value: unknown): MealForValidation["slot"] | null {
	if (typeof value !== "string") return null;
	const lower = value.toLowerCase();
	if (lower === "breakfast" || lower === "lunch" || lower === "dinner" || lower === "snack") return lower;
	return null;
}

function buildComponentIdToFormulaId(plan: PlanLike): Map<string, string> {
	const map = new Map<string, string>();
	for (const batch of plan.component_batches || []) {
		const cid = typeof batch.id === "string" ? batch.id : null;
		const fid = typeof batch.meta?.formula_id === "string" ? batch.meta.formula_id : null;
		if (cid && fid) map.set(cid, fid);
	}
	return map;
}

function buildFormulaByIdIndex(index: FormulaIndexLike | null | undefined): FormulaIndex {
	const byId = new Map<string, FormulaLike>();
	if (!index) return { by_id: byId };

	const sources: Array<Map<string, FormulaIndexEntry> | undefined> = [
		index.by_state_id,
		index.by_label,
		index.by_canonical,
	];

	for (const source of sources) {
		if (!source) continue;
		for (const entry of source.values()) {
			if (!entry) continue;
			const id = typeof entry.id === "string" ? entry.id : null;
			if (!id || byId.has(id)) continue;
			const formulaLike: FormulaLike = {
				output_label: entry.output_label,
				output_canonical_name: entry.output_canonical_name ?? null,
				inputs: (entry.inputs || []).map(input => ({
					canonical_name: input.canonical_name || "",
					role: input.role || "",
					qty: input.qty,
					unit: input.unit,
					grams: input.grams,
				})),
			};
			if (entry.output_label) formulaLike.label = entry.output_label;
			byId.set(id, formulaLike);
		}
	}

	return { by_id: byId };
}
