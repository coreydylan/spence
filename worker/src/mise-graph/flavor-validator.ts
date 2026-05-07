// flavor-validator.ts
// ----------------------------------------------------------------------------
// Structural flavor validator for composed meals.
//
// COOKING LOGIC ENCODED HERE
// --------------------------
// A real cooked savory dinner generally needs five things to feel complete on
// the plate:
//
//   1. FAT   — carries flavor, lubricates the dish, makes it satisfying. Olive
//              oil, butter, tahini, yogurt, mayo, coconut milk, cream, ghee,
//              sesame oil, nuts, avocado, cheese.
//   2. ACID  — wakes the dish up, balances fat and salt. Lemon, lime, vinegar
//              of any sort, wine, tomato, yogurt (doubles as fat + acid), and
//              anything pickled.
//   3. SALT  — explicit seasoning source. Plain salt, soy sauce, miso, fish
//              sauce, tamari, salted feta/pecorino/parmesan, anchovy, capers,
//              olives, and other heavily-salted condiments.
//   4. TEXTURE CONTRAST — at least one element should be crunchy, raw, or
//              crisp when the rest is soft. Crispy chickpea, toasted nuts /
//              seeds, fresh raw veg, croutons, pickled veg, crackers, fried
//              shallot.
//   5. PROTEIN + VEG/GRAIN ANCHOR — for a vegetarian household, a dinner needs
//              a real protein source (chickpea, lentil, bean, tofu/tempeh,
//              eggs, cheese/yogurt, nuts/seeds) plus a substantial vegetable
//              or grain — sauce + protein alone isn't a meal.
//
// SCOPE
// -----
//   - Validate cooked savory dinners hard. (severity: hard_error for missing
//     fat / acid / salt; warning for missing texture contrast or vegetable.)
//   - Lunches get the same checks, but missing-fat / acid / salt drop to
//     warning (lunches are often lighter / one-pot).
//   - Breakfasts: only validated if they look like a cooked savory plate
//     (eggs, hash, shakshuka, tofu scramble). Chia jars, yogurt bowls,
//     oatmeal etc. are skipped — they're allowed to be soft and sweet.
//   - Snack boxes: not validated here at all (too small to require structure;
//     also explicitly excluded by the integrator).
//
// We pull ingredient role data from BOTH:
//   - the meal's `formula_ids` (look each up in the formula index, walk its
//     `inputs[]`, pull canonical_name + role + grams)
//   - the meal's `raw_ingredients[]` array (which carries name + category but
//     usually no role tag, so we infer roles by canonical-name matching)
//
// All matching is lower-cased and substring-aware so "extra-virgin olive
// oil", "evoo", "good olive oil" all resolve to the same FAT category.
// ----------------------------------------------------------------------------

// ---- Public types ----------------------------------------------------------

export type FlavorIssueSeverity = "hard_error" | "warning" | "info";

export type FlavorIssueType =
	| "missing_fat"
	| "missing_acid"
	| "missing_salt"
	| "missing_texture_contrast"
	| "missing_protein_dinner"
	| "missing_vegetable_dinner";

export interface FlavorIssue {
	severity: FlavorIssueSeverity;
	issue_type: FlavorIssueType;
	title: string;
	detail: string;
	repair_hint?: string;
}

// Minimal shape of the meal we validate. We accept a structural subset so the
// caller can pass a planner MisePlanMeal, a freshly composed ComposedMeal, or
// a hand-built test fixture without coupling to ledger.ts / planner.ts.
export interface MealForValidation {
	id: string;
	title: string;
	slot: "breakfast" | "lunch" | "dinner" | "snack";
	cuisine: string[];
	format: string;
	component_ids: string[];
	raw_ingredients?: RawIngredientLike[];
	formula_ids?: string[];
	method_summary?: string | null;
}

export interface RawIngredientLike {
	name: string;
	qty?: number | null;
	unit?: string | null;
	grams?: number | null;
	category?: string | null;
	role?: string | null;
}

// Minimal formula shape we read. Mirrors what ledger.ts's MiseFormulaIndex
// exposes; either pass that index directly or a slimmed-down equivalent.
export interface FormulaInputLike {
	canonical_name: string;
	role: string;
	qty?: number;
	unit?: string;
	grams?: number;
}

