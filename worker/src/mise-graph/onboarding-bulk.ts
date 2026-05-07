// Onboarding Phase B — bulk intake tools.
//
// Three "rapid-fire" tools that let a user (or an agent acting on their
// behalf) load a chunk of household state in one MCP call instead of trickling
// it in a question at a time:
//
//   * setPantryBulk     — text or photo → mise_kitchen_inventory rows
//   * setEquipmentBulk  — slug list     → mise_equipment_definitions rows
//   * setTraditions     — tradition specs → mise_household_traditions rows
//
// Each tool also writes a synthetic row to mise_onboarding_responses with a
// `_bulk_intake` question_kind so the trait inference engine sees the bulk
// intake as observed evidence. Phase A's applyTraitDelta is used directly to
// fire the trait moves — pantry and equipment counts are the strongest
// signals available before behavioral observation kicks in.
//
// Photo-pantry is OPTIONAL — if MESH bridge isn't wired, the tool returns a
// clear `vision_unavailable` error instead of crashing. Real callers can fall
// back to text mode.

import type { MiseGraphEnv } from "./types";
import { addItem } from "./kitchen-inventory";
import { ensureEquipmentDefined } from "./equipment";
import {
	applyTraitDelta,
	listTraits,
	type Trait,
} from "./onboarding";
import { TRAIT_NAMES, type TraitName } from "./onboarding-questions";
import { callBridgeVision } from "./bridge-vision";

// ─── Pantry bulk intake ────────────────────────────────────────────────────

export type PantryBulkMode = "text" | "photo";

export interface SetPantryBulkInput {
	household_id: string;
	mode?: PantryBulkMode;
	text?: string;
	image_b64?: string;
	image_mime?: string;
	replace_existing?: boolean;
}

export interface SetPantryBulkResult {
	ok: boolean;
	mode: PantryBulkMode;
	items_recorded: number;
	items_categorized: number;
	categories: string[];
	parsed_items?: Array<{ name: string; category: string }>;
	trait_deltas: TraitName[];
	error?: string;
}

const PANTRY_RICH_THRESHOLD = 30;
const PANTRY_BARE_THRESHOLD = 8;

export async function setPantryBulk(
	env: MiseGraphEnv,
	input: SetPantryBulkInput,
): Promise<SetPantryBulkResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("setPantryBulk: household_id required");
	const mode: PantryBulkMode = input.mode === "photo" ? "photo" : "text";

	let rawNames: string[] = [];
	let visionObserved: string | undefined;
	if (mode === "text") {
		rawNames = parseFreeTextItems(input.text ?? "");
	} else {
		const visionResult = await runVisionPantry(env, input);
		if (!visionResult.ok) {
			return {
				ok: false,
				mode: "photo",
				items_recorded: 0,
				items_categorized: 0,
				categories: [],
				trait_deltas: [],
				error: visionResult.error,
			};
		}
		rawNames = visionResult.items;
		visionObserved = visionResult.observed;
	}

	const parsed = rawNames
		.map(n => n.trim())
		.filter(n => n.length > 0)
		.map(name => ({ name, category: categorizeName(name) }));

	if (parsed.length === 0) {
		return {
			ok: true,
			mode,
			items_recorded: 0,
			items_categorized: 0,
			categories: [],
			parsed_items: [],
			trait_deltas: [],
		};
	}

	if (input.replace_existing) {
		try {
			await env.DB.prepare(
				`UPDATE mise_kitchen_inventory
				 SET consumed = ?, updated_at = ?
				 WHERE household_id = ?
				   AND (consumed IS NULL OR consumed = 0 OR consumed = FALSE)`,
			).bind(1, new Date().toISOString(), household_id).run();
		} catch {
			// Table missing — treat as no-op; addItem below will fail loudly if
			// the schema really is unprovisioned.
		}
	}

	const categoriesSet = new Set<string>();
	let recorded = 0;
	let categorized = 0;
	for (const item of parsed) {
		categoriesSet.add(item.category);
		const storage = categoryToStorage(item.category);
		try {
			await addItem(env, {
				household_id,
				canonical_name: item.name,
				qty: null,
				unit: null,
				storage,
				acquired_at: new Date().toISOString().slice(0, 10),
				expires_at: null,
				source: "bulk_intake",
				notes: mode === "photo" ? "photo bulk intake" : null,
			});
			recorded++;
			categorized++;
		} catch {
			// One item failure shouldn't kill the batch — keep going.
		}
	}

	// Fire trait deltas. Strong signals: large pantry → pantry-first (0.0),
	// tiny pantry → shop-fresh (1.0). Equipment-rich/minimalist also gets a
	// soft nudge if the user uploaded a *very* extensive list.
	const deltas: TraitName[] = [];
	const pantryDelta = pantryCountToDelta(recorded);
	if (pantryDelta) {
		await persistTraitDelta(env, household_id, "pantry_first_vs_shop_fresh",
			pantryDelta.delta_value, pantryDelta.delta_confidence);
		deltas.push("pantry_first_vs_shop_fresh");
	}

	// Append a synthetic onboarding response so the engine has provenance.
	await writeBulkResponse(env, {
		household_id,
		question_kind: "_pantry_bulk_intake",
		question_text: `pantry bulk intake (${mode})`,
		response_text: visionObserved ?? `${recorded} items: ${parsed.slice(0, 12).map(p => p.name).join(", ")}${parsed.length > 12 ? "…" : ""}`,
		tier: 1,
		inferred_traits_json: deltas.length
			? JSON.stringify({ trait_names: deltas, items_recorded: recorded })
			: null,
	});

	const categories = [...categoriesSet].sort();
	return {
		ok: true,
		mode,
		items_recorded: recorded,
		items_categorized: categorized,
		categories,
		parsed_items: parsed,
		trait_deltas: deltas,
	};
}

