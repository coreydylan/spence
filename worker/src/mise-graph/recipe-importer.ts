// Recipe importer — turns a URL / plain-text / pre-parsed schema.org Recipe
// JSON into an ImportedRecipe, then assigns it to a slot in a
// MiseWeeklyPlanDraft. fetch_impl + llm_canonicalize are injectable for
// tests. Browser-rendering for JS-heavy pages is a follow-up; we only do
// plain fetch + JSON-LD here. Slot assignment deep-clones the plan, swaps
// the meal, optionally locks. Ripple math lives elsewhere (Agent F).

import {
	type ComponentRole, type ComponentSource, type MealComponent,
	FORMAT_ALIASES, FORMAT_SLOT_SPECS,
} from "./meal-component";
import type { ComposerRawIngredient } from "./menu-composer";
import { lockMeal } from "./locks";
import type { MiseMealSlot, MisePlanMeal, MiseSnackBox, MiseWeeklyPlanDraft } from "./planner";

// --- Types ----------------------------------------------------------------

export type IngredientAlert = "non-vegetarian" | "non-vegan" | "potential-allergen" | "ambiguous";

export interface CanonicalIngredient {
	canonical: string; qty: number | null; unit: string | null; grams: number | null;
	role_hint?: ComponentRole; alert?: IngredientAlert; original?: string;
}

export interface ImportedRecipeWarning { kind: string; detail: string; }

export interface ImportedRecipeProvenance {
	source_url: string; scraped_at: string;
	parser: "schema_org" | "schema_org+llm" | "llm_only" | "plain_text";
	raw_extracted?: unknown;
}

export interface ImportedRecipe {
	id: string; title: string; creator: string | null;
	source_url: string; source_image_url: string | null;
	canonical_format: string | null; cuisine: string[];
	servings: number; active_time_min: number; idle_time_min: number;
	ingredients_canonicalized: CanonicalIngredient[];
	components_inferred: MealComponent[];
	method_summary: string; full_method?: string;
	confidence: number;
	provenance: ImportedRecipeProvenance;
	warnings: ImportedRecipeWarning[];
}

export interface ImportOptions {
	trust_hint?: "creator:known" | "verified_blog" | "unknown";
	household_dietary?: string[];
	use_llm_canonicalize?: boolean;
	fetch_impl?: typeof fetch;
	llm_canonicalize?: (raw: unknown) => Promise<Partial<ImportedRecipe>>;
}

export type ImportSourceKind = "url" | "plain_text" | "schema_org_json";
export interface ImportInput { kind: ImportSourceKind; payload: string; options?: ImportOptions; }
export interface AssignSlot { date: string; slot: string; }
export interface AssignOptions { lock?: boolean; scale_to?: number; lock_reason?: string; }
export interface CanonicalizeOptions { household_dietary?: string[]; llm?: ImportOptions["llm_canonicalize"]; }
export interface RecipeStoreFilter { household_id?: string; limit?: number; }
export interface RecipeStore {
	save(recipe: ImportedRecipe): Promise<{ id: string }>;
	get(id: string): Promise<ImportedRecipe | null>;
	list(filter?: RecipeStoreFilter): Promise<ImportedRecipe[]>;
	search(query: string): Promise<ImportedRecipe[]>;
}

// --- Public API ---

export async function importRecipe(input: ImportInput): Promise<ImportedRecipe> {
	const opts = input.options || {};
	const useLlm = opts.use_llm_canonicalize !== false;
	const dietary = opts.household_dietary;
	const stamp = (r: ImportedRecipe, parser: ImportedRecipeProvenance["parser"], url?: string) => {
		r.provenance.parser = parser;
		if (url !== undefined) { r.provenance.source_url = url; r.source_url = url; }
		return r;
	};

	if (input.kind === "url") {
		const fetchFn = opts.fetch_impl || (typeof fetch !== "undefined" ? fetch : null);
		if (!fetchFn) throw new Error("recipe-importer: no fetch impl available");
		const html = await (await fetchFn(input.payload)).text();
		const schemaOrg = extractSchemaOrgRecipe(html);
		if (schemaOrg) return stamp(await canonicalizeParsedRecipe(schemaOrg, { household_dietary: dietary }), "schema_org", input.payload);
		const fallback = parseHtmlMetaFallback(html);
		const merged = useLlm && opts.llm_canonicalize
			? mergeShallow(fallback, await opts.llm_canonicalize(html))
			: fallback;
		return stamp(await canonicalizeParsedRecipe(merged, { household_dietary: dietary }), useLlm && opts.llm_canonicalize ? "llm_only" : "plain_text", input.payload);
	}

	if (input.kind === "schema_org_json") {
		let parsed: unknown = null;
		try { parsed = JSON.parse(input.payload); } catch { /* fall through */ }
		if (!parsed) throw new Error("recipe-importer: invalid schema.org JSON payload");
		return stamp(await canonicalizeParsedRecipe(parsed, { household_dietary: dietary }), "schema_org");
	}

	// plain_text
	let parsed: Record<string, unknown> = parsePlainTextRecipe(input.payload);
	if (useLlm && opts.llm_canonicalize) {
		try { parsed = mergeShallow(parsed, await opts.llm_canonicalize(input.payload)) as Record<string, unknown>; }
		catch { /* keep heuristic */ }
	}
	return stamp(await canonicalizeParsedRecipe(parsed, { household_dietary: dietary }), useLlm && opts.llm_canonicalize ? "llm_only" : "plain_text");
}