export interface FormulaLike {
	label?: string;
	output_label?: string;
	output_canonical_name?: string | null;
	inputs: FormulaInputLike[];
}

export interface FormulaIndex {
	by_id: Map<string, FormulaLike>;
}

// ---- Ingredient role tables -----------------------------------------------
// Substring matchers — every entry is tested as `name.includes(token)`
// against a lower-cased canonical/raw name. Order doesn't matter; we just OR
// across the whole list.

const FAT_TOKENS = [
	"olive oil", "evoo", "butter", "ghee", "tahini", "yogurt", "yoghurt",
	"mayo", "mayonnaise", "aioli", "coconut milk", "coconut cream", "cream",
	"creme fraiche", "crème fraîche", "sour cream", "sesame oil",
	"avocado oil", "grapeseed oil", "canola oil", "vegetable oil", "duck fat",
	"schmaltz", "lard", "almond", "walnut", "pecan", "cashew", "pistachio",
	"hazelnut", "peanut", "pine nut", "macadamia", "avocado", "feta", "cheese",
	"halloumi", "ricotta", "burrata", "mozzarella", "parmesan", "parmigiano",
	"pecorino", "labneh", "mascarpone", "creme",
];

const ACID_TOKENS = [
	"lemon", "lime", "yuzu", "calamansi",
	"vinegar", "verjus", "wine", "champagne", "sherry", "shaoxing",
	"tomato", "tomatillo", "passata", "marinara",
	"pickle", "pickled", "kimchi", "sauerkraut", "achar", "preserved lemon",
	"giardiniera", "amba",
	"yogurt", "yoghurt", "labneh", "buttermilk", "kefir",
	"tamarind", "sumac", "pomegranate molasses", "ume", "umeboshi",
	"capers",
];

const SALT_TOKENS = [
	"salt", "kosher salt", "sea salt", "flaky salt", "fleur de sel",
	"soy sauce", "shoyu", "tamari", "miso", "fish sauce", "nuoc mam",
	"colatura", "garum",
	"anchovy", "anchovies", "bonito", "katsuobushi", "dashi",
	"olive", "olives", "caper", "capers",
	"feta", "pecorino", "parmesan", "parmigiano", "halloumi", "manchego",
	"prosciutto",  // present mostly for completeness; this household is veg
	"gochujang", "doenjang", "ssamjang", "doubanjiang", "black bean paste",
	"furikake", "togarashi shichimi",
];

const CRUNCH_TOKENS = [
	"crispy", "crisp", "toasted", "fried", "crouton",
	"nut", "nuts", "almond", "walnut", "pecan", "cashew", "pistachio",
	"hazelnut", "peanut", "pine nut",
	"seed", "seeds", "sesame", "sunflower seed", "pumpkin seed", "pepita",
	"chickpea crisp", "crispy chickpea", "roasted chickpea",
	"raw", "fresh", "shaved", "slaw", "cucumber", "radish", "celery",
	"carrot", "fennel", "bell pepper", "snap pea", "snow pea",
	"pickle", "pickled", "kimchi", "achar", "giardiniera",
	"cracker", "crackers", "pita chip", "tortilla chip", "papadum",
	"furikake", "togarashi", "panko", "breadcrumb",
];

const PROTEIN_TOKENS = [
	"chickpea", "garbanzo",
	"lentil", "lentils", "bean", "beans", "black bean", "white bean",
	"pinto", "kidney bean", "navy bean", "cannellini", "borlotti",
	"butter bean", "lima bean",
	"tofu", "tempeh", "seitan", "soybean", "edamame",
	"egg", "eggs",
	"cheese", "feta", "ricotta", "halloumi", "paneer", "burrata",
	"mozzarella", "parmesan", "cottage cheese", "labneh",
	"yogurt", "greek yogurt", "yoghurt", "skyr",
	"nut", "nuts", "almond", "walnut", "pecan", "cashew", "pistachio",
	"peanut", "hazelnut",
	"seed", "seeds", "hemp seed", "hemp heart", "pumpkin seed", "pepita",
	"sunflower seed", "chia", "flax",
];

