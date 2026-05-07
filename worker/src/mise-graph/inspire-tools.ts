// Inspire tools — Wave 6 of the mise-graph planner.
//
// These tool handlers wrap existing world-model "inspiration" reads (corpus,
// recipe library, fusions, flavor compounds, format library, anchor pressure,
// taste feedback, recent menu, season) so the chef-of-staff agent can gather
// signal BEFORE composing meals (Phase 1: scene-setting reads).
//
// Each function takes a JSON arg bag and returns a plain object the MCP
// dispatcher will JSON-encode into a `content[].text` block. None of these
// tools mutate state — they're all reads against the corpus + household
// memory.
//
// All error paths are swallowed by the underlying loaders (every loader in
// composer-context, window-memory, recipe-feedback, etc. wraps its DB calls
// in try/catch and returns empty results on failure). That makes these
// handlers safe to call even when D1 is missing tables, which matters for
// fresh households where the corpus has been seeded but no plans exist yet.

import type { MiseGraphEnv } from "./types";
import {
	loadAffinities,
	loadCompoundPairings,
	loadComponentCandidates,
	loadDishCandidates,
	loadSeasonal,
	type ContextAffinity,
	type ContextComponent,
	type ContextCompoundPair,
	type ContextDish,
	type ContextPersonalRecipe,
	type ContextSeasonalItem,
} from "./composer-context";
import { loadRecentMenuContext, type RecentMenuContext } from "./window-memory";
import { loadRecentFeedback, mealFeedbackHints, type MealFeedbackHints } from "./recipe-feedback";
import {
	loadCuisineFusions,
	loadFlavorVibes,
	formatCuisineFusionsForPrompt,
	formatFlavorVibesForPrompt,
	type CuisineFusion,
	type FlavorVibe,
} from "./cuisine-fusions";
import {
	loadFormatLibrary,
	formatLibraryForComposer,
	findFormatTemplate,
	type FormatPromptShape,
} from "./format-library-loader";
import { listPersonalRecipes, type PersonalRecipeRecord } from "./personal-recipes";

// ---------- Tunables ----------

const DEFAULT_LIMIT = 12;
const DEFAULT_LOOKBACK_DAYS = 28;
const FEEDBACK_LOOKBACK_DAYS = 60;
const SATURATED_THRESHOLD = 0.6;
const TRENDING_THRESHOLD = 0.3;
const COOLED_THRESHOLD = 0.15;

// ---------- 1. Seasonality ----------

export interface SeasonalityResult {
	region: string | null;
	dates: string[];
	peak: ContextSeasonalItem[];
	coming: ContextSeasonalItem[];
	departing: ContextSeasonalItem[];
}

export async function inspireReadSeasonality(
	env: MiseGraphEnv,
	args: { region?: string | null; dates?: string[] | null; limit?: number },
): Promise<SeasonalityResult> {
	const region = optionalString(args.region) ?? null;
	const dates = ensureDates(args.dates);
	const limit = clampPositiveInt(args.limit, DEFAULT_LIMIT * 4);
	const items = await loadSeasonal(env, dates, region, limit);
	return {
		region,
		dates,
		peak: items.filter(item => item.status === "peak"),
		coming: items.filter(item => item.status === "coming"),
		departing: items.filter(item => item.status === "departing"),
	};
}

// ---------- 2. Anchor pressure ----------

export interface AnchorPressureBucket {
	name: string;
	pressure: number;
}

export interface AnchorPressureResult {
	household_id: string;
	lookback_days: number;
	plans_seen: number;
	saturated: AnchorPressureBucket[];
	trending: AnchorPressureBucket[];
	cooled: AnchorPressureBucket[];
}