interface VisionPantryResult {
	ok: boolean;
	items: string[];
	observed?: string;
	error?: string;
}

async function runVisionPantry(
	env: MiseGraphEnv,
	input: SetPantryBulkInput,
): Promise<VisionPantryResult> {
	const image_b64 = (input.image_b64 || "").trim();
	if (!image_b64) {
		return { ok: false, items: [], error: "photo mode requires image_b64" };
	}
	if (!env.MESH || typeof env.MESH.fetch !== "function" || !env.BRIDGE_HOST || !env.BRIDGE_PORT || !env.BRIDGE_SECRET) {
		return {
			ok: false,
			items: [],
			error: "vision_unavailable: bridge-vision not wired (MESH / BRIDGE_HOST / BRIDGE_PORT / BRIDGE_SECRET missing). Use mode='text' instead.",
		};
	}

	const image_mime = (input.image_mime || "image/jpeg").trim();
	const image_bytes = base64ToBytes(image_b64);
	if (!image_bytes) {
		return { ok: false, items: [], error: "image_b64 could not be decoded" };
	}

	const prompt = [
		"You are looking at a kitchen shelf, fridge, or pantry. List every distinct food item you can identify.",
		"One item per line, lowercase, generic name (e.g. 'chickpeas', 'olive oil', 'cherry tomato').",
		"Skip non-food items (utensils, dishes, packaging logos).",
		"Skip uncertain identifications.",
		"Return JUST the list — no headings, no commentary.",
	].join(" ");

	const result = await callBridgeVision(env, {
		image_bytes,
		image_mime,
		prompt,
	});
	if (!result.ok) {
		return { ok: false, items: [], error: result.error || "vision call failed" };
	}
	const observed = result.analysis?.observed || result.raw_response || "";
	const items = parseFreeTextItems(observed);
	return { ok: true, items, observed };
}

function pantryCountToDelta(count: number): { delta_value: number; delta_confidence: number } | null {
	if (count >= PANTRY_RICH_THRESHOLD) {
		return { delta_value: 0.0, delta_confidence: 0.4 };
	}
	if (count > 0 && count <= PANTRY_BARE_THRESHOLD) {
		return { delta_value: 1.0, delta_confidence: 0.3 };
	}
	return null;
}

// ─── Equipment bulk intake ─────────────────────────────────────────────────

export interface SetEquipmentBulkInput {
	household_id: string;
	equipment_slugs: string[];
}

export interface SetEquipmentBulkResult {
	ok: boolean;
	defined_count: number;
	already_defined: string[];
	newly_defined: string[];
	trait_deltas: TraitName[];
}