// "Soft / saucy" forms — used to detect when a meal has only soft components.
const SOFT_FORMAT_TOKENS = [
	"puree", "purée", "sauce", "soup", "stew", "porridge", "polenta",
	"oatmeal", "congee", "risotto", "dal", "daal", "curry", "braise",
	"hummus", "baba ganoush", "yogurt bowl", "smoothie", "pudding",
];

// Vegetable / grain anchor markers — at least one must appear in a dinner.
const VEG_GRAIN_ANCHOR_TOKENS = [
	"rice", "brown rice", "white rice", "jasmine", "basmati", "wild rice",
	"quinoa", "farro", "barley", "bulgur", "freekeh", "couscous", "millet",
	"buckwheat", "polenta", "grits", "noodle", "noodles", "pasta",
	"orzo", "spaghetti", "linguine", "rigatoni", "penne", "udon", "soba",
	"ramen", "rice noodle", "lo mein", "bread", "pita", "tortilla", "naan",
	"flatbread", "lavash", "focaccia",
	"broccoli", "cauliflower", "cabbage", "kale", "chard", "spinach",
	"collard", "bok choy", "gai lan", "rapini", "arugula", "lettuce",
	"romaine", "endive", "radicchio", "fennel", "leek", "carrot", "parsnip",
	"beet", "turnip", "rutabaga", "celeriac", "kohlrabi",
	"sweet potato", "potato", "yam", "squash", "pumpkin", "zucchini",
	"eggplant", "aubergine", "okra", "asparagus", "artichoke", "brussels",
	"green bean", "snap pea", "snow pea", "pea", "corn", "tomato",
	"mushroom", "shiitake", "oyster mushroom", "cremini", "portobello",
	"onion", "shallot", "garlic", "pepper", "bell pepper", "chili",
];

// Soft-only signals — components/labels that, when ALL components match this
// list, mean the meal has no real bite to it.
const ALL_SOFT_HINT_TOKENS = [
	...SOFT_FORMAT_TOKENS,
	"mash", "spread", "dip", "blended", "creamed",
];

// Breakfast formats that should be checked as cooked savory.
const SAVORY_BREAKFAST_TOKENS = [
	"egg", "shakshuka", "scramble", "frittata", "hash", "savory", "tofu scramble",
	"breakfast burrito", "breakfast taco", "huevos", "omelet", "omelette",
	"congee", "jook", "khichdi",
];

// ---- Main entry point ------------------------------------------------------