export async function inspireReadAnchorPressure(
	env: MiseGraphEnv,
	args: { household_id: string; lookback_days?: number },
): Promise<AnchorPressureResult> {
	const householdId = requireString(args.household_id, "household_id");
	const lookback = clampPositiveInt(args.lookback_days, DEFAULT_LOOKBACK_DAYS);
	const recent = await loadRecentMenuContext(env, {
		household_id: householdId,
		lookback_days: lookback,
	});
	const saturated: AnchorPressureBucket[] = [];
	const trending: AnchorPressureBucket[] = [];
	const cooled: AnchorPressureBucket[] = [];
	for (const [name, pressure] of Object.entries(recent.recent_anchor_pressure || {})) {
		if (pressure >= SATURATED_THRESHOLD) saturated.push({ name, pressure });
		else if (pressure >= TRENDING_THRESHOLD) trending.push({ name, pressure });
		else if (pressure >= COOLED_THRESHOLD) cooled.push({ name, pressure });
	}
	const sortByPressureDesc = (a: AnchorPressureBucket, b: AnchorPressureBucket) => b.pressure - a.pressure;
	saturated.sort(sortByPressureDesc);
	trending.sort(sortByPressureDesc);
	cooled.sort(sortByPressureDesc);
	return {
		household_id: householdId,
		lookback_days: lookback,
		plans_seen: recent.plans_seen,
		saturated,
		trending,
		cooled,
	};
}

// ---------- 3. Recent menu ----------

export interface RecentMenuResult {
	household_id: string;
	lookback_days: number;
	plans_seen: number;
	recent_dinner_titles: string[];
	recent_dinner_formats: Array<{ format: string; count: number }>;
	recent_cuisines: Array<{ cuisine: string; count: number }>;
}

export async function inspireReadRecentMenu(
	env: MiseGraphEnv,
	args: { household_id: string; lookback_days?: number },
): Promise<RecentMenuResult> {
	const householdId = requireString(args.household_id, "household_id");
	const lookback = clampPositiveInt(args.lookback_days, DEFAULT_LOOKBACK_DAYS);
	const recent: RecentMenuContext = await loadRecentMenuContext(env, {
		household_id: householdId,
		lookback_days: lookback,
	});
	return {
		household_id: householdId,
		lookback_days: lookback,
		plans_seen: recent.plans_seen,
		recent_dinner_titles: recent.recent_dinner_titles,
		recent_dinner_formats: recent.recent_dinner_formats,
		recent_cuisines: recent.recent_cuisines,
	};
}

// ---------- 4. Taste feedback ----------

export interface TasteFeedbackResult {
	household_id: string;
	lookback_days: number;
	count_total: number;
	count_loved: number;
	count_rejected: number;
	loved_titles: string[];
	rejected_titles: string[];
	loved_anchors: Record<string, number>;
	loved_cuisines: Record<string, number>;
	loved_formats: Record<string, number>;
	would_repeat_titles: string[];
	wont_repeat_titles: string[];
	unfinished_titles: string[];
}

export async function inspireReadTasteFeedback(
	env: MiseGraphEnv,
	args: { household_id: string; lookback_days?: number },
): Promise<TasteFeedbackResult> {
	const householdId = requireString(args.household_id, "household_id");
	const lookback = clampPositiveInt(args.lookback_days, FEEDBACK_LOOKBACK_DAYS);
	const records = await loadRecentFeedback(env, householdId, lookback);
	const hints: MealFeedbackHints = mealFeedbackHints(records);
	return {
		household_id: householdId,
		lookback_days: lookback,
		count_total: hints.count_total,
		count_loved: hints.count_loved,
		count_rejected: hints.count_rejected,
		loved_titles: hints.loved_titles,
		rejected_titles: hints.rejected_titles,
		loved_anchors: hints.loved_anchors,
		loved_cuisines: hints.loved_cuisines,
		loved_formats: hints.loved_formats,
		would_repeat_titles: hints.would_repeat_titles,
		wont_repeat_titles: hints.wont_repeat_titles,
		unfinished_titles: hints.unfinished_titles,
	};
}

// ---------- 5. Recipe library ----------

export interface RecipeLibraryRecord {
	id: string;
	title: string;
	cuisine: string[];
	format: string | null;
	ingredients: Array<{ name: string; qty?: number; unit?: string }>;
	loved: boolean;
	cooked_count: number;
	last_cooked_at: string | null;
	flavor_tags: string[];
}

