// Shopping list builder with canonicalization, batch-output exclusion,
// snack-box-string filtering, and shop-run scheduling.
//
// Replaces the previous naive aggregator that produced 145-item lists with
// duplicates ("cherry tomato" + "cherry tomatoes"), batch outputs ("Hummus",
// "Chia Pudding") listed as items to buy, and snack-box description strings
// ("Bell Pepper & Carrot Sticks", "Hummus With Sumac & Olive Oil") leaking in.
//
// Goals:
//   1. Singularize and dedupe. "cherry tomatoes" / "cherry tomato" / "Cherry
//      Tomatoes" all collapse to one entry.
//   2. Strip anything produced by a component batch — if the household is
//      making hummus, "hummus" should never appear in the shopping list.
//   3. Strip anything derived from a formula's input list — the formula's prep
//      task already brings in those raw materials.
//   4. Strip snack-box description-string leakage (e.g. multi-word phrases
//      with "& " or "with " or noun adjectives like "warm"/"sumac dust").
//   5. Lemon roll-up: "lemon", "lemon juice", "lemon zest", "lemon wedge" all
//      reduce to a single "lemon" line with quantity = ceil(uses / 2).
//   6. Categorize properly using a richer rule set + alias awareness.
//   7. Split into shop_runs: pantry/dairy/protein on day 0, produce on day 0,
//      a produce-refresh ~day 7. Each run lists which categories belong to it.

import type { MisePlanComponentBatch, MisePlanDay, MisePlanMeal, MiseShoppingListItem, MiseShoppingListSection, MiseSnackBox } from "./planner";
import type { ComposerRawIngredient } from "./menu-composer";
import type { MiseFormula } from "./ledger";
import { computeItemWindowsFromParts, computeRuns, DEFAULT_HOUSEHOLD_PREFS, type HouseholdShopPreferences } from "./shopping-runs";

export interface ShoppingRun {
	id: string;
	date: string;
	label: string;             // "Day 0 — pantry + protein", "Day 7 — produce refresh"
	categories: string[];      // category names included in this run
	item_count: number;
	meta?: Record<string, unknown>;
}

export interface ShoppingResult {
	sections: MiseShoppingListSection[];
	runs: ShoppingRun[];
	debug?: Record<string, string>;
}

interface AggregatorEntry {
	canonical: string;
	display: string;
	source: Set<string>;
	grams: number;
	qty: number | null;
	unit: string | null;
	pieces: number;            // for lemon-style roll-up; counts distinct uses
	categoryHint: string | null;
}