// Extract schema.org Recipe JSON-LD from HTML. Returns the Recipe object
// (or null when not found). Recipes may be top-level, inside @graph, or
// nested under mainEntity.
export function extractSchemaOrgRecipe(html: string): unknown | null {
	if (!html || typeof html !== "string") return null;
	const re = /<script[^>]*type\s*=\s*['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const text = m[1].trim();
		if (!text) continue;
		const recipe = findRecipeNode(safeJsonParse(text));
		if (recipe) return recipe;
	}
	return null;
}

// Canonicalize a pre-parsed payload (schema.org Recipe / LLM JSON / plain
// text shim) into an ImportedRecipe. Pure when no LLM is provided.
export async function canonicalizeParsedRecipe(parsed: unknown, opts: CanonicalizeOptions = {}): Promise<ImportedRecipe> {
	let merged = (parsed || {}) as Record<string, unknown>;
	if (opts.llm) {
		try { merged = mergeShallow(merged, await opts.llm(parsed)) as Record<string, unknown>; }
		catch { /* keep heuristic */ }
	}

	const title = pickString(merged.title, merged.name) || "Untitled imported recipe";
	const sourceUrl = pickString(merged.source_url, merged.url) || "";
	const prep = pickTimeMin(merged.prepTime) || 0;
	const cook = pickTimeMin(merged.cookTime) || 0;
	const total = pickTimeMin(merged.totalTime) || 0;
	const activeMin = pickTimeMin(merged.active_time_min) || (prep + cook) || pickTimeMin(merged.cookTime, merged.totalTime, merged.prepTime) || 30;
	let idleMin = pickTimeMin(merged.idle_time_min) || 0;
	if (total && activeMin && total > activeMin) idleMin = Math.max(idleMin, total - activeMin);

	const dietary = (opts.household_dietary || []).map(s => s.toLowerCase());
	const warnings: ImportedRecipeWarning[] = [];
	const canonicals: CanonicalIngredient[] = pickIngredientStrings(merged).map(line => {
		const p = parseIngredientLine(line);
		const canonical = canonicalizeIngredientName(p.name);
		const alerts = scanIngredientForAlerts(canonical, dietary);
		if (alerts.warning) warnings.push(alerts.warning);
		return {
			canonical, qty: p.qty, unit: p.unit,
			grams: estimateGrams(canonical, p.qty, p.unit),
			role_hint: inferRoleHint(canonical), alert: alerts.alert, original: line,
		};
	});

	const methodSummary = pickMethod(merged);
	const format = inferFormat(title, canonicals.map(i => i.canonical));
	const parser = detectParserFromShape(parsed);

	return {
		id: makeRecipeId(title, sourceUrl),
		title,
		creator: pickAuthor(merged.author) || pickString(merged.creator) || null,
		source_url: sourceUrl,
		source_image_url: pickImage(merged.image) || pickString(merged.source_image_url) || null,
		canonical_format: format,
		cuisine: pickStringArray(merged.cuisine, merged.recipeCuisine, merged.recipeCategory),
		servings: pickServings(merged.servings, merged.recipeYield, merged.yield) || 4,
		active_time_min: activeMin,
		idle_time_min: idleMin,
		ingredients_canonicalized: canonicals,
		components_inferred: buildComponentsFromRecipe(format, canonicals),
		method_summary: methodSummary,
		full_method: pickFullMethod(merged),
		confidence: scoreConfidence({ title, ingredients: canonicals.length, method: !!methodSummary, schemaOrg: parser === "schema_org" }),
		provenance: { source_url: sourceUrl, scraped_at: new Date().toISOString(), parser, raw_extracted: parsed },
		warnings,
	};
}

// Heuristic: classify a recipe's likely format from title + ingredient names.
export function inferFormat(title: string, ingredients: string[]): string | null {
	const haystack = [title.toLowerCase(), ...ingredients.map(i => i.toLowerCase())].join(" ");
	for (const rule of FORMAT_KEYWORDS) {
		for (const kw of rule.keywords) {
			if (new RegExp(`\\b${kw}\\b`, "i").test(haystack)) return rule.format;
		}
	}
	return null;
}

