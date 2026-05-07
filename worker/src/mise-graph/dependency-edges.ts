// Dependency-edge derivation for the mise-graph planner.
//
// The calendar has three entity types — ShoppingTrip, CookSession, Meal — and
// the lines between them are NOT hand-drawn. They fall out of the time-physics
// of the children: a shopping item's shelf life forces a max gap between Shop
// and Cook; a prep task's idle time forces a min gap between Cook and Meal; a
// meal's leftovers_to claim wires Meal → Meal with a 72h fridge window.
//
// This module is pure and read-only. Critics use it to detect violations. The
// planner UI uses it to draw lines on the calendar. The revision loop uses it
// to identify critical-path constraints when proposing fixes.
//
// The plan today doesn't have explicit ShoppingTrip / CookSession entity types,
// so we synthesize them: every plan.shop_runs entry is a ShoppingTrip
// (entity_id = run.id); prep_tasks grouped by scheduled_date become synthetic
// CookSessions (entity_id = "cook_session:<date>"); meals are explicit.

import type {
	MiseWeeklyPlanDraft,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseMealSlot,
} from "./planner";

// --- public types ----------------------------------------------------------

export type EntityType = "Shop" | "Cook" | "Meal";

export interface EntityRef {
	entity_type: EntityType;
	entity_id: string;
	date: string;            // YYYY-MM-DD
}

export type EdgeRuleKind =
	| "min_lead_time"        // A.date + value <= B.date  (e.g. 24h marinade)
	| "max_lead_time"        // B.date - A.date <= value  (e.g. shelf life freshness)
	| "freshness_window"     // both bounds combined
	| "prep_chain"           // A must finish before B starts (intra-cook)
	| "leftover_window"      // meal B consumes meal A's leftover within window
	| "equipment_conflict"   // two cooks compete for same equipment same time
	| "household_rule"       // user-defined
	| "recipe_rule";         // declared by imported recipe

export interface EdgeRule {
	kind: EdgeRuleKind;
	value: number;             // hours for time rules; 0 for non-time
	description: string;
}

export interface DependencyEdge {
	id: string;
	from: EntityRef;
	to:   EntityRef;
	derived_from: {            // the child whose property created this edge
		parent_entity_type: EntityType;
		parent_entity_id: string;
		child_id: string;
		child_property: string;  // "shelf_life_fridge", "idle_time_min", "leftovers_to", etc.
	};
	rule: EdgeRule;
	current_lead_time_hours: number;  // actual hours between from.date and to.date
	slack_hours: number;              // signed slack (see calculation below)
	status: "ok" | "marginal" | "violated";
	critical: boolean;                // status==='ok' && slack < 25% of rule.value
}

// --- constants -------------------------------------------------------------

const DEFAULT_LEFTOVER_WINDOW_HOURS = 72;     // 3 days fridge for most leftovers
const DEFAULT_UNKNOWN_SHELF_HOURS = 7 * 24;   // 7d default for unknown items
const MARGINAL_FRACTION = 0.25;               // <25% slack = marginal/critical

// Inline shelf-life-at-room-temp lookup (hours). Until a proper table lands in
// ledger.ts, this hand-rolled set covers ~20 common items the planner cycles
// through. Keys are normalized to lowercase singular canonical form.
const SHELF_LIFE_ROOM_TEMP_HOURS: Record<string, number> = {
	// fresh produce / herbs (short)
	shiitake: 4 * 24, "shiitake mushroom": 4 * 24, mushroom: 4 * 24,
	spinach: 4 * 24, arugula: 3 * 24,
	basil: 2 * 24, cilantro: 3 * 24, parsley: 3 * 24, mint: 3 * 24,
	herb: 3 * 24, herbs: 3 * 24,
	// breads
	sourdough: 3 * 24, bread: 3 * 24, pita: 3 * 24,
	// dairy / proteins
	egg: 21 * 24, "hard cheese": 30 * 24, parmesan: 30 * 24, pecorino: 30 * 24,
	// dry pantry (very long)
	flour: 180 * 24, rice: 180 * 24, pasta: 180 * 24,
	chickpea: 365 * 24, lentil: 365 * 24,
	oat: 180 * 24, oats: 180 * 24,
	sugar: 365 * 24, salt: 365 * 24,
};

// --- public api: derivation ------------------------------------------------

/**
 * Walk the plan and emit every dependency edge derivable from child time-physics.
 * Pure: same input → same output, no I/O.
 */