export interface RecipeLibraryResult {
	household_id: string;
	count: number;
	recipes: RecipeLibraryRecord[];
	filters: {
		anchor_filter: string[] | null;
		cuisine_filter: string[] | null;
		format_filter: string | null;
		loved_only: boolean;
	};
}

export async function inspireReadRecipeLibrary(
	env: MiseGraphEnv,
	args: {
		household_id: string;
		anchor_filter?: string[] | null;
		cuisine_filter?: string[] | null;
		format_filter?: string | null;
		loved_only?: boolean;
		limit?: number;
	},
): Promise<RecipeLibraryResult> {
	const householdId = requireString(args.household_id, "household_id");
	const anchorFilter = lowerStringArray(args.anchor_filter);
	const cuisineFilter = lowerStringArray(args.cuisine_filter);
	const formatFilter = optionalString(args.format_filter)?.toLowerCase() ?? null;
	const lovedOnly = args.loved_only === true;
	const limit = clampPositiveInt(args.limit, 50);
	const all = await listPersonalRecipes(env, householdId, {
		loved_only: lovedOnly,
		limit: 200,
	});
	const filtered = all.filter(record => {
		if (cuisineFilter && cuisineFilter.length > 0) {
			const cuisines = record.cuisine.map(c => c.toLowerCase());
			if (!cuisineFilter.some(c => cuisines.includes(c))) return false;
		}
		if (formatFilter) {
			if ((record.format || "").toLowerCase() !== formatFilter) return false;
		}
		if (anchorFilter && anchorFilter.length > 0) {
			const ingredients = record.canonical_ingredients.map(i => (i.name || "").toLowerCase());
			if (!anchorFilter.some(a => ingredients.some(i => i.includes(a)))) return false;
		}
		return true;
	}).slice(0, limit);
	return {
		household_id: householdId,
		count: filtered.length,
		recipes: filtered.map(toRecipeLibraryRecord),
		filters: {
			anchor_filter: anchorFilter,
			cuisine_filter: cuisineFilter,
			format_filter: formatFilter,
			loved_only: lovedOnly,
		},
	};
}

function toRecipeLibraryRecord(record: PersonalRecipeRecord): RecipeLibraryRecord {
	return {
		id: record.id,
		title: record.normalized_title || record.original_title || "untitled recipe",
		cuisine: record.cuisine,
		format: record.format,
		ingredients: record.canonical_ingredients.slice(0, 12).map(ing => ({
			name: ing.name,
			qty: typeof ing.qty === "number" ? ing.qty : undefined,
			unit: typeof ing.unit === "string" ? ing.unit : undefined,
		})),
		loved: record.household_loved,
		cooked_count: record.cooked_count,
		last_cooked_at: record.last_cooked_at,
		flavor_tags: record.flavor_tags,
	};
}

// ---------- 6. Canonical dishes ----------

export interface CanonicalDishesResult {
	anchors: string[];
	count: number;
	dishes: ContextDish[];
}

export async function inspireReadCanonicalDishes(
	env: MiseGraphEnv,
	args: { anchors: string[]; limit?: number },
): Promise<CanonicalDishesResult> {
	const anchors = lowerStringArray(args.anchors) ?? [];
	const limit = clampPositiveInt(args.limit, DEFAULT_LIMIT);
	// No anchors → return top dishes by recipe_count (broad starting point).
	const dishes = await loadDishCandidates(env, anchors, limit);
	return { anchors, count: dishes.length, dishes };
}

// ---------- 7. Canonical components ----------

export interface CanonicalComponentsResult {
	anchors: string[];
	count: number;
	components: ContextComponent[];
}

export async function inspireReadCanonicalComponents(
	env: MiseGraphEnv,
	args: { anchors: string[]; limit?: number },
): Promise<CanonicalComponentsResult> {
	const anchors = lowerStringArray(args.anchors) ?? [];
	const limit = clampPositiveInt(args.limit, DEFAULT_LIMIT);
	// No anchors → return top components by recipe_count.
	const components = await loadComponentCandidates(env, anchors, limit);
	return { anchors, count: components.length, components };
}

// ---------- 8. Flavor compounds ----------