// Build MealComponent[] from canonicalized ingredients + the chosen format.
export function buildComponentsFromRecipe(format: string | null, ingredients: CanonicalIngredient[]): MealComponent[] {
	const slots = format ? FORMAT_SLOT_SPECS[normalizeFormatKey(format)] : null;
	const lite = ingredients.map(toLiteIngredient);
	if (!slots || slots.length === 0) {
		return [mkComponent("main", true, "Main", { kind: "compose_inline", raw_ingredients: lite })];
	}

	const used = new Set<number>();
	const components: MealComponent[] = [];
	for (const slot of slots) {
		const matched: number[] = [];
		for (let i = 0; i < ingredients.length; i++) {
			if (used.has(i)) continue;
			if (ingredients[i].role_hint === slot.role) matched.push(i);
		}
		if (matched.length === 0) {
			for (let i = 0; i < ingredients.length; i++) {
				if (used.has(i)) continue;
				if (matchesSlotKeyword(slot.role, ingredients[i].canonical)) matched.push(i);
			}
		}
		if (matched.length === 0 && slot.role !== "main") continue;
		for (const idx of matched) used.add(idx);
		const slotIngredients = matched.map(i => lite[i]);
		components.push(mkComponent(slot.role, slot.required, slotTitle(slot.role), { kind: "compose_inline", raw_ingredients: slotIngredients }));
	}

	const leftover: number[] = [];
	for (let i = 0; i < ingredients.length; i++) if (!used.has(i)) leftover.push(i);
	if (leftover.length > 0) {
		const leftoverLite = leftover.map(i => lite[i]);
		const main = components.find(c => c.role === "main");
		if (main && main.source.kind === "compose_inline") {
			main.source = { kind: "compose_inline", raw_ingredients: dedupeIngredients([...main.source.raw_ingredients, ...leftoverLite]) };
		} else {
			components.unshift(mkComponent("main", true, "Main", { kind: "compose_inline", raw_ingredients: leftoverLite }));
		}
	}
	return components;
}

function mkComponent(role: ComponentRole, required: boolean, title: string, source: ComponentSource): MealComponent {
	return { role, required, title, source, serves: 1, active_time_min: 0 };
}

// --- Slot assignment ---

export function assignRecipeToSlot(plan: MiseWeeklyPlanDraft, recipe: ImportedRecipe, slot: AssignSlot, opts: AssignOptions = {}): MiseWeeklyPlanDraft {
	const cloned: MiseWeeklyPlanDraft = JSON.parse(JSON.stringify(plan));
	const slotKey = slot.slot.toLowerCase();
	const factor = opts.scale_to && recipe.servings > 0 ? opts.scale_to / recipe.servings : 1;
	const people = opts.scale_to ?? recipe.servings;
	let touched = false;

	for (const day of cloned.meals_by_day || []) {
		if (day.date !== slot.date) continue;
		day.meals = day.meals.map(m => {
			if (m.slot.toLowerCase() !== slotKey) return m;
			touched = true;
			return buildMealFromRecipe(m, recipe, factor, people, slotKey);
		});
	}
	if (slotKey === "breakfast" && cloned.breakfasts) {
		cloned.breakfasts = cloned.breakfasts.map(m => {
			if (m.date !== slot.date) return m;
			touched = true;
			return buildMealFromRecipe(m, recipe, factor, people, slotKey);
		});
	}
	if (slotKey === "snack" && cloned.snack_boxes) {
		cloned.snack_boxes = cloned.snack_boxes.map(s => {
			if (s.date !== slot.date) return s;
			touched = true;
			return buildSnackFromRecipe(s, recipe, factor, people);
		});
	}
	if (!touched) return plan;

	if (cloned.source_recipe_ids && !cloned.source_recipe_ids.includes(recipe.id)) {
		cloned.source_recipe_ids = [...cloned.source_recipe_ids, recipe.id];
	}

	return opts.lock
		? lockMeal(cloned, { date: slot.date, slot: slotKey }, { reason: opts.lock_reason || `user pinned recipe ${recipe.id}`, by: "user", scope: "hard" })
		: cloned;
}

function buildMealFromRecipe(existing: MisePlanMeal, recipe: ImportedRecipe, factor: number, people: number, slotKey: string): MisePlanMeal {
	const sourceLabel = recipe.source_url || "personal recipe";
	return {
		...existing,
		title: recipe.title,
		format: recipe.canonical_format || existing.format,
		ingredient_names: recipe.ingredients_canonicalized.map(i => i.canonical),
		raw_ingredients: recipe.ingredients_canonicalized.map(i => scaleRawIngredient(i, factor)),
		components: scaleComponents(recipe.components_inferred, factor),
		method_summary: recipe.method_summary,
		active_time_min: recipe.active_time_min,
		cuisine: recipe.cuisine.length > 0 ? recipe.cuisine : existing.cuisine,
		people,
		source: `personal_recipe:${recipe.id}`,
		notes: dedupeStrings([...(existing.notes || []), `Imported from ${sourceLabel}`]),
		lineage: [
			...(existing.lineage || []),
			{
				source_kind: "personal_recipe",
				source_id: recipe.id,
				source_title: recipe.title,
				influence: `imported from ${sourceLabel} for ${slotKey}`,
				confidence: recipe.confidence,
			},
		],
		meta: { ...(existing.meta || {}), source_recipe_id: recipe.id, source_kind: "personal_recipe" },
	};
}

function buildSnackFromRecipe(existing: MiseSnackBox, recipe: ImportedRecipe, factor: number, people: number): MiseSnackBox {
	return {
		...existing,
		title: recipe.title,
		raw_ingredients: recipe.ingredients_canonicalized.map(i => scaleRawIngredient(i, factor)),
		people,
		items: recipe.ingredients_canonicalized.map(i => i.canonical),
		meta: { ...(existing.meta || {}), source_recipe_id: recipe.id, source_kind: "personal_recipe" },
	};
}

