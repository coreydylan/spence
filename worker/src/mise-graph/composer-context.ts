// Composer context loader.
//
// Pulls real signal from the Spence corpus + household state and packages it
// into a compact bundle the menu composer LLM can ground itself in:
//
//   - canonical_dishes: real dishes from the recipe corpus that match anchors
//   - canonical_components: reusable components from the corpus
//   - ingredient_edges: top affinity pairs (PMI-weighted) for the anchors
//   - regional_seasons + produce_profiles: peak/coming/departing for the dates
//   - flavor_compounds: top molecular pairings (FoodDB) for the anchors
//   - composition_templates: format templates ("grain bowl = base + protein + ...")
//   - personal_recipes: user-loved recipes for the household
//   - recent_menu_context: last 4 weeks of plans (variety pressure)
//   - pantry_pressure: items expiring in the plan window
//   - feedback_hints: loved / rejected meals from past ratings
//
// Each is capped to top N to keep the prompt focused. The composer's system
// prompt teaches it to USE this context — prefer real dishes from the corpus,
// honor seasonality, lean on affinity pairs, cite lineage in the output.

import type { MiseGraphEnv } from "./types";
import { loadRecentMenuContext, type RecentMenuContext } from "./window-memory";
import { loadRecentFeedback, mealFeedbackHints, type MealFeedbackHints } from "./recipe-feedback";
import { loadPantryPressure, type PantryPressureContext } from "./pantry-pressure";
import { loadFormatLibrary, formatLibraryForComposer, type FormatPromptShape } from "./format-library-loader";
import { loadCuisineFusions, loadFlavorVibes, formatCuisineFusionsForPrompt, formatFlavorVibesForPrompt } from "./cuisine-fusions";

export interface ComposerContextBundle {
	dish_candidates: ContextDish[];
	component_candidates: ContextComponent[];
	affinity_pairs: ContextAffinity[];
	seasonal_items: ContextSeasonalItem[];
	technique_hints: ContextTechnique[];
	flavor_compound_pairings: ContextCompoundPair[];
	composition_templates: ContextCompositionTemplate[];
	personal_recipe_candidates: ContextPersonalRecipe[];
	recent_menu?: RecentMenuContext | null;
	pantry_pressure?: PantryPressureContext | null;
	feedback_hints?: MealFeedbackHints | null;
	format_library?: FormatPromptShape[] | null;
	cuisine_fusions_lines?: string[] | null;
	flavor_vibe_lines?: string[] | null;
}

export interface ContextDish {
	id: string;
	title: string;
	composition: string | null;
	core_ingredients: string[];
	expected_ingredients: string[];
	methods: string[];
	equipment: string[];
	recipe_count: number;
	consensus_total_time: number | null;
	consensus_servings: number | null;
}

export interface ContextComponent {
	id: string;
	canonical_name: string;
	component_type: string | null;
	core_ingredients: string[];
	common_ingredients: string[];
	recipe_count: number;
}

export interface ContextAffinity {
	a: string;
	b: string;
	pmi: number;
	co_count: number;
}

export interface ContextSeasonalItem {
	canonical_name: string;
	status: "peak" | "coming" | "departing" | "available";
	region: string | null;
	month: number | null;
	notes: string | null;
}

export interface ContextTechnique {
	technique: string;
	equipment: string[];
	example_ingredients: string[];
	freq: number;
}

export interface ContextCompoundPair {
	a: string;
	b: string;
	shared_compounds: number;
	top_compounds: string[];
}

export interface ContextCompositionTemplate {
	name: string;
	slots: string[];
	variants: string[];
}

export interface ContextPersonalRecipe {
	id: string;
	title: string;
	cuisine: string[];
	format: string | null;
	canonical_ingredients: Array<{ name: string; qty?: number; unit?: string }>;
	method_summary: string | null;
	servings: number | null;
	loved: boolean;
	cooked_count: number;
	last_cooked_at: string | null;
	flavor_tags: string[];
}

export interface ComposerContextRequest {
	anchors: string[];
	plan_dates: string[];
	household_id: string | null;
	location_region: string | null;
	cuisine_direction: string[];
	per_section_limit?: number;
}

