// Post-pass over the LLM composer output.
//
// The composer is a probabilistic dish writer; this module is the deterministic
// chef-of-staff that cleans up its output. It does six things:
//
//   1. Auto-link `formula_ids` when the LLM forgot but the dish obviously uses
//      a known formula (hummus in title → mise_formula_hummus, etc.).
//   2. Enforce dietary constraints: scrub vegetarian-violating ingredients
//      (fish sauce, anchovy, chicken, etc.), suggesting plant swaps so the
//      household never sees meat in a vegetarian plan.
//   3. Strip filler notes ("Cuisine direction: Mediterranean.") and notes that
//      restate the method_summary verbatim.
//   4. Fill `leftovers_to` from cooked volume vs serving size — if a dinner
//      cooks more than ~1.5× one meal's worth, the next-day lunch is claimed.
//   5. Enforce 1-3 lineage entries per meal, falling back to template/season
//      citations from the corpus when the LLM omitted them.
//   6. Assign `active_time_min` heuristically by format when the LLM didn't.
//
// Runs in-place on the composer output before the planner persists batches +
// shopping list, so downstream code sees a clean, consistent menu.

import type { ComposedMeal, ComposerSnackBox, ComposerLineageRef, ComposerRawIngredient } from "./menu-composer";
import type { MiseFormula } from "./ledger";
import type { MisePlanComponentBatch } from "./planner";
import {
	resolveFormatSpec,
	type ComponentRole,
	type ComponentSource,
	type ComposerRawIngredientLite,
	type FormatSlotSpec,
	type MealComponent,
} from "./meal-component";

export interface PostPassContext {
	formulas: MiseFormula[];
	dietary: string[];
	cuisine_direction: string[];
	people_default: number;
	composition_template_names?: string[];
	seasonal_now?: string[];
}

export interface PostPassReport {
	formula_links_added: number;
	dietary_swaps: Array<{ date: string; slot: string; from: string; to: string; reason: string }>;
	notes_stripped: number;
	leftovers_inferred: number;
	lineage_filled: number;
	active_time_filled: number;
	components_filled: number;
	cuisine_filled: number;
}

const VEGETARIAN_VIOLATIONS: Array<{ pattern: RegExp; swap: string; reason: string }> = [
	{ pattern: /\bfish sauce\b/i, swap: "soy sauce + seaweed dashi", reason: "fish sauce is not vegetarian" },
	{ pattern: /\banchov(y|ies)\b/i, swap: "miso paste", reason: "anchovy is not vegetarian" },
	{ pattern: /\boyster sauce\b/i, swap: "vegetarian oyster sauce (mushroom-based)", reason: "oyster sauce is not vegetarian" },
	{ pattern: /\bshrimp paste\b/i, swap: "fermented bean paste", reason: "shrimp paste is not vegetarian" },
	{ pattern: /\bchicken\b(?! ?stock)/i, swap: "tofu", reason: "chicken is not vegetarian" },
	{ pattern: /\bchicken stock\b/i, swap: "vegetable stock", reason: "chicken stock is not vegetarian" },
	{ pattern: /\bbeef\b/i, swap: "lentils", reason: "beef is not vegetarian" },
	{ pattern: /\bpork\b/i, swap: "tempeh", reason: "pork is not vegetarian" },
	{ pattern: /\bbacon\b/i, swap: "smoked tofu", reason: "bacon is not vegetarian" },
	{ pattern: /\bham\b/i, swap: "smoked tofu", reason: "ham is not vegetarian" },
	{ pattern: /\b(prawn|shrimp|squid|cuttlefish)\b/i, swap: "tofu", reason: "shellfish is not vegetarian" },
	{ pattern: /\b(salmon|tuna|cod|halibut|trout|sardine|mackerel)\b/i, swap: "tempeh", reason: "fish is not vegetarian" },
	{ pattern: /\bgelatin\b/i, swap: "agar-agar", reason: "gelatin is animal-derived" },
	{ pattern: /\blard\b/i, swap: "olive oil", reason: "lard is animal-derived" },
];