const EQUIPMENT_RICH_THRESHOLD = 15;
const EQUIPMENT_MINIMALIST_THRESHOLD = 4;

export async function setEquipmentBulk(
	env: MiseGraphEnv,
	input: SetEquipmentBulkInput,
): Promise<SetEquipmentBulkResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("setEquipmentBulk: household_id required");
	const slugs = Array.isArray(input.equipment_slugs) ? input.equipment_slugs : [];
	const cleaned = uniqueSlugs(slugs);

	const newly: string[] = [];
	const already: string[] = [];
	for (const slug of cleaned) {
		const before = await readEquipmentSlugExists(env, slug);
		try {
			await ensureEquipmentDefined(env, household_id, slug);
			if (before) already.push(slug);
			else newly.push(slug);
		} catch {
			// Skip unparseable slugs rather than fail the whole batch.
		}
	}
	const definedCount = newly.length + already.length;

	const deltas: TraitName[] = [];
	const equipDelta = equipmentCountToDelta(definedCount);
	if (equipDelta) {
		await persistTraitDelta(env, household_id, "equipment_rich_vs_minimalist",
			equipDelta.delta_value, equipDelta.delta_confidence);
		deltas.push("equipment_rich_vs_minimalist");
	}

	await writeBulkResponse(env, {
		household_id,
		question_kind: "_equipment_bulk_intake",
		question_text: "equipment bulk intake",
		response_text: `${definedCount} slugs defined: ${cleaned.slice(0, 16).join(", ")}${cleaned.length > 16 ? "…" : ""}`,
		tier: 1,
		inferred_traits_json: deltas.length
			? JSON.stringify({ trait_names: deltas, defined_count: definedCount })
			: null,
	});

	return {
		ok: true,
		defined_count: definedCount,
		already_defined: already,
		newly_defined: newly,
		trait_deltas: deltas,
	};
}

function equipmentCountToDelta(count: number): { delta_value: number; delta_confidence: number } | null {
	if (count >= EQUIPMENT_RICH_THRESHOLD) {
		return { delta_value: 0.0, delta_confidence: 0.4 };
	}
	if (count > 0 && count <= EQUIPMENT_MINIMALIST_THRESHOLD) {
		return { delta_value: 1.0, delta_confidence: 0.3 };
	}
	return null;
}

async function readEquipmentSlugExists(env: MiseGraphEnv, slug: string): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			`SELECT slug FROM mise_equipment_definitions WHERE slug = ? LIMIT 1`,
		).bind(slug).first<{ slug: string }>();
		return !!row;
	} catch {
		return false;
	}
}

// ─── Traditions ────────────────────────────────────────────────────────────

export interface TraditionInput {
	name: string;
	cadence: string;
	description?: string;
	must_include_ingredients?: string[];
	must_include_format?: string;
	origin_note?: string;
}

export interface SetTraditionsInput {
	household_id: string;
	traditions: TraditionInput[];
}

export interface SetTraditionsResult {
	ok: boolean;
	traditions_set: number;
	rejected: Array<{ name: string; reason: string }>;
}

// cadence forms: "weekly:friday", "monthly:1st-saturday", "seasonal:fall", "annual:thanksgiving".
const WEEKLY_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SEASONS = ["spring", "summer", "fall", "autumn", "winter"];

const CADENCE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{ kind: "weekly",   re: /^weekly:([a-z]+)$/ },
	{ kind: "monthly",  re: /^monthly:(1st|2nd|3rd|4th|last)-([a-z]+)$/ },
	{ kind: "seasonal", re: /^seasonal:([a-z]+)$/ },
	{ kind: "annual",   re: /^annual:([a-z0-9_-]+)$/ },
];

