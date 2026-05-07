// Personal recipe import: stash user-loved recipes from Paprika exports,
// URL scrapes, social saves, screenshots, manual entry. Each recipe is
// normalized into the personal_recipes table with provenance preserved.
//
// The composer-context loader pulls the household's loved recipes and feeds
// them to the menu composer as "taste evidence" — it can riff on them and
// must cite them in lineage.

import type { MiseGraphEnv } from "./types";
import { callMeshClaudeJSON, type MeshClaudeEnv } from "./llm-bridge";

export type PersonalRecipeKind = "paprika" | "url" | "instagram" | "manual" | "screenshot";

export interface PersonalRecipeIngredient {
	name: string;
	qty?: number;
	unit?: string;
	grams?: number;
	role?: string;
}

export interface PersonalRecipeRecord {
	id: string;
	household_id: string | null;
	source_kind: PersonalRecipeKind;
	source_url: string | null;
	source_app: string | null;
	author: string | null;
	original_title: string | null;
	normalized_title: string | null;
	cuisine: string[];
	format: string | null;
	meal_slots: string[];
	canonical_ingredients: PersonalRecipeIngredient[];
	raw_ingredients_text: string | null;
	method_summary: string | null;
	active_time_min: number | null;
	total_time_min: number | null;
	servings: number | null;
	flavor_tags: string[];
	household_rating: number | null;
	household_loved: boolean;
	cooked_count: number;
	last_cooked_at: string | null;
	parser_confidence: number;
}

export interface ImportRequest {
	household_id: string;
	kind: PersonalRecipeKind;
	loved?: boolean;
	rating?: number;
	// One of these depending on kind:
	url?: string;
	paprika_payload?: string;          // raw Paprika export JSON or YAML
	manual?: ManualRecipeInput;
	text?: string;                      // free-form user-pasted recipe text
	screenshot_text?: string;           // OCR'd text
}

export interface ManualRecipeInput {
	title: string;
	cuisine?: string[];
	format?: string;
	ingredients: PersonalRecipeIngredient[];
	method_summary?: string;
	servings?: number;
	active_time_min?: number;
	total_time_min?: number;
	flavor_tags?: string[];
	source_url?: string;
	author?: string;
}

export async function importPersonalRecipe(env: MiseGraphEnv, request: ImportRequest): Promise<{ ok: boolean; recipe?: PersonalRecipeRecord; error?: string }> {
	if (!request.household_id) return { ok: false, error: "household_id required" };
	let record: PersonalRecipeRecord | null = null;
	switch (request.kind) {
		case "manual":
			if (!request.manual) return { ok: false, error: "manual payload required" };
			record = recordFromManual(request, request.manual);
			break;
		case "paprika":
			if (!request.paprika_payload) return { ok: false, error: "paprika_payload required" };
			record = recordFromPaprika(request, request.paprika_payload);
			break;
		case "url":
		case "instagram":
		case "screenshot": {
			// Use the LLM bridge to parse free-form text/url payload into structured form.
			const text = request.text || request.screenshot_text || "";
			if (!text && !request.url) return { ok: false, error: "url, text, or screenshot_text required" };
			record = await recordFromTextWithLlm(env, request, text);
			break;
		}
		default:
			return { ok: false, error: `unknown kind: ${request.kind}` };
	}
	if (!record) return { ok: false, error: "could not normalize recipe" };
	await persistPersonalRecipe(env, record);
	return { ok: true, recipe: record };
}

function recordFromManual(req: ImportRequest, manual: ManualRecipeInput): PersonalRecipeRecord {
	return {
		id: slugId("pr_manual", req.household_id, manual.title, Date.now()),
		household_id: req.household_id,
		source_kind: "manual",
		source_url: manual.source_url || null,
		source_app: null,
		author: manual.author || null,
		original_title: manual.title,
		normalized_title: titleCase(manual.title),
		cuisine: manual.cuisine || [],
		format: manual.format || null,
		meal_slots: [],
		canonical_ingredients: manual.ingredients,
		raw_ingredients_text: null,
		method_summary: manual.method_summary || null,
		active_time_min: manual.active_time_min ?? null,
		total_time_min: manual.total_time_min ?? null,
		servings: manual.servings ?? null,
		flavor_tags: manual.flavor_tags || [],
		household_rating: req.rating ?? null,
		household_loved: !!req.loved,
		cooked_count: 0,
		last_cooked_at: null,
		parser_confidence: 1.0,
	};
}