export function deriveDependencyEdges(plan: MiseWeeklyPlanDraft): DependencyEdge[] {
	const allMeals = collectAllMeals(plan);
	const mealsById = new Map<string, MisePlanMeal>();
	for (const m of allMeals) mealsById.set(m.id, m);
	const tasksById = new Map<string, MisePlanTask>();
	for (const t of plan.prep_tasks || []) tasksById.set(t.id, t);

	return [
		...deriveShopToCookEdges(plan),                   // (a)
		...deriveCookToMealEdges(plan, mealsById),        // (b)
		...deriveMealToMealEdges(plan),                   // (c)
		...derivePrepChainEdges(plan, tasksById),         // (d)
	];
}

// --- public api: inspection ------------------------------------------------

/** Edges where the given entity is either source or target. */
export function edgesIncidentTo(edges: DependencyEdge[], ref: EntityRef): DependencyEdge[] {
	return edges.filter(e =>
		(e.from.entity_type === ref.entity_type && e.from.entity_id === ref.entity_id)
		|| (e.to.entity_type === ref.entity_type && e.to.entity_id === ref.entity_id),
	);
}

/** Edges currently flagged critical (ok but slack < 25% of rule value). */
export function edgesOnCriticalPath(edges: DependencyEdge[]): DependencyEdge[] {
	return edges.filter(e => e.critical);
}

/** Edges with status === 'violated'. */
export function edgesViolated(edges: DependencyEdge[]): DependencyEdge[] {
	return edges.filter(e => e.status === "violated");
}

// (a) Shop → Cook edges. For each prep_task, walk inputs and cross-reference
// the shopping list. Emit min_lead_time(0) for precedence + max_lead_time(shelf
// life at room temp) for freshness.
function deriveShopToCookEdges(plan: MiseWeeklyPlanDraft): DependencyEdge[] {
	const edges: DependencyEdge[] = [];
	const shopRuns = plan.shop_runs || [];
	if (shopRuns.length === 0) return edges;

	// Build a flat index of shopping-list canonical names → array of (run, item).
	// Without canonical fields on items, we lowercase the name. Each item is
	// indexed under multiple keys (the display form and a singularized form) so
	// the cross-reference catches "lemons" matching "lemon".
	const itemIndex = buildShoppingItemIndex(plan);

	for (const task of plan.prep_tasks || []) {
		const cookDate = task.scheduled_date;
		if (!cookDate) continue;
		const cookRef: EntityRef = {
			entity_type: "Cook",
			entity_id: synthCookSessionId(cookDate),
			date: cookDate,
		};

		// Pull every input name we can see — task-level state_inputs + meta hints
		const inputNames = collectTaskInputNames(task);
		const seenItemKeys = new Set<string>();

		for (const rawName of inputNames) {
			const key = normalizeName(rawName);
			if (!key || seenItemKeys.has(key)) continue;
			const matches = itemIndex.get(key);
			if (!matches || matches.length === 0) continue;
			seenItemKeys.add(key);

			// Latest run on/before cook (else earliest available).
			const runForItem = pickShopRunForCook(matches, cookDate);
			if (!runForItem) continue;

			const shopRef: EntityRef = {
				entity_type: "Shop",
				entity_id: runForItem.runId,
				date: runForItem.runDate,
			};

			const currentLead = hoursBetween(shopRef.date, cookRef.date);

			// min_lead_time(0): shop precedes cook.
			edges.push(buildEdge({
				id: `edge:shop_to_cook:precedence:${runForItem.runId}->${cookRef.entity_id}:${key}`,
				from: shopRef,
				to: cookRef,
				rule: {
					kind: "min_lead_time",
					value: 0,
					description: `Shopping run for "${rawName}" must occur on or before the cook date.`,
				},
				currentLead,
				derived_from: {
					parent_entity_type: "Shop",
					parent_entity_id: runForItem.runId,
					child_id: `shop_item:${key}`,
					child_property: "purchase_date",
				},
			}));

			// max_lead_time(shelf_life_room_temp): freshness.
			const shelfHours = lookupRoomTempShelfHours(key);
			edges.push(buildEdge({
				id: `edge:shop_to_cook:freshness:${runForItem.runId}->${cookRef.entity_id}:${key}`,
				from: shopRef,
				to: cookRef,
				rule: {
					kind: "max_lead_time",
					value: shelfHours,
					description: `"${rawName}" room-temp freshness window is ${shelfHours}h.`,
				},
				currentLead,
				derived_from: {
					parent_entity_type: "Shop",
					parent_entity_id: runForItem.runId,
					child_id: `shop_item:${key}`,
					child_property: "shelf_life_room_temp",
				},
			}));
		}
	}

	return edges;
}