// Hand-curated alias table — every key normalizes to a canonical singular form.
// Keys MUST be lowercase singular-or-plural variants we've actually seen the
// LLM emit. The right-hand side is the canonical form that goes onto the list.
const ALIAS_TABLE: Record<string, string> = {
	// --- plurals + casing ---
	"cherry tomatoes": "cherry tomato",
	"canned tomatoes": "canned tomato",
	"kalamata olives": "kalamata olive",
	"olives": "olive",
	"radishes": "radish",
	"scallions": "scallion",
	"shallots": "shallot",
	"chiles": "chile",
	"chillies": "chile",
	"chilies": "chile",
	"chillis": "chile",
	"cloves": "clove",
	"garlic clove": "garlic",
	"garlic cloves": "garlic",
	"eggs": "egg",
	"large egg": "egg",
	"large eggs": "egg",
	"tomatoes": "tomato",
	"ripe tomato": "tomato",
	"potatoes": "potato",
	"medium potato": "potato",
	"sweet potatoes": "sweet potato",
	"mushrooms": "mushroom",
	"shiitake mushrooms": "shiitake mushroom",
	"shiitakes": "shiitake mushroom",
	"shiitake": "shiitake mushroom",
	"fresh shiitake": "shiitake mushroom",
	"onions": "onion",
	"red onions": "red onion",
	"carrots": "carrot",
	"medium carrot": "carrot",
	"cucumbers": "cucumber",
	"peppers": "bell pepper",
	"bell peppers": "bell pepper",
	"limes": "lime",
	"lemons": "lemon",
	"avocados": "avocado",
	"ripe avocado": "avocado",
	"corn tortillas": "corn tortilla",
	"flour tortillas": "flour tortilla",
	"brioche buns": "brioche bun",
	"buns": "bun",
	"pita or wrap": "pita",
	"pita bread": "pita",
	"warm pita": "pita",
	"fresh baguette": "baguette",
	"baguettes": "baguette",
	"crusty bread": "crusty bread",
	"asparagus lettuce": "asparagus",
	"large asparagus": "asparagus",
	"white asparagus": "asparagus",
	"white european asparagus": "asparagus",
	"wild asparagus": "asparagus",
	"purple asparagus": "asparagus",
	"green asparagus": "asparagus",
	"butter lettuce": "butter lettuce",
	"mixed berries": "mixed berry",
	"mixed greens": "mixed greens",
	"baby spinach": "spinach",
	"fresh spinach": "spinach",
	"fresh dill": "dill",
	"fresh mint": "mint",
	"fresh parsley": "parsley",
	"fresh thyme": "thyme",
	"fresh herbs": "mixed herbs",
	"fresh cilantro": "cilantro",
	"fresh basil": "basil",
	"fresh sage": "sage",
	"fresh chive": "chive",
	"fresh chives": "chive",
	"fresh ginger": "ginger",
	"fresh strawberry": "strawberry",
	"fresh blueberry": "blueberry",
	"fresh mango": "mango",
	"sliced almond": "almond",
	"sliced almonds": "almond",
	"raw almond": "almond",
	"toasted almond": "almond",
	"shelled pistachio": "pistachio",
	"oil for cooking": "neutral oil",
	"oil for frying": "neutral oil",
	"vegetable oil": "neutral oil",
	"sesame seeds": "sesame seed",
	"black sesame seed": "sesame seed",
	"white sesame seed": "sesame seed",
	"crushed peanut": "peanut",
	"crushed peanuts": "peanut",
	"toasted nori": "nori",
	"nori seaweed": "nori",
	"nori sheet": "nori",
	"black bean patty": "black bean patty",
	"black bean patties": "black bean patty",
	"mung bean sprout": "mung bean sprout",
	"mung bean sprouts": "mung bean sprout",
	"bean sprout": "mung bean sprout",
	"bean sprouts": "mung bean sprout",
	"napa cabbage": "napa cabbage",
	"green cabbage": "green cabbage",
	"japanese eggplant": "japanese eggplant",
	"thai eggplant": "thai eggplant",
	"firm tofu": "tofu",
	"extra-firm tofu": "tofu",
	"extra firm tofu": "tofu",
	"pressed tofu": "tofu",
	"marinated tofu": "tofu",
	"silken tofu": "silken tofu",
	"thai green curry paste": "thai green curry paste",
	"red curry paste": "red curry paste",
	"green curry paste": "green curry paste",
	"pomegranate aril": "pomegranate",
	"pomegranate arils": "pomegranate",
	"pomegranate seed": "pomegranate",
	"pomegranate seeds": "pomegranate",
	"pitted date": "date",
	"pitted dates": "date",
	"medjool date": "date",
	"date": "date",
	"raisin": "raisin",
	"raisins": "raisin",
	"feta cheese": "feta",
	"low-moisture mozzarella": "mozzarella",
	"fresh mozzarella": "mozzarella",
	"low moisture mozzarella": "mozzarella",
	"parmesan cheese": "parmesan",
	"ricotta cheese": "ricotta",
	"goat cheese": "goat cheese",
	"cumin seed": "cumin",
	"ground cumin": "cumin",
	"ground coriander": "coriander",
	"red chili powder": "chili powder",
	"chile powder": "chili powder",
	"chili crisp": "chili crisp",
	"saffron threads": "saffron",
	"saffron thread": "saffron",
	"smoked paprika": "smoked paprika",
	"sweet paprika": "paprika",
	"paprika": "paprika",
	"turmeric powder": "turmeric",
	"ground turmeric": "turmeric",
	"matcha powder": "matcha",
	"red miso": "red miso",
	"white miso": "white miso",
	"white miso paste": "white miso",
	"miso paste": "white miso",
	"yellow miso": "white miso",
	"okonomiyaki sauce": "okonomiyaki sauce",
	"vegetable stock": "vegetable stock",
	"vegetable broth": "vegetable stock",
	"vegetable dashi": "vegetable dashi",
	"dashi stock": "dashi",
	"dashi": "dashi",
	"kombu (kelp)": "kombu",
	"kombu kelp": "kombu",
	"dried shiitake": "dried shiitake",
	"jasmine rice": "jasmine rice",
	"basmati rice": "basmati rice",
	"arborio rice": "arborio rice",
	"brown rice": "brown rice",
	"white rice": "white rice",
	"short-grain rice": "short-grain rice",
	"sushi rice": "short-grain rice",
	"rice noodle": "rice noodle",
	"rice noodles": "rice noodle",
	"ramen noodle": "ramen noodle",
	"ramen noodles": "ramen noodle",
	"udon noodle": "udon noodle",
	"udon noodles": "udon noodle",
	"soba noodle": "soba noodle",
	"soba noodles": "soba noodle",
	"fideuá noodle": "fideuá noodle",
	"fideuá noodles": "fideuá noodle",
	"linguine": "linguine",
	"spaghetti": "spaghetti",
	"short pasta": "short pasta",
	"penne": "penne",
	"rigatoni": "rigatoni",
	"orecchiette": "orecchiette",
	"farfalle": "farfalle",
	"fusilli": "fusilli",
	"couscous or bulgur": "couscous",
	"cauliflower florets": "cauliflower",
	"cauliflower floret": "cauliflower",
	"broccoli florets": "broccoli",
	"broccoli floret": "broccoli",
	"medium beet": "beet",
	"beets": "beet",
	"medium zucchini": "zucchini",
	"medium yellow squash": "yellow squash",
	"vegan mayonnaise": "vegan mayo",
	"mayonnaise": "mayo",
	"sake or white wine": "sake",
	"dry white wine": "white wine",
	"red wine": "red wine",
	"tamarind paste": "tamarind paste",
	"palm sugar": "palm sugar",
	"brown sugar": "brown sugar",
	"granulated sugar": "sugar",
	"shredded coconut": "shredded coconut",
	"toasted coconut": "shredded coconut",
	// --- citrus derivative roll-up ---
	"lemon wedge": "__LEMON_DERIV__",
	"lemon juice": "__LEMON_DERIV__",
	"lemon zest": "__LEMON_DERIV__",
	"lime juice": "__LIME_DERIV__",
	"lime wedge": "__LIME_DERIV__",
	"lime zest": "__LIME_DERIV__",
	// --- batch outputs (we MAKE these, never buy) ---
	"radish quick pickle": "__BATCH_OUTPUT__",
	"quick pickled radish": "__BATCH_OUTPUT__",
	"pickled radish": "__BATCH_OUTPUT__",
	"hummus": "__BATCH_OUTPUT__",
	"falafel": "__BATCH_OUTPUT__",
	"warm falafel": "__BATCH_OUTPUT__",
	"falafel (fried or baked)": "__BATCH_OUTPUT__",
	"chickpea hummus": "__BATCH_OUTPUT__",
	"chickpea falafel mix": "__BATCH_OUTPUT__",
	"crispy chickpea": "__BATCH_OUTPUT__",
	"crispy chickpeas": "__BATCH_OUTPUT__",
	"crispy chickpea clusters": "__BATCH_OUTPUT__",
	"crispy chickpea crunch": "__BATCH_OUTPUT__",
	"roasted crispy chickpea": "__BATCH_OUTPUT__",
	"roasted crispy chickpeas": "__BATCH_OUTPUT__",
	"chickpea cooked whole": "__BATCH_OUTPUT__",
	"cooked chickpea": "__BATCH_OUTPUT__",
	"cooked whole chickpea": "__BATCH_OUTPUT__",
	"cooked whole chickpeas": "__BATCH_OUTPUT__",
	"chia pudding": "__BATCH_OUTPUT__",
	"chia_pudding": "__BATCH_OUTPUT__",
	"overnight oats": "__BATCH_OUTPUT__",
	"overnight_oat": "__BATCH_OUTPUT__",
	"herb yogurt sauce": "__BATCH_OUTPUT__",
	"herb yogurt dip": "__BATCH_OUTPUT__",
	"yogurt herb sauce": "__BATCH_OUTPUT__",
	"yogurt_herb_sauce": "__BATCH_OUTPUT__",
	"herb labneh spread": "__BATCH_OUTPUT__",
	"whipped labneh": "__BATCH_OUTPUT__",
	"whipped feta dip": "__BATCH_OUTPUT__",
	"whipped feta": "__BATCH_OUTPUT__",
	"miso tahini dip": "__BATCH_OUTPUT__",
	"toasted seeds & dukkah": "__BATCH_OUTPUT__",
	"tahini lemon dip": "__BATCH_OUTPUT__",
	"tahini lemon sauce": "__BATCH_OUTPUT__",
	"tahini_lemon_sauce": "__BATCH_OUTPUT__",
	"lemon tahini sauce": "__BATCH_OUTPUT__",
	"hummus with warm pita": "__BATCH_OUTPUT__",
	"hummus with sumac & dukkah": "__BATCH_OUTPUT__",
	"hummus with olive oil & sumac": "__BATCH_OUTPUT__",
	"hummus with sumac & olive oil": "__BATCH_OUTPUT__",
	"whipped feta with herbs & olive oil": "__BATCH_OUTPUT__",
	"whipped labneh with za'atar oil": "__BATCH_OUTPUT__",
	"pita chips": "__BATCH_OUTPUT__",
	"warm pita chips": "__BATCH_OUTPUT__",
	"flatbread chips": "__BATCH_OUTPUT__",
	"charred flatbread": "__BATCH_OUTPUT__",
	"warm flatbread": "__BATCH_OUTPUT__",
	"chickpea_cooked_whole": "__BATCH_OUTPUT__",
	"chickpea_crispy": "__BATCH_OUTPUT__",
	"chickpea_hummus": "__BATCH_OUTPUT__",
	"dough_cold_fermented": "__BATCH_OUTPUT__",
	"radish_quick_pickle": "__BATCH_OUTPUT__",
	// --- in-meal preparations of base ingredients (drop, household roasts/boils them) ---
	"roasted broccoli": "__DERIV_DROP__",
	"roasted cauliflower": "__DERIV_DROP__",
	"roasted carrot": "__DERIV_DROP__",
	"roasted beet": "__DERIV_DROP__",
	"soft-boiled egg": "__DERIV_DROP__",
	"soft boiled egg": "__DERIV_DROP__",
	"hard-boiled egg": "__DERIV_DROP__",
	"hard boiled egg": "__DERIV_DROP__",
	"scrambled egg": "__DERIV_DROP__",
	"poached egg": "__DERIV_DROP__",
	"sautéed shiitake": "__DERIV_DROP__",
	"sauteed shiitake": "__DERIV_DROP__",
	"charred tomato": "__DERIV_DROP__",
	// --- snack-box description strings ---
	"bell pepper & carrot sticks": "__SNACK_DESC__",
	"fresh mint & sumac": "__SNACK_DESC__",
	"sumac dust": "__SNACK_DESC__",
	"cucumber & apple slices": "__SNACK_DESC__",
	"carrot & cucumber ribbons": "__SNACK_DESC__",
	"cucumber slices": "__SNACK_DESC__",
	"roasted carrot & beet chips": "__SNACK_DESC__",
	"fresh herb pita": "__SNACK_DESC__",
	"sesame seed crackers": "__SNACK_DESC__",
	"olive tapenade": "__SNACK_DESC__",
	"cucumber sticks": "__SNACK_DESC__",
	"vegetable crudités": "__SNACK_DESC__",
	"crudités": "__SNACK_DESC__",
	"preserved lemon chunks": "preserved lemon",
	// --- household assumed-pantry items (drop unless explicitly marked) ---
	"olive oil": "__HOUSEHOLD_PANTRY__",
	"extra virgin olive oil": "__HOUSEHOLD_PANTRY__",
	"salt": "__HOUSEHOLD_PANTRY__",
	"kosher salt": "__HOUSEHOLD_PANTRY__",
	"flaky sea salt": "__HOUSEHOLD_PANTRY__",
	"sea salt": "__HOUSEHOLD_PANTRY__",
	"black pepper": "__HOUSEHOLD_PANTRY__",
	"freshly ground black pepper": "__HOUSEHOLD_PANTRY__",
	"vinegar": "__HOUSEHOLD_PANTRY__",
	"rice vinegar": "__HOUSEHOLD_PANTRY__",
	"white vinegar": "__HOUSEHOLD_PANTRY__",
	"tahini": "__HOUSEHOLD_PANTRY__",
	"yogurt": "__HOUSEHOLD_PANTRY__",
	"plain yogurt": "__HOUSEHOLD_PANTRY__",
	"greek yogurt": "__HOUSEHOLD_PANTRY__",
	"milk": "__HOUSEHOLD_PANTRY__",
	"all purpose flour": "__HOUSEHOLD_PANTRY__",
	"all-purpose flour": "__HOUSEHOLD_PANTRY__",
	"flour": "__HOUSEHOLD_PANTRY__",
	"rolled oats": "__HOUSEHOLD_PANTRY__",
	"oats": "__HOUSEHOLD_PANTRY__",
	"chia seed": "__HOUSEHOLD_PANTRY__",
	"chia seeds": "__HOUSEHOLD_PANTRY__",
	"preserved lemon": "__HOUSEHOLD_PANTRY__",
	"yeast": "__HOUSEHOLD_PANTRY__",
	"sugar": "__HOUSEHOLD_PANTRY__",
	"baking soda": "__HOUSEHOLD_PANTRY__",
	"baking powder": "__HOUSEHOLD_PANTRY__",
	"vanilla": "__HOUSEHOLD_PANTRY__",
	"vanilla extract": "__HOUSEHOLD_PANTRY__",
	"maple syrup": "__HOUSEHOLD_PANTRY__",
	"honey": "__HOUSEHOLD_PANTRY__",
	"hot honey": "hot honey",       // less common, keep
	// --- never buy ---
	"water": "__DROP__",
	"ice water": "__DROP__",
	"cold water": "__DROP__",
	"warm water": "__DROP__",
	"hot water": "__DROP__",
	"ice": "__DROP__",
};