// --- Recipe store (memory) ---

export function makeMemoryRecipeStore(): RecipeStore {
	const recipes = new Map<string, ImportedRecipe>();
	return {
		async save(recipe) { recipes.set(recipe.id, recipe); return { id: recipe.id }; },
		async get(id) { return recipes.get(id) || null; },
		async list(filter) { return Array.from(recipes.values()).slice(0, filter?.limit ?? 50); },
		async search(query) {
			const q = query.toLowerCase().trim();
			if (!q) return [];
			return Array.from(recipes.values()).filter(r =>
				r.title.toLowerCase().includes(q)
				|| (r.creator || "").toLowerCase().includes(q)
				|| r.ingredients_canonicalized.some(i => i.canonical.includes(q)),
			);
		},
	};
}

// --- JSON-LD walking + plain-text fallback ---

function safeJsonParse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

function findRecipeNode(node: unknown): Record<string, unknown> | null {
	if (!node) return null;
	if (Array.isArray(node)) {
		for (const child of node) { const f = findRecipeNode(child); if (f) return f; }
		return null;
	}
	if (typeof node !== "object") return null;
	const obj = node as Record<string, unknown>;
	if (matchesType(obj["@type"], "Recipe")) return obj;
	const graph = obj["@graph"];
	if (Array.isArray(graph)) { const f = findRecipeNode(graph); if (f) return f; }
	const main = obj.mainEntity || obj.mainEntityOfPage;
	if (main && typeof main === "object") { const f = findRecipeNode(main); if (f) return f; }
	return null;
}

function matchesType(t: unknown, target: string): boolean {
	return typeof t === "string" ? t === target : Array.isArray(t) && t.some(v => v === target);
}

function parsePlainTextRecipe(text: string): Record<string, unknown> {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length === 0) return { title: "Pasted recipe" };
	const title = lines[0].replace(/^#+\s*/, "");
	const ingredients: string[] = [];
	const methodLines: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		(looksLikeIngredient(lines[i]) ? ingredients : methodLines).push(lines[i]);
	}
	return {
		title,
		recipeIngredient: ingredients,
		method_summary: methodLines.slice(0, 3).join(" "),
		full_method: methodLines.join("\n"),
	};
}

function parseHtmlMetaFallback(html: string): Record<string, unknown> {
	const title = matchOne(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
		|| matchOne(html, /<title>([^<]+)<\/title>/i)
		|| "Imported page";
	return {
		title,
		source_image_url: matchOne(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i),
		method_summary: matchOne(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) || "",
	};
}

function matchOne(text: string, re: RegExp): string | null { const m = text.match(re); return m ? m[1] : null; }

function looksLikeIngredient(line: string): boolean {
	if (/^\d/.test(line)) return true;
	if (/^[¼½¾⅓⅔⅛⅜⅝⅞]/.test(line)) return true;
	if (/^(a |an |one |two |three |four |a few |a pinch|several )/i.test(line)) return true;
	return /^(salt|pepper|olive oil|garlic|butter)/i.test(line);
}

// --- Field extraction helpers ---

function pickString(...vals: unknown[]): string | null {
	for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
	return null;
}

function pickStringArray(...vals: unknown[]): string[] {
	for (const v of vals) {
		if (Array.isArray(v)) {
			const out = v.map(x => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
			if (out.length > 0) return out;
		} else if (typeof v === "string" && v.trim()) {
			return v.split(",").map(s => s.trim()).filter(Boolean);
		}
	}
	return [];
}

function pickFromObject(value: unknown, fields: string[]): string | null {
	if (!value) return null;
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		for (const v of value) { const x = pickFromObject(v, fields); if (x) return x; }
		return null;
	}
	if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		return pickString(...fields.map(f => o[f]));
	}
	return null;
}

function pickAuthor(value: unknown): string | null { return pickFromObject(value, ["name", "@id"]); }
function pickImage(value: unknown): string | null { return pickFromObject(value, ["url", "@id"]); }

function pickServings(...vals: unknown[]): number {
	for (const v of vals) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
		if (typeof v === "string") { const n = parseFirstInt(v); if (n !== null && n > 0) return n; }
		if (Array.isArray(v) && v.length > 0) { const c = pickServings(v[0]); if (c) return c; }
	}
	return 0;
}

function pickTimeMin(...vals: unknown[]): number {
	for (const v of vals) {
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
		if (typeof v === "string") {
			const t = parseIso8601DurationMinutes(v) ?? parseHumanTimeMinutes(v);
			if (t !== null) return t;
		}
	}
	return 0;
}