// (b) Cook → Meal edges. For each component batch, find its cook date via the
// task whose state_outputs includes the batch. For each planned_use emit
// min_lead_time(idle_hours) when idle is set + max_lead_time(quality_window).
function deriveCookToMealEdges(
	plan: MiseWeeklyPlanDraft,
	mealsById: Map<string, MisePlanMeal>,
): DependencyEdge[] {
	const edges: DependencyEdge[] = [];

	for (const batch of plan.component_batches || []) {
		const cookDate = findBatchCookDate(batch, plan.prep_tasks || []);
		if (!cookDate) continue;

		const cookRef: EntityRef = {
			entity_type: "Cook",
			entity_id: synthCookSessionId(cookDate),
			date: cookDate,
		};

		const idleHours = (batch.idle_time_min || 0) / 60;
		const shelfHours = batch.quality_window_hours || 0;

		for (const use of batch.planned_uses || []) {
			const meal = mealsById.get(use.meal_id);
			const mealRef: EntityRef = {
				entity_type: "Meal",
				entity_id: meal?.id || use.meal_id,
				date: use.date,
			};

			const currentLead = hoursBetween(cookRef.date, mealRef.date);

			if (idleHours > 0) {
				edges.push(buildEdge({
					id: `edge:cook_to_meal:idle:${batch.id}->${mealRef.entity_id}`,
					from: cookRef,
					to: mealRef,
					rule: {
						kind: "min_lead_time",
						value: idleHours,
						description: `Batch "${batch.label}" needs ${idleHours}h idle (e.g. marinade/ferment/chill) before serving.`,
					},
					currentLead,
					derived_from: {
						parent_entity_type: "Cook",
						parent_entity_id: cookRef.entity_id,
						child_id: batch.id,
						child_property: "idle_time_min",
					},
				}));
			}

			if (shelfHours > 0) {
				edges.push(buildEdge({
					id: `edge:cook_to_meal:freshness:${batch.id}->${mealRef.entity_id}`,
					from: cookRef,
					to: mealRef,
					rule: {
						kind: "max_lead_time",
						value: shelfHours,
						description: `Batch "${batch.label}" must be consumed within ${shelfHours}h of prep.`,
					},
					currentLead,
					derived_from: {
						parent_entity_type: "Cook",
						parent_entity_id: cookRef.entity_id,
						child_id: batch.id,
						child_property: "quality_window_hours",
					},
				}));
			}
		}
	}

	return edges;
}

// (c) Meal → Meal leftover edges. Parse "YYYY-MM-DD slot" claims; default
// 72h fridge window.
function deriveMealToMealEdges(plan: MiseWeeklyPlanDraft): DependencyEdge[] {
	const edges: DependencyEdge[] = [];
	const allMeals = collectAllMeals(plan);

	// Build (date+slot)→meal index for resolving "YYYY-MM-DD slot" claims.
	const slotIndex = new Map<string, MisePlanMeal>();
	for (const m of allMeals) slotIndex.set(slotKey(m.date, m.slot), m);

	for (const meal of allMeals) {
		const claims = meal.leftovers_to || [];
		for (const claim of claims) {
			const parsed = parseLeftoverClaim(claim);
			if (!parsed) continue;
			const targetMeal = slotIndex.get(slotKey(parsed.date, parsed.slot));
			const targetId = targetMeal?.id || `meal:${parsed.date}:${parsed.slot}`;

			const fromRef: EntityRef = {
				entity_type: "Meal",
				entity_id: meal.id,
				date: meal.date,
			};
			const toRef: EntityRef = {
				entity_type: "Meal",
				entity_id: targetId,
				date: parsed.date,
			};

			edges.push(buildEdge({
				id: `edge:meal_to_meal:leftover:${meal.id}->${targetId}`,
				from: fromRef,
				to: toRef,
				rule: {
					kind: "leftover_window",
					value: DEFAULT_LEFTOVER_WINDOW_HOURS,
					description: `Leftovers must be consumed within ${DEFAULT_LEFTOVER_WINDOW_HOURS}h (3 days fridge).`,
				},
				currentLead: hoursBetween(fromRef.date, toRef.date),
				derived_from: {
					parent_entity_type: "Meal",
					parent_entity_id: meal.id,
					child_id: `leftover_claim:${claim}`,
					child_property: "leftovers_to",
				},
			}));
		}
	}

	return edges;
}