// Name → category. Order matters: produce/herb match BEFORE dairy/grains
// because "fresh dill" must hit produce, not get caught by something else.
const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
	// FRUIT first (so "lemon zest", "pomegranate" etc. don't get caught by produce)
	{ pattern: /\b(berry|berries|peach|plum|apricot|nectarine|pear|apple|orange|grape|kiwi|pomegranate|mango|fig|date|melon|watermelon|raspberr|blackberr|blueberr|strawberr|cranberr|currant|passion fruit|persimmon|cherry$)\b/, category: "fruit" },
	{ pattern: /^lemon$|^lime$/, category: "fruit" },
	// HERBS + PRODUCE (broader catch — explicitly include cilantro/mint/parsley/basil/sage/dill/thyme that previously fell to "other")
	{ pattern: /\b(cilantro|mint|parsley|basil|sage|dill|thyme|oregano|rosemary|chive|chervil|tarragon|marjoram)\b/, category: "produce" },
	{ pattern: /\b(spinach|kale|chard|arugula|lettuce|romaine|cabbage|bok choy|cauliflower|broccoli|asparagus|zucchini|squash|eggplant|leek|fennel|celery|sweet potato|potato|corn|peas|sprout|greens|beet|turnip|parsnip|kohlrabi|rutabaga|jicama|daikon|napa|artichoke heart|artichoke|okra|edamame pod)\b/, category: "produce" },
	{ pattern: /\b(onion|shallot|garlic|ginger|scallion|chile|jalapeño|jalapeno|serrano|habanero|fresno|poblano|chipotle)\b/, category: "produce" },
	{ pattern: /\b(tomato|cucumber|radish|carrot|bell pepper|pepper|mushroom|shiitake|portobello|cremini|enoki|oyster mushroom|king oyster|maitake)\b/, category: "produce" },
	{ pattern: /\b(kimchi|olive)\b/, category: "produce" },  // refrigerated produce-ish
	// PROTEIN
	{ pattern: /\b(chickpea|lentil|tempeh|tofu|seitan|edamame|soybean|bean$|black bean|kidney bean|pinto bean|navy bean|cannellini|fava|lima bean|mung bean(?! sprout)|cooked beans?)\b/, category: "protein" },
	{ pattern: /\bblack bean patty\b/, category: "protein" },
	// DAIRY (eggs, cheeses, yogurts)
	{ pattern: /\b(yogurt|milk|cream|butter|labneh|ricotta|feta|cotija|mozzarella|parmesan|burrata|gruyere|cheddar|brie|goat cheese|halloumi|paneer)\b/, category: "dairy" },
	{ pattern: /^egg$|\beggs?\b/, category: "dairy" },
	// GRAINS
	{ pattern: /\b(rice|oat|quinoa|farro|barley|millet|buckwheat|noodle|pasta|spaghetti|linguine|fettuccine|penne|fusilli|farfalle|orecchiette|rigatoni|fideua|fideuá|couscous|bulgur|polenta|grits|bread|pita|tortilla|flatbread|bun|wrap|crouton|baguette|focaccia|naan|cracker)\b/, category: "grains" },
	// PANTRY (oils, vinegars, spices, sauces, seeds, nuts, sweeteners, dry goods)
	{ pattern: /\b(tahini|oil|vinegar|cumin|sumac|coriander|paprika|turmeric|cardamom|cinnamon|clove|nutmeg|fennel seed|allspice|mustard seed|fenugreek|harissa|miso|gochujang|fish sauce|soy sauce|tamari|sesame|nori|kombu|dashi|stock|broth|nut$|almond|cashew|peanut|hazelnut|walnut|pistachio|pecan|sunflower seed|pumpkin seed|honey|maple|sugar|syrup|spice|garam masala|chili powder|chili crisp|sake|mirin|tamarind|saffron|matcha|aonori|za'atar|za atar|dukkah|ras el hanout|salt|pepper|wine|baking|yeast|cornstarch|flour|chia|seed$|seeds$|cocoa|cacao|chocolate|coconut|coconut milk|panko|breadcrumb|capers|anchovy paste|hot sauce|sriracha)\b/, category: "pantry" },
];

const SHOP_RUN_ORDER = ["dairy", "protein", "grains", "pantry", "fruit", "produce"];
const PRODUCE_REFRESH_CATEGORIES = new Set(["produce", "fruit", "dairy"]);

export function buildShoppingListV2(options: {
	startDate: string;
	endDate: string;
	pantry: Set<string>;
	componentBatches: MisePlanComponentBatch[];
	formulaCatalog: MiseFormula[];
	mealsByDay: MisePlanDay[];
	breakfasts: MisePlanMeal[];
	snackBoxes: MiseSnackBox[];
	llmRawIngredients: ComposerRawIngredient[];
}): ShoppingResult {
	const {
		startDate,
		endDate,
		pantry,
		componentBatches,
		formulaCatalog,
		mealsByDay,
		breakfasts,
		snackBoxes,
		llmRawIngredients,
	} = options;

	// 1. Set of items produced by component batches → never buy
	const batchOutputs = new Set<string>();
	for (const batch of componentBatches) {
		batchOutputs.add(canonicalize(batch.label));
		const meta = batch.meta as Record<string, unknown> | undefined;
		const formula = (meta?.formula as MiseFormula | undefined);
		if (formula?.output_canonical_name) batchOutputs.add(canonicalize(formula.output_canonical_name));
	}

	// 2. Set of inputs already covered by claimed formulas → don't list raw inputs
	// the formula will buy through its own prep task. The exception is "core
	// pantry" items the household already has (handled by `pantry` Set).
	const formulaInputs = new Set<string>();
	for (const batch of componentBatches) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const formula = (meta?.formula as MiseFormula | undefined);
		if (!formula) continue;
		for (const input of formula.inputs) {
			formulaInputs.add(canonicalize(input.canonical_name));
		}
	}
	// Keep the cross-reference so we know which formula owns which input
	const formulaInputSources = new Map<string, string>();
	for (const batch of componentBatches) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const formula = (meta?.formula as MiseFormula | undefined);
		if (!formula) continue;
		for (const input of formula.inputs) {
			const key = canonicalize(input.canonical_name);
			if (!formulaInputSources.has(key)) formulaInputSources.set(key, batch.label);
		}
	}

	// 3. Aggregate
	const map = new Map<string, AggregatorEntry>();

	const add = (rawName: string, source: string, grams?: number | null, qty?: number | null, unit?: string | null) => {
		if (!rawName) return;
		const key = canonicalize(rawName);
		if (!key) return;
		// snake_case is a tell that the LLM emitted a component ID as a raw
		// ingredient (e.g. "chickpea_falafel_mix") — drop unconditionally.
		if (key.includes("_")) return;
		// drop pantry items the household already stocks
		if (pantry.has(key)) return;
		// sentinel routing
		if (key === "__snack_desc__") return;
		if (key === "__batch_output__") return;
		if (key === "__deriv_drop__") return;
		if (key === "__household_pantry__") return;
		if (key === "__drop__") return;
		// route lemon/lime derivatives to their fruit
		if (key === "__lemon_deriv__") {
			addLemonish("lemon", source, map);
			return;
		}
		if (key === "__lime_deriv__") {
			addLemonish("lime", source, map);
			return;
		}
		if (batchOutputs.has(key)) return;
		// drop formula-owned inputs (the formula's prep task handles them)
		if (formulaInputs.has(key)) return;

		let entry = map.get(key);
		if (!entry) {
			entry = {
				canonical: key,
				display: titleCase(key),
				source: new Set(),
				grams: 0,
				qty: null,
				unit: null,
				pieces: 0,
				categoryHint: categorize(key),
			};
			map.set(key, entry);
		}
		entry.source.add(source);
		if (grams && Number.isFinite(grams)) entry.grams += grams;
		if (qty !== null && qty !== undefined && Number.isFinite(qty) && unit) {
			if (entry.unit === null || entry.unit === unit) {
				entry.qty = (entry.qty || 0) + qty;
				entry.unit = unit;
			}
		}
		entry.pieces += 1;
	};

	// LLM raw_ingredients are the primary source for composer-driven plans
	for (const ing of llmRawIngredients) add(ing.name, "composer", ing.grams, ing.qty, ing.unit);
	// Meal ingredient_names (older deterministic path)
	for (const meal of [...mealsByDay.flatMap(d => d.meals), ...breakfasts]) {
		for (const name of meal.ingredient_names) add(name, meal.title);
	}
	// Snack box raw_ingredients (NOT items[] — those are description strings)
	for (const box of snackBoxes) {
		for (const ing of box.raw_ingredients || []) add(ing.name, box.title, ing.grams, ing.qty, ing.unit);
	}

	// 4. Build sections
	const sectionMap = new Map<string, MiseShoppingListItem[]>();
	for (const entry of map.values()) {
		const item: MiseShoppingListItem = {
			name: entry.display,
			quantity: entry.qty,
			unit: entry.unit,
			source: Array.from(entry.source).sort(),
			...(entry.grams ? { grams_total: Math.ceil(entry.grams * 1.1) } : {}),
		};
		const cat = entry.categoryHint || "pantry";
		if (!sectionMap.has(cat)) sectionMap.set(cat, []);
		sectionMap.get(cat)!.push(item);
	}
	const sections: MiseShoppingListSection[] = Array.from(sectionMap.entries())
		.sort((a, b) => SHOP_RUN_ORDER.indexOf(a[0]) - SHOP_RUN_ORDER.indexOf(b[0]))
		.map(([category, items]) => ({
			category,
			items: items.sort((x, y) => x.name.localeCompare(y.name)),
		}));

	// 5. Shop runs — dynamic scheduler driven by per-item freshness windows.
	const runs = buildShopRuns(startDate, endDate, sections, {
		mealsByDay,
		breakfasts,
		snackBoxes,
		componentBatches,
	});

	// debug — verifies the deployed code is current
	const probe: Record<string, string> = {};
	for (const t of ["Fresh Mint", "fresh mint", "Mint", "Almond Slivers", "Pomegranate Arils", "Cilantro", "Feta Cheese", "Feta", "Burger Buns"]) {
		const k = canonicalize(t);
		probe[t] = `canon=${JSON.stringify(k)} cat=${categorize(k)}`;
	}

	return { sections, runs, debug: probe };
}