export function validateMealFlavorStructure(meal: MealForValidation, formulas: FormulaIndex): FlavorIssue[] {
	const issues: FlavorIssue[] = [];

	// Snack boxes are never validated here.
	if (meal.slot === "snack") return issues;

	// Breakfasts: only validate if cooked savory.
	if (meal.slot === "breakfast" && !looksLikeSavoryBreakfast(meal)) {
		return issues;
	}

	const tokens = collectMealTokens(meal, formulas);
	const isDinner = meal.slot === "dinner";
	const isCookedSavory = meal.slot === "dinner" || meal.slot === "lunch" || (meal.slot === "breakfast" && looksLikeSavoryBreakfast(meal));

	const hasFat = matchesAny(tokens, FAT_TOKENS);
	const hasAcid = matchesAny(tokens, ACID_TOKENS);
	const hasSalt = matchesAny(tokens, SALT_TOKENS);
	const hasCrunch = matchesAny(tokens, CRUNCH_TOKENS);
	const hasProtein = matchesAny(tokens, PROTEIN_TOKENS);
	const hasVegGrain = matchesAny(tokens, VEG_GRAIN_ANCHOR_TOKENS);

	const dinnerSeverity: FlavorIssueSeverity = isDinner ? "hard_error" : "warning";
	const lighterSeverity: FlavorIssueSeverity = "warning";

	if (isCookedSavory && !hasFat) {
		issues.push({
			severity: dinnerSeverity,
			issue_type: "missing_fat",
			title: "No fat source detected",
			detail: `${meal.title} doesn't appear to include a fat (olive oil, butter, tahini, yogurt, cheese, nuts, etc.). Cooked dishes need fat to carry flavor.`,
			repair_hint: "Add olive oil, butter, tahini, or another fat. A finishing drizzle counts.",
		});
	}

	if (isCookedSavory && !hasAcid) {
		issues.push({
			severity: dinnerSeverity,
			issue_type: "missing_acid",
			title: "No acid source detected",
			detail: `${meal.title} has no lemon, lime, vinegar, tomato, yogurt, or pickled element. The dish will taste flat.`,
			repair_hint: "Squeeze lemon/lime, splash vinegar, add a pickled element, or finish with yogurt.",
		});
	}

	if (isCookedSavory && !hasSalt) {
		issues.push({
			severity: dinnerSeverity,
			issue_type: "missing_salt",
			title: "No explicit salt source detected",
			detail: `${meal.title} doesn't list salt, soy/tamari, miso, fish sauce, or a strongly salted ingredient (feta, olives, capers).`,
			repair_hint: "Season with salt at minimum; consider miso, soy, or a salty cheese for depth.",
		});
	}

	if (isCookedSavory && !hasCrunch && componentsLookAllSoft(meal, formulas)) {
		issues.push({
			severity: lighterSeverity,
			issue_type: "missing_texture_contrast",
			title: "All-soft plate — no crunch",
			detail: `${meal.title} reads as entirely soft (sauce/puree/cooked grain). Without a crisp or raw element it will eat one-note.`,
			repair_hint: "Add toasted nuts/seeds, crispy chickpeas, fresh raw veg, croutons, or a pickled element.",
		});
	}

	if (isDinner && !hasProtein) {
		issues.push({
			severity: "warning",
			issue_type: "missing_protein_dinner",
			title: "Dinner has no clear protein",
			detail: `${meal.title} doesn't include chickpeas/lentils/beans, tofu/tempeh, eggs, cheese, yogurt, or nuts/seeds in meaningful quantity.`,
			repair_hint: "Add a vegetarian protein anchor — chickpeas, lentils, tofu, eggs, or feta/halloumi.",
		});
	}

	if (isDinner && !hasVegGrain) {
		issues.push({
			severity: "warning",
			issue_type: "missing_vegetable_dinner",
			title: "Dinner has no substantial vegetable or grain",
			detail: `${meal.title} doesn't include a real vegetable or grain anchor (rice, pasta, bread, broccoli, squash, etc.). Sauce + protein alone isn't a meal.`,
			repair_hint: "Build on a grain (rice, farro, pasta) or roast/braise a substantial vegetable as the base.",
		});
	}

	return issues;
}

// ---- Helpers ---------------------------------------------------------------

interface CollectedTokens {
	// Lower-cased searchable strings derived from the meal's ingredients.
	names: string[];
	roles: string[];
	formats: string[];
}

function collectMealTokens(meal: MealForValidation, formulas: FormulaIndex): CollectedTokens {
	const names: string[] = [];
	const roles: string[] = [];
	const formats: string[] = [];

	// Format itself is a token (e.g. "soup", "bowl", "tacos").
	if (meal.format) formats.push(meal.format.toLowerCase());
	if (meal.title) names.push(meal.title.toLowerCase());
	if (meal.method_summary) names.push(meal.method_summary.toLowerCase());

	// Walk formula inputs.
	const formulaIds = meal.formula_ids || [];
	for (const fid of formulaIds) {
		const formula = formulas.by_id.get(fid);
		if (!formula) continue;
		const label = (formula.output_label || formula.label || "").toLowerCase();
		if (label) names.push(label);
		const out = (formula.output_canonical_name || "").toLowerCase();
		if (out) names.push(out);
		for (const input of formula.inputs || []) {
			if (input.canonical_name) names.push(input.canonical_name.toLowerCase());
			if (input.role) roles.push(input.role.toLowerCase());
		}
	}

	// Walk raw ingredients.
	for (const raw of meal.raw_ingredients || []) {
		if (raw.name) names.push(raw.name.toLowerCase());
		if (raw.category) names.push(raw.category.toLowerCase());
		if (raw.role) roles.push(raw.role.toLowerCase());
	}

	return { names, roles, formats };
}

