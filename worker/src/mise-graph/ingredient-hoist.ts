// Ingredient hoist — cross-meal batching post-pass.
//
// The composer plans each meal in isolation. That leaves an obvious win on the
// table: when 5 different meals each call for 1/2 cup chopped cilantro, we
// should chop one bigger pile on Sunday and portion into the meals.
//
// hoistRepeatedRawIngredients() walks every meal in a finished plan, groups
// raw_ingredients by canonical_name, and emits two kinds of suggestions:
//
//   1. ingredient_clusters — "this raw ingredient appears in N meals, do
//      the discrete prep step (chop / juice / grind) once and portion it."
//      These are conservative, well-scoped batching wins.
//
//   2. proposed_formulas — "this looks like a stored component (salsa,
//      vinaigrette, herb oil) showing up across meals — propose forming a
//      formula." Only emitted when there's a clear pattern of supporting
//      ingredients across meals; bias is toward fewer false positives.
//
// The integrator wires this into planner.ts as a post-pass and surfaces the
// suggestions to the user (or auto-applies if confidence is high enough).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HoistOptions {
	min_uses?: number;
}

export interface HoistResult {
	proposed_formulas: ProposedFormula[];
	ingredient_clusters: IngredientCluster[];
}

export interface ProposedFormula {
	canonical_name: string;
	output_label: string;
	total_grams_estimated: number;
	affected_meal_ids: string[];
	suggested_prep_date: string;
	reasoning: string;
}

export interface IngredientCluster {
	canonical_name: string;
	total_qty?: number;
	total_grams?: number;
	affected_meal_ids: string[];
	suggested_action: ClusterAction;
	reasoning: string;
}

export type ClusterAction = "batch_chop" | "batch_juice" | "batch_grind" | "pre_portion";

// ---------------------------------------------------------------------------
// Detection rules.
//
// These are kept narrow on purpose. Hoisting suggestions need to be obviously
// correct or the user loses trust — better to miss a few than to suggest
// "batch chop your salt." Volume thresholds reflect the point where setting
// up a board / juicer / grinder is justified.
// ---------------------------------------------------------------------------

const CHOP_HERBS = new Set([
	"cilantro", "parsley", "mint", "dill", "scallion", "green onion",
	"chive", "chives", "tarragon", "basil",
]);

const JUICE_CITRUS = new Set([
	"lemon", "lime", "orange", "grapefruit", "yuzu",
]);

const GRIND_WHOLE_SPICES = new Set([
	"cumin seed", "cumin seeds", "coriander seed", "coriander seeds",
	"peppercorn", "peppercorns", "black peppercorn", "black peppercorns",
	"fennel seed", "fennel seeds", "mustard seed", "mustard seeds",
	"cardamom pod", "cardamom pods", "clove", "cloves", "star anise",
]);

// Formula candidates: canonical_name → ( supporting set, formula label ).
// We propose a stored component only if a meal containing the candidate ALSO
// contains all (or nearly all) supporting ingredients, AND this happens
// repeatedly. Conservative on purpose.
interface FormulaCandidate {
	canonical_name: string;
	output_label: string;
	supporting_required: string[];   // must all be present
	supporting_optional: string[];   // bonus signal
	min_meals: number;
	min_grams_each: number;
}

const FORMULA_CANDIDATES: FormulaCandidate[] = [
	{
		canonical_name: "salsa",
		output_label: "Salsa Verde / Pico",
		supporting_required: ["lime", "cilantro"],
		supporting_optional: ["jalapeno", "onion", "tomato", "tomatillo", "chile"],
		min_meals: 3,
		min_grams_each: 30,
	},
	{
		canonical_name: "vinaigrette",
		output_label: "House Vinaigrette",
		supporting_required: ["olive oil", "vinegar"],
		supporting_optional: ["mustard", "shallot", "lemon", "honey", "garlic"],
		min_meals: 3,
		min_grams_each: 20,
	},
	{
		canonical_name: "herb oil",
		output_label: "Green Herb Oil",
		supporting_required: ["olive oil"],
		supporting_optional: ["parsley", "cilantro", "basil", "chive", "chives", "garlic"],
		min_meals: 3,
		min_grams_each: 15,
	},
	{
		canonical_name: "marinade",
		output_label: "Standing Marinade",
		supporting_required: ["olive oil", "garlic"],
		supporting_optional: ["lemon", "yogurt", "soy sauce", "vinegar", "herb"],
		min_meals: 3,
		min_grams_each: 25,
	},
];