const ACTIVE_TIME_BY_FORMAT: Record<string, number> = {
	"omelette": 15, "frittata": 25, "pasta": 30, "salad": 20, "burger": 35,
	"sandwich": 20, "pizza": 30, "flatbread": 30, "fritter": 35, "soup": 30,
	"stew": 40, "skillet": 30, "stir fry": 25, "stir-fry": 25, "curry": 35,
	"taco": 30, "tacos": 30, "noodle": 25, "ramen": 35, "dumpling": 60,
	"hot pot": 25, "donburi": 25, "bowl": 25, "grain bowl": 25,
	"rice bowl": 25, "mezze": 20, "mezze plate": 20, "tagine": 50,
	"paella": 45, "risotto": 40, "gratin": 30, "sopes": 35, "banh mi": 25,
	"tostada": 25, "galette": 40, "grilled": 25, "leftover lunch": 8,
	"leftover": 8, "wrap": 20,
};

export function applyComposerPostPass(
	meals: ComposedMeal[],
	snackBoxes: ComposerSnackBox[],
	ctx: PostPassContext,
	batches?: MisePlanComponentBatch[],
): PostPassReport {
	const report: PostPassReport = {
		formula_links_added: 0,
		dietary_swaps: [],
		notes_stripped: 0,
		leftovers_inferred: 0,
		lineage_filled: 0,
		active_time_filled: 0,
		components_filled: 0,
		cuisine_filled: 0,
	};

	const formulasByPattern = buildFormulaMatchPatterns(ctx.formulas);
	const isVegetarian = ctx.dietary.some(d => /vegetarian|vegan/i.test(d));
	const validFormulaIds = new Set(ctx.formulas.map(f => f.id));

	for (const meal of meals) {
		// (1) Auto-link formulas when the LLM forgot
		const linked = linkFormulasToMeal(meal, formulasByPattern, validFormulaIds);
		report.formula_links_added += linked;

		// (2) Dietary scrub
		if (isVegetarian) {
			const swaps = scrubVegetarian(meal);
			report.dietary_swaps.push(...swaps);
		}

		// (3) Strip filler notes
		const stripped = stripFillerNotes(meal);
		report.notes_stripped += stripped;

		// (5) Lineage backfill
		if (!meal.lineage || meal.lineage.length === 0) {
			meal.lineage = inferLineage(meal, ctx);
			if (meal.lineage.length > 0) report.lineage_filled++;
		}

		// (6) Active time when LLM didn't supply it
		// (ComposedMeal doesn't have active_time_min in its base type; we put it on
		// the raw object via a type-flexible cast so downstream consumers can read it.)
		const mealAny = meal as ComposedMeal & { active_time_min?: number };
		if (typeof mealAny.active_time_min !== "number" || mealAny.active_time_min <= 0) {
			mealAny.active_time_min = ACTIVE_TIME_BY_FORMAT[meal.format?.toLowerCase()] ?? 30;
			report.active_time_filled++;
		}

		// (7) Fill structural components from the format spec.
		const filled = fillComponents(meal, batches || []);
		if (filled > 0) report.components_filled += filled;
	}

	for (const snack of snackBoxes) {
		const linked = linkFormulasToSnack(snack, formulasByPattern, validFormulaIds);
		report.formula_links_added += linked;
	}

	// (4) Leftover inference — runs after meals stable
	report.leftovers_inferred += inferLeftovers(meals, ctx.people_default);
	report.cuisine_filled += fillMissingCuisine(meals, ctx);

	return report;
}

// ---------------------------------------------------------------------------
// (1) Formula auto-link
// ---------------------------------------------------------------------------

interface FormulaMatcher {
	formula: MiseFormula;
	titlePatterns: RegExp[];   // strong: matches the formula in the meal title
	bodyPatterns: RegExp[];    // weak: matches in raw_ingredients/method (still link)
}