function recordFromPaprika(req: ImportRequest, payload: string): PersonalRecipeRecord {
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(payload) as Record<string, unknown>;
	} catch {
		// Paprika exports include a per-recipe JSON envelope; user can paste it raw.
		// Future: handle .paprikarecipes (gzipped) by decoding R2.
	}
	const title = stringValue(parsed.name) || stringValue(parsed.title) || "Untitled paprika recipe";
	const ingredientsText = stringValue(parsed.ingredients);
	const directionsText = stringValue(parsed.directions) || stringValue(parsed.method);
	const ingredients = ingredientsText
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => parseIngredientLine(line));
	return {
		id: slugId("pr_paprika", req.household_id, title, Date.now()),
		household_id: req.household_id,
		source_kind: "paprika",
		source_url: stringValue(parsed.source_url) || stringValue(parsed.source) || null,
		source_app: "Paprika",
		author: stringValue(parsed.source) || null,
		original_title: title,
		normalized_title: titleCase(title),
		cuisine: parseStringArray(parsed.categories) || [],
		format: null,
		meal_slots: [],
		canonical_ingredients: ingredients,
		raw_ingredients_text: ingredientsText || null,
		method_summary: directionsText.slice(0, 1000) || null,
		active_time_min: parseTimeMinutes(stringValue(parsed.cook_time)),
		total_time_min: parseTimeMinutes(stringValue(parsed.total_time)),
		servings: parseInt(stringValue(parsed.servings), 10) || null,
		flavor_tags: [],
		household_rating: req.rating ?? (typeof parsed.rating === "number" ? parsed.rating : null),
		household_loved: !!req.loved || (typeof parsed.rating === "number" && parsed.rating >= 4),
		cooked_count: 0,
		last_cooked_at: null,
		parser_confidence: 0.7,
	};
}

async function recordFromTextWithLlm(env: MiseGraphEnv, req: ImportRequest, text: string): Promise<PersonalRecipeRecord | null> {
	const prompt = `Extract a structured recipe from the following text. Return strict JSON:
{
  "title": "...",
  "cuisine": ["..."],
  "format": "bowl|salad|...",
  "ingredients": [{"name":"...","qty":1,"unit":"cup","grams":150,"role":"primary|fat|acid|herb|..."}],
  "method_summary": "1-2 sentence",
  "servings": 4,
  "active_time_min": 30,
  "total_time_min": 45,
  "flavor_tags": ["herby","smoky",...]
}

Source: ${req.kind}${req.url ? ` (${req.url})` : ""}

Text:
${text.slice(0, 8000)}`;
	const response = await callMeshClaudeJSON<{
		title?: string;
		cuisine?: string[];
		format?: string;
		ingredients?: PersonalRecipeIngredient[];
		method_summary?: string;
		servings?: number;
		active_time_min?: number;
		total_time_min?: number;
		flavor_tags?: string[];
	}>(env as unknown as MeshClaudeEnv, {
		prompt,
		system: "You are a recipe parser. Reply with strict JSON only.",
		model: "claude-haiku-4-5-20251001",
	});
	if (!response.ok || !response.data) return null;
	const data = response.data;
	const title = stringValue(data.title) || "Imported recipe";
	return {
		id: slugId("pr", req.kind, req.household_id, title, Date.now()),
		household_id: req.household_id,
		source_kind: req.kind,
		source_url: req.url || null,
		source_app: req.kind === "instagram" ? "Instagram" : null,
		author: null,
		original_title: title,
		normalized_title: titleCase(title),
		cuisine: parseStringArray(data.cuisine) || [],
		format: stringValue(data.format) || null,
		meal_slots: [],
		canonical_ingredients: Array.isArray(data.ingredients) ? data.ingredients.filter(i => i && typeof i === "object" && typeof i.name === "string") : [],
		raw_ingredients_text: null,
		method_summary: stringValue(data.method_summary) || null,
		active_time_min: typeof data.active_time_min === "number" ? data.active_time_min : null,
		total_time_min: typeof data.total_time_min === "number" ? data.total_time_min : null,
		servings: typeof data.servings === "number" ? data.servings : null,
		flavor_tags: parseStringArray(data.flavor_tags) || [],
		household_rating: req.rating ?? null,
		household_loved: !!req.loved,
		cooked_count: 0,
		last_cooked_at: null,
		parser_confidence: 0.7,
	};
}