function addLemonish(fruit: string, source: string, map: Map<string, AggregatorEntry>): void {
	let entry = map.get(fruit);
	if (!entry) {
		entry = {
			canonical: fruit,
			display: titleCase(fruit),
			source: new Set(),
			grams: 0,
			qty: 0,
			unit: "piece",
			pieces: 0,
			categoryHint: "fruit",
		};
		map.set(fruit, entry);
	}
	entry.source.add(source);
	entry.pieces += 1;
	entry.qty = Math.ceil(entry.pieces / 2);  // 2 zest/juice uses per fruit
}

interface BuildShopRunsParts {
	mealsByDay: MisePlanDay[];
	breakfasts: MisePlanMeal[];
	snackBoxes: MiseSnackBox[];
	componentBatches: MisePlanComponentBatch[];
}

/**
 * Replaces the legacy hardcoded "day 0 + day 7" pattern with the dynamic
 * scheduler. The scheduler derives a (earliest_purchase, latest_purchase)
 * window for every item from its first must_have_by date minus its shelf
 * life, then bin-packs items into household-available shop slots.
 */
function buildShopRuns(
	startDate: string,
	endDate: string,
	sections: MiseShoppingListSection[],
	parts: BuildShopRunsParts,
	prefs: HouseholdShopPreferences = DEFAULT_HOUSEHOLD_PREFS,
): ShoppingRun[] {
	if (sections.length === 0) return [];
	const windows = computeItemWindowsFromParts({
		startDate,
		mealsByDay: parts.mealsByDay,
		breakfasts: parts.breakfasts,
		snackBoxes: parts.snackBoxes,
		componentBatches: parts.componentBatches,
		sections,
	});
	// Normalize the end date — if the plan ends before any meal, fall back to
	// startDate + 7 so the scheduler still has a sweep window.
	const sweepEnd = endDate < startDate ? startDate : endDate;
	return computeRuns(startDate, sweepEnd, windows, prefs);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function canonicalize(rawName: string): string {
	const n = (rawName || "").toLowerCase().trim().replace(/\s+/g, " ");
	if (!n) return "";
	if (ALIAS_TABLE[n]) return ALIAS_TABLE[n].toLowerCase();
	// Crude singularizer: "X tomatoes" → "X tomato", "X olives" → "X olive"
	if (n.endsWith("oes")) return n.slice(0, -2);
	if (n.endsWith("ies") && n.length > 4) return n.slice(0, -3) + "y";
	if (n.endsWith("ves") && n.length > 4) return n.slice(0, -3) + "f";
	if (n.endsWith("ches")) return n.slice(0, -2);
	if (n.endsWith("shes")) return n.slice(0, -2);
	if (n.endsWith("s") && !n.endsWith("ss") && !n.endsWith("us") && !n.endsWith("is") && n.length > 3) {
		return n.slice(0, -1);
	}
	return n;
}

function categorize(canonical: string): string {
	for (const rule of CATEGORY_RULES) {
		if (rule.pattern.test(canonical)) return rule.category;
	}
	return "pantry";
}

function titleCase(s: string): string {
	return s.split(" ").map(w => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

function addDays(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000) + 1;
}

function formatDate(iso: string): string {
	const d = new Date(iso + "T00:00:00Z");
	const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()];
	return `${dow} ${iso}`;
}