function validateCadence(raw: string): { ok: boolean; reason?: string } {
	const c = (raw || "").trim().toLowerCase();
	if (!c) return { ok: false, reason: "cadence required" };
	for (const pat of CADENCE_PATTERNS) {
		const m = pat.re.exec(c);
		if (!m) continue;
		if (pat.kind === "weekly" && !WEEKLY_DAYS.includes(m[1])) {
			return { ok: false, reason: `weekly day must be one of ${WEEKLY_DAYS.join("/")}` };
		}
		if (pat.kind === "monthly" && !WEEKLY_DAYS.includes(m[2])) {
			return { ok: false, reason: `monthly day-of-week must be one of ${WEEKLY_DAYS.join("/")}` };
		}
		if (pat.kind === "seasonal" && !SEASONS.includes(m[1])) {
			return { ok: false, reason: `seasonal must be spring/summer/fall/autumn/winter` };
		}
		return { ok: true };
	}
	return { ok: false, reason: `cadence must be one of weekly:<day> | monthly:<1st-saturday> | seasonal:<season> | annual:<event>` };
}

export async function setTraditions(
	env: MiseGraphEnv,
	input: SetTraditionsInput,
): Promise<SetTraditionsResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("setTraditions: household_id required");
	const arr = Array.isArray(input.traditions) ? input.traditions : [];

	const rejected: Array<{ name: string; reason: string }> = [];
	let inserted = 0;

	for (const t of arr) {
		const name = (t?.name || "").trim();
		if (!name) {
			rejected.push({ name: "(unnamed)", reason: "name required" });
			continue;
		}
		const cadenceCheck = validateCadence(t?.cadence || "");
		if (!cadenceCheck.ok) {
			rejected.push({ name, reason: cadenceCheck.reason || "invalid cadence" });
			continue;
		}
		const cadence = (t.cadence || "").trim().toLowerCase();
		const description = optionalTrim(t.description);
		const must_format = optionalTrim(t.must_include_format);
		const origin = optionalTrim(t.origin_note);
		const must_ingredients = Array.isArray(t.must_include_ingredients)
			? t.must_include_ingredients.map(s => (s || "").trim()).filter(s => s.length > 0)
			: [];
		const must_ingredients_json = must_ingredients.length > 0
			? JSON.stringify(must_ingredients)
			: null;

		// Find existing tradition with same (household_id, name) — if so, replace.
		let existingId: string | null = null;
		try {
			const row = await env.DB.prepare(
				`SELECT tradition_id FROM mise_household_traditions
				 WHERE household_id = ? AND name = ?
				 LIMIT 1`,
			).bind(household_id, name).first<{ tradition_id: string }>();
			existingId = row?.tradition_id ?? null;
		} catch {
			existingId = null;
		}
		const tradition_id = existingId || makeTraditionId(household_id, name);
		const now = Date.now();

		try {
			await env.DB.prepare(
				`INSERT OR REPLACE INTO mise_household_traditions
					(tradition_id, household_id, name, cadence, description,
					 must_include_ingredients_json, must_include_format,
					 origin_note, active, created_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				tradition_id,
				household_id,
				name,
				cadence,
				description ?? null,
				must_ingredients_json,
				must_format ?? null,
				origin ?? null,
				1,
				now,
			).run();
			inserted++;
		} catch (err) {
			rejected.push({
				name,
				reason: `db error: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	if (inserted > 0) {
		await writeBulkResponse(env, {
			household_id,
			question_kind: "_traditions_bulk_set",
			question_text: "traditions bulk set",
			response_text: `${inserted} tradition(s): ${arr.slice(0, 8).map(t => t.name).join(", ")}${arr.length > 8 ? "…" : ""}`,
			tier: 1,
			inferred_traits_json: null,
		});
	}

	return {
		ok: rejected.length === 0,
		traditions_set: inserted,
		rejected,
	};
}

// ─── Helpers (parsing + writes) ────────────────────────────────────────────

export function parseFreeTextItems(text: string): string[] {
	if (!text || typeof text !== "string") return [];
	const out: string[] = [];
	const seen = new Set<string>();
	// Split on newlines OR commas OR semicolons. Trim each piece and drop
	// bullet/leading-dash artifacts and trailing parentheticals.
	for (const raw of text.split(/[\n,;]+/)) {
		let token = raw.trim();
		if (!token) continue;
		// Drop common bullet prefixes: "- ", "* ", "• ", "1. ", "1) ".
		token = token.replace(/^[-*•·]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
		// Drop trailing parenthetical descriptions ("almonds (raw)" → "almonds").
		token = token.replace(/\s*\(.*?\)\s*$/, "").trim();
		// Drop trailing colons.
		token = token.replace(/[:]+$/, "").trim();
		if (!token) continue;
		const key = token.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(token.toLowerCase());
	}
	return out;
}

// Lightweight categorizer — mirrors the rules in shopping-list.ts but kept
// local so we don't introduce a circular dep just for the bulk-intake path.
//
// "olive oil" / "sesame oil" must hit the pantry rule, not the produce-olive
// rule, so anything ending in " oil" is short-circuited to pantry first.
const PANTRY_CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
	{ pattern: /\boils?\b/, category: "pantry" },
	{ pattern: /\b(berry|berries|peach|peaches|plum|plums|apricot|nectarine|pear|pears|apples?|oranges?|grapes?|kiwi|pomegranate|mango|figs?|dates?|melons?|watermelon|raspberr|blackberr|blueberr|strawberr|cranberr|currant|persimmon|cherry|cherries)/, category: "fruit" },
	{ pattern: /^lemon$|^lime$|^lemons$|^limes$/, category: "fruit" },
	{ pattern: /\b(cilantro|mint|parsley|basil|sage|dill|thyme|oregano|rosemary|chive|chervil|tarragon|marjoram)\b/, category: "produce" },
	{ pattern: /\b(spinach|kale|chard|arugula|lettuce|romaine|cabbage|bok choy|cauliflower|broccoli|asparagus|zucchini|squash|eggplant|leek|fennel|celery|sweet potato|potato|corn|peas|sprout|greens|beet|turnip|parsnip|kohlrabi|rutabaga|jicama|daikon|napa|artichoke|okra|edamame pod)\b/, category: "produce" },
	{ pattern: /\b(onions?|shallots?|garlic|ginger|scallions?|chiles?|jalape[nñ]os?|serranos?|habaneros?|fresnos?|poblanos?|chipotles?)\b/, category: "produce" },
	{ pattern: /\b(tomato(es)?|cucumbers?|radish(es)?|carrots?|bell peppers?|peppers?|mushrooms?|shiitake|portobello|cremini|enoki|oyster mushrooms?|king oyster|maitake)\b/, category: "produce" },
	{ pattern: /\b(kimchi|olive)\b/, category: "produce" },
	{ pattern: /\b(chickpeas?|lentils?|tempeh|tofu|seitan|edamame|soybeans?|black beans?|kidney beans?|pinto beans?|navy beans?|cannellini|fava|lima beans?|mung beans?|cooked beans?|beans?)\b/, category: "protein" },
	{ pattern: /\b(chicken|turkey|duck|beef|pork|lamb|veal|bacon|sausage|prosciutto|pancetta|ham|salami|chorizo|ground beef|ground turkey|fish|salmon|tuna|cod|halibut|trout|shrimp|prawn|scallop|squid|octopus|lobster|crab|mussel|clam|oyster|anchovy|sardine|mackerel)\b/, category: "protein" },
	{ pattern: /\b(yogurt|milk|cream|butter|labneh|ricotta|feta|cotija|mozzarella|parmesan|burrata|gruyere|cheddar|brie|goat cheese|halloumi|paneer)\b/, category: "dairy" },
	{ pattern: /\bcheese\b/, category: "dairy" },
	{ pattern: /^egg$|^eggs$|\beggs?\b/, category: "dairy" },
	{ pattern: /\b(rice|oats?|quinoa|farro|barley|millet|buckwheat|noodles?|pasta|spaghetti|linguine|fettuccine|penne|fusilli|farfalle|orecchiette|rigatoni|fideua|fideu[aá]|couscous|bulgur|polenta|grits|bread|pita|tortillas?|flatbread|buns?|wraps?|croutons?|baguette|focaccia|naan|crackers?)\b/, category: "grains" },
	{ pattern: /\b(flour|cornmeal|breadcrumb|panko)\b/, category: "grains" },
	{ pattern: /\b(tahini|oil|vinegar|cumin|sumac|coriander|paprika|turmeric|cardamom|cinnamon|clove|nutmeg|fennel seed|allspice|mustard seed|fenugreek|harissa|miso|gochujang|fish sauce|soy sauce|tamari|sesame|nori|kombu|dashi|stock|broth|nuts?|almond|cashew|peanut|hazelnut|walnut|pistachio|pecan|sunflower seed|pumpkin seed|honey|maple|sugar|syrup|spice|garam masala|chili powder|chili crisp|sake|mirin|tamarind|saffron|matcha|aonori|za'?atar|dukkah|ras el hanout|salt|pepper|wine|baking|yeast|cornstarch|chia|seeds?|cocoa|cacao|chocolate|coconut|coconut milk|capers|anchovy paste|hot sauce|sriracha)\b/, category: "pantry" },
];

export function categorizeName(name: string): string {
	const n = (name || "").toLowerCase().trim();
	if (!n) return "pantry";
	for (const rule of PANTRY_CATEGORY_RULES) {
		if (rule.pattern.test(n)) return rule.category;
	}
	return "pantry";
}

function categoryToStorage(category: string): "pantry" | "fridge" | "freezer" | "counter" | null {
	switch (category) {
		case "produce":
		case "fruit":
		case "dairy":
		case "protein":
			return "fridge";
		case "grains":
		case "pantry":
			return "pantry";
		default:
			return null;
	}
}

interface BulkResponseInput {
	household_id: string;
	question_kind: string;
	question_text: string;
	response_text: string;
	tier: number;
	inferred_traits_json: string | null;
}

async function writeBulkResponse(env: MiseGraphEnv, input: BulkResponseInput): Promise<void> {
	const now = Date.now();
	const response_id = `obr_${input.household_id}__${input.question_kind}__${now}_${Math.random().toString(36).slice(2, 8)}`;
	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_onboarding_responses
				(response_id, household_id, member_id, question_kind, question_text,
				 response_text, response_chars, asked_at_ms, answered_at_ms,
				 inferred_traits_json, tier)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			response_id,
			input.household_id,
			null,
			input.question_kind,
			input.question_text,
			input.response_text,
			input.response_text.length,
			now,
			now,
			input.inferred_traits_json,
			input.tier,
		).run();
	} catch {
		// Onboarding schema not migrated — skip the synthetic log row. The
		// real pantry/equipment writes already succeeded, so the bulk-intake
		// is still useful, just without the trait-inference breadcrumb.
	}
}

async function persistTraitDelta(
	env: MiseGraphEnv,
	household_id: string,
	trait_name: TraitName,
	delta_value: number,
	delta_confidence: number,
): Promise<void> {
	if (!isKnownTrait(trait_name)) return;
	const existing = await loadTraitRow(env, household_id, trait_name);
	const old_value = existing?.trait_value ?? 0.5;
	const old_confidence = existing?.confidence ?? 0;
	const evidence_count = (existing?.evidence_count ?? 0) + 1;
	const updated = applyTraitDelta({ old_value, old_confidence, delta_value, delta_confidence });
	const now = Date.now();
	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_traits
				(household_id, trait_name, member_id, trait_value, confidence,
				 last_evidence_at_ms, evidence_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			household_id,
			trait_name,
			null,
			updated.new_value,
			updated.new_confidence,
			now,
			evidence_count,
		).run();
	} catch {
		// Traits table missing — skip. The synthetic response row still
		// records what happened.
	}
}

async function loadTraitRow(
	env: MiseGraphEnv,
	household_id: string,
	trait_name: TraitName,
): Promise<Trait | null> {
	const traits = await listTraits(env, household_id);
	return traits.find(t => t.trait_name === trait_name) ?? null;
}

function isKnownTrait(name: string): name is TraitName {
	return (TRAIT_NAMES as ReadonlyArray<string>).includes(name);
}

function uniqueSlugs(input: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") continue;
		const slug = raw.trim();
		if (!slug) continue;
		const key = slug.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(slug);
	}
	return out;
}

function optionalTrim(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

function makeTraditionId(household_id: string, name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "tradition";
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `trad_${household_id}__${slug}__${stamp}_${rand}`;
}

function base64ToBytes(b64: string): Uint8Array | null {
	try {
		// Node + Workers both support `atob`. atob may throw on bad padding.
		const cleaned = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
		const bin = atob(cleaned);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}