export async function loadComposerContext(env: MiseGraphEnv, request: ComposerContextRequest): Promise<ComposerContextBundle> {
	const limit = request.per_section_limit ?? 12;
	const [
		dishes,
		components,
		affinities,
		seasonal,
		techniques,
		compounds,
		templates,
		personal,
		recentMenu,
		pantry,
		feedback,
		formatLibrary,
		cuisineFusionLines,
		flavorVibeLines,
	] = await Promise.all([
		loadDishCandidates(env, request.anchors, limit),
		loadComponentCandidates(env, request.anchors, limit),
		loadAffinities(env, request.anchors, limit * 2),
		loadSeasonal(env, request.plan_dates, request.location_region, limit * 2),
		loadTechniques(env, request.anchors, limit),
		loadCompoundPairings(env, request.anchors, limit),
		loadCompositionTemplates(env, limit * 2),
		loadPersonalRecipes(env, request.household_id, request.anchors, request.cuisine_direction, limit * 2),
		request.household_id
			? loadRecentMenuContext(env, { household_id: request.household_id, lookback_days: 28 }).catch(() => null)
			: Promise.resolve(null),
		request.household_id
			? loadPantryPressure(env, request.household_id, request.plan_dates).catch(() => null)
			: Promise.resolve(null),
		request.household_id
			? loadRecentFeedback(env, request.household_id, 60).then(rows => mealFeedbackHints(rows)).catch(() => null)
			: Promise.resolve(null),
		loadFormatLibrary(env).then(lib => formatLibraryForComposer(lib, { max_cuisines_per_format: 4, max_ingredients_per_slot: 3 })).catch(() => null),
		loadCuisineFusions(env, { min_affinity: 0.5 }).then(fusions => formatCuisineFusionsForPrompt(fusions)).catch(() => null),
		loadFlavorVibes(env, { max: 24 }).then(vibes => formatFlavorVibesForPrompt(vibes)).catch(() => null),
	]);
	return {
		dish_candidates: dishes,
		component_candidates: components,
		affinity_pairs: affinities,
		seasonal_items: seasonal,
		technique_hints: techniques,
		flavor_compound_pairings: compounds,
		composition_templates: templates,
		personal_recipe_candidates: personal,
		recent_menu: recentMenu,
		pantry_pressure: pantry,
		feedback_hints: feedback,
		format_library: formatLibrary,
		cuisine_fusions_lines: cuisineFusionLines,
		flavor_vibe_lines: flavorVibeLines,
	};
}

export async function loadDishCandidates(env: MiseGraphEnv, anchors: string[], limit: number): Promise<ContextDish[]> {
	// When called with no anchors, fall back to top dishes by recipe_count —
	// gives the agent something useful to look at instead of an empty array
	// when it doesn't yet know what ingredients to focus on.
	const filtered = anchors.length === 0
		? { where: "1=1", params: [] as unknown[] }
		: likeJsonClauses(anchors, ["core_ingredients", "expected_ingredients"]);
	if (!filtered.where) return [];
	try {
		const result = await env.DB.prepare(`
			SELECT id, canonical_title, composition, methods, equipment,
				recipe_count, consensus_total_time, consensus_servings,
				core_ingredients, expected_ingredients
			FROM canonical_dishes
			WHERE ${filtered.where}
			ORDER BY recipe_count DESC
			LIMIT ?
		`).bind(...filtered.params, limit).all<{
			id: string;
			canonical_title: string;
			composition: string | null;
			methods: string | null;
			equipment: string | null;
			recipe_count: number | null;
			consensus_total_time: number | null;
			consensus_servings: number | null;
			core_ingredients: string | null;
			expected_ingredients: string | null;
		}>();
		return (result.results || []).map(row => ({
			id: row.id,
			title: row.canonical_title,
			composition: row.composition,
			core_ingredients: parseJsonArray(row.core_ingredients),
			expected_ingredients: parseJsonArray(row.expected_ingredients),
			methods: parseJsonArray(row.methods),
			equipment: parseJsonArray(row.equipment),
			recipe_count: row.recipe_count || 0,
			consensus_total_time: row.consensus_total_time,
			consensus_servings: row.consensus_servings,
		}));
	} catch {
		return [];
	}
}