// Per-cluster volume thresholds — below this we don't suggest hoisting (the
// effort of batching exceeds the per-meal effort).
const MIN_CLUSTER_GRAMS_FOR_CHOP = 30;     // ~1/2 cup chopped herb
const MIN_CLUSTER_QTY_FOR_JUICE = 2;       // 2 lemons / limes
const MIN_CLUSTER_GRAMS_FOR_GRIND = 10;    // a couple tablespoons of whole spices

// ---------------------------------------------------------------------------
// Plan-shape (loose) — we accept anything the planner emits without coupling
// to the full MiseWeeklyPlanDraft type, so the post-pass can run on either
// the in-memory draft or a re-parsed JSON plan.
// ---------------------------------------------------------------------------

interface PlanShape {
	start_date?: string;
	end_date?: string;
	meals_by_day?: Array<{
		date?: string;
		meals?: PlanMealShape[];
	}>;
	breakfasts?: PlanMealShape[];
	snack_boxes?: PlanSnackShape[];
}

interface PlanMealShape {
	id?: string;
	date?: string;
	title?: string;
	raw_ingredients?: PlanRawIngredient[];
}

interface PlanSnackShape {
	id?: string;
	date?: string;
	title?: string;
	raw_ingredients?: PlanRawIngredient[];
}