export interface FlavorCompoundsResult {
	anchor: string;
	count: number;
	pairings: ContextCompoundPair[];
}

export async function inspireReadFlavorCompounds(
	env: MiseGraphEnv,
	args: { anchor: string; limit?: number },
): Promise<FlavorCompoundsResult> {
	const anchor = requireString(args.anchor, "anchor");
	const limit = clampPositiveInt(args.limit, DEFAULT_LIMIT);
	const pairings = await loadCompoundPairings(env, [anchor], limit);
	return { anchor, count: pairings.length, pairings };
}

// ---------- 9. Affinity pairs ----------

export interface AffinityPairsResult {
	anchors: string[];
	count: number;
	pairs: ContextAffinity[];
}

export async function inspireReadAffinityPairs(
	env: MiseGraphEnv,
	args: { anchors: string[]; limit?: number },
): Promise<AffinityPairsResult> {
	const anchors = lowerStringArray(args.anchors) ?? [];
	const limit = clampPositiveInt(args.limit, DEFAULT_LIMIT * 2);
	if (anchors.length === 0) return { anchors, count: 0, pairs: [] };
	const pairs = await loadAffinities(env, anchors, limit);
	return { anchors, count: pairs.length, pairs };
}

// ---------- 10. Cuisine fusions ----------

export interface CuisineFusionsResult {
	cuisines: string[] | null;
	min_affinity: number | null;
	count: number;
	fusions: CuisineFusion[];
	prompt_lines: string[];
}

export async function inspireReadCuisineFusions(
	env: MiseGraphEnv,
	args: { cuisines?: string[] | null; min_affinity?: number | null; limit?: number },
): Promise<CuisineFusionsResult> {
	const cuisines = lowerStringArray(args.cuisines);
	const minAffinity = typeof args.min_affinity === "number" && Number.isFinite(args.min_affinity)
		? args.min_affinity
		: null;
	const limit = clampPositiveInt(args.limit, 50);
	const fusions = await loadCuisineFusions(env, {
		min_affinity: minAffinity ?? undefined,
		cuisine_filter: cuisines ?? undefined,
	});
	const sliced = fusions.slice(0, limit);
	return {
		cuisines,
		min_affinity: minAffinity,
		count: sliced.length,
		fusions: sliced,
		prompt_lines: formatCuisineFusionsForPrompt(sliced),
	};
}

// ---------- 11. Flavor vibes ----------

export interface FlavorVibesResult {
	count: number;
	vibes: FlavorVibe[];
	prompt_lines: string[];
}

export async function inspireReadFlavorVibes(
	env: MiseGraphEnv,
	args: { vibe_kind?: string; max?: number },
): Promise<FlavorVibesResult> {
	const max = clampPositiveInt(args.max, 24);
	const vibes = await loadFlavorVibes(env, {
		vibe_kind: optionalString(args.vibe_kind),
		max,
	});
	return {
		count: vibes.length,
		vibes,
		prompt_lines: formatFlavorVibesForPrompt(vibes),
	};
}

// ---------- 12. Format library ----------

export interface FormatLibraryResult {
	count: number;
	formats: FormatPromptShape[];
}

export async function inspireReadFormatLibrary(
	env: MiseGraphEnv,
	args: { formats?: string[] | null; max_cuisines_per_format?: number; max_ingredients_per_slot?: number },
): Promise<FormatLibraryResult> {
	const library = await loadFormatLibrary(env);
	const filterFormats = lowerStringArray(args.formats);
	const compact = formatLibraryForComposer(library, {
		max_cuisines_per_format: clampPositiveInt(args.max_cuisines_per_format, 4),
		max_ingredients_per_slot: clampPositiveInt(args.max_ingredients_per_slot, 3),
	});
	const filtered = filterFormats && filterFormats.length > 0
		? compact.filter(shape => filterFormats.includes(shape.format.toLowerCase()))
		: compact;
	// If a specific formats[] list was passed but the library only has some of
	// them, also try direct lookup so the agent can ask "do we have a recipe
	// for this format?" and get back null vs. populated entries deterministically.
	if (filterFormats && filterFormats.length > filtered.length) {
		const present = new Set(filtered.map(s => s.format.toLowerCase()));
		for (const name of filterFormats) {
			if (present.has(name)) continue;
			const tpl = findFormatTemplate(library, name);
			if (!tpl) continue;
			filtered.push({
				format: tpl.name,
				slots: tpl.slots
					.map(s => `${s.name} (${s.required ? "req" : "opt"} ${s.min === s.max ? s.min : `${s.min}-${s.max}`})`)
					.join(" + "),
				cuisine_riffs: [],
			});
		}
	}
	return { count: filtered.length, formats: filtered };
}