export async function loadComponentCandidates(env: MiseGraphEnv, anchors: string[], limit: number): Promise<ContextComponent[]> {
	// Same fallback as loadDishCandidates — empty anchors returns top by
	// recipe_count instead of an empty array.
	const filtered = anchors.length === 0
		? { where: "1=1", params: [] as unknown[] }
		: likeJsonClauses(anchors, ["core_ingredients", "common_ingredients"]);
	if (!filtered.where) return [];
	try {
		const result = await env.DB.prepare(`
			SELECT id, canonical_name, component_type, recipe_count,
				core_ingredients, common_ingredients
			FROM canonical_components
			WHERE ${filtered.where}
			ORDER BY recipe_count DESC
			LIMIT ?
		`).bind(...filtered.params, limit).all<{
			id: string;
			canonical_name: string;
			component_type: string | null;
			recipe_count: number | null;
			core_ingredients: string | null;
			common_ingredients: string | null;
		}>();
		return (result.results || []).map(row => ({
			id: row.id,
			canonical_name: row.canonical_name,
			component_type: row.component_type,
			core_ingredients: parseJsonArray(row.core_ingredients),
			common_ingredients: parseJsonArray(row.common_ingredients),
			recipe_count: row.recipe_count || 0,
		}));
	} catch {
		return [];
	}
}

export async function loadAffinities(env: MiseGraphEnv, anchors: string[], limit: number): Promise<ContextAffinity[]> {
	if (anchors.length === 0) return [];
	try {
		const placeholders = anchors.map(() => "?").join(",");
		const lower = anchors.map(name => name.toLowerCase());
		const idsResult = await env.DB.prepare(`
			SELECT id, name FROM canonical_ingredients
			WHERE LOWER(name) IN (${placeholders})
			LIMIT 25
		`).bind(...lower).all<{ id: number; name: string }>();
		const ids = (idsResult.results || []).map(row => row.id);
		if (ids.length === 0) return [];
		const idList = ids.join(",");
		const idsSet = new Set(ids);
		const idToName = new Map((idsResult.results || []).map(row => [row.id, row.name]));
		const result = await env.DB.prepare(`
			SELECT e.from_ingredient_id, e.to_ingredient_id,
				ci_from.name AS from_name, ci_to.name AS to_name,
				SUM(e.weighted_pmi) AS pmi,
				SUM(e.co_count) AS co_count
			FROM ingredient_edges e
			JOIN canonical_ingredients ci_from ON ci_from.id = e.from_ingredient_id
			JOIN canonical_ingredients ci_to ON ci_to.id = e.to_ingredient_id
			WHERE e.from_ingredient_id IN (${idList}) OR e.to_ingredient_id IN (${idList})
			GROUP BY e.from_ingredient_id, e.to_ingredient_id, ci_from.name, ci_to.name
			ORDER BY pmi DESC
			LIMIT ?
		`).bind(limit * 4).all<{
			from_ingredient_id: number;
			to_ingredient_id: number;
			from_name: string;
			to_name: string;
			pmi: number | null;
			co_count: number | null;
		}>();
		const seen = new Set<string>();
		const out: ContextAffinity[] = [];
		for (const row of result.results || []) {
			const otherSide = idsSet.has(row.from_ingredient_id) ? row.to_name : row.from_name;
			if (idsSet.has(row.from_ingredient_id) && idsSet.has(row.to_ingredient_id)) {
				const key = [row.from_name, row.to_name].sort().join("::");
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({
					a: row.from_name,
					b: row.to_name,
					pmi: Number(row.pmi || 0),
					co_count: Number(row.co_count || 0),
				});
				continue;
			}
			const anchor = idsSet.has(row.from_ingredient_id) ? row.from_name : row.to_name;
			const key = [anchor, otherSide].sort().join("::");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				a: anchor,
				b: otherSide,
				pmi: Number(row.pmi || 0),
				co_count: Number(row.co_count || 0),
			});
			if (out.length >= limit) break;
		}
		return out.slice(0, limit);
	} catch {
		return [];
	}
}