function pickIngredientStrings(safe: Record<string, unknown>): string[] {
	for (const c of [safe.recipeIngredient, safe.ingredients, safe.ingredient_list]) {
		if (Array.isArray(c)) {
			const out = c.map(x => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
			if (out.length > 0) return out;
		}
		if (typeof c === "string" && c.trim()) return c.split(/\r?\n|;/).map(s => s.trim()).filter(Boolean);
	}
	return [];
}

function pickMethod(safe: Record<string, unknown>): string {
	const inst = safe.recipeInstructions || safe.method || safe.method_summary;
	if (typeof inst === "string") return inst.trim().slice(0, 600);
	if (Array.isArray(inst)) return collectInstructionText(inst).slice(0, 600);
	return typeof safe.description === "string" ? safe.description.slice(0, 600) : "";
}

function pickFullMethod(safe: Record<string, unknown>): string | undefined {
	for (const c of [safe.full_method, safe.recipeInstructions, safe.method, safe.method_summary]) {
		if (typeof c === "string" && c.trim()) return c.trim();
		if (Array.isArray(c)) { const t = collectInstructionText(c); if (t) return t; }
	}
	return undefined;
}

function collectInstructionText(steps: unknown[]): string {
	const parts: string[] = [];
	for (const step of steps) {
		if (typeof step === "string") { parts.push(step.trim()); continue; }
		if (!step || typeof step !== "object") continue;
		const o = step as Record<string, unknown>;
		const t = pickString(o.text, o.name);
		if (t) { parts.push(t); continue; }
		if (Array.isArray(o.itemListElement)) {
			for (const el of o.itemListElement) {
				if (el && typeof el === "object") {
					const et = pickString((el as Record<string, unknown>).text, (el as Record<string, unknown>).name);
					if (et) parts.push(et);
				}
			}
		}
	}
	return parts.join(" ");
}

function detectParserFromShape(parsed: unknown): ImportedRecipeProvenance["parser"] {
	if (!parsed || typeof parsed !== "object") return "plain_text";
	return matchesType((parsed as Record<string, unknown>)["@type"], "Recipe") ? "schema_org" : "plain_text";
}

// --- Ingredient parsing + canonicalization ---

interface ParsedIngredient { qty: number | null; unit: string | null; name: string; prep: string | null; }

const UNIT_TOKENS = new Set("cup cups c tbsp tablespoon tablespoons tbs tsp teaspoon teaspoons oz ounce ounces lb lbs pound pounds g gram grams kg kilogram kilograms ml milliliter milliliters l liter liters clove cloves sprig sprigs slice slices pinch pinches can cans jar jars package packages pkg head heads bunch bunches stalk stalks piece pieces large medium small".split(" "));

const FRACTION_GLYPHS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

export function parseIngredientLine(line: string): ParsedIngredient {
	const trimmed = line.trim();
	if (!trimmed) return { qty: null, unit: null, name: "", prep: null };
	let rest = trimmed.replace(/^[•\-\*\s]+/, "");
	let prep: string | null = null;
	const commaIdx = rest.indexOf(",");
	if (commaIdx >= 0) {
		prep = rest.slice(commaIdx + 1).trim();
		rest = rest.slice(0, commaIdx).trim();
	}
	const q = consumeQuantity(rest);
	const u = consumeUnit(q.rest);
	const name = u.rest.replace(/\s+/g, " ").trim() || rest.trim();
	return { qty: q.qty, unit: u.unit, name, prep };
}

function consumeQuantity(text: string): { qty: number | null; rest: string } {
	let s = text;
	const mixed = s.match(/^(\d+)\s+(\d+\/\d+)\s+/);
	if (mixed) {
		const whole = parseFloat(mixed[1]);
		const frac = parseSimpleFraction(mixed[2]) || 0;
		return { qty: whole + frac, rest: s.slice(mixed[0].length) };
	}
	const fracOnly = s.match(/^(\d+\/\d+)\s+/);
	if (fracOnly) return { qty: parseSimpleFraction(fracOnly[1]) || 0, rest: s.slice(fracOnly[0].length) };
	const num = s.match(/^(\d+(?:\.\d+)?)(?:\s+|$)/);
	if (num) return { qty: parseFloat(num[1]), rest: s.slice(num[0].length) };
	const glyph = s.match(/^([¼½¾⅓⅔⅛⅜⅝⅞])\s+/);
	if (glyph) return { qty: FRACTION_GLYPHS[glyph[1]] || 0, rest: s.slice(glyph[0].length) };
	return { qty: null, rest: s };
}

function parseSimpleFraction(text: string): number | null {
	const m = text.match(/^(\d+)\/(\d+)$/);
	if (!m) return null;
	const den = parseFloat(m[2]);
	return den ? parseFloat(m[1]) / den : null;
}

function consumeUnit(text: string): { unit: string | null; rest: string } {
	const tokens = text.split(/\s+/);
	if (tokens.length === 0) return { unit: null, rest: text };
	const first = tokens[0].toLowerCase().replace(/\.$/, "");
	if (UNIT_TOKENS.has(first)) return { unit: first, rest: tokens.slice(1).join(" ") };
	return { unit: null, rest: text };
}

const CANONICAL_NAME_MAP: Array<[RegExp, string]> = [
	[/^extra[- ]virgin olive oil$/i, "olive oil"], [/^evoo$/i, "olive oil"],
	[/^(kosher|sea|flaky sea) salt$/i, "salt"],
	[/^(freshly ground|cracked) black pepper$/i, "black pepper"],
	[/^garlic cloves?$/i, "garlic"], [/^cloves?(?: of)? garlic$/i, "garlic"],
	[/^red onions?$/i, "red onion"], [/^(yellow|white) onions?$/i, "onion"],
	[/^(large )?eggs?$/i, "egg"], [/^all[- ]purpose flour$/i, "flour"],
	[/^kosher chicken stock$/i, "chicken stock"],
	[/^heavy cream$/i, "cream"], [/^whole milk$/i, "milk"],
	[/^(un)?salted butter$/i, "butter"],
	[/^anchovy fillets?$/i, "anchovy"], [/^anchov(y|ies)$/i, "anchovy"], [/^anchovy paste$/i, "anchovy paste"],
	[/^(canned|cherry|plum) tomatoes?$/i, "tomato"],
	[/^lemons?$/i, "lemon"], [/^limes?$/i, "lime"],
	[/^shallots?$/i, "shallot"], [/^carrots?$/i, "carrot"],
	[/^chickpeas?$/i, "chickpea"], [/^cannellini beans?$/i, "cannellini bean"],
	[/^chicken thighs?$/i, "chicken thigh"], [/^chicken breasts?$/i, "chicken breast"],
	[/^ground beef$/i, "beef"], [/^ground pork$/i, "pork"], [/^bacon strips?$/i, "bacon"],
	[/^bay (leaf|leaves)$/i, "bay leaf"],
];

export function canonicalizeIngredientName(rawName: string): string {
	let n = rawName.toLowerCase().trim();
	n = n.replace(/^(?:about|approximately|roughly|a small handful of|a handful of|a heaping|a scant|a generous)\s+/i, "");
	n = n.replace(/^(?:freshly\s+|finely\s+|thinly\s+|coarsely\s+|chopped\s+|minced\s+|grated\s+|sliced\s+)+/i, "");
	n = n.replace(/\s*\([^)]*\)\s*/g, " ").trim();
	n = n.split(",")[0].trim();
	for (const [pattern, target] of CANONICAL_NAME_MAP) if (pattern.test(n)) return target;
	if (n.length > 4 && n.endsWith("s") && !n.endsWith("ss") && !n.endsWith("us")) n = n.slice(0, -1);
	return n.replace(/\s+/g, " ").trim();
}

