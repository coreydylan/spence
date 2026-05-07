// Recipe lookup — Track A.
//
// Exposes a real recipe-step reader against the `canonical_recipes_v2` D1
// table. The agent uses this when it needs concrete method steps (rather
// than a synthesized timeline) for a meal it's planning or briefing.
//
// `canonical_recipes_v2` rows have a heavy `document_json` blob that
// contains the full structured recipe (ingredient_groups, steps with
// prose, time, yield, etc.). We pull a row, parse the JSON, and return a
// compact, agent-friendly shape:
//
//   { recipe_id, title, ingredients[], steps[], total_time_min,
//     servings, source_url }
//
// Caller can identify the recipe by `recipe_id` (the exact `id` column,
// e.g. `"banana_bread"`), by `canonical_dish_id` (joined through
// `canonical_dishes` to find a matching recipe), or by
// `canonical_dish_title` (LIKE match against the recipe `title` and
// `canonical_dishes.canonical_title`). At least one identifier is
// required.
//
// All DB calls are wrapped in try/catch — schema mismatches and missing
// tables degrade to `null` rather than crashing the agent loop, matching
// the pattern in `composer-context.ts`.

import type { MiseGraphEnv } from "./types";

export interface RecipeStepsArgs {
	recipe_id?: string | null;
	canonical_dish_id?: string | number | null;
	canonical_dish_title?: string | null;
	limit?: number;
}

export interface RecipeIngredient {
	name: string;
	qty: number | null;
	unit: string | null;
	prep: string | null;
	importance: string | null;
	group: string | null;
}

export interface RecipeStep {
	index: number;
	phase: string | null;
	prose: string;
	verb: string | null;
	ingredients: string[];
	equipment: string[];
	completion_signal: string | null;
	idle_time_min: number | null;
}

export interface RecipeStepsResult {
	recipe_id: string;
	title: string;
	description: string | null;
	ingredients: RecipeIngredient[];
	steps: RecipeStep[];
	total_time_min: number | null;
	prep_time_min: number | null;
	cook_time_min: number | null;
	servings: number | null;
	source_url: string | null;
	matched_by: "recipe_id" | "canonical_dish_id" | "canonical_dish_title";
}

interface CanonicalRecipeRow {
	id: string;
	title: string;
	description: string | null;
	document_json: string;
}

/**
 * Load real recipe steps from `canonical_recipes_v2`. Returns null when
 * no recipe matches or the underlying DB is unreachable. The caller
 * (the MCP handler) decides whether that translates to {ok:false,...}
 * or an empty result.
 */
export async function loadRecipeSteps(
	env: MiseGraphEnv,
	args: RecipeStepsArgs,
): Promise<RecipeStepsResult | null> {
	const recipeId = trimString(args.recipe_id);
	const canonicalDishId = args.canonical_dish_id != null && String(args.canonical_dish_id).trim().length > 0
		? String(args.canonical_dish_id).trim()
		: null;
	const canonicalDishTitle = trimString(args.canonical_dish_title);

	if (!recipeId && !canonicalDishId && !canonicalDishTitle) {
		return null;
	}

	let row: CanonicalRecipeRow | null = null;
	let matchedBy: RecipeStepsResult["matched_by"] = "recipe_id";

	// 1) Direct recipe_id match — the cheapest and most precise path.
	if (recipeId) {
		row = await safeFetchById(env, recipeId);
		matchedBy = "recipe_id";
	}

	// 2) canonical_dish_id → look up the dish title, then LIKE match a recipe.
	if (!row && canonicalDishId) {
		const dishTitle = await safeFetchDishTitle(env, canonicalDishId);
		if (dishTitle) {
			row = await safeFetchByTitle(env, dishTitle);
		}
		// Fall back to treating the canonical_dish_id as a recipe id in case
		// the agent already passed a slug like "banana_bread".
		if (!row) row = await safeFetchById(env, canonicalDishId);
		matchedBy = "canonical_dish_id";
	}

	// 3) canonical_dish_title — LIKE match against title.
	if (!row && canonicalDishTitle) {
		row = await safeFetchByTitle(env, canonicalDishTitle);
		matchedBy = "canonical_dish_title";
	}

	if (!row) return null;
	return shapeResult(row, matchedBy);
}

