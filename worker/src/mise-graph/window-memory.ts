// Window Memory — multi-week recency for the menu composer.
//
// The menu composer is good at variety WITHIN one plan but blind to what came
// BEFORE: if the user just had a chickpea-heavy week, the next plan should
// shift away from chickpeas. This module reads the household's recent
// `mise_week_plans` rows, walks the persisted plan_json (meals_by_day +
// breakfasts), and aggregates titles, formats, anchors, cuisines, and
// formula/personal-recipe IDs into a compact `RecentMenuContext` the composer
// can reason over.
//
// Design notes
// ------------
// • Recency weighting: exponential decay `weight = exp(-days_ago / 14)`.
//   Yesterday ≈ 0.93, 7 days ≈ 0.61, 14 days ≈ 0.37, 28 days ≈ 0.14, 56 days
//   ≈ 0.02. Smooth, monotonic, avoids hard cutoffs that produce cliffs at the
//   window boundary. After accumulation `recent_anchor_pressure` is normalized
//   so the heaviest anchor = 1.0; consumers compare to threshold (e.g. > 0.6
//   means "saturated, avoid this week"). The spec called out a few sample
//   weights (1.0 / 0.5 / 0.2 / 0.05); the τ=14 curve hits those targets within
//   a few hundredths after normalization.
// • Robustness: every JSON parse is guarded; missing tables, null columns,
//   malformed plan_json, empty `breakfasts`, missing `snack_boxes` all return
//   empty/zero rather than throwing. The composer must never crash because
//   memory is unavailable.
// • Anchors come from BOTH plan.selected_ingredients AND each meal's
//   ingredient_names — selected_ingredients captures user intent, ingredient
//   names capture what actually shipped to the plate.

import type { MiseGraphEnv } from "./types";

export interface RecentMenuContext {
	window_days: number;
	plans_seen: number;
	recent_dinner_titles: string[];
	recent_dinner_formats: Array<{ format: string; count: number }>;
	recent_anchor_pressure: Record<string, number>;
	recent_cuisines: Array<{ cuisine: string; count: number }>;
	recent_formula_ids: string[];
	recent_personal_recipe_ids: string[];
	last_meal_dates: Record<string, string>;
}

export interface LoadRecentMenuContextOptions {
	household_id: string;
	lookback_days?: number;
	exclude_plan_id?: string;
}

const DEFAULT_LOOKBACK_DAYS = 28;
const RECENCY_TAU_DAYS = 14; // controls exp(-d/τ) decay
const MAX_RECENT_DINNER_TITLES = 14;