// Friendly region resolver — agents pass things like "san_diego_ca" or
// "california" or even "san_diego"; the data is keyed by USDA-ish regions
// (`southwest`, `northeast`, ...). Map common variants to those keys.
const REGION_ALIASES: Record<string, string> = {
	"san_diego": "southwest", "san_diego_ca": "southwest",
	"socal": "southwest", "southern_california": "southwest",
	"ca": "southwest", "california": "southwest",
	"nv": "southwest", "nevada": "southwest",
	"az": "southwest", "arizona": "southwest",
	"ny": "northeast", "new_york": "northeast",
	"ma": "northeast", "boston": "northeast", "massachusetts": "northeast",
	"pnw": "northwest", "wa": "northwest", "or": "northwest",
	"seattle": "northwest", "portland": "northwest",
	"midwest": "great_lakes_midwest",
	"chicago": "great_lakes_midwest", "il": "great_lakes_midwest",
	"texas": "south_central", "tx": "south_central",
	"florida": "southeast", "fl": "southeast",
	"atlanta": "southeast", "ga": "southeast",
};

function resolveRegion(input: string): string {
	const k = input.toLowerCase().trim().replace(/\s+/g, "_");
	return REGION_ALIASES[k] ?? k;
}

export async function loadSeasonal(env: MiseGraphEnv, dates: string[], region: string | null, limit: number): Promise<ContextSeasonalItem[]> {
	if (dates.length === 0) return [];
	try {
		const months = unique(dates.map(date => Number(date.slice(5, 7))).filter(month => month >= 1 && month <= 12));
		if (months.length === 0) return [];
		const targetMonth = months[0];
		const nextMonth = (targetMonth % 12) + 1;
		const params: unknown[] = [];
		let regionClause = "";
		if (region) {
			const resolved = resolveRegion(region);
			regionClause = "AND (rs.region = ? OR rs.region IS NULL OR rs.region = '')";
			params.push(resolved);
		}
		// regional_seasons.months is stored as JSON: e.g. "[6, 7, 8]". Pull
		// any row touching the target window — we'll classify status by
		// parsing JSON in code (json_each is awkward across dialects).
		const result = await env.DB.prepare(`
			SELECT rs.ingredient, rs.region, rs.season, rs.months,
				pp.peak_months AS pp_peak_months,
				pp.description_taste AS pp_description_taste,
				pp.season_profile AS pp_season_profile
			FROM regional_seasons rs
			LEFT JOIN produce_profiles pp
				ON LOWER(rs.ingredient) = LOWER(pp.normalized_name)
				OR LOWER(rs.ingredient) = LOWER(pp.name)
			WHERE rs.months IS NOT NULL AND rs.months != ''
			${regionClause}
			LIMIT ?
		`).bind(...params, limit * 8).all<{
			ingredient: string;
			region: string | null;
			season: string | null;
			months: string | null;
			pp_peak_months: string | null;
			pp_description_taste: string | null;
			pp_season_profile: string | null;
		}>();
		const out: ContextSeasonalItem[] = [];
		const seen = new Set<string>();
		for (const row of result.results || []) {
			const monthsArr = parseIntArray(row.months);
			if (monthsArr.length === 0) continue;
			const inThis = monthsArr.includes(targetMonth);
			const inNext = monthsArr.includes(nextMonth);
			let status: ContextSeasonalItem["status"];
			if (inThis && inNext) status = "peak";
			else if (inThis && !inNext) status = "departing";
			else if (!inThis && inNext) status = "coming";
			else continue; // not relevant to this window
			const key = row.ingredient.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				canonical_name: row.ingredient,
				status,
				region: row.region,
				month: targetMonth,
				notes: row.pp_description_taste,
			});
		}
		return out.sort((a, b) => statusRank(a.status) - statusRank(b.status)).slice(0, limit);
	} catch {
		return [];
	}
}

function parseIntArray(value: string | null): number[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((n): n is number => typeof n === "number" && n >= 1 && n <= 12);
	} catch {
		return [];
	}
}

function statusRank(status: ContextSeasonalItem["status"]): number {
	if (status === "peak") return 0;
	if (status === "coming") return 1;
	if (status === "departing") return 2;
	return 3;
}