interface PlanRawIngredient {
	name?: string;
	qty?: number | null;
	unit?: string | null;
	grams?: number | null;
	category?: string | null;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function hoistRepeatedRawIngredients(plan: unknown, opts: HoistOptions = {}): HoistResult {
	const minUses = opts.min_uses ?? 3;
	const planShape = plan as PlanShape;

	const meals = collectMeals(planShape);
	if (meals.length === 0) {
		return { proposed_formulas: [], ingredient_clusters: [] };
	}

	const grouped = groupByCanonical(meals);
	const ingredient_clusters: IngredientCluster[] = [];
	const proposed_formulas: ProposedFormula[] = [];

	const planStart = stringValue(planShape.start_date) || earliestDate(meals);

	for (const [canonical, occurrences] of grouped.entries()) {
		const distinctMeals = uniq(occurrences.map(o => o.meal_id));
		if (distinctMeals.length < minUses) continue;

		const cluster = decideCluster(canonical, occurrences, planStart);
		if (cluster) ingredient_clusters.push(cluster);
	}

	// Formula proposals — walk each candidate, check meals for the required
	// supporting set + the candidate name itself.
	for (const formula of FORMULA_CANDIDATES) {
		const proposal = evaluateFormulaCandidate(formula, meals, grouped, planStart);
		if (proposal) proposed_formulas.push(proposal);
	}

	return {
		proposed_formulas,
		ingredient_clusters,
	};
}

// ---------------------------------------------------------------------------
// Cluster decision
// ---------------------------------------------------------------------------

interface Occurrence {
	meal_id: string;
	meal_date: string;
	qty: number | null;
	unit: string | null;
	grams: number | null;
}

function decideCluster(canonical: string, occs: Occurrence[], planStart: string): IngredientCluster | null {
	const totals = aggregateOccs(occs);
	const distinctMealIds = uniq(occs.map(o => o.meal_id));

	const action = pickAction(canonical);
	if (!action) {
		// No discrete prep step we know how to suggest — skip rather than
		// emit a vague "pre_portion" for everything.
		return null;
	}

	// Volume gate: only suggest hoisting when the totals justify the setup.
	if (action === "batch_chop") {
		if ((totals.grams ?? 0) < MIN_CLUSTER_GRAMS_FOR_CHOP) return null;
	} else if (action === "batch_juice") {
		if ((totals.qty ?? 0) < MIN_CLUSTER_QTY_FOR_JUICE) return null;
	} else if (action === "batch_grind") {
		if ((totals.grams ?? 0) < MIN_CLUSTER_GRAMS_FOR_GRIND) return null;
	}

	return {
		canonical_name: canonical,
		total_qty: totals.qty ?? undefined,
		total_grams: totals.grams ?? undefined,
		affected_meal_ids: distinctMealIds,
		suggested_action: action,
		reasoning: clusterReasoning(canonical, action, distinctMealIds.length, totals, planStart),
	};
}

function pickAction(canonical: string): ClusterAction | null {
	const lower = canonical.toLowerCase().trim();
	for (const herb of CHOP_HERBS) {
		if (lower === herb || lower.includes(herb)) return "batch_chop";
	}
	for (const citrus of JUICE_CITRUS) {
		if (lower === citrus || lower.endsWith(` ${citrus}`) || lower === `${citrus} juice`) return "batch_juice";
	}
	for (const spice of GRIND_WHOLE_SPICES) {
		if (lower === spice || lower.includes(spice)) return "batch_grind";
	}
	return null;
}

function clusterReasoning(canonical: string, action: ClusterAction, mealCount: number, totals: { qty: number | null; grams: number | null }, planStart: string): string {
	const verb = action === "batch_chop" ? "chop" : action === "batch_juice" ? "juice" : action === "batch_grind" ? "grind" : "portion";
	const quantityPhrase = action === "batch_juice" && totals.qty
		? `${totals.qty} ${pluralize(canonical, totals.qty)}`
		: totals.grams
			? `${Math.round(totals.grams)}g`
			: "the full amount";
	return `${canonical} appears in ${mealCount} meals across the plan — ${verb} ${quantityPhrase} once on or before ${planStart} and portion to each meal. Saves ${mealCount - 1} board setups; final-day portions stay fresh because everything's in the prepped jar already.`;
}

function aggregateOccs(occs: Occurrence[]): { qty: number | null; grams: number | null } {
	let qty = 0;
	let qtyHits = 0;
	let grams = 0;
	let gramHits = 0;
	for (const o of occs) {
		if (o.qty !== null && Number.isFinite(o.qty)) {
			qty += o.qty;
			qtyHits++;
		}
		if (o.grams !== null && Number.isFinite(o.grams)) {
			grams += o.grams;
			gramHits++;
		}
	}
	return {
		qty: qtyHits > 0 ? qty : null,
		grams: gramHits > 0 ? grams : null,
	};
}

// ---------------------------------------------------------------------------
// Formula evaluation
// ---------------------------------------------------------------------------

function evaluateFormulaCandidate(
	formula: FormulaCandidate,
	meals: NormalizedMeal[],
	grouped: Map<string, Occurrence[]>,
	planStart: string,
): ProposedFormula | null {
	// First gate: the formula's anchor name itself must show up enough.
	const anchorOccs = grouped.get(formula.canonical_name);
	if (!anchorOccs || uniq(anchorOccs.map(o => o.meal_id)).length < formula.min_meals) return null;

	// Second gate: in the meals where the anchor appears, the required
	// supporting ingredients must consistently co-occur.
	const anchorMealIds = new Set(anchorOccs.map(o => o.meal_id));
	let strongMatches = 0;
	let totalGrams = 0;
	const matchedMealIds: string[] = [];
	let earliestMealDate: string | null = null;

	for (const meal of meals) {
		if (!anchorMealIds.has(meal.id)) continue;
		const presentNames = new Set(meal.raw_ingredients.map(r => r.name));
		const allRequiredPresent = formula.supporting_required.every(req => hasFuzzy(presentNames, req));
		if (!allRequiredPresent) continue;
		strongMatches++;
		matchedMealIds.push(meal.id);
		const anchorEntry = meal.raw_ingredients.find(r => r.name === formula.canonical_name);
		if (anchorEntry?.grams) totalGrams += anchorEntry.grams;
		if (earliestMealDate === null || meal.date < earliestMealDate) earliestMealDate = meal.date;
	}

	if (strongMatches < formula.min_meals) return null;
	if (totalGrams > 0 && totalGrams < formula.min_grams_each * formula.min_meals) return null;

	const prepDate = suggestPrepDate(earliestMealDate || planStart, planStart);
	const requiredJoined = formula.supporting_required.join(" + ");
	return {
		canonical_name: formula.canonical_name,
		output_label: formula.output_label,
		total_grams_estimated: Math.round(totalGrams || formula.min_grams_each * strongMatches),
		affected_meal_ids: matchedMealIds,
		suggested_prep_date: prepDate,
		reasoning: `${formula.canonical_name} co-occurs with ${requiredJoined} in ${strongMatches} meals — strong signal this should be a stored ${formula.output_label.toLowerCase()} formula. Make once on ${prepDate}, portion across the plan.`,
	};
}

function hasFuzzy(set: Set<string>, needle: string): boolean {
	const lower = needle.toLowerCase();
	if (set.has(lower)) return true;
	for (const item of set) {
		if (item.includes(lower) || lower.includes(item)) return true;
	}
	return false;
}

function suggestPrepDate(earliestMealDate: string, planStart: string): string {
	// One day before the earliest meal that uses it, but never before the
	// plan start date (you can't shop / prep before the plan begins).
	const earliest = parseDate(earliestMealDate);
	if (!earliest) return planStart || earliestMealDate;
	const dayBefore = new Date(earliest);
	dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
	const candidate = dayBefore.toISOString().slice(0, 10);
	if (planStart && candidate < planStart) return planStart;
	return candidate;
}

// ---------------------------------------------------------------------------
// Walking the plan
// ---------------------------------------------------------------------------

interface NormalizedMeal {
	id: string;
	date: string;
	title: string;
	raw_ingredients: Array<{ name: string; qty: number | null; unit: string | null; grams: number | null }>;
}

function collectMeals(plan: PlanShape): NormalizedMeal[] {
	const out: NormalizedMeal[] = [];
	const days = Array.isArray(plan.meals_by_day) ? plan.meals_by_day : [];
	for (const day of days) {
		const meals = Array.isArray(day.meals) ? day.meals : [];
		for (const meal of meals) {
			const norm = normalizeMeal(meal, stringValue(meal.date) || stringValue(day.date));
			if (norm) out.push(norm);
		}
	}
	const breakfasts = Array.isArray(plan.breakfasts) ? plan.breakfasts : [];
	for (const meal of breakfasts) {
		const norm = normalizeMeal(meal, stringValue(meal.date));
		if (norm) out.push(norm);
	}
	const snacks = Array.isArray(plan.snack_boxes) ? plan.snack_boxes : [];
	for (const snack of snacks) {
		const norm = normalizeMeal(snack, stringValue(snack.date));
		if (norm) out.push(norm);
	}
	return out;
}

function normalizeMeal(meal: PlanMealShape | PlanSnackShape, fallbackDate: string): NormalizedMeal | null {
	const id = stringValue(meal.id);
	if (!id) return null;
	const date = stringValue(meal.date) || fallbackDate || "";
	const title = stringValue(meal.title) || "untitled";
	const raw = Array.isArray(meal.raw_ingredients) ? meal.raw_ingredients : [];
	const items = raw
		.map(r => ({
			name: stringValue(r?.name).toLowerCase(),
			qty: numberOrNull(r?.qty),
			unit: stringValue(r?.unit) || null,
			grams: numberOrNull(r?.grams),
		}))
		.filter(r => r.name);
	return { id, date, title, raw_ingredients: items };
}

function groupByCanonical(meals: NormalizedMeal[]): Map<string, Occurrence[]> {
	const out = new Map<string, Occurrence[]>();
	for (const meal of meals) {
		for (const ing of meal.raw_ingredients) {
			const list = out.get(ing.name) || [];
			list.push({
				meal_id: meal.id,
				meal_date: meal.date,
				qty: ing.qty,
				unit: ing.unit,
				grams: ing.grams,
			});
			out.set(ing.name, list);
		}
	}
	return out;
}

function earliestDate(meals: NormalizedMeal[]): string {
	let earliest = "";
	for (const meal of meals) {
		if (!meal.date) continue;
		if (!earliest || meal.date < earliest) earliest = meal.date;
	}
	return earliest;
}

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function uniq<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function parseDate(value: string): Date | null {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

function pluralize(name: string, count: number): string {
	if (count === 1) return name;
	if (name.endsWith("s")) return name;
	return `${name}s`;
}