// ---------- 13. Master household context ----------

export interface HouseholdContextResult {
	household_id: string;
	plan_id: string | null;
	location_region: string | null;
	dates: string[];
	lookback_days: number;
	seasonality: SeasonalityResult;
	anchor_pressure: AnchorPressureResult;
	recent_menu: RecentMenuResult;
	taste_feedback: TasteFeedbackResult;
	recipe_library: RecipeLibraryResult;
	canonical_dishes: CanonicalDishesResult;
	canonical_components: CanonicalComponentsResult;
	affinity_pairs: AffinityPairsResult;
	flavor_compounds: { anchors: string[]; pairings: ContextCompoundPair[] };
	cuisine_fusions: CuisineFusionsResult;
	flavor_vibes: FlavorVibesResult;
	format_library: FormatLibraryResult;
}

export async function inspireReadHouseholdContext(
	env: MiseGraphEnv,
	args: {
		household_id: string;
		plan_id?: string | null;
		lookback_days?: number;
		location_region?: string | null;
		dates?: string[] | null;
		anchors?: string[] | null;
		// Compact mode tightens per-section limits AND strips bulky fields
		// (vibe example_dishes/components, format slot ingredients, fusion
		// examples). Default false. Cuts payload by ~6–8× for fresh agents
		// that just need a structural overview.
		compact?: boolean;
		per_section_limit?: number;
	},
): Promise<HouseholdContextResult> {
	const householdId = requireString(args.household_id, "household_id");
	const planId = optionalString(args.plan_id) ?? null;
	const lookback = clampPositiveInt(args.lookback_days, DEFAULT_LOOKBACK_DAYS);
	const region = optionalString(args.location_region) ?? null;
	const dates = ensureDates(args.dates);
	const compact = args.compact === true;
	// Per-section limit: explicit > compact default (4) > full default (DEFAULT_LIMIT=12)
	const perSection = clampPositiveInt(
		args.per_section_limit,
		compact ? 4 : DEFAULT_LIMIT,
	);
	// Anchors fall back to the household's saturated/trending anchors when not
	// passed — that's the agent's default intent on first-turn read.
	const anchorsArg = lowerStringArray(args.anchors);

	// Run the cheap parallel reads first; we may need anchor_pressure to
	// derive the anchors used by canonical_*/affinity_*/compound_* tools.
	const [
		seasonality,
		anchorPressure,
		recentMenu,
		tasteFeedback,
		recipeLibrary,
		cuisineFusionsResult,
		flavorVibesResult,
		formatLibraryResult,
	] = await Promise.all([
		inspireReadSeasonality(env, { region, dates, limit: compact ? perSection : perSection * 2 }),
		inspireReadAnchorPressure(env, { household_id: householdId, lookback_days: lookback }),
		inspireReadRecentMenu(env, { household_id: householdId, lookback_days: lookback }),
		inspireReadTasteFeedback(env, { household_id: householdId, lookback_days: FEEDBACK_LOOKBACK_DAYS }),
		inspireReadRecipeLibrary(env, { household_id: householdId, limit: compact ? perSection * 2 : 25 }),
		inspireReadCuisineFusions(env, { min_affinity: 0.5, limit: perSection }),
		inspireReadFlavorVibes(env, { max: perSection }),
		inspireReadFormatLibrary(env, {
			max_cuisines_per_format: compact ? 1 : 3,
			max_ingredients_per_slot: compact ? 1 : 3,
		}),
	]);

	// In compact mode, strip the bulky example arrays from vibes / fusions.
	// They're useful to a deep read but balloon payload size for the common
	// "scan and pick a vibe" path.
	if (compact) {
		stripCompactBulk(flavorVibesResult, formatLibraryResult, cuisineFusionsResult);
	}

	const derivedAnchors = anchorsArg && anchorsArg.length > 0
		? anchorsArg
		: deriveAnchorsForLookups(anchorPressure, tasteFeedback, recipeLibrary);

	const [canonicalDishes, canonicalComponents, affinityPairs, compounds] = await Promise.all([
		inspireReadCanonicalDishes(env, { anchors: derivedAnchors, limit: perSection }),
		inspireReadCanonicalComponents(env, { anchors: derivedAnchors, limit: perSection }),
		inspireReadAffinityPairs(env, { anchors: derivedAnchors, limit: perSection }),
		loadCompoundPairings(env, derivedAnchors, perSection),
	]);

	return {
		household_id: householdId,
		plan_id: planId,
		location_region: region,
		dates,
		lookback_days: lookback,
		seasonality,
		anchor_pressure: anchorPressure,
		recent_menu: recentMenu,
		taste_feedback: tasteFeedback,
		recipe_library: recipeLibrary,
		canonical_dishes: canonicalDishes,
		canonical_components: canonicalComponents,
		affinity_pairs: affinityPairs,
		flavor_compounds: { anchors: derivedAnchors, pairings: compounds },
		cuisine_fusions: cuisineFusionsResult,
		flavor_vibes: flavorVibesResult,
		format_library: formatLibraryResult,
	};
}

