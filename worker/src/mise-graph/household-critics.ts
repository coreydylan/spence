// Household-aware critics — soft "preference" tier that nudges the
// chef-of-staff agent to actually USE the personality data carried by
// `buildHouseholdSignals`. None of these block plan finalization; they emit
// `severity: "preference"` grievances that the agent reads on the next audit
// turn and naturally folds into its compose call.
//
// Design: critics are PURE FUNCTIONS that take `(plan, householdContext)` and
// return `Grievance[]`. The household context (signals + traditions + meta)
// is loaded once by `loadHouseholdContextForAudit` and passed in — that keeps
// the critic functions deterministic and trivially testable without a DB.
//
// Critics in this file:
//   * TraditionRespectCritic   — meal on a tradition cadence date that doesn't
//                                honor the tradition's format/keywords.
//   * QuickPersonalityCritic   — long-prep meal in a quick-leaning household.
//   * PantryUnderusedCritic    — meal that doesn't anchor on existing pantry
//                                when ≥10 items are on the shelf.
//   * MemberSpreadCritic       — one meta-grievance per plan reminding the
//                                agent that members diverge on a trait.
//
// All four emit `severity: "preference"` ONLY. The agentic loop reads these
// alongside hard/warning grievances; preference-only audits stay green.

import type { MiseWeeklyPlanDraft, MisePlanMeal } from "./planner";
import type { Grievance, SlotRef } from "./critics";
import type { HouseholdSignals } from "./household-signals";
import type { MiseGraphEnv } from "./types";
import { buildHouseholdSignals } from "./household-signals";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Tradition row enriched with the metadata our critic needs (id + format).
 * We don't add this to HouseholdSignalTradition because the public bundle
 * stays compact; this is an audit-only enrichment.
 */
export interface TraditionWithMeta {
	tradition_id: string;
	name: string;
	cadence: string;
	description?: string | null;
	must_include_format?: string | null;
	must_include?: string[];
}

export interface HouseholdAuditContext {
	household_id: string;
	signals: HouseholdSignals;
	traditions: TraditionWithMeta[];
}

// ─── Cadence → date matcher ────────────────────────────────────────────────