// (d) Prep-chain edges (intra-cook task dependencies via task.depends_on).
function derivePrepChainEdges(
	plan: MiseWeeklyPlanDraft,
	tasksById: Map<string, MisePlanTask>,
): DependencyEdge[] {
	const edges: DependencyEdge[] = [];

	for (const task of plan.prep_tasks || []) {
		const deps = task.depends_on || [];
		if (deps.length === 0) continue;
		for (const depId of deps) {
			const dep = tasksById.get(depId);
			if (!dep) continue;
			const fromRef: EntityRef = {
				entity_type: "Cook",
				entity_id: synthCookSessionId(dep.scheduled_date),
				date: dep.scheduled_date,
			};
			const toRef: EntityRef = {
				entity_type: "Cook",
				entity_id: synthCookSessionId(task.scheduled_date),
				date: task.scheduled_date,
			};
			edges.push(buildEdge({
				id: `edge:prep_chain:${dep.id}->${task.id}`,
				from: fromRef,
				to: toRef,
				rule: {
					kind: "prep_chain",
					value: 0,
					description: `Task "${task.title}" depends on "${dep.title}" finishing first.`,
				},
				currentLead: hoursBetween(fromRef.date, toRef.date),
				derived_from: {
					parent_entity_type: "Cook",
					parent_entity_id: toRef.entity_id,
					child_id: task.id,
					child_property: "depends_on",
				},
			}));
		}
	}

	return edges;
}

// --- edge construction + slack / status calculation -----------------------

interface BuildEdgeArgs {
	id: string;
	from: EntityRef;
	to: EntityRef;
	rule: EdgeRule;
	currentLead: number;
	derived_from: DependencyEdge["derived_from"];
}

function buildEdge(args: BuildEdgeArgs): DependencyEdge {
	const { rule, currentLead } = args;
	const slack = computeSlack(rule, currentLead);
	const status = computeStatus(rule, slack);
	const critical = status === "ok" && isCritical(rule, slack);
	return {
		id: args.id,
		from: args.from,
		to: args.to,
		derived_from: args.derived_from,
		rule,
		current_lead_time_hours: round(currentLead, 2),
		slack_hours: round(slack, 2),
		status,
		critical,
	};
}

/**
 * Slack is signed:
 *   - For min_lead_time(N): slack = current - N. Positive = surplus, negative = violation.
 *   - For max_lead_time(N): slack = N - current. Positive = surplus, negative = violation.
 *   - For prep_chain:       slack = current - 0 (must be >= 0).
 *   - For leftover_window:  slack = N - current (same as max_lead_time).
 *   - Other kinds:          slack = current. (Information-only.)
 */
function computeSlack(rule: EdgeRule, currentLead: number): number {
	switch (rule.kind) {
		case "min_lead_time":
		case "prep_chain":
			return currentLead - rule.value;
		case "max_lead_time":
		case "leftover_window":
		case "freshness_window":
			return rule.value - currentLead;
		default:
			return currentLead;
	}
}

function computeStatus(rule: EdgeRule, slack: number): DependencyEdge["status"] {
	if (slack < 0) return "violated";
	if (rule.value <= 0) return "ok"; // precedence-only rules have no marginal band
	// Slack of exactly zero is at the boundary — still viable; surface via `critical`.
	if (slack > 0 && slack < rule.value * MARGINAL_FRACTION) return "marginal";
	return "ok";
}

function isCritical(rule: EdgeRule, slack: number): boolean {
	if (rule.value <= 0) return false;
	return slack >= 0 && slack < rule.value * MARGINAL_FRACTION;
}

// --- helpers ---------------------------------------------------------------

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) for (const m of day.meals) out.push(m);
	for (const b of plan.breakfasts || []) out.push(b);
	return out;
}

function synthCookSessionId(date: string): string {
	return `cook_session:${date}`;
}

function slotKey(date: string, slot: string): string {
	return `${date}::${slot.toLowerCase()}`;
}

function parseLeftoverClaim(claim: string): { date: string; slot: MiseMealSlot } | null {
	const m = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
	if (!m) return null;
	return { date: m[1], slot: m[2].toLowerCase() as MiseMealSlot };
}

function hoursBetween(a: string, b: string): number {
	if (!a || !b) return 0;
	const da = Date.parse(`${a}T00:00:00Z`);
	const db = Date.parse(`${b}T00:00:00Z`);
	if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
	return (db - da) / 3_600_000;
}