function matchesAny(tokens: CollectedTokens, table: string[]): boolean {
	// Role-based fast path: if the formula author or composer explicitly
	// tagged something as "fat" / "acid" / "salt" / "crunch" / "protein"
	// / "primary"+protein etc., honor that.
	const tokenSetForRole = new Set(tokens.roles);
	const roleHints = roleHintsFor(table);
	for (const hint of roleHints) {
		if (tokenSetForRole.has(hint)) return true;
	}
	const haystack = tokens.names.join(" | ");
	for (const needle of table) {
		if (!needle) continue;
		if (containsWord(haystack, needle)) return true;
	}
	return false;
}

// Word-boundary substring match — prevents "legume" from matching "ume"
// (umeboshi) or "consume" matching "ume", etc. We treat any non-letter
// character as a boundary so multi-word tokens like "olive oil" still match
// inside a phrase. Apostrophes and digits are also treated as letters so
// "bird's eye" works.
function containsWord(haystack: string, needle: string): boolean {
	if (!needle) return false;
	const idx = haystack.indexOf(needle);
	if (idx < 0) return false;
	let start = idx;
	while (start >= 0) {
		const before = start === 0 ? "" : haystack.charAt(start - 1);
		const afterIndex = start + needle.length;
		const after = afterIndex >= haystack.length ? "" : haystack.charAt(afterIndex);
		if (!isWordChar(before) && !isWordChar(after)) return true;
		start = haystack.indexOf(needle, start + 1);
	}
	return false;
}

function isWordChar(ch: string): boolean {
	if (!ch) return false;
	const c = ch.charCodeAt(0);
	// a-z
	if (c >= 97 && c <= 122) return true;
	// A-Z
	if (c >= 65 && c <= 90) return true;
	// 0-9
	if (c >= 48 && c <= 57) return true;
	// apostrophe (treat as part of word so "bird's" stays one word)
	if (ch === "'" || ch === "’") return true;
	return false;
}

function roleHintsFor(table: string[]): string[] {
	// Roles in the formula schema we trust (set in formulas-seed / composer):
	//   fat, acid, salt, salt_source, crunch, texture, protein,
	//   primary_protein, vegetable, grain, primary, aromatic, herb, ...
	// We pick the right hints based on which table we're matching.
	if (table === FAT_TOKENS) return ["fat"];
	if (table === ACID_TOKENS) return ["acid", "acidulant"];
	if (table === SALT_TOKENS) return ["salt", "salt_source", "seasoning"];
	if (table === CRUNCH_TOKENS) return ["crunch", "texture", "garnish_crunch"];
	if (table === PROTEIN_TOKENS) return ["protein", "primary_protein"];
	if (table === VEG_GRAIN_ANCHOR_TOKENS) return ["vegetable", "grain", "starch", "anchor"];
	return [];
}

function looksLikeSavoryBreakfast(meal: MealForValidation): boolean {
	const blob = [
		meal.title || "",
		meal.format || "",
		meal.method_summary || "",
		...(meal.raw_ingredients || []).map(r => r.name || ""),
	].join(" ").toLowerCase();
	for (const token of SAVORY_BREAKFAST_TOKENS) {
		if (containsWord(blob, token)) return true;
	}
	return false;
}

function componentsLookAllSoft(meal: MealForValidation, formulas: FormulaIndex): boolean {
	// We look at the *output* labels of each referenced formula plus the
	// meal's own format. If *every* one matches a soft-format token, the
	// plate is soft-only.
	const labels: string[] = [];
	if (meal.format) labels.push(meal.format.toLowerCase());

	const formulaIds = meal.formula_ids || [];
	for (const fid of formulaIds) {
		const formula = formulas.by_id.get(fid);
		if (!formula) continue;
		const label = (formula.output_label || formula.label || "").toLowerCase();
		if (label) labels.push(label);
		const out = (formula.output_canonical_name || "").toLowerCase();
		if (out) labels.push(out);
	}

	if (labels.length === 0) return false;
	return labels.every(label => ALL_SOFT_HINT_TOKENS.some(token => containsWord(label, token)));
}