const WEEKLY_DAYS: Record<string, number> = {
	sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Return true iff the given ISO date `YYYY-MM-DD` falls on the weekday
 * specified by the cadence (e.g. "weekly:friday").
 *
 * Only weekly cadences are matched today; monthly/seasonal/annual cadences
 * return false (the critic skips them — they need additional context to
 * match correctly).
 */
export function cadenceMatchesDate(cadence: string, isoDate: string): boolean {
	const c = (cadence || "").trim().toLowerCase();
	const m = /^weekly:([a-z]+)$/.exec(c);
	if (!m) return false;
	const day = WEEKLY_DAYS[m[1]];
	if (day === undefined) return false;
	const d = new Date(`${isoDate}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	return d.getUTCDay() === day;
}

/**
 * Heuristic check: does the meal honor a tradition? A tradition is honored
 * when the meal's format matches `must_include_format` (case-insensitive,
 * normalising hyphens/underscores) OR the meal's title contains a keyword
 * from the tradition (its `must_include` ingredients OR a token from its
 * name, e.g. "pizza" from "Friday Pizza Night").
 */
export function mealHonorsTradition(meal: MisePlanMeal, tradition: TraditionWithMeta): boolean {
	const expectedFormat = (tradition.must_include_format || "").trim().toLowerCase();
	if (expectedFormat) {
		const mealFormat = (meal.format || "").trim().toLowerCase();
		if (normaliseFormat(mealFormat) === normaliseFormat(expectedFormat)) return true;
	}
	const haystack = [
		meal.title || "",
		(meal.ingredient_names || []).join(" "),
		...(meal.raw_ingredients || []).map(r => r.name || ""),
	].join(" ").toLowerCase();
	const keywords: string[] = [];
	for (const k of tradition.must_include || []) {
		if (typeof k === "string" && k.trim()) keywords.push(k.trim().toLowerCase());
	}
	// Pull keyword tokens from the tradition name itself, dropping noise words.
	const NOISE = new Set(["night", "day", "the", "a", "an", "and", "of", "weekly", "every", "our", "family"]);
	for (const tok of (tradition.name || "").toLowerCase().split(/[^a-z0-9]+/)) {
		if (tok && !NOISE.has(tok) && tok.length > 2) keywords.push(tok);
	}
	for (const kw of keywords) {
		if (kw && haystack.includes(kw)) return true;
	}
	return false;
}

function normaliseFormat(value: string): string {
	return value.replace(/-/g, "_").replace(/\s+/g, "_");
}

// ─── Format → estimated active cook minutes ────────────────────────────────
//
// Mirrors the FORMAT_COOK_MIN table in agents/meal-agent.ts. Kept in sync
// manually; there's no shared module yet (and meal-agent is in the
// "do-not-touch" list per the brief). When the agent's estimate ships into
// MealSnapshot we can drop this fallback.

const FORMAT_COOK_MIN: Record<string, number> = {
	salad: 15, sandwich: 10, taco: 25, tostada: 20, sopes: 25, banh_mi: 20,
	bowl: 30, donburi: 35, stir_fry: 25, soup: 35, curry: 40,
	pasta: 30, frittata: 25, pizza: 40, flatbread: 35, mezze: 60,
	mezze_plate: 60, fritter: 30, dumpling: 50, hot_pot: 45,
	risotto: 35, paella: 50, tagine: 70, gratin: 60, galette: 55,
	burger: 25,
};

export function estimateMealCookMin(meal: MisePlanMeal): number {
	const explicit = meal.active_time_min;
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
		return explicit;
	}
	const format = (meal.format || "").toLowerCase().trim().replace(/-/g, "_");
	if (!format) return 30;
	return FORMAT_COOK_MIN[format] ?? FORMAT_COOK_MIN[format.replace(/_/g, " ")] ?? 30;
}

// ─── 1. TraditionRespectCritic ─────────────────────────────────────────────

const QUICK_TRAIT = "quick_vs_project";
const QUICK_VALUE_THRESHOLD = 0.7;
const QUICK_CONFIDENCE_THRESHOLD = 0.2;
const LONG_COOK_MIN = 60;
const PANTRY_MIN_ITEMS = 10;

/**
 * Emit one preference grievance per (meal, tradition) pair where the meal's
 * date matches the tradition's cadence but the meal doesn't honor the
 * tradition's must_include_format / keywords.
 */
export function traditionRespectCritic(
	plan: MiseWeeklyPlanDraft,
	context: HouseholdAuditContext,
): Grievance[] {
	const traditions = context.traditions || [];
	if (traditions.length === 0) return [];
	const out: Grievance[] = [];
	for (const meal of collectAllMeals(plan)) {
		for (const tradition of traditions) {
			if (!cadenceMatchesDate(tradition.cadence, meal.date)) continue;
			if (mealHonorsTradition(meal, tradition)) continue;
			const slot: SlotRef = { date: meal.date, slot: meal.slot };
			const expected = tradition.must_include_format || tradition.name;
			out.push({
				critic: "TraditionRespectCritic",
				severity: "preference",
				slot_ref: slot,
				message: `Meal "${meal.title}" on ${meal.date} ${meal.slot} doesn't honor the household's "${tradition.name}" tradition (${tradition.cadence}).`,
				suggested_repair: `Consider a ${expected}-style meal here, or move "${meal.title}" to a non-tradition slot.`,
				meta: {
					tradition_id: tradition.tradition_id,
					tradition_name: tradition.name,
					cadence: tradition.cadence,
					expected_format: tradition.must_include_format ?? null,
				},
			});
		}
	}
	return out;
}

// ─── 2. QuickPersonalityCritic ─────────────────────────────────────────────

/**
 * Emit a preference grievance for every meal whose estimated active cook
 * exceeds LONG_COOK_MIN when the household personality leans quick.
 */
export function quickPersonalityCritic(
	plan: MiseWeeklyPlanDraft,
	context: HouseholdAuditContext,
): Grievance[] {
	const dim = (context.signals.personality.dimensions || []).find(d => d.trait_name === QUICK_TRAIT);
	if (!dim) return [];
	if (!(dim.value > QUICK_VALUE_THRESHOLD && dim.confidence > QUICK_CONFIDENCE_THRESHOLD)) return [];
	const out: Grievance[] = [];
	for (const meal of collectAllMeals(plan)) {
		const minutes = estimateMealCookMin(meal);
		if (minutes <= LONG_COOK_MIN) continue;
		const slot: SlotRef = { date: meal.date, slot: meal.slot };
		out.push({
			critic: "QuickPersonalityCritic",
			severity: "preference",
			slot_ref: slot,
			message: `Meal "${meal.title}" estimated ${minutes}min; this household leans quick (signal ${dim.value.toFixed(2)} confidence ${dim.confidence.toFixed(2)}).`,
			suggested_repair: `Pick a faster format (taco, bowl, sandwich) or split prep across two days.`,
			meta: {
				estimated_cook_min: minutes,
				quick_value: dim.value,
				quick_confidence: dim.confidence,
				format: meal.format,
			},
		});
	}
	return out;
}

// ─── 3. PantryUnderusedCritic ──────────────────────────────────────────────

/**
 * Emit a preference grievance for every meal whose raw_ingredients (or
 * ingredient_names if no raw_ingredients) contain ZERO items already in the
 * household pantry, when the pantry has at least PANTRY_MIN_ITEMS unique
 * entries.
 */
export function pantryUnderusedCritic(
	plan: MiseWeeklyPlanDraft,
	context: HouseholdAuditContext,
): Grievance[] {
	const pantryItems = collectPantryItems(context.signals);
	if (pantryItems.length < PANTRY_MIN_ITEMS) return [];
	const lowered = new Set(pantryItems.map(p => p.toLowerCase()));
	const out: Grievance[] = [];
	for (const meal of collectAllMeals(plan)) {
		const names: string[] = [];
		for (const r of meal.raw_ingredients || []) {
			if (typeof r?.name === "string") names.push(r.name);
		}
		for (const n of meal.ingredient_names || []) {
			if (typeof n === "string") names.push(n);
		}
		if (names.length === 0) continue; // nothing to inspect — skip
		const lowerNames = names.map(n => n.toLowerCase());
		const usesPantry = lowerNames.some(n => containsAnyPantryName(n, lowered));
		if (usesPantry) continue;
		const top5 = pantryItems.slice(0, 5).join(", ");
		const slot: SlotRef = { date: meal.date, slot: meal.slot };
		out.push({
			critic: "PantryUnderusedCritic",
			severity: "preference",
			slot_ref: slot,
			message: `Meal "${meal.title}" uses 0 items from your pantry (${pantryItems.length} on hand). Big shop spike incoming.`,
			suggested_repair: `Try anchoring on items already on hand: ${top5}.`,
			meta: {
				pantry_count: pantryItems.length,
				top_pantry: pantryItems.slice(0, 5),
			},
		});
	}
	return out;
}

function containsAnyPantryName(ingredientName: string, pantry: Set<string>): boolean {
	if (pantry.has(ingredientName)) return true;
	// Fallback: token-level match — ingredient name contains a pantry item or
	// vice-versa. Cheap heuristic; avoids forcing exact canonical match.
	for (const p of pantry) {
		if (!p) continue;
		if (ingredientName.includes(p) || p.includes(ingredientName)) return true;
	}
	return false;
}

function collectPantryItems(signals: HouseholdSignals): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const group of signals.pantry_top || []) {
		for (const item of group.items || []) {
			const key = (item || "").trim().toLowerCase();
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

// ─── 4. MemberSpreadCritic ─────────────────────────────────────────────────

/**
 * Emit ONE meta-grievance per plan when members diverge on a trait. Anchored
 * to the first meal in the plan (chronologically by date+slot ordering, with
 * day-of-week meals taking precedence over breakfasts when they share a date)
 * so the agent has a concrete slot to attach the nudge to.
 *
 * Design choice: anchoring to the first meal (vs adding to a separate
 * plan-level summary) keeps the existing `Grievance` shape stable and lets
 * the existing renderer / agent loop pick the nudge up without changes.
 */
export function memberSpreadCritic(
	plan: MiseWeeklyPlanDraft,
	context: HouseholdAuditContext,
): Grievance[] {
	const guidance = context.signals.member_spread_guidance;
	if (!guidance) return [];
	const first = firstMealOfPlan(plan);
	if (!first) return [];
	return [{
		critic: "MemberSpreadCritic",
		severity: "preference",
		slot_ref: { date: first.date, slot: first.slot },
		message: guidance,
		suggested_repair: "Consider alternating meals or splitting components across the diverging dimension.",
		meta: {
			anchor_meal_id: first.id,
		},
	}];
}

function firstMealOfPlan(plan: MiseWeeklyPlanDraft): MisePlanMeal | null {
	const meals = collectAllMeals(plan);
	if (meals.length === 0) return null;
	const order: Record<string, number> = { breakfast: 1, lunch: 2, snack: 3, dinner: 4 };
	meals.sort((a, b) => {
		if (a.date !== b.date) return a.date.localeCompare(b.date);
		return (order[a.slot.toLowerCase()] || 0) - (order[b.slot.toLowerCase()] || 0);
	});
	return meals[0];
}

// ─── Aggregator ────────────────────────────────────────────────────────────

export function runHouseholdAwareCritics(
	plan: MiseWeeklyPlanDraft,
	context: HouseholdAuditContext,
): Grievance[] {
	const out: Grievance[] = [];
	out.push(...traditionRespectCritic(plan, context));
	out.push(...quickPersonalityCritic(plan, context));
	out.push(...pantryUnderusedCritic(plan, context));
	out.push(...memberSpreadCritic(plan, context));
	return out;
}

// ─── Loader ────────────────────────────────────────────────────────────────

interface TraditionRow {
	tradition_id: string;
	name: string;
	cadence: string;
	description: string | null;
	must_include_ingredients_json: string | null;
	must_include_format: string | null;
}

/**
 * Build the audit context for a plan: the household signals bundle plus the
 * tradition rows enriched with `tradition_id` + `must_include_format` (which
 * the public signals payload deliberately omits).
 *
 * Returns `null` when the plan has no `household_id` — the caller should
 * skip household-aware critics in that case.
 */
export async function loadHouseholdContextForAudit(
	env: MiseGraphEnv,
	plan: MiseWeeklyPlanDraft,
): Promise<HouseholdAuditContext | null> {
	const id = (plan.household_id || "").trim();
	if (!id) return null;
	const [signals, traditions] = await Promise.all([
		buildHouseholdSignals(env, id).catch(() => null),
		loadTraditionsWithMeta(env, id),
	]);
	if (!signals) return null;
	return { household_id: id, signals, traditions };
}

async function loadTraditionsWithMeta(
	env: MiseGraphEnv,
	household_id: string,
): Promise<TraditionWithMeta[]> {
	try {
		const result = await env.DB.prepare(
			`SELECT tradition_id, name, cadence, description,
				must_include_ingredients_json, must_include_format
			 FROM mise_household_traditions
			 WHERE household_id = ? AND active = 1
			 ORDER BY created_at_ms ASC
			 LIMIT 50`,
		).bind(household_id).all<TraditionRow>();
		const out: TraditionWithMeta[] = [];
		for (const r of result.results || []) {
			if (!r || typeof r.name !== "string" || typeof r.cadence !== "string") continue;
			const t: TraditionWithMeta = {
				tradition_id: r.tradition_id,
				name: r.name,
				cadence: r.cadence,
			};
			if (r.description) t.description = r.description;
			if (r.must_include_format) t.must_include_format = r.must_include_format;
			const must = parseStringArray(r.must_include_ingredients_json);
			if (must.length > 0) t.must_include = must;
			out.push(t);
		}
		return out;
	} catch {
		return [];
	}
}

function parseStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
		return [];
	} catch {
		return [];
	}
}

// ─── helpers ───────────────────────────────────────────────────────────────

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) for (const m of day.meals) out.push(m);
	for (const b of plan.breakfasts || []) out.push(b);
	return out;
}