const GRAMS_PER_UNIT: Array<{ pattern: RegExp; unit: string; grams: number }> = [
	{ pattern: /^flour$/, unit: "cup", grams: 125 }, { pattern: /^sugar$/, unit: "cup", grams: 200 },
	{ pattern: /^brown sugar$/, unit: "cup", grams: 213 },
	{ pattern: /^butter$/, unit: "cup", grams: 227 }, { pattern: /^butter$/, unit: "tbsp", grams: 14 },
	{ pattern: /^olive oil$/, unit: "cup", grams: 216 }, { pattern: /^olive oil$/, unit: "tbsp", grams: 14 }, { pattern: /^olive oil$/, unit: "tsp", grams: 4.5 },
	{ pattern: /^salt$/, unit: "tsp", grams: 6 }, { pattern: /^salt$/, unit: "tbsp", grams: 18 },
	{ pattern: /^(water|milk|cream)$/, unit: "cup", grams: 240 },
	{ pattern: /^honey$/, unit: "tbsp", grams: 21 }, { pattern: /^maple syrup$/, unit: "tbsp", grams: 20 },
	{ pattern: /^chickpea$/, unit: "cup", grams: 165 }, { pattern: /^cannellini bean$/, unit: "cup", grams: 175 },
	{ pattern: /^tomato$/, unit: "cup", grams: 180 },
];

const PIECE_GRAMS: Array<{ pattern: RegExp; grams: number }> = [
	{ pattern: /^egg$/, grams: 50 }, { pattern: /^garlic$/, grams: 5 },
	{ pattern: /^lemon$/, grams: 60 }, { pattern: /^lime$/, grams: 50 },
	{ pattern: /^(red )?onion$/, grams: 150 },
	{ pattern: /^shallot$/, grams: 40 }, { pattern: /^carrot$/, grams: 60 },
	{ pattern: /^bay leaf$/, grams: 0.5 },
];

const RAW_UNIT_GRAMS: Record<string, number> = {
	g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
	oz: 28.35, ounce: 28.35, ounces: 28.35, lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6,
	ml: 1, milliliter: 1, milliliters: 1, l: 1000, liter: 1000, liters: 1000,
};

export function estimateGrams(canonical: string, qty: number | null, unit: string | null): number | null {
	if (qty === null || !Number.isFinite(qty)) return null;
	if (unit) {
		const norm = unit.toLowerCase();
		if (norm in RAW_UNIT_GRAMS) return Math.round(qty * RAW_UNIT_GRAMS[norm]);
		for (const row of GRAMS_PER_UNIT) {
			if (row.pattern.test(canonical) && row.unit === norm) return Math.round(qty * row.grams);
		}
	}
	for (const row of PIECE_GRAMS) if (row.pattern.test(canonical)) return Math.round(qty * row.grams);
	return null;
}