function buildFormulaMatchPatterns(formulas: MiseFormula[]): FormulaMatcher[] {
	return formulas.map(formula => {
		const label = (formula.output_label || "").toLowerCase();
		const canonical = (formula.output_canonical_name || "").toLowerCase();
		const stems: string[] = [];
		// Hand-coded synonym table for the prototype formulas.
		// Each stem is a regex word-boundary pattern.
		const labelKey = label.replace(/[^a-z0-9 ]/g, " ").trim();
		switch (labelKey) {
			case "hummus": stems.push("hummus"); break;
			case "lemon tahini sauce": stems.push("lemon tahini", "tahini sauce", "tahini lemon", "tahini-lemon", "tahini drizzle"); break;
			case "herb yogurt sauce": stems.push("herb yogurt", "herbed yogurt", "herb labneh", "herbed labneh", "yogurt herb", "labneh"); break;
			case "crispy chickpeas": stems.push("crispy chickpea", "crispy chickpeas", "roasted chickpea"); break;
			case "falafel mix": stems.push("falafel"); break;
			case "quick pickled radishes": stems.push("pickled radish", "quick pickle"); break;
			case "cold-fermented dough": stems.push("flatbread", "pizza dough", "ooni", "cold-fermented dough", "fermented dough", "pita dough"); break;
			case "cooked whole chickpeas": stems.push("cooked chickpea", "chickpea stew", "chana", "chickpea soup"); break;
			case "chia pudding": stems.push("chia pudding", "chia jar"); break;
			case "overnight oats": stems.push("overnight oats", "oat jar"); break;
			default:
				if (canonical) stems.push(canonical);
				else stems.push(labelKey);
		}
		const titlePatterns = stems.map(s => new RegExp(`\\b${escapeRegex(s)}\\b`, "i"));
		const bodyPatterns = stems.map(s => new RegExp(`\\b${escapeRegex(s)}\\b`, "i"));
		return { formula, titlePatterns, bodyPatterns };
	});
}

function linkFormulasToMeal(meal: ComposedMeal, matchers: FormulaMatcher[], validIds: Set<string>): number {
	const have = new Set(meal.formula_ids.filter(id => validIds.has(id)));
	const haystack = [
		meal.title || "",
		meal.method_summary || "",
		...(meal.raw_ingredients || []).map(r => r.name || ""),
		...(meal.notes || []),
	].join(" || ").toLowerCase();
	let added = 0;
	for (const matcher of matchers) {
		if (have.has(matcher.formula.id)) continue;
		const matchedTitle = matcher.titlePatterns.some(p => p.test(meal.title || ""));
		const matchedBody = matcher.bodyPatterns.some(p => p.test(haystack));
		if (matchedTitle || matchedBody) {
			meal.formula_ids.push(matcher.formula.id);
			have.add(matcher.formula.id);
			added++;
		}
	}
	// Drop raw_ingredients that the auto-linked formula already covers, so the
	// shopping list aggregator doesn't list "chickpea" when "Hummus" formula
	// already buys it.
	if (added > 0) {
		const linkedFormulas = matchers.filter(m => have.has(m.formula.id)).map(m => m.formula);
		meal.raw_ingredients = pruneRawIngredientsCoveredByFormulas(meal.raw_ingredients, linkedFormulas);
	}
	return added;
}

function linkFormulasToSnack(snack: ComposerSnackBox, matchers: FormulaMatcher[], validIds: Set<string>): number {
	const have = new Set(snack.formula_ids.filter(id => validIds.has(id)));
	const haystack = [
		snack.title || "",
		...(snack.items || []),
		...(snack.raw_ingredients || []).map(r => r.name || ""),
	].join(" || ").toLowerCase();
	let added = 0;
	for (const matcher of matchers) {
		if (have.has(matcher.formula.id)) continue;
		if (matcher.bodyPatterns.some(p => p.test(haystack))) {
			snack.formula_ids.push(matcher.formula.id);
			have.add(matcher.formula.id);
			added++;
		}
	}
	if (added > 0) {
		const linkedFormulas = matchers.filter(m => have.has(m.formula.id)).map(m => m.formula);
		snack.raw_ingredients = pruneRawIngredientsCoveredByFormulas(snack.raw_ingredients, linkedFormulas);
	}
	return added;
}

function pruneRawIngredientsCoveredByFormulas(raw: ComposerRawIngredient[], formulas: MiseFormula[]): ComposerRawIngredient[] {
	if (!raw || raw.length === 0) return raw;
	const covered = new Set<string>();
	for (const formula of formulas) {
		for (const input of formula.inputs) {
			covered.add(normalize(input.canonical_name));
		}
	}
	return raw.filter(item => !covered.has(normalize(item.name || "")));
}

// ---------------------------------------------------------------------------
// (2) Dietary scrub
// ---------------------------------------------------------------------------