function shapeResult(row: CanonicalRecipeRow, matchedBy: RecipeStepsResult["matched_by"]): RecipeStepsResult {
	const doc = parseJsonObject(row.document_json);
	const time = parseJsonObject(doc.time);
	const yieldDoc = parseJsonObject(doc.yield);
	const ingredientGroups = Array.isArray(doc.ingredient_groups) ? doc.ingredient_groups : [];
	const stepsRaw = Array.isArray(doc.steps) ? doc.steps : [];
	const internal = parseJsonObject(doc._internal);

	const ingredients: RecipeIngredient[] = [];
	for (const group of ingredientGroups) {
		const g = parseJsonObject(group);
		const groupLabel = typeof g.label === "string" ? g.label : null;
		const items = Array.isArray(g.items) ? g.items : [];
		for (const item of items) {
			const it = parseJsonObject(item);
			const name = typeof it.canonical_name === "string"
				? it.canonical_name
				: typeof it.name === "string" ? it.name : null;
			if (!name) continue;
			ingredients.push({
				name,
				qty: typeof it.consensus_qty === "number"
					? it.consensus_qty
					: typeof it.qty === "number" ? it.qty : null,
				unit: typeof it.unit === "string" ? it.unit : null,
				prep: typeof it.prep === "string" ? it.prep : null,
				importance: typeof it.importance === "string" ? it.importance : null,
				group: groupLabel,
			});
		}
	}

	const steps: RecipeStep[] = stepsRaw
		.map((raw: unknown, idx: number): RecipeStep | null => {
			const s = parseJsonObject(raw);
			const prose = typeof s.prose === "string" && s.prose.length > 0
				? s.prose
				: typeof s.description === "string" ? s.description : "";
			if (!prose) return null;
			const primary = parseJsonObject(s.primary_action);
			const ingredientRefs = Array.isArray(s.ingredient_refs)
				? s.ingredient_refs.filter((x: unknown): x is string => typeof x === "string")
				: [];
			const equipmentRefs = Array.isArray(s.equipment_refs)
				? s.equipment_refs.filter((x: unknown): x is string => typeof x === "string")
				: [];
			return {
				index: typeof s.index === "number" ? s.index : idx + 1,
				phase: typeof s.phase === "string" ? s.phase : null,
				prose,
				verb: typeof primary.verb === "string" ? primary.verb : null,
				ingredients: ingredientRefs,
				equipment: equipmentRefs,
				completion_signal: typeof s.completion_signal === "string" ? s.completion_signal : null,
				idle_time_min: typeof s.idle_time_min === "number" ? s.idle_time_min : null,
			};
		})
		.filter((s): s is RecipeStep => s !== null);

	const sourceUrl = typeof internal.source_url === "string"
		? internal.source_url
		: typeof doc.source_url === "string" ? doc.source_url : null;

	return {
		recipe_id: row.id,
		title: row.title,
		description: row.description ?? (typeof doc.description === "string" ? doc.description : null),
		ingredients,
		steps,
		total_time_min: typeof time.total_min === "number" ? time.total_min : null,
		prep_time_min: typeof time.prep_min === "number" ? time.prep_min : null,
		cook_time_min: typeof time.cook_min === "number" ? time.cook_min : null,
		servings: typeof yieldDoc.servings === "number" ? yieldDoc.servings : null,
		source_url: sourceUrl,
		matched_by: matchedBy,
	};
}

async function safeFetchById(env: MiseGraphEnv, id: string): Promise<CanonicalRecipeRow | null> {
	try {
		const row = await env.DB.prepare(`
			SELECT id, title, description, document_json
			FROM canonical_recipes_v2
			WHERE id = ?
			LIMIT 1
		`).bind(id).first<CanonicalRecipeRow>();
		return row ?? null;
	} catch {
		return null;
	}
}

async function safeFetchByTitle(env: MiseGraphEnv, title: string): Promise<CanonicalRecipeRow | null> {
	try {
		const lower = title.toLowerCase();
		// Exact-ish match first (case-insensitive), then LIKE fallback. Both
		// degrade gracefully if the column doesn't exist.
		const exact = await env.DB.prepare(`
			SELECT id, title, description, document_json
			FROM canonical_recipes_v2
			WHERE LOWER(title) = ?
			LIMIT 1
		`).bind(lower).first<CanonicalRecipeRow>();
		if (exact) return exact;
		const likePattern = `%${lower}%`;
		const fuzzy = await env.DB.prepare(`
			SELECT id, title, description, document_json
			FROM canonical_recipes_v2
			WHERE LOWER(title) LIKE ?
			ORDER BY LENGTH(title) ASC
			LIMIT 1
		`).bind(likePattern).first<CanonicalRecipeRow>();
		return fuzzy ?? null;
	} catch {
		return null;
	}
}

async function safeFetchDishTitle(env: MiseGraphEnv, dishId: string): Promise<string | null> {
	try {
		const row = await env.DB.prepare(`
			SELECT canonical_title
			FROM canonical_dishes
			WHERE id = ?
			LIMIT 1
		`).bind(dishId).first<{ canonical_title: string }>();
		return row?.canonical_title ?? null;
	} catch {
		return null;
	}
}

function trimString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Thin wrapper used by the MCP dispatcher. Mirrors the pattern of
 * `inspireReadCanonicalDishes` — returns a structured envelope instead
 * of throwing when no recipe matches, so the agent gets a usable
 * `{ok:false, message}` it can react to.
 */
export interface RecipeStepsToolResult {
	ok: boolean;
	message?: string;
	recipe_id?: string;
	title?: string;
	description?: string | null;
	ingredients?: RecipeIngredient[];
	steps?: RecipeStep[];
	total_time_min?: number | null;
	prep_time_min?: number | null;
	cook_time_min?: number | null;
	servings?: number | null;
	source_url?: string | null;
	matched_by?: RecipeStepsResult["matched_by"];
}

export async function inspireReadRecipeSteps(
	env: MiseGraphEnv,
	args: RecipeStepsArgs,
): Promise<RecipeStepsToolResult> {
	const hasIdentifier = trimString(args.recipe_id)
		|| (args.canonical_dish_id != null && String(args.canonical_dish_id).trim().length > 0)
		|| trimString(args.canonical_dish_title);
	if (!hasIdentifier) {
		return {
			ok: false,
			message: "Provide one of: recipe_id, canonical_dish_id, canonical_dish_title.",
		};
	}
	const result = await loadRecipeSteps(env, args);
	if (!result) {
		return {
			ok: false,
			message: "No matching recipe found in canonical_recipes_v2.",
		};
	}
	return {
		ok: true,
		recipe_id: result.recipe_id,
		title: result.title,
		description: result.description,
		ingredients: result.ingredients,
		steps: result.steps,
		total_time_min: result.total_time_min,
		prep_time_min: result.prep_time_min,
		cook_time_min: result.cook_time_min,
		servings: result.servings,
		source_url: result.source_url,
		matched_by: result.matched_by,
	};
}