// --- Role hints + dietary scanning ---

const ROLE_KEYWORDS: Array<{ role: ComponentRole; pattern: RegExp }> = [
	{ role: "starch",         pattern: /\b(rice|noodle|pasta|spaghetti|penne|linguine|orzo|farro|quinoa|barley|couscous|polenta)\b/i },
	{ role: "bread",          pattern: /\b(bun|tortilla|pita|naan|baguette|sourdough|toast|loaf|bread|focaccia|dough)\b/i },
	{ role: "protein",        pattern: /\b(chicken|beef|pork|tofu|tempeh|seitan|chickpea|lentil|fish|shrimp|salmon|tuna|egg|paneer|bean)\b/i },
	{ role: "sauce",          pattern: /\b(sauce|aioli|salsa|chutney|dressing|vinaigrette|paste|marinade|harissa|chimichurri|tahini)\b/i },
	{ role: "vegetable_side", pattern: /\b(broccoli|kale|spinach|cabbage|carrot|zucchini|asparagus|cauliflower|brussels|fennel)\b/i },
	{ role: "salad",          pattern: /\b(salad|greens|arugula|romaine|lettuce|mesclun|herb)\b/i },
	{ role: "garnish",        pattern: /\b(parsley|cilantro|chive|dill|basil|mint|sesame|sumac|chili flake|scallion)\b/i },
	{ role: "crunch",         pattern: /\b(panko|breadcrumb|crouton|nut|almond|walnut|pecan|pumpkin seed|pine nut)\b/i },
	{ role: "pickle",         pattern: /\b(pickle|pickled|kimchi|sauerkraut|giardiniera)\b/i },
];

function inferRoleHint(canonical: string): ComponentRole | undefined {
	for (const r of ROLE_KEYWORDS) if (r.pattern.test(canonical)) return r.role;
	return undefined;
}

const DIETARY_VIOLATIONS: Array<{ pattern: RegExp; reason: string; type: "vegetarian" | "vegan" }> = [
	{ pattern: /\bfish sauce\b/i, reason: "fish sauce is not vegetarian", type: "vegetarian" },
	{ pattern: /\banchov(y|ies)\b/i, reason: "anchovy is not vegetarian", type: "vegetarian" },
	{ pattern: /\boyster sauce\b/i, reason: "oyster sauce is not vegetarian", type: "vegetarian" },
	{ pattern: /\bshrimp paste\b/i, reason: "shrimp paste is not vegetarian", type: "vegetarian" },
	{ pattern: /\b(chicken|beef|pork|lamb|veal|duck|turkey|goose)\b/i, reason: "contains meat", type: "vegetarian" },
	{ pattern: /\b(bacon|ham|lard|gelatin)\b/i, reason: "animal-derived", type: "vegetarian" },
	{ pattern: /\b(prawn|shrimp|squid|cuttlefish|octopus|crab|lobster)\b/i, reason: "shellfish is not vegetarian", type: "vegetarian" },
	{ pattern: /\b(salmon|tuna|cod|halibut|trout|sardine|mackerel|swordfish|sea bass)\b/i, reason: "fish is not vegetarian", type: "vegetarian" },
	{ pattern: /\b(milk|cream|butter|cheese|yogurt|ghee|whey|honey|egg|eggs)\b/i, reason: "contains animal product", type: "vegan" },
];

function scanIngredientForAlerts(canonical: string, dietary: string[]): { alert?: IngredientAlert; warning?: ImportedRecipeWarning } {
	const isVeg = dietary.some(d => /vegetarian|vegan/i.test(d));
	const isVegan = dietary.some(d => /vegan/i.test(d));
	if (!isVeg && !isVegan) return {};
	for (const v of DIETARY_VIOLATIONS) {
		if (v.type === "vegan" && !isVegan) continue;
		if (v.pattern.test(canonical)) {
			const alert: IngredientAlert = v.type === "vegan" ? "non-vegan" : "non-vegetarian";
			return { alert, warning: { kind: alert, detail: `${canonical}: ${v.reason}` } };
		}
	}
	return {};
}

// --- Format inference + slot keyword matching ---

const FORMAT_KEYWORDS: Array<{ format: string; keywords: string[] }> = [
	{ format: "pasta",     keywords: ["spaghetti", "linguine", "penne", "rigatoni", "orecchiette", "fettuccine", "pasta", "tagliatelle", "bucatini", "lasagna", "lasagne", "ravioli"] },
	{ format: "burger",    keywords: ["smashburger", "burger", "cheeseburger"] },
	{ format: "tagine",    keywords: ["tagine"] }, { format: "frittata", keywords: ["frittata"] }, { format: "pizza", keywords: ["pizza"] },
	{ format: "taco",      keywords: ["taco", "tacos"] },
	{ format: "sandwich",  keywords: ["sandwich", "sub", "panini", "grinder"] },
	{ format: "flatbread", keywords: ["flatbread", "manakish", "lavash"] },
	{ format: "curry",     keywords: ["curry", "korma", "vindaloo", "tikka masala", "rogan josh"] },
	{ format: "stir fry",  keywords: ["stir fry", "stir-fry", "stirfry"] },
	{ format: "donburi",   keywords: ["donburi", "gyudon", "katsudon", "oyakodon"] },
	{ format: "risotto",   keywords: ["risotto"] },
	{ format: "fritter",   keywords: ["fritter", "falafel"] },
	{ format: "omelette",  keywords: ["omelette", "omelet"] },
	{ format: "soup",      keywords: ["soup", "stew", "chili", "pho", "ramen", "minestrone", "chowder"] },
	{ format: "salad",     keywords: ["salad"] },
	{ format: "bowl",      keywords: ["bowl", "buddha bowl", "grain bowl", "rice bowl"] },
	{ format: "mezze",     keywords: ["mezze", "meze", "hummus plate"] },
];