function scrubVegetarian(meal: ComposedMeal): Array<{ date: string; slot: string; from: string; to: string; reason: string }> {
	const swaps: Array<{ date: string; slot: string; from: string; to: string; reason: string }> = [];
	if (!meal.raw_ingredients || meal.raw_ingredients.length === 0) return swaps;
	const cleaned: ComposerRawIngredient[] = [];
	for (const item of meal.raw_ingredients) {
		const name = item.name || "";
		const violation = VEGETARIAN_VIOLATIONS.find(v => v.pattern.test(name));
		if (violation) {
			cleaned.push({ ...item, name: violation.swap });
			swaps.push({ date: meal.date, slot: meal.slot, from: name, to: violation.swap, reason: violation.reason });
			// Also patch method_summary so the recipe text doesn't still say "fish sauce"
			if (meal.method_summary) {
				meal.method_summary = meal.method_summary.replace(violation.pattern, violation.swap);
			}
			meal.notes = (meal.notes || []).map(note => note.replace(violation.pattern, violation.swap));
		} else {
			cleaned.push(item);
		}
	}
	meal.raw_ingredients = cleaned;
	return swaps;
}

// ---------------------------------------------------------------------------
// (3) Filler note stripping
// ---------------------------------------------------------------------------

function stripFillerNotes(meal: ComposedMeal): number {
	if (!meal.notes || meal.notes.length === 0) return 0;
	const original = meal.notes.length;
	const method = (meal.method_summary || "").toLowerCase();
	meal.notes = meal.notes.filter(note => {
		const n = note.toLowerCase().trim();
		if (!n) return false;
		if (n.startsWith("cuisine direction:")) return false;
		if (n.startsWith("cuisine:") && n.length < 60) return false;
		// Drop notes that just restate the method_summary (>= 80% overlap on first 30 chars)
		if (method && n.length > 30 && method.length > 30) {
			const a = n.slice(0, 40);
			const b = method.slice(0, 40);
			if (a === b) return false;
		}
		// Drop notes that exactly equal the method_summary
		if (method && n === method) return false;
		return true;
	});
	return original - meal.notes.length;
}

// ---------------------------------------------------------------------------
// (4) Leftover inference
// ---------------------------------------------------------------------------

function inferLeftovers(meals: ComposedMeal[], peopleDefault: number): number {
	// Index meals by date+slot
	const byDate = new Map<string, ComposedMeal[]>();
	for (const m of meals) {
		if (!m.date) continue;
		if (!byDate.has(m.date)) byDate.set(m.date, []);
		byDate.get(m.date)!.push(m);
	}
	const dates = Array.from(byDate.keys()).sort();
	let inferred = 0;
	for (let i = 0; i < dates.length - 1; i++) {
		const today = dates[i];
		const tomorrow = dates[i + 1];
		const dinner = byDate.get(today)?.find(m => m.slot === "dinner");
		const lunch = byDate.get(tomorrow)?.find(m => m.slot === "lunch");
		if (!dinner || !lunch) continue;
		// If lunch title contains "leftover" or matches dinner title, mark the link.
		const lunchTitle = (lunch.title || "").toLowerCase();
		const dinnerTitle = (dinner.title || "").toLowerCase();
		const sharesTitle = dinnerTitle.length > 8 &&
			(lunchTitle.includes(dinnerTitle.slice(0, 12)) || isLeftoverPhrase(lunchTitle, dinnerTitle));
		if (sharesTitle && !dinner.leftovers_to.includes(`${tomorrow} lunch`)) {
			dinner.leftovers_to.push(`${tomorrow} lunch`);
			inferred++;
		}
	}
	return inferred;
}

function isLeftoverPhrase(lunchTitle: string, dinnerTitle: string): boolean {
	if (/^cold /.test(lunchTitle)) return true;
	if (/leftover/.test(lunchTitle)) return true;
	// Tokenize by space; if 2+ significant words from dinner appear in lunch
	const dinnerWords = new Set(dinnerTitle.split(/\s+/).filter(w => w.length >= 5));
	const lunchWords = new Set(lunchTitle.split(/\s+/).filter(w => w.length >= 5));
	let shared = 0;
	for (const w of dinnerWords) if (lunchWords.has(w)) shared++;
	return shared >= 2;
}

// ---------------------------------------------------------------------------
// (4b) Cuisine backfill
// ---------------------------------------------------------------------------