function round(value: number, decimals: number): number {
	const f = Math.pow(10, decimals);
	return Math.round(value * f) / f;
}

function normalizeName(name: string): string {
	const n = (name || "").toLowerCase().trim().replace(/\s+/g, " ");
	if (!n) return "";
	// Crude singularizer matching shopping-list.canonicalize() behavior.
	if (n.endsWith("oes")) return n.slice(0, -2);
	if (n.endsWith("ies") && n.length > 4) return n.slice(0, -3) + "y";
	if (n.endsWith("ves") && n.length > 4) return n.slice(0, -3) + "f";
	if (n.endsWith("ches")) return n.slice(0, -2);
	if (n.endsWith("shes")) return n.slice(0, -2);
	if (n.endsWith("s") && !n.endsWith("ss") && !n.endsWith("us") && !n.endsWith("is") && n.length > 3) {
		return n.slice(0, -1);
	}
	return n;
}

function lookupRoomTempShelfHours(canonical: string): number {
	if (canonical in SHELF_LIFE_ROOM_TEMP_HOURS) return SHELF_LIFE_ROOM_TEMP_HOURS[canonical];
	// Try a single-word fallback (e.g. "fresh basil" → "basil").
	const last = canonical.split(" ").pop() || canonical;
	if (last in SHELF_LIFE_ROOM_TEMP_HOURS) return SHELF_LIFE_ROOM_TEMP_HOURS[last];
	return DEFAULT_UNKNOWN_SHELF_HOURS;
}

interface ItemSourceRef {
	runId: string;
	runDate: string;
}

// Index canonical-name → shop-runs that supply it. Items don't carry per-item
// run pointers, so we associate each item with every run whose `categories`
// include the item's section — same model the shopping-list builder uses.
function buildShoppingItemIndex(plan: MiseWeeklyPlanDraft): Map<string, ItemSourceRef[]> {
	const out = new Map<string, ItemSourceRef[]>();
	const runs = plan.shop_runs || [];
	const sections = plan.shopping_list || [];

	for (const section of sections) {
		const matchingRuns = runs.filter(r => r.categories.includes(section.category));
		// Fall back to all runs if no category-level match.
		const useRuns = matchingRuns.length > 0 ? matchingRuns : runs;
		for (const item of section.items) {
			const key = normalizeName(item.name);
			if (!key) continue;
			if (!out.has(key)) out.set(key, []);
			for (const run of useRuns) {
				out.get(key)!.push({ runId: run.id, runDate: run.date });
			}
		}
	}
	return out;
}

function pickShopRunForCook(matches: ItemSourceRef[], cookDate: string): ItemSourceRef | null {
	if (matches.length === 0) return null;
	// Prefer the latest run whose date is <= cookDate (freshest supply chain).
	const before = matches
		.filter(m => m.runDate <= cookDate)
		.sort((a, b) => b.runDate.localeCompare(a.runDate));
	if (before.length > 0) return before[0];
	// Fallback: earliest run overall.
	return [...matches].sort((a, b) => a.runDate.localeCompare(b.runDate))[0];
}

function collectTaskInputNames(task: MisePlanTask): string[] {
	const out: string[] = [];
	for (const s of task.state_inputs || []) out.push(s);
	const meta = task.meta as Record<string, unknown> | undefined;
	const inputNames = meta?.input_names;
	if (Array.isArray(inputNames)) {
		for (const n of inputNames) if (typeof n === "string") out.push(n);
	}
	return out;
}

function findBatchCookDate(batch: MisePlanComponentBatch, tasks: MisePlanTask[]): string | null {
	// Primary: task whose state_outputs includes the batch id.
	for (const task of tasks) {
		if ((task.state_outputs || []).includes(batch.id)) return task.scheduled_date;
	}
	// Secondary: meta.desired_prep_date set by the rebatch pass.
	const meta = batch.meta as Record<string, unknown> | undefined;
	const desired = meta?.desired_prep_date;
	if (typeof desired === "string" && /^\d{4}-\d{2}-\d{2}$/.test(desired)) return desired;
	// Tertiary: planned_uses[0].date - 1 day (fallback heuristic).
	const uses = (batch.planned_uses || []).slice().sort((a, b) => a.date.localeCompare(b.date));
	if (uses.length > 0) return subtractDays(uses[0].date, 1);
	return null;
}

function subtractDays(iso: string, days: number): string {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	if (!Number.isFinite(ms)) return iso;
	const d = new Date(ms);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}