function matchesSlotKeyword(role: ComponentRole, canonical: string): boolean {
	const r = ROLE_KEYWORDS.find(x => x.role === role);
	return !!r && r.pattern.test(canonical);
}

const SLOT_TITLES: Record<ComponentRole, string> = {
	main: "Main", protein: "Protein", starch: "Starch", bread: "Bread",
	vegetable_side: "Vegetable side", salad: "Salad", sauce: "Sauce",
	garnish: "Garnish", drink: "Drink", pickle: "Pickle", crunch: "Crunch",
	shell: "Shell", topping: "Topping", filling: "Filling",
};

function slotTitle(role: ComponentRole): string { return SLOT_TITLES[role]; }
function normalizeFormatKey(format: string): string { const lower = format.toLowerCase().trim(); return FORMAT_ALIASES[lower] ?? lower; }

// --- Plumbing helpers ---

function toLiteIngredient(i: CanonicalIngredient) {
	return { name: i.canonical, qty: i.qty, unit: i.unit, grams: i.grams };
}

function dedupeIngredients<T extends { name: string }>(list: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of list) {
		const key = item.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function dedupeStrings(list: string[]): string[] { return Array.from(new Set(list)); }

function scaleRawIngredient(i: CanonicalIngredient, factor: number): ComposerRawIngredient {
	const f = factor && Number.isFinite(factor) && factor > 0 ? factor : 1;
	return {
		name: i.canonical,
		qty: i.qty !== null ? Math.round(i.qty * f * 100) / 100 : null,
		unit: i.unit,
		grams: i.grams !== null ? Math.round(i.grams * f) : null,
		category: null,
	};
}

function scaleComponents(components: MealComponent[], factor: number): MealComponent[] {
	if (!factor || factor === 1) return JSON.parse(JSON.stringify(components));
	return components.map(c => {
		const cloned: MealComponent = JSON.parse(JSON.stringify(c));
		const s = cloned.source;
		if (s.kind === "compose_inline" || s.kind === "pantry_only" || s.kind === "personal_recipe") {
			s.raw_ingredients = s.raw_ingredients.map(r => ({
				name: r.name,
				qty: r.qty !== null ? Math.round(r.qty * factor * 100) / 100 : null,
				unit: r.unit,
				grams: r.grams !== null ? Math.round(r.grams * factor) : null,
			}));
		}
		return cloned;
	});
}

function mergeShallow(a: Record<string, unknown> | null | undefined, b: Partial<ImportedRecipe> | Record<string, unknown> | null | undefined): Record<string, unknown> {
	return { ...((a || {}) as Record<string, unknown>), ...((b || {}) as Record<string, unknown>) };
}

function parseFirstInt(s: string): number | null { const m = s.match(/(\d+)/); return m ? parseInt(m[1], 10) : null; }

function parseIso8601DurationMinutes(value: string): number | null {
	const m = value.trim().match(/^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
	if (!m) return null;
	const total = (m[1] ? +m[1] * 60 : 0) + (m[2] ? +m[2] : 0) + (m[3] ? Math.round(+m[3] / 60) : 0);
	return total > 0 ? total : null;
}

function parseHumanTimeMinutes(value: string): number | null {
	const lower = value.toLowerCase();
	const h = lower.match(/(\d+)\s*(?:h|hr|hour)/);
	const m = lower.match(/(\d+)\s*(?:m|min|minute)/);
	if (!h && !m) {
		const pure = parseInt(lower, 10);
		return Number.isFinite(pure) && pure > 0 ? pure : null;
	}
	return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

function makeRecipeId(title: string, sourceUrl: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);
	return `pr_${slug || "recipe"}_${shortHash(`${title}|${sourceUrl}|${Date.now()}`)}`;
}

function shortHash(input: string): string {
	let h = 5381;
	for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) & 0xffffffff;
	return Math.abs(h).toString(36).slice(0, 8);
}

function scoreConfidence(args: { title: string; ingredients: number; method: boolean; schemaOrg: boolean }): number {
	let score = 0.2;
	if (args.title && args.title !== "Untitled imported recipe") score += 0.2;
	if (args.ingredients >= 3) score += 0.2;
	if (args.ingredients >= 6) score += 0.1;
	if (args.method) score += 0.15;
	if (args.schemaOrg) score += 0.15;
	return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

export type { MiseMealSlot };