function fillMissingCuisine(meals: ComposedMeal[], ctx: PostPassContext): number {
	const sourceCuisineByTarget = new Map<string, string[]>();
	for (const source of meals) {
		const cuisines = cleanCuisine(source.cuisine);
		if (cuisines.length === 0) continue;
		for (const claim of source.leftovers_to || []) {
			const parsed = parseLeftoverClaim(claim);
			if (parsed) sourceCuisineByTarget.set(slotKey(parsed.date, parsed.slot), cuisines);
		}
	}

	let filled = 0;
	for (const meal of meals) {
		if (cleanCuisine(meal.cuisine).length > 0) continue;
		const inherited = sourceCuisineByTarget.get(slotKey(meal.date, meal.slot));
		const inferred = inherited
			|| inferCuisineFromMeal(meal)
			|| defaultCuisineForMeal(meal, ctx);
		if (inferred.length === 0) continue;
		meal.cuisine = inferred;
		filled++;
	}
	return filled;
}

function inferCuisineFromMeal(meal: ComposedMeal): string[] | null {
	const text = [
		meal.title,
		meal.format,
		meal.method_summary,
		...(meal.raw_ingredients || []).map(r => r.name || ""),
		...(meal.notes || []),
	].join(" ").toLowerCase();
	const rules: Array<[RegExp, string]> = [
		[/\b(kimchi|gochujang|bibimbap|bulgogi|japchae|doenjang)\b/, "Korean"],
		[/\b(miso|udon|ramen|soba|donburi|teriyaki|nori|ponzu|matcha|furikake)\b/, "Japanese"],
		[/\b(mapo|scallion pancake|lo mein|dan dan|sichuan|sesame noodle)\b/, "Chinese"],
		[/\b(thai|lemongrass|kaffir|green curry|red curry|panang|massaman)\b/, "Thai"],
		[/\b(curry|dal|dahl|chana|masala|tikka|paneer|raita|naan|korma|vindaloo)\b/, "Indian"],
		[/\b(taco|tacos|tortilla|quesadilla|enchilada|tostada|salsa|elote|esquites|pico de gallo)\b/, "Mexican"],
		[/\b(pasta|risotto|pizza|gnocchi|polenta|focaccia|ricotta|parmesan|cacio e pepe)\b/, "Italian"],
		[/\b(falafel|hummus|tahini|feta|sumac|za'?atar|labneh|pita|mezze|preserved lemon|dukkah)\b/, "Mediterranean"],
		[/\b(harissa|chermoula|tagine|couscous)\b/, "North African"],
		[/\b(galette|quiche|nicoise|ratatouille|baguette)\b/, "French"],
		[/\b(chia|oat|oats|granola|yogurt|avocado toast|scramble|toast|almond butter)\b/, "California"],
	];
	for (const [pattern, cuisine] of rules) {
		if (pattern.test(text)) return [cuisine];
	}
	return null;
}

function defaultCuisineForMeal(meal: ComposedMeal, ctx: PostPassContext): string[] {
	const direction = cleanCuisine(ctx.cuisine_direction);
	if (meal.slot === "breakfast") return ["California"];
	if (direction.length > 0 && meal.slot === "dinner") return [direction[0]];
	return ["American"];
}

function cleanCuisine(cuisines: string[] | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const cuisine of cuisines || []) {
		const value = (cuisine || "").trim();
		const key = value.toLowerCase();
		if (!value || seen.has(key) || /^(unknown|tbd|none|n\/a|na)$/i.test(value)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function parseLeftoverClaim(claim: string): { date: string; slot: string } | null {
	const match = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
	if (!match) return null;
	return { date: match[1], slot: match[2].toLowerCase() };
}

function slotKey(date: string, slot: string): string {
	return `${date}::${slot.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// (5) Lineage backfill
// ---------------------------------------------------------------------------

function inferLineage(meal: ComposedMeal, ctx: PostPassContext): ComposerLineageRef[] {
	const out: ComposerLineageRef[] = [];
	// Template lineage from format
	const templateName = (ctx.composition_template_names || []).find(t => t.toLowerCase().startsWith((meal.format || "").toLowerCase()));
	if (templateName) {
		out.push({
			source_kind: "template",
			source_title: templateName,
			influence: "structure",
		});
	}
	// Season lineage if any seasonal item appears in raw_ingredients
	const rawNames = (meal.raw_ingredients || []).map(r => (r.name || "").toLowerCase());
	const seasonHit = (ctx.seasonal_now || []).find(s => {
		const name = s.toLowerCase().split("[")[0].trim();
		return name && rawNames.some(rn => rn.includes(name));
	});
	if (seasonHit) {
		out.push({ source_kind: "season", source_title: seasonHit, influence: "seasonal anchor" });
	}
	// Household pattern fallback
	if (out.length === 0) {
		out.push({ source_kind: "household_pattern", source_title: "household weekly arc", influence: "pacing" });
	}
	return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalize(s: string): string {
	return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// (7) Component slot-filling
// ---------------------------------------------------------------------------
//
// For each format slot the meal's format declares, infer one MealComponent.
// Order of preference:
//   1. Match the slot's role to one of the meal's linked formula_ids
//      (e.g. "bread" matches "dough"; "sauce" matches "tahini" or "yogurt").
//      → source = use_batch.
//   2. Match raw_ingredients by name keyword (bread/loaf, salad/greens,
//      tortilla, rice, pasta, etc.). → source = compose_inline.
//   3. Required slot with no match → empty compose_inline (critic flags this).
//   4. Optional slot with no match → skip.
//
// Patterns are intentionally broad. The post-pass is preferred over LLM
// emission because the LLM omits structural components most of the time.

// Keyword patterns mapped to component roles. First match wins.
const ROLE_KEYWORDS: Array<{ role: ComponentRole; pattern: RegExp }> = [
	{ role: "bread",          pattern: /\b(bread|loaf|baguette|focaccia|pita|naan|tortilla|wrap|bun|brioche|ciabatta|crouton|toast|crostini)\b/i },
	{ role: "salad",          pattern: /\b(salad|greens?|arugula|lettuce|romaine|spinach leaves|mesclun|frise|escarole|radicchio)\b/i },
	{ role: "starch",         pattern: /\b(rice|noodle|pasta|orzo|couscous|farro|barley|polenta|quinoa|bulgur|udon|soba|ramen)\b/i },
	{ role: "shell",          pattern: /\b(tortilla|taco shell|hard shell|soft shell|corn shell|flour shell|wonton)\b/i },
	{ role: "sauce",          pattern: /\b(sauce|drizzle|salsa|aioli|tahini|labneh|chimichurri|pesto|romesco|harissa|gochujang|aioli|vinaigrette|dressing)\b/i },
	{ role: "pickle",         pattern: /\b(pickle|pickled|kimchi|sauerkraut|fermented|escabeche|chutney|relish)\b/i },
	{ role: "crunch",         pattern: /\b(crispy|crunchy|fried|toasted seeds?|toasted nuts?|crouton|chip|cracker|panko|dukkah)\b/i },
	{ role: "garnish",        pattern: /\b(cilantro|parsley|chive|dill|basil|mint|tarragon|sesame seed|herb sprig|microgreen|scallion|green onion|shiso)\b/i },
	{ role: "protein",        pattern: /\b(tofu|tempeh|seitan|egg|chickpea|lentil|bean|edamame|paneer|halloumi|cottage cheese)\b/i },
	{ role: "vegetable_side", pattern: /\b(roasted veg|grilled veg|steamed veg|broccoli|cauliflower|asparagus|carrot|zucchini|squash|brussels|fennel|leek|chard|kale)\b/i },
	{ role: "topping",        pattern: /\b(topping|cheese|mozzarella|feta|olive|sun-dried|caramelized onion|pepperoni)\b/i },
	{ role: "filling",        pattern: /\b(filling|stuffing|jackfruit|tinga|barbacoa|carnitas|al pastor)\b/i },
];

// Formula label keywords mapped to roles. Used to detect that an existing
// batch satisfies a slot. First match wins per formula.
const FORMULA_ROLE_PATTERNS: Array<{ role: ComponentRole; pattern: RegExp }> = [
	{ role: "bread",  pattern: /\b(dough|pita|focaccia|flatbread|pizza)\b/i },
	{ role: "sauce",  pattern: /\b(tahini|yogurt|labneh|sauce|aioli|harissa|chimichurri|pesto|romesco|drizzle)\b/i },
	{ role: "pickle", pattern: /\b(pickle|pickled|kimchi|sauerkraut|fermented)\b/i },
	{ role: "crunch", pattern: /\b(crispy|crunchy|fried)\b/i },
	{ role: "main",   pattern: /\b(hummus|falafel|chickpea|stew|curry|filling)\b/i },
	{ role: "starch", pattern: /\b(rice|noodle|grain|pasta|polenta)\b/i },
];

function batchesMatchingRole(role: ComponentRole, batches: MisePlanComponentBatch[]): MisePlanComponentBatch[] {
	const out: MisePlanComponentBatch[] = [];
	for (const batch of batches) {
		const label = (batch.label || "").toLowerCase();
		for (const pat of FORMULA_ROLE_PATTERNS) {
			if (pat.role !== role) continue;
			if (pat.pattern.test(label)) {
				out.push(batch);
				break;
			}
		}
	}
	return out;
}

function findBatchByFormulaIdOrLabel(
	formulaIds: string[],
	role: ComponentRole,
	batches: MisePlanComponentBatch[],
): MisePlanComponentBatch | null {
	// First: direct formula_id → batch (when batches are keyed by/contain the
	// formula id). Try to match the role against each linked formula label.
	for (const fid of formulaIds) {
		const stem = fid.replace(/^mise_formula_/, "").toLowerCase();
		for (const pat of FORMULA_ROLE_PATTERNS) {
			if (pat.role !== role) continue;
			if (pat.pattern.test(stem)) {
				// Find the matching batch by formula_id or stem-in-id-or-label.
				const match = batches.find(b => {
					const meta = b.meta as Record<string, unknown> | undefined;
					const metaFormulaId = typeof meta?.formula_id === "string" ? meta.formula_id : "";
					if (metaFormulaId === fid) return true;
					const idStem = b.id.replace(/^mise_(component|batch|formula)[:_]/, "").toLowerCase();
					const labelStem = (b.label || "").toLowerCase();
					return idStem.includes(stem) || labelStem.includes(stem);
				});
				if (match) return match;
			}
		}
	}
	// Fallback: scan batches directly for a label matching the role.
	const matches = batchesMatchingRole(role, batches);
	return matches[0] ?? null;
}

function rawIngredientsMatchingRole(
	role: ComponentRole,
	raw: ComposerRawIngredient[] | undefined,
): ComposerRawIngredient[] {
	if (!raw || raw.length === 0) return [];
	const out: ComposerRawIngredient[] = [];
	for (const item of raw) {
		const name = item.name || "";
		for (const kw of ROLE_KEYWORDS) {
			if (kw.role !== role) continue;
			if (kw.pattern.test(name)) {
				out.push(item);
				break;
			}
		}
	}
	return out;
}

function rawToLite(items: ComposerRawIngredient[]): ComposerRawIngredientLite[] {
	return items.map(i => ({
		name: i.name,
		qty: i.qty,
		unit: i.unit,
		grams: i.grams,
	}));
}

function defaultRoleTitle(role: ComponentRole, formatLabel: string): string {
	const map: Record<ComponentRole, string> = {
		main:           formatLabel ? `${formatLabel} main` : "main",
		protein:        "protein",
		starch:         "starch",
		bread:          "bread",
		vegetable_side: "vegetable side",
		salad:          "side salad",
		sauce:          "sauce",
		garnish:        "garnish",
		drink:          "drink",
		pickle:         "pickle",
		crunch:         "crunch",
		shell:          "shell",
		topping:        "topping",
		filling:        "filling",
	};
	return map[role];
}

// "Primary" roles ARE the dish itself (e.g. a frittata's main IS the meal);
// when no keyword match found, fall back to using the meal's raw_ingredients
// as the source.
const PRIMARY_ROLES: ReadonlySet<ComponentRole> = new Set([
	"main", "filling", "topping",
]);

function buildComponentForSlot(
	slot: FormatSlotSpec,
	meal: ComposedMeal,
	batches: MisePlanComponentBatch[],
	usedRawNames: Set<string>,
	opts: { allow_primary_fallback: boolean } = { allow_primary_fallback: true },
): MealComponent | null {
	const peopleDefault = meal.people || 2;
	// (1) batch reuse
	const matchingBatch = findBatchByFormulaIdOrLabel(meal.formula_ids || [], slot.role, batches);
	if (matchingBatch) {
		const qtyG = typeof matchingBatch.quantity === "number" && matchingBatch.unit === "g"
			? matchingBatch.quantity
			: 0;
		const source: ComponentSource = {
			kind: "use_batch",
			batch_id: matchingBatch.id,
			qty_g: qtyG,
		};
		return {
			role: slot.role,
			required: slot.required,
			title: matchingBatch.label || defaultRoleTitle(slot.role, meal.format),
			source,
			serves: peopleDefault,
			active_time_min: 0,
		};
	}

	// (2) raw_ingredient match by role keyword
	const matchingRaw = rawIngredientsMatchingRole(slot.role, meal.raw_ingredients)
		.filter(r => !usedRawNames.has((r.name || "").toLowerCase()));
	if (matchingRaw.length > 0) {
		for (const r of matchingRaw) usedRawNames.add((r.name || "").toLowerCase());
		const source: ComponentSource = {
			kind: "compose_inline",
			raw_ingredients: rawToLite(matchingRaw),
		};
		return {
			role: slot.role,
			required: slot.required,
			title: matchingRaw[0].name || defaultRoleTitle(slot.role, meal.format),
			source,
			serves: peopleDefault,
			active_time_min: 5,
		};
	}

	// (2b) Primary-role fallback: the dish IS the main / filling / topping.
	// Use the meal's remaining raw_ingredients as the source.
	// Gated by allow_primary_fallback so pass 1 in fillComponents only does
	// keyword matching — pass 2 lets primary roles scoop the remainder.
	if (opts.allow_primary_fallback && PRIMARY_ROLES.has(slot.role) && meal.raw_ingredients && meal.raw_ingredients.length > 0) {
		const remaining = meal.raw_ingredients.filter(r => !usedRawNames.has((r.name || "").toLowerCase()));
		if (remaining.length > 0) {
			for (const r of remaining) usedRawNames.add((r.name || "").toLowerCase());
			const source: ComponentSource = {
				kind: "compose_inline",
				raw_ingredients: rawToLite(remaining),
			};
			return {
				role: slot.role,
				required: slot.required,
				title: meal.title || defaultRoleTitle(slot.role, meal.format),
				source,
				serves: peopleDefault,
				active_time_min: 15,
			};
		}
	}

	// (3) Required slot with no match → empty compose_inline so the critic
	// flags it. (4) Optional slots → skip.
	// In pass 1 (keyword-only) we don't emit hollow placeholders — that would
	// block pass 2 from filling the slot via primary-role fallback. The hollow
	// placeholder is only the last resort once pass 2 has had its turn.
	if (!slot.required) return null;
	if (!opts.allow_primary_fallback) return null;
	return {
		role: slot.role,
		required: true,
		title: defaultRoleTitle(slot.role, meal.format),
		source: { kind: "compose_inline", raw_ingredients: [] },
		serves: peopleDefault,
		active_time_min: 0,
	};
}

export function fillComponents(
	meal: ComposedMeal,
	batches: MisePlanComponentBatch[],
): number {
	const slots = resolveFormatSpec(meal.format);
	if (!slots || slots.length === 0) return 0;
	const mealAny = meal as ComposedMeal & { components?: MealComponent[] };
	// Don't overwrite components the LLM already supplied. (Idempotent.)
	if (Array.isArray(mealAny.components) && mealAny.components.length > 0) return 0;
	const usedRawNames = new Set<string>();
	const built: Map<ComponentRole, MealComponent> = new Map();

	// Pass 1: keyword-specific matching only. Every slot gets a chance to
	// claim ingredients that match ITS role keyword (rice→starch, tortilla→
	// bread, etc.) before any primary role can scoop them. Required-first
	// ordering for tie-breaks when the same ingredient could match multiple
	// keywords.
	const ordered = [...slots].sort((a, b) => Number(b.required) - Number(a.required));
	for (const slot of ordered) {
		const comp = buildComponentForSlot(slot, meal, batches, usedRawNames, { allow_primary_fallback: false });
		if (comp) built.set(slot.role, comp);
	}

	// Pass 2: primary roles (main / filling / topping) claim whatever's left,
	// and any remaining required slot gets a hollow placeholder so the critic
	// can flag a real gap. Optional slots that didn't match anything stay out.
	for (const slot of ordered) {
		if (built.has(slot.role)) continue;
		const comp = buildComponentForSlot(slot, meal, batches, usedRawNames, { allow_primary_fallback: true });
		if (comp) built.set(slot.role, comp);
	}

	if (built.size === 0) return 0;
	// Preserve original slot order (not required-first reorder) when emitting.
	const out: MealComponent[] = [];
	for (const slot of slots) {
		const c = built.get(slot.role);
		if (c) out.push(c);
	}
	mealAny.components = out;
	return out.length;
}