async function loadTechniques(env: MiseGraphEnv, anchors: string[], limit: number): Promise<ContextTechnique[]> {
	if (anchors.length === 0) return [];
	try {
		const placeholders = anchors.map(() => "?").join(",");
		const lower = anchors.map(name => name.toLowerCase());
		const result = await env.DB.prepare(`
			SELECT ti.technique, COUNT(*) AS freq,
				GROUP_CONCAT(DISTINCT ti.canonical_name) AS examples
			FROM tg_technique_ingredient ti
			WHERE LOWER(ti.canonical_name) IN (${placeholders})
			GROUP BY ti.technique
			ORDER BY freq DESC
			LIMIT ?
		`).bind(...lower, limit * 2).all<{
			technique: string;
			freq: number;
			examples: string;
		}>();
		const out: ContextTechnique[] = [];
		for (const row of result.results || []) {
			const eqResult = await env.DB.prepare(`
				SELECT equipment, COUNT(*) AS n FROM tg_technique_equipment
				WHERE technique = ?
				GROUP BY equipment
				ORDER BY n DESC
				LIMIT 4
			`).bind(row.technique).all<{ equipment: string }>();
			out.push({
				technique: row.technique,
				equipment: (eqResult.results || []).map(eq => eq.equipment),
				example_ingredients: (row.examples || "").split(",").slice(0, 5),
				freq: Number(row.freq || 0),
			});
			if (out.length >= limit) break;
		}
		return out;
	} catch {
		return [];
	}
}