export async function loadRecentMenuContext(
	env: MiseGraphEnv,
	opts: LoadRecentMenuContextOptions,
): Promise<RecentMenuContext> {
	const householdId = (opts.household_id || "").trim();
	const lookbackDays = clampPositiveInt(opts.lookback_days, DEFAULT_LOOKBACK_DAYS);
	const empty: RecentMenuContext = {
		window_days: lookbackDays,
		plans_seen: 0,
		recent_dinner_titles: [],
		recent_dinner_formats: [],
		recent_anchor_pressure: {},
		recent_cuisines: [],
		recent_formula_ids: [],
		recent_personal_recipe_ids: [],
		last_meal_dates: {},
	};
	if (!householdId) return empty;

	const cutoff = isoDateNDaysAgo(lookbackDays);
	let rows: PlanRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT id, household_id, start_date, end_date, plan_json, selected_ingredients_json,
			        source_recipe_ids_json, created_at
			 FROM mise_week_plans
			 WHERE household_id = ?
			   AND end_date >= ?
			 ORDER BY end_date DESC, created_at DESC
			 LIMIT 24`,
		)
			.bind(householdId, cutoff)
			.all<PlanRow>();
		rows = (result.results || []) as PlanRow[];
	} catch {
		// Table missing, D1 unavailable, etc. — return empty rather than throw.
		return empty;
	}

	const filtered = opts.exclude_plan_id
		? rows.filter(r => r.id !== opts.exclude_plan_id)
		: rows;
	if (filtered.length === 0) return empty;

	const today = new Date();
	const dinnerTitles: Array<{ date: string; title: string }> = [];
	const formatCounts = new Map<string, number>();
	const cuisineCounts = new Map<string, number>();
	const anchorWeighted = new Map<string, number>();
	const formulaIds = new Set<string>();
	const personalRecipeIds = new Set<string>();
	const lastMealDates = new Map<string, string>();

	for (const row of filtered) {
		const plan = parseJsonObject(row.plan_json);
		const planSelectedFromRow = parseJsonStringArray(row.selected_ingredients_json);
		const planSourceIdsFromRow = parseJsonStringArray(row.source_recipe_ids_json);

		// Plan-level selected_ingredients: try plan_json first, then row column.
		const planSelected: string[] = (() => {
			const fromPlan = plan ? extractStringArray(plan["selected_ingredients"]) : [];
			return fromPlan.length > 0 ? fromPlan : planSelectedFromRow;
		})();

		// Walk meals_by_day + breakfasts. snack_boxes intentionally skipped:
		// they're flexible filler, not menu signal we want to weight.
		const meals: PlanMeal[] = [];
		if (plan) {
			const days = extractArray(plan["meals_by_day"]);
			for (const day of days) {
				const dayObj = isObject(day) ? day : null;
				if (!dayObj) continue;
				const dayDate = stringOrNull(dayObj["date"]);
				const dayMeals = extractArray(dayObj["meals"]);
				for (const m of dayMeals) {
					const meal = normalizeMeal(m, dayDate);
					if (meal) meals.push(meal);
				}
			}
			const breakfasts = extractArray(plan["breakfasts"]);
			for (const m of breakfasts) {
				const meal = normalizeMeal(m, null);
				if (meal) meals.push(meal);
			}
		}

		// Plan-level source_recipe_ids (covers both formulas and personal recipes).
		for (const id of planSourceIdsFromRow) {
			if (id.startsWith("pr_") || id.startsWith("personal_")) personalRecipeIds.add(id);
			else formulaIds.add(id);
		}

		for (const meal of meals) {
			const daysAgo = daysBetween(today, meal.date) ?? estimatePlanDaysAgo(today, row);
			const recencyWeight = recencyWeightFor(daysAgo);

			if (meal.slot === "dinner" && meal.title) {
				dinnerTitles.push({ date: meal.date || row.end_date || "", title: meal.title });
				if (meal.format) {
					formatCounts.set(meal.format, (formatCounts.get(meal.format) || 0) + 1);
				}
			}

			for (const c of meal.cuisine) {
				if (c) cuisineCounts.set(c, (cuisineCounts.get(c) || 0) + 1);
			}

			for (const fid of meal.formula_ids) {
				if (!fid) continue;
				if (fid.startsWith("pr_") || fid.startsWith("personal_")) personalRecipeIds.add(fid);
				else formulaIds.add(fid);
				const prev = lastMealDates.get(fid);
				if (meal.date && (!prev || meal.date > prev)) {
					lastMealDates.set(fid, meal.date);
				}
			}
			for (const lin of meal.lineage) {
				if (lin.kind === "personal_recipe" && lin.id) personalRecipeIds.add(lin.id);
			}

			// Per-meal anchor accumulation. We pull from BOTH plan-level
			// selected_ingredients and the meal's ingredient_names so we capture
			// intent (selected) and reality (ingredient_names).
			const seen = new Set<string>();
			for (const raw of [...planSelected, ...meal.ingredient_names]) {
				const key = canonicalAnchor(raw);
				if (!key) continue;
				if (seen.has(key)) continue; // don't double-count within one meal
				seen.add(key);
				anchorWeighted.set(key, (anchorWeighted.get(key) || 0) + recencyWeight);
			}
		}

		// If a plan had selected_ingredients but no meals (degenerate), still
		// surface those anchors at half-strength so we don't lose the signal.
		if (meals.length === 0 && planSelected.length > 0) {
			const planDaysAgo = estimatePlanDaysAgo(today, row);
			const w = recencyWeightFor(planDaysAgo) * 0.5;
			for (const raw of planSelected) {
				const key = canonicalAnchor(raw);
				if (!key) continue;
				anchorWeighted.set(key, (anchorWeighted.get(key) || 0) + w);
			}
		}
	}

	// Most-recent-first dinner titles, deduped, capped.
	dinnerTitles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
	const dedupedTitles: string[] = [];
	const seenTitles = new Set<string>();
	for (const { title } of dinnerTitles) {
		const key = title.toLowerCase().trim();
		if (!key || seenTitles.has(key)) continue;
		seenTitles.add(key);
		dedupedTitles.push(title);
		if (dedupedTitles.length >= MAX_RECENT_DINNER_TITLES) break;
	}

	const formats = Array.from(formatCounts.entries())
		.map(([format, count]) => ({ format, count }))
		.sort((a, b) => b.count - a.count);

	const cuisines = Array.from(cuisineCounts.entries())
		.map(([cuisine, count]) => ({ cuisine, count }))
		.sort((a, b) => b.count - a.count);

	const anchorPressure = normalizeMaxToOne(anchorWeighted);

	return {
		window_days: lookbackDays,
		plans_seen: filtered.length,
		recent_dinner_titles: dedupedTitles,
		recent_dinner_formats: formats,
		recent_anchor_pressure: anchorPressure,
		recent_cuisines: cuisines,
		recent_formula_ids: Array.from(formulaIds),
		recent_personal_recipe_ids: Array.from(personalRecipeIds),
		last_meal_dates: Object.fromEntries(lastMealDates),
	};
}

// ---------- internal types ----------

interface PlanRow {
	id: string;
	household_id: string | null;
	start_date: string;
	end_date: string;
	plan_json: string | null;
	selected_ingredients_json: string | null;
	source_recipe_ids_json: string | null;
	created_at: string | null;
}

interface PlanMeal {
	date: string;
	slot: string;
	title: string;
	format: string;
	cuisine: string[];
	formula_ids: string[];
	ingredient_names: string[];
	lineage: Array<{ kind: string; id: string | null }>;
}

// ---------- helpers ----------

function recencyWeightFor(daysAgo: number): number {
	const d = Math.max(0, daysAgo);
	return Math.exp(-d / RECENCY_TAU_DAYS);
}

function normalizeMaxToOne(weighted: Map<string, number>): Record<string, number> {
	if (weighted.size === 0) return {};
	let max = 0;
	for (const v of weighted.values()) if (v > max) max = v;
	if (max <= 0) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of weighted.entries()) {
		out[k] = round3(v / max);
	}
	return out;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function clampPositiveInt(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function isoDateNDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(today: Date, isoDate: string): number | null {
	if (!isoDate || typeof isoDate !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
	if (!m) return null;
	const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	const diff = (now - then) / (1000 * 60 * 60 * 24);
	return diff;
}

function estimatePlanDaysAgo(today: Date, row: PlanRow): number {
	// Best effort: prefer end_date (last meal in the plan), fall back to created_at.
	const fromEnd = daysBetween(today, row.end_date);
	if (fromEnd !== null) return fromEnd;
	const fromCreated = row.created_at ? daysBetween(today, row.created_at.slice(0, 10)) : null;
	return fromCreated ?? 14;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
	if (!value || typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function parseJsonStringArray(value: string | null | undefined): string[] {
	if (!value || typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return extractStringArray(parsed);
	} catch {
		return [];
	}
}

function extractArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function extractStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === "string" && v.trim()) out.push(v.trim());
	}
	return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeMeal(raw: unknown, fallbackDate: string | null): PlanMeal | null {
	if (!isObject(raw)) return null;
	const date = stringOrNull(raw["date"]) || fallbackDate || "";
	const slot = (stringOrNull(raw["slot"]) || "").toLowerCase();
	const title = stringOrNull(raw["title"]) || "";
	const format = (stringOrNull(raw["format"]) || "").toLowerCase();
	const cuisine = extractStringArray(raw["cuisine"]);
	const formulaIds = extractStringArray(raw["formula_ids"]);
	const ingredientNames = extractStringArray(raw["ingredient_names"]);
	// lineage is optional; entries look like { source_kind, source_id, ... }.
	const lineage: Array<{ kind: string; id: string | null }> = [];
	const lineageRaw = extractArray(raw["lineage"]);
	for (const lin of lineageRaw) {
		if (!isObject(lin)) continue;
		const kind = stringOrNull(lin["source_kind"]) || "";
		const id = stringOrNull(lin["source_id"]);
		if (kind) lineage.push({ kind, id });
	}
	if (!title && formulaIds.length === 0 && ingredientNames.length === 0) return null;
	return { date, slot, title, format, cuisine, formula_ids: formulaIds, ingredient_names: ingredientNames, lineage };
}

// Anchor canonicalization is intentionally conservative — we lowercase, trim,
// strip parenthetical qualifiers, and drop a small set of cooking-state words
// so "roasted chickpeas" and "chickpeas" both bucket to "chickpeas". We do NOT
// try to do full canonical-ingredient resolution here; that lives elsewhere.
const ANCHOR_STOP_PREFIXES = [
	"roasted ", "raw ", "fresh ", "dried ", "cooked ", "grilled ", "boiled ",
	"steamed ", "fried ", "smoked ", "pickled ", "frozen ", "canned ",
	"chopped ", "diced ", "sliced ", "minced ", "ground ", "whole ", "crushed ",
];
function canonicalAnchor(raw: string): string {
	if (typeof raw !== "string") return "";
	let s = raw.toLowerCase().trim();
	if (!s) return "";
	// Drop trailing parenthetical qualifiers: "tofu (firm)" → "tofu".
	s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
	for (const prefix of ANCHOR_STOP_PREFIXES) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length).trim();
			break;
		}
	}
	// Strip a leading article.
	if (s.startsWith("a ")) s = s.slice(2);
	if (s.startsWith("the ")) s = s.slice(4);
	// Collapse whitespace.
	s = s.replace(/\s+/g, " ").trim();
	return s;
}