// ---------- helpers ----------

// Strip bulk fields from the shared canonical results when caller asked
// for compact mode. We mutate the result objects in place because they
// were just produced for THIS request — callers don't share references.
function stripCompactBulk(
	vibes: FlavorVibesResult,
	formatLib: FormatLibraryResult,
	fusions: CuisineFusionsResult,
): void {
	for (const v of vibes.vibes) {
		(v as { example_dishes?: unknown }).example_dishes = undefined;
		(v as { example_components?: unknown }).example_components = undefined;
		(v as { description?: unknown }).description = undefined;
	}
	for (const fmt of formatLib.formats) {
		(fmt as { example_recipes?: unknown }).example_recipes = undefined;
		(fmt as { example_dishes?: unknown }).example_dishes = undefined;
	}
	for (const f of fusions.fusions) {
		(f as { examples?: unknown }).examples = undefined;
		(f as { description?: unknown }).description = undefined;
	}
}

function deriveAnchorsForLookups(
	anchorPressure: AnchorPressureResult,
	tasteFeedback: TasteFeedbackResult,
	recipeLibrary: RecipeLibraryResult,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (name: string | undefined | null) => {
		if (!name) return;
		const key = name.toLowerCase().trim();
		if (!key || seen.has(key)) return;
		seen.add(key);
		out.push(key);
	};
	// Loved anchors and trending anchors are the most useful starting points —
	// they reflect what the household actually wants more of right now.
	for (const [name] of Object.entries(tasteFeedback.loved_anchors).sort((a, b) => b[1] - a[1])) {
		add(name);
		if (out.length >= 6) return out;
	}
	for (const bucket of anchorPressure.trending) {
		add(bucket.name);
		if (out.length >= 6) return out;
	}
	for (const recipe of recipeLibrary.recipes) {
		for (const ing of recipe.ingredients) {
			add(ing.name);
			if (out.length >= 6) return out;
		}
	}
	return out;
}

function ensureDates(value: unknown): string[] {
	if (!Array.isArray(value)) {
		// Default: today + the next 6 days.
		const out: string[] = [];
		const today = new Date();
		for (let i = 0; i < 7; i++) {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() + i);
			out.push(d.toISOString().slice(0, 10));
		}
		return out;
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)) out.push(item);
	}
	return out;
}

function lowerStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) out.push(item.trim().toLowerCase());
	}
	return out.length > 0 ? out : null;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} is required`);
	}
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function clampPositiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}