export async function loadCompoundPairings(env: MiseGraphEnv, anchors: string[], limit: number): Promise<ContextCompoundPair[]> {
	if (anchors.length === 0) return [];
	try {
		const placeholders = anchors.map(() => "?").join(",");
		const lower = anchors.map(name => name.toLowerCase());
		const idsResult = await env.DB.prepare(`
			SELECT id, name FROM canonical_ingredients
			WHERE LOWER(name) IN (${placeholders})
			LIMIT 25
		`).bind(...lower).all<{ id: number; name: string }>();
		const ids = (idsResult.results || []).map(row => row.id);
		if (ids.length === 0) return [];
		const idList = ids.join(",");
		const idToName = new Map((idsResult.results || []).map(row => [row.id, row.name]));

		const result = await env.DB.prepare(`
			SELECT
				ic1.canonical_ingredient_id AS a_id,
				ic2.canonical_ingredient_id AS b_id,
				ci.name AS b_name,
				COUNT(DISTINCT ic1.compound_id) AS shared,
				GROUP_CONCAT(DISTINCT fc.name) AS compound_names
			FROM ingredient_compounds ic1
			JOIN ingredient_compounds ic2 ON ic2.compound_id = ic1.compound_id
				AND ic2.canonical_ingredient_id != ic1.canonical_ingredient_id
			JOIN canonical_ingredients ci ON ci.id = ic2.canonical_ingredient_id
			JOIN flavor_compounds fc ON fc.id = ic1.compound_id
			WHERE ic1.canonical_ingredient_id IN (${idList})
				AND ic2.canonical_ingredient_id NOT IN (${idList})
			GROUP BY ic1.canonical_ingredient_id, ic2.canonical_ingredient_id, ci.name
			HAVING shared >= 5
			ORDER BY shared DESC
			LIMIT ?
		`).bind(limit * 2).all<{
			a_id: number;
			b_id: number;
			b_name: string;
			shared: number;
			compound_names: string;
		}>();
		const out: ContextCompoundPair[] = [];
		const seen = new Set<string>();
		for (const row of result.results || []) {
			const aName = idToName.get(row.a_id) || `id:${row.a_id}`;
			const key = [aName, row.b_name].sort().join("::");
			if (seen.has(key)) continue;
			seen.add(key);
			const compoundList = (row.compound_names || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
			out.push({
				a: aName,
				b: row.b_name,
				shared_compounds: row.shared,
				top_compounds: compoundList,
			});
			if (out.length >= limit) break;
		}
		return out;
	} catch {
		return [];
	}
}

async function loadCompositionTemplates(env: MiseGraphEnv, limit: number): Promise<ContextCompositionTemplate[]> {
	try {
		const result = await env.DB.prepare(`
			SELECT name, slots_json, variant_sets_json
			FROM composition_templates
			LIMIT ?
		`).bind(limit).all<{
			name: string;
			slots_json: string | null;
			variant_sets_json: string | null;
		}>();
		return (result.results || []).map(row => {
			const slots = parseJsonArray(row.slots_json) as unknown as Array<{ name?: string }>;
			const variants = parseJsonArray(row.variant_sets_json) as unknown as Array<{ name?: string }>;
			return {
				name: row.name,
				slots: slots.map(s => s.name || "").filter(Boolean).slice(0, 8),
				variants: variants.map(v => v.name || "").filter(Boolean).slice(0, 4),
			};
		});
	} catch {
		return [];
	}
}

async function loadPersonalRecipes(env: MiseGraphEnv, householdId: string | null, anchors: string[], cuisineDirection: string[], limit: number): Promise<ContextPersonalRecipe[]> {
	if (!householdId) return [];
	try {
		const result = await env.DB.prepare(`
			SELECT id, normalized_title, original_title, cuisine_json, format,
				canonical_ingredients_json, method_summary, servings,
				flavor_tags_json, household_loved, cooked_count, last_cooked_at
			FROM personal_recipes
			WHERE household_id = ?
			ORDER BY household_loved DESC, household_rating DESC, cooked_count DESC, last_cooked_at DESC
			LIMIT ?
		`).bind(householdId, limit * 3).all<{
			id: string;
			normalized_title: string | null;
			original_title: string | null;
			cuisine_json: string | null;
			format: string | null;
			canonical_ingredients_json: string | null;
			method_summary: string | null;
			servings: number | null;
			flavor_tags_json: string | null;
			household_loved: number;
			cooked_count: number;
			last_cooked_at: string | null;
		}>();
		const out = (result.results || []).map(row => ({
			id: row.id,
			title: row.normalized_title || row.original_title || "untitled recipe",
			cuisine: parseJsonArray(row.cuisine_json),
			format: row.format,
			canonical_ingredients: (parseJsonArray(row.canonical_ingredients_json) as unknown as Array<Record<string, unknown>>)
				.slice(0, 10)
				.map(ing => ({
					name: String(ing.name || ing.canonical_name || ""),
					qty: typeof ing.qty === "number" ? ing.qty : undefined,
					unit: typeof ing.unit === "string" ? ing.unit : undefined,
				}))
				.filter(ing => ing.name),
			method_summary: row.method_summary,
			servings: row.servings,
			loved: row.household_loved === 1,
			cooked_count: row.cooked_count || 0,
			last_cooked_at: row.last_cooked_at,
			flavor_tags: parseJsonArray(row.flavor_tags_json),
		}));
		// Score: favor anchor overlap + cuisine match.
		const anchorSet = new Set(anchors.map(a => a.toLowerCase()));
		const cuisineSet = new Set(cuisineDirection.map(c => c.toLowerCase()));
		const scored = out.map(recipe => {
			let score = recipe.loved ? 5 : 0;
			score += Math.min(5, recipe.cooked_count);
			score += recipe.canonical_ingredients.filter(i => anchorSet.has(i.name.toLowerCase())).length * 2;
			if (recipe.cuisine.some(c => cuisineSet.has(c.toLowerCase()))) score += 3;
			return { recipe, score };
		});
		return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.recipe);
	} catch {
		return [];
	}
}

function parseJsonArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
		return [];
	} catch {
		return [];
	}
}

function likeJsonClauses(values: string[], columns: string[]): { where: string; params: unknown[] } {
	if (values.length === 0 || columns.length === 0) return { where: "", params: [] };
	const params: unknown[] = [];
	const clauses: string[] = [];
	for (const value of values) {
		const lower = value.toLowerCase();
		for (const column of columns) {
			clauses.push(`LOWER(${column}) LIKE ?`);
			params.push(`%${lower}%`);
		}
	}
	return { where: clauses.join(" OR "), params };
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}