async function persistPersonalRecipe(env: MiseGraphEnv, record: PersonalRecipeRecord): Promise<void> {
	await env.DB.prepare(`
		INSERT OR REPLACE INTO personal_recipes
		(id, household_id, source_kind, source_url, source_app, author,
		 original_title, normalized_title, cuisine_json, format, meal_slots_json,
		 canonical_ingredients_json, raw_ingredients_text, method_summary,
		 active_time_min, total_time_min, servings, flavor_tags_json,
		 household_rating, household_loved, cooked_count, last_cooked_at,
		 parser_confidence, meta_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`).bind(
		record.id,
		record.household_id,
		record.source_kind,
		record.source_url,
		record.source_app,
		record.author,
		record.original_title,
		record.normalized_title,
		JSON.stringify(record.cuisine),
		record.format,
		JSON.stringify(record.meal_slots),
		JSON.stringify(record.canonical_ingredients),
		record.raw_ingredients_text,
		record.method_summary,
		record.active_time_min,
		record.total_time_min,
		record.servings,
		JSON.stringify(record.flavor_tags),
		record.household_rating,
		record.household_loved ? 1 : 0,
		record.cooked_count,
		record.last_cooked_at,
		record.parser_confidence,
		"{}",
	).run();
}

export async function listPersonalRecipes(env: MiseGraphEnv, householdId: string, opts: { loved_only?: boolean; limit?: number } = {}): Promise<PersonalRecipeRecord[]> {
	const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
	const lovedClause = opts.loved_only ? "AND household_loved = 1" : "";
	const result = await env.DB.prepare(`
		SELECT *
		FROM personal_recipes
		WHERE household_id = ? ${lovedClause}
		ORDER BY household_loved DESC, household_rating DESC, last_cooked_at DESC
		LIMIT ?
	`).bind(householdId, limit).all<Record<string, unknown>>();
	return (result.results || []).map(rowToRecord);
}

function rowToRecord(row: Record<string, unknown>): PersonalRecipeRecord {
	return {
		id: stringValue(row.id),
		household_id: stringValue(row.household_id) || null,
		source_kind: (stringValue(row.source_kind) || "manual") as PersonalRecipeKind,
		source_url: stringValue(row.source_url) || null,
		source_app: stringValue(row.source_app) || null,
		author: stringValue(row.author) || null,
		original_title: stringValue(row.original_title) || null,
		normalized_title: stringValue(row.normalized_title) || null,
		cuisine: parseStringArray(row.cuisine_json) || [],
		format: stringValue(row.format) || null,
		meal_slots: parseStringArray(row.meal_slots_json) || [],
		canonical_ingredients: (parseAny(row.canonical_ingredients_json) as PersonalRecipeIngredient[] | null) || [],
		raw_ingredients_text: stringValue(row.raw_ingredients_text) || null,
		method_summary: stringValue(row.method_summary) || null,
		active_time_min: numberValue(row.active_time_min),
		total_time_min: numberValue(row.total_time_min),
		servings: numberValue(row.servings),
		flavor_tags: parseStringArray(row.flavor_tags_json) || [],
		household_rating: numberValue(row.household_rating),
		household_loved: row.household_loved === 1 || row.household_loved === "1",
		cooked_count: numberValue(row.cooked_count) || 0,
		last_cooked_at: stringValue(row.last_cooked_at) || null,
		parser_confidence: numberValue(row.parser_confidence) || 0.7,
	};
}

function parseIngredientLine(line: string): PersonalRecipeIngredient {
	// Best-effort parse: "1.5 cup chickpeas" → {qty:1.5, unit:"cup", name:"chickpeas"}
	const match = line.match(/^([\d./]+)\s+(\w+)\s+(.+)$/);
	if (match) {
		const qty = parseFraction(match[1]);
		return { name: match[3].trim(), qty: qty ?? undefined, unit: match[2] };
	}
	return { name: line };
}

function parseFraction(value: string): number | null {
	if (value.includes("/")) {
		const [num, den] = value.split("/").map(Number);
		if (den) return num / den;
	}
	const n = parseFloat(value);
	return Number.isFinite(n) ? n : null;
}

function parseTimeMinutes(value: string): number | null {
	if (!value) return null;
	const lower = value.toLowerCase();
	const hourMatch = lower.match(/(\d+)\s*h/);
	const minMatch = lower.match(/(\d+)\s*m/);
	const hours = hourMatch ? Number(hourMatch[1]) : 0;
	const mins = minMatch ? Number(minMatch[1]) : 0;
	const total = hours * 60 + mins;
	if (total) return total;
	const justNumber = parseInt(lower, 10);
	return Number.isFinite(justNumber) ? justNumber : null;
}

function parseStringArray(value: unknown): string[] | null {
	if (Array.isArray(value)) return value.filter((i): i is string => typeof i === "string");
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed.filter((i): i is string => typeof i === "string");
		} catch { /* not JSON */ }
		return value.split(",").map(s => s.trim()).filter(Boolean);
	}
	return null;
}

function parseAny(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function titleCase(value: string): string {
	return value.replace(/\b\w/g, c => c.toUpperCase());
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(p => String(p || "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}
