/**
 * Format Library Seed
 *
 * Adds 18 hand-authored format templates to the `composition_templates` table.
 * The existing 7 format templates (bowl, curry, pasta, salad, soup, stir_fry,
 * taco) were corpus-mined from a recipe dataset; these 18 are AUTHORED to
 * supply chef-grade cuisine variants where the corpus is sparse — e.g. "Korean
 * burger" gets gochujang aioli + kimchi, "Thai pizza" gets makrut + coconut +
 * chili, etc.
 *
 * Each template carries the same JSON shape as the corpus rows:
 *   - slots_json:        Array<{ name, required, min, max }>
 *   - variant_sets_json: Array<{
 *       cuisine, label, recipe_count,
 *       slots: Record<slotName, Array<{ name, frequency, count }>>
 *     }>
 *
 * Frequencies are RELATIVE prominence within the variant (0-1 floats):
 *   1.0 = essential, 0.7-0.85 = core, 0.5 = common, 0.3 = often-optional.
 *
 * `recipe_count` is 0 because these are authored, not mined.
 *
 * Structural sources cited per format below — slots derive from canonical
 * cookbook anatomy for that dish family, not invented per-variant.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Format → structural source
 * ─────────────────────────────────────────────────────────────────────────
 * burger          — Heston Blumenthal "In Search of Perfection: Hamburger";
 *                   Kenji López-Alt "The Food Lab" burger anatomy chapter.
 * sandwich        — Jenn Louis "The Book of Greens"; James Beard "American
 *                   Cookery" sandwich grammar (bread/filling/sauce/veg).
 * pizza           — Roberta's pizza book; The Pizza Bible (Tony Gemignani):
 *                   dough+sauce+cheese+topping+finish.
 * flatbread       — Mourad Lahlou "Mourad: New Moroccan"; Yotam Ottolenghi
 *                   "Jerusalem" — manakish/lahmacun/naan grammar.
 * fritter         — Madhur Jaffrey "World Vegetarian"; Joyce Chen for
 *                   binder+primary+seasoning+dip anatomy.
 * frittata        — Marcella Hazan "Essentials of Classic Italian Cooking";
 *                   eggs as set custard with veg+aromatic+cheese+finish.
 * dumpling        — Andrea Nguyen "Asian Dumplings"; Helen You "The Dumpling
 *                   Galaxy Cookbook" — wrapper+filling+seasoning+dipping.
 * hot_pot         — Fuchsia Dunlop "Land of Plenty"; communal broth+protein+
 *                   vegetables+starch+dipping anatomy.
 * donburi         — Tadashi Ono / Harris Salat "Japanese Hot Pots & Donburi";
 *                   rice + topping + sauce + garnish.
 * mezze_plate     — Greg Malouf "Saraban"; Yotam Ottolenghi "Plenty More" —
 *                   dips + bread + pickles + salads + small protein.
 * tagine          — Paula Wolfert "The Food of Morocco"; protein +
 *                   vegetables + spice + aromatic + finish.
 * paella          — José Andrés "Tapas"; Penelope Casas "Foods and Wines of
 *                   Spain" — rice + broth + protein + veg + aromatic.
 * risotto         — Marcella Hazan; The Silver Spoon — rice + broth +
 *                   aromatic (soffritto) + additions + mantecatura finish.
 * gratin          — Julia Child "Mastering the Art of French Cooking" —
 *                   base + bechamel/cream + cheese + aromatic + topping.
 * sopes           — Diana Kennedy "The Cuisines of Mexico"; masa + bean +
 *                   protein + salsa + garnish.
 * banh_mi         — Andrea Nguyen "The Banh Mi Handbook"; baguette + pâté/
 *                   spread + protein + pickle + herb + heat.
 * tostada         — Diana Kennedy; Pati Jinich — tortilla + bean + protein +
 *                   salsa + garnish.
 * galette         — David Tanis "A Platter of Figs"; Tartine — dough +
 *                   filling + aromatic + cheese/richness + finish.
 * ─────────────────────────────────────────────────────────────────────────
 */

// ---------- Types (shape that goes into JSON columns) ----------

interface SeedSlot {
	name: string;
	required: boolean;
	min: number;
	max: number;
}

interface SeedVariantIngredient {
	name: string;
	frequency: number; // 0-1
	count: number;     // 0 (authored, not mined)
}

interface SeedVariantSet {
	cuisine: string;
	label: string;
	recipe_count: number; // 0 (authored)
	slots: Record<string, SeedVariantIngredient[]>;
}

interface SeedTemplate {
	name: string;
	slots: SeedSlot[];
	variant_sets: SeedVariantSet[];
}

// ---------- Helpers ----------

const ing = (name: string, frequency: number): SeedVariantIngredient => ({
	name,
	frequency,
	count: 0,
});

const slot = (name: string, required: boolean, min: number, max: number): SeedSlot => ({
	name,
	required,
	min,
	max,
});

// ============================================================================
// 1. BURGER
// ============================================================================
const BURGER: SeedTemplate = {
	name: "burger",
	slots: [
		slot("bun", true, 1, 1),
		slot("patty", true, 1, 1),
		slot("sauce/spread", true, 1, 1),
		slot("vegetable", true, 1, 3),
		slot("pickle", false, 0, 1),
		slot("cheese", false, 0, 1),
		slot("crunch", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "american",
			label: "American Classic Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("brioche bun", 1.0)],
				"patty": [ing("beef patty", 0.7), ing("black bean patty", 0.3)],
				"sauce/spread": [ing("special sauce", 0.6), ing("ranch", 0.4)],
				"vegetable": [ing("iceberg lettuce", 0.85), ing("tomato", 0.85), ing("red onion", 0.6)],
				"pickle": [ing("dill pickle", 0.85)],
				"cheese": [ing("american cheese", 0.7), ing("cheddar", 0.4)],
			},
		},
		{
			cuisine: "korean",
			label: "Korean Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("brioche bun", 1.0)],
				"patty": [ing("bulgogi-style tofu", 0.7), ing("marinated mushroom", 0.3)],
				"sauce/spread": [ing("gochujang aioli", 1.0)],
				"vegetable": [ing("kimchi", 0.85), ing("scallion", 0.6), ing("butter lettuce", 0.4)],
				"pickle": [ing("daikon pickle", 0.5)],
				"crunch": [ing("toasted sesame seeds", 0.7)],
			},
		},
		{
			cuisine: "indian",
			label: "Indian Pav Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("pav bun", 1.0)],
				"patty": [ing("chana patty", 0.6), ing("spiced lentil patty", 0.4)],
				"sauce/spread": [ing("mint chutney", 0.85), ing("tamarind chutney", 0.7)],
				"vegetable": [ing("cucumber", 0.6), ing("red onion", 0.6), ing("tomato", 0.4)],
				"pickle": [ing("raita", 0.5)],
				"crunch": [ing("fresh green chili", 0.7), ing("sev", 0.4)],
			},
		},
		{
			cuisine: "mediterranean",
			label: "Mediterranean Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("focaccia bun", 0.7), ing("sesame bun", 0.3)],
				"patty": [ing("falafel patty", 0.6), ing("lentil patty", 0.4)],
				"sauce/spread": [ing("lemon tahini sauce", 1.0)],
				"vegetable": [ing("arugula", 0.7), ing("tomato", 0.7), ing("cucumber", 0.5)],
				"pickle": [ing("pickled red onion", 0.7)],
				"cheese": [ing("feta", 0.6)],
			},
		},
		{
			cuisine: "mexican",
			label: "Mexican Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("brioche bun", 0.7), ing("telera roll", 0.3)],
				"patty": [ing("chorizo-spiced bean patty", 0.6), ing("black bean patty", 0.4)],
				"sauce/spread": [ing("chipotle crema", 1.0)],
				"vegetable": [ing("guacamole", 0.85), ing("shredded lettuce", 0.5), ing("tomato", 0.4)],
				"pickle": [ing("pickled jalapeño", 0.85)],
				"cheese": [ing("queso fresco", 0.6)],
			},
		},
		{
			cuisine: "japanese",
			label: "Japanese Burger",
			recipe_count: 0,
			slots: {
				"bun": [ing("brioche bun", 1.0)],
				"patty": [ing("teriyaki tofu patty", 0.6), ing("shiitake mushroom patty", 0.4)],
				"sauce/spread": [ing("kewpie mayo", 0.85), ing("soy glaze", 0.7)],
				"vegetable": [ing("butter lettuce", 0.6), ing("nori sheet", 0.5), ing("shiso leaf", 0.3)],
				"pickle": [ing("daikon pickle", 0.7)],
				"crunch": [ing("toasted sesame seeds", 0.6)],
			},
		},
	],
};

// ============================================================================
// 2. SANDWICH
// ============================================================================
const SANDWICH: SeedTemplate = {
	name: "sandwich",
	slots: [
		slot("bread", true, 1, 1),
		slot("filling", true, 1, 2),
		slot("sauce/spread", true, 1, 1),
		slot("vegetable", false, 0, 3),
		slot("cheese", false, 0, 1),
		slot("pickle", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "vietnamese",
			label: "Banh Mi",
			recipe_count: 0,
			slots: {
				"bread": [ing("vietnamese baguette", 1.0)],
				"filling": [ing("marinated tofu", 0.5), ing("lemongrass seitan", 0.3), ing("pâté", 0.2)],
				"sauce/spread": [ing("kewpie mayo", 0.85), ing("maggi seasoning", 0.7)],
				"vegetable": [ing("cilantro", 0.95), ing("cucumber", 0.85), ing("pickled daikon-carrot", 0.95)],
				"pickle": [ing("fresh jalapeño", 0.7)],
			},
		},
		{
			cuisine: "cuban",
			label: "Cubano",
			recipe_count: 0,
			slots: {
				"bread": [ing("cuban bread", 1.0)],
				"filling": [ing("mojo-roasted jackfruit", 0.5), ing("mojo seitan", 0.5)],
				"sauce/spread": [ing("yellow mustard", 0.85), ing("mayonnaise", 0.5)],
				"cheese": [ing("swiss cheese", 1.0)],
				"pickle": [ing("dill pickle", 1.0)],
			},
		},
		{
			cuisine: "italian",
			label: "Italian Grinder",
			recipe_count: 0,
			slots: {
				"bread": [ing("ciabatta", 0.7), ing("italian sub roll", 0.3)],
				"filling": [ing("fresh mozzarella", 0.6), ing("roasted vegetables", 0.6), ing("marinated artichoke", 0.4)],
				"sauce/spread": [ing("olive tapenade", 0.7), ing("herbed olive oil", 0.5)],
				"vegetable": [ing("arugula", 0.7), ing("tomato", 0.7), ing("pepperoncini", 0.6)],
			},
		},
		{
			cuisine: "american",
			label: "Smashburger Melt",
			recipe_count: 0,
			slots: {
				"bread": [ing("brioche", 0.5), ing("sourdough", 0.5)],
				"filling": [ing("smashed bean patty", 0.5), ing("smashed mushroom patty", 0.5)],
				"sauce/spread": [ing("dijonnaise", 1.0)],
				"vegetable": [ing("caramelized onion", 0.85)],
				"cheese": [ing("swiss cheese", 0.7), ing("gruyère", 0.3)],
			},
		},
		{
			cuisine: "levantine",
			label: "Egg Salad Levantine",
			recipe_count: 0,
			slots: {
				"bread": [ing("pita", 1.0)],
				"filling": [ing("herbed egg salad", 1.0)],
				"sauce/spread": [ing("labneh", 0.85)],
				"vegetable": [ing("cucumber", 0.7), ing("sumac onion", 0.7)],
				"pickle": [ing("dukkah", 0.7)],
			},
		},
	],
};

// ============================================================================
// 3. PIZZA
// ============================================================================
const PIZZA: SeedTemplate = {
	name: "pizza",
	slots: [
		slot("dough", true, 1, 1),
		slot("sauce", true, 1, 1),
		slot("cheese", true, 0, 2),
		slot("topping", true, 1, 4),
		slot("finish", false, 0, 3),
	],
	variant_sets: [
		{
			cuisine: "italian",
			label: "Neapolitan Classic",
			recipe_count: 0,
			slots: {
				"dough": [ing("00 flour dough", 1.0)],
				"sauce": [ing("san marzano tomato sauce", 1.0)],
				"cheese": [ing("fresh mozzarella di bufala", 1.0)],
				"topping": [ing("fresh basil", 0.95)],
				"finish": [ing("extra virgin olive oil", 0.95), ing("flaky sea salt", 0.5)],
			},
		},
		{
			cuisine: "american",
			label: "New York Classic",
			recipe_count: 0,
			slots: {
				"dough": [ing("high-gluten dough", 1.0)],
				"sauce": [ing("marinara", 1.0)],
				"cheese": [ing("low-moisture mozzarella", 1.0)],
				"topping": [ing("dried oregano", 0.7)],
				"finish": [ing("chili flakes", 0.85), ing("grated parmesan", 0.5)],
			},
		},
		{
			cuisine: "italian_white",
			label: "White Pie",
			recipe_count: 0,
			slots: {
				"dough": [ing("cold-fermented dough", 1.0)],
				"sauce": [ing("ricotta-cream base", 1.0)],
				"cheese": [ing("low-moisture mozzarella", 0.85), ing("parmesan", 0.7)],
				"topping": [ing("garlic", 0.85), ing("lemon zest", 0.6)],
				"finish": [ing("arugula", 0.7), ing("black pepper", 0.5)],
			},
		},
		{
			cuisine: "korean",
			label: "Korean Kimchi Pizza",
			recipe_count: 0,
			slots: {
				"dough": [ing("pizza dough", 1.0)],
				"sauce": [ing("gochujang sauce", 1.0)],
				"cheese": [ing("low-moisture mozzarella", 0.85)],
				"topping": [ing("kimchi", 1.0), ing("scallion", 0.85), ing("corn", 0.5)],
				"finish": [ing("toasted sesame oil", 0.85), ing("toasted sesame seeds", 0.5)],
			},
		},
		{
			cuisine: "mexican",
			label: "Mexican Spiced Chickpea Pizza",
			recipe_count: 0,
			slots: {
				"dough": [ing("pizza dough", 1.0)],
				"sauce": [ing("salsa roja", 1.0)],
				"cheese": [ing("oaxaca cheese", 0.85)],
				"topping": [ing("spiced chickpeas", 0.7), ing("charred corn", 0.7), ing("pickled jalapeño", 0.6)],
				"finish": [ing("cilantro", 0.85), ing("lime crema", 0.7)],
			},
		},
		{
			cuisine: "mediterranean",
			label: "Mediterranean Pizza",
			recipe_count: 0,
			slots: {
				"dough": [ing("pizza dough", 1.0)],
				"sauce": [ing("herbed olive oil", 1.0)],
				"cheese": [ing("feta", 0.85), ing("low-moisture mozzarella", 0.5)],
				"topping": [ing("kalamata olives", 0.85), ing("cherry tomato", 0.7), ing("red onion", 0.5), ing("dried oregano", 0.5)],
				"finish": [ing("lemon zest", 0.7), ing("fresh oregano", 0.4)],
			},
		},
	],
};

// ============================================================================
// 4. FLATBREAD
// ============================================================================
const FLATBREAD: SeedTemplate = {
	name: "flatbread",
	slots: [
		slot("bread", true, 1, 1),
		slot("spread/sauce", true, 1, 1),
		slot("topping", true, 2, 4),
		slot("finish", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "levantine",
			label: "Levantine Manakish",
			recipe_count: 0,
			slots: {
				"bread": [ing("manakish flatbread", 1.0)],
				"spread/sauce": [ing("za'atar oil", 1.0)],
				"topping": [ing("labneh", 0.85), ing("cherry tomato", 0.7), ing("cucumber", 0.5)],
				"finish": [ing("fresh mint", 0.7), ing("lemon juice", 0.5)],
			},
		},
		{
			cuisine: "indian",
			label: "Indian Naan Chutney",
			recipe_count: 0,
			slots: {
				"bread": [ing("garlic naan", 1.0)],
				"spread/sauce": [ing("mint-cilantro chutney", 1.0)],
				"topping": [ing("paneer", 0.7), ing("roasted vegetables", 0.7), ing("pickled onion", 0.5)],
				"finish": [ing("sev", 0.6)],
			},
		},
		{
			cuisine: "greek",
			label: "Greek Lahmajun-Style",
			recipe_count: 0,
			slots: {
				"bread": [ing("thin flatbread", 1.0)],
				"spread/sauce": [ing("herbed yogurt", 1.0)],
				"topping": [ing("kalamata olives", 0.85), ing("feta", 0.85), ing("tomato", 0.6), ing("arugula", 0.5)],
				"finish": [ing("lemon juice", 0.85)],
			},
		},
		{
			cuisine: "mexican",
			label: "Mexican Tostada-Style Flatbread",
			recipe_count: 0,
			slots: {
				"bread": [ing("charred flatbread", 1.0)],
				"spread/sauce": [ing("refried bean spread", 1.0)],
				"topping": [ing("queso fresco", 0.85), ing("crema", 0.7), ing("radish", 0.5), ing("shredded cabbage", 0.5)],
				"finish": [ing("cilantro and lime", 0.85)],
			},
		},
		{
			cuisine: "california",
			label: "California Fusion Flatbread",
			recipe_count: 0,
			slots: {
				"bread": [ing("sourdough flatbread", 1.0)],
				"spread/sauce": [ing("lemon-tahini base", 1.0)],
				"topping": [ing("roasted asparagus", 0.7), ing("chickpea", 0.7), ing("ricotta", 0.5)],
				"finish": [ing("herb oil with chili flake", 0.85)],
			},
		},
	],
};

// ============================================================================
// 5. FRITTER
// ============================================================================
const FRITTER: SeedTemplate = {
	name: "fritter",
	slots: [
		slot("binder", true, 1, 1),
		slot("primary_ingredient", true, 1, 2),
		slot("seasoning", true, 1, 3),
		slot("dipping_sauce", true, 1, 1),
		slot("garnish", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "jewish",
			label: "Latke",
			recipe_count: 0,
			slots: {
				"binder": [ing("potato-egg binder", 1.0)],
				"primary_ingredient": [ing("russet potato", 1.0), ing("yellow onion", 0.7)],
				"seasoning": [ing("kosher salt", 1.0), ing("black pepper", 0.7)],
				"dipping_sauce": [ing("applesauce", 0.85), ing("sour cream", 0.85)],
				"garnish": [ing("chive", 0.4)],
			},
		},
		{
			cuisine: "indian",
			label: "Pakora",
			recipe_count: 0,
			slots: {
				"binder": [ing("chickpea-flour batter", 1.0)],
				"primary_ingredient": [ing("yellow onion", 0.6), ing("spinach", 0.5), ing("potato", 0.5)],
				"seasoning": [ing("cumin seed", 0.85), ing("ajwain", 0.7), ing("green chili", 0.7)],
				"dipping_sauce": [ing("cilantro chutney", 0.85), ing("tamarind chutney", 0.7)],
			},
		},
		{
			cuisine: "thai",
			label: "Thai Corn Fritter",
			recipe_count: 0,
			slots: {
				"binder": [ing("rice-flour batter", 1.0)],
				"primary_ingredient": [ing("sweet corn", 1.0), ing("scallion", 0.7)],
				"seasoning": [ing("makrut lime leaf", 0.85), ing("red curry paste", 0.85)],
				"dipping_sauce": [ing("sweet chili sauce", 1.0)],
				"garnish": [ing("cilantro", 0.5)],
			},
		},
		{
			cuisine: "korean",
			label: "Jeon",
			recipe_count: 0,
			slots: {
				"binder": [ing("rice-flour batter", 1.0)],
				"primary_ingredient": [ing("kimchi", 0.5), ing("scallion", 0.5), ing("zucchini", 0.4)],
				"seasoning": [ing("gochugaru", 0.7), ing("soy sauce", 0.7)],
				"dipping_sauce": [ing("soy-vinegar dipping sauce", 1.0)],
			},
		},
		{
			cuisine: "levantine",
			label: "Kibbeh-Style Fritter",
			recipe_count: 0,
			slots: {
				"binder": [ing("bulgur-chickpea binder", 1.0)],
				"primary_ingredient": [ing("toasted walnut", 0.85), ing("cooked chickpea", 0.5)],
				"seasoning": [ing("allspice", 0.85), ing("cinnamon", 0.7), ing("sumac", 0.5)],
				"dipping_sauce": [ing("lemon-tahini sauce", 1.0)],
				"garnish": [ing("parsley", 0.5)],
			},
		},
		{
			cuisine: "japanese",
			label: "Okonomiyaki",
			recipe_count: 0,
			slots: {
				"binder": [ing("wheat-flour-dashi batter", 1.0)],
				"primary_ingredient": [ing("napa cabbage", 1.0), ing("scallion", 0.85), ing("corn", 0.4)],
				"seasoning": [ing("kosher salt", 0.7), ing("black pepper", 0.5)],
				"dipping_sauce": [ing("kewpie mayo and okonomiyaki sauce", 1.0)],
				"garnish": [ing("bonito flakes and aonori", 0.85)],
			},
		},
	],
};

// ============================================================================
// 6. FRITTATA
// ============================================================================
const FRITTATA: SeedTemplate = {
	name: "frittata",
	slots: [
		slot("egg_base", true, 1, 1),
		slot("vegetable", true, 1, 3),
		slot("cheese", false, 0, 1),
		slot("aromatic", true, 1, 1),
		slot("finish", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "italian",
			label: "Italian Classic Frittata",
			recipe_count: 0,
			slots: {
				"egg_base": [ing("8-egg base", 1.0)],
				"vegetable": [ing("asparagus", 0.7), ing("leek", 0.5)],
				"cheese": [ing("parmesan", 0.7), ing("ricotta", 0.5)],
				"aromatic": [ing("garlic", 0.85), ing("fresh basil", 0.7)],
				"finish": [ing("lemon zest", 0.6)],
			},
		},
		{
			cuisine: "mediterranean",
			label: "Mediterranean Frittata",
			recipe_count: 0,
			slots: {
				"egg_base": [ing("8-egg base", 1.0)],
				"vegetable": [ing("kalamata olives", 0.85), ing("cherry tomato", 0.85), ing("baby spinach", 0.7)],
				"cheese": [ing("feta", 1.0)],
				"aromatic": [ing("garlic", 0.85), ing("dried oregano", 0.7)],
				"finish": [ing("fresh mint and lemon", 0.7)],
			},
		},
		{
			cuisine: "mexican",
			label: "Mexican Migas Frittata",
			recipe_count: 0,
			slots: {
				"egg_base": [ing("8-egg base", 1.0)],
				"vegetable": [ing("charred corn", 0.85), ing("bell pepper", 0.7), ing("cilantro", 0.7)],
				"cheese": [ing("queso fresco", 0.85)],
				"aromatic": [ing("jalapeño", 0.85), ing("cumin", 0.7)],
				"finish": [ing("salsa verde", 0.85)],
			},
		},
		{
			cuisine: "french",
			label: "French Omelette-Style Frittata",
			recipe_count: 0,
			slots: {
				"egg_base": [ing("3-egg base", 1.0)],
				"vegetable": [ing("cremini mushroom", 0.85), ing("fresh tarragon", 0.5)],
				"cheese": [ing("gruyère", 0.85)],
				"aromatic": [ing("shallot", 1.0)],
				"finish": [ing("fresh chive and parsley", 0.7)],
			},
		},
	],
};

// ============================================================================
// 7. DUMPLING
// ============================================================================
const DUMPLING: SeedTemplate = {
	name: "dumpling",
	slots: [
		slot("wrapper", true, 1, 1),
		slot("filling", true, 1, 2),
		slot("seasoning", true, 1, 3),
		slot("dipping_sauce", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "chinese",
			label: "Jiaozi",
			recipe_count: 0,
			slots: {
				"wrapper": [ing("thin wheat wrapper", 1.0)],
				"filling": [ing("napa cabbage", 0.85), ing("firm tofu", 0.5), ing("shiitake mushroom", 0.4)],
				"seasoning": [ing("ginger", 0.85), ing("scallion", 0.85), ing("soy sauce", 0.7)],
				"dipping_sauce": [ing("black vinegar with chili oil", 1.0)],
			},
		},
		{
			cuisine: "japanese",
			label: "Gyoza",
			recipe_count: 0,
			slots: {
				"wrapper": [ing("round thin gyoza wrapper", 1.0)],
				"filling": [ing("napa cabbage", 0.85), ing("garlic chive", 0.7), ing("firm tofu", 0.5)],
				"seasoning": [ing("ginger", 0.85), ing("toasted sesame oil", 0.7)],
				"dipping_sauce": [ing("soy-vinegar with chili oil", 1.0)],
			},
		},
		{
			cuisine: "korean",
			label: "Mandu",
			recipe_count: 0,
			slots: {
				"wrapper": [ing("mandu wrapper", 1.0)],
				"filling": [ing("kimchi", 0.85), ing("firm tofu", 0.7), ing("glass noodle", 0.5)],
				"seasoning": [ing("toasted sesame oil", 0.85), ing("scallion", 0.7)],
				"dipping_sauce": [ing("soy-vinegar dipping sauce", 1.0)],
			},
		},
		{
			cuisine: "polish",
			label: "Pierogi",
			recipe_count: 0,
			slots: {
				"wrapper": [ing("tender egg dough", 1.0)],
				"filling": [ing("mashed potato", 0.85), ing("yellow onion", 0.7), ing("farmer's cheese", 0.5)],
				"seasoning": [ing("white pepper", 0.7), ing("butter", 0.85)],
				"dipping_sauce": [ing("sour cream with chive", 1.0)],
			},
		},
		{
			cuisine: "italian",
			label: "Ravioli",
			recipe_count: 0,
			slots: {
				"wrapper": [ing("fresh pasta dough", 1.0)],
				"filling": [ing("ricotta", 0.6), ing("baby spinach", 0.5), ing("butternut squash", 0.4)],
				"seasoning": [ing("nutmeg", 0.7), ing("black pepper", 0.7), ing("fresh sage", 0.5)],
				"dipping_sauce": [ing("brown butter and sage", 1.0)],
			},
		},
	],
};

// ============================================================================
// 8. HOT_POT
// ============================================================================
const HOT_POT: SeedTemplate = {
	name: "hot_pot",
	slots: [
		slot("broth", true, 1, 1),
		slot("protein", true, 1, 2),
		slot("vegetable", true, 3, 6),
		slot("grain_or_starch", false, 0, 1),
		slot("dipping_sauce", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "chinese",
			label: "Szechuan Hot Pot",
			recipe_count: 0,
			slots: {
				"broth": [ing("szechuan chili broth", 1.0)],
				"protein": [ing("firm tofu", 0.85), ing("shiitake mushroom", 0.7)],
				"vegetable": [ing("baby bok choy", 0.85), ing("napa cabbage", 0.85), ing("lotus root", 0.7), ing("enoki mushroom", 0.7), ing("tofu skin", 0.5)],
				"grain_or_starch": [ing("glass noodle", 0.85)],
				"dipping_sauce": [ing("toasted sesame paste with scallion and chili oil", 1.0)],
			},
		},
		{
			cuisine: "japanese",
			label: "Shabu Shabu",
			recipe_count: 0,
			slots: {
				"broth": [ing("kombu dashi", 1.0)],
				"protein": [ing("thinly sliced tofu", 0.7), ing("seitan slices", 0.4)],
				"vegetable": [ing("napa cabbage", 0.85), ing("watercress", 0.7), ing("shiitake mushroom", 0.7), ing("carrot", 0.5)],
				"grain_or_starch": [ing("udon noodle", 0.85)],
				"dipping_sauce": [ing("ponzu and toasted sesame", 1.0)],
			},
		},
		{
			cuisine: "korean",
			label: "Jeongol",
			recipe_count: 0,
			slots: {
				"broth": [ing("anchovy-kombu broth", 1.0)],
				"protein": [ing("fermented tofu", 0.7), ing("plant-based spam", 0.4)],
				"vegetable": [ing("kimchi", 1.0), ing("scallion", 0.85), ing("korean radish", 0.7), ing("shiitake mushroom", 0.6)],
				"grain_or_starch": [ing("glass noodle", 0.85)],
				"dipping_sauce": [ing("ssamjang with toasted sesame oil", 1.0)],
			},
		},
		{
			cuisine: "thai",
			label: "Thai Tom Kha Hot Pot",
			recipe_count: 0,
			slots: {
				"broth": [ing("coconut-galangal broth", 1.0)],
				"protein": [ing("oyster mushroom", 0.7), ing("firm tofu", 0.7)],
				"vegetable": [ing("straw mushroom", 0.85), ing("baby bok choy", 0.7), ing("lemongrass", 0.7), ing("makrut lime leaf", 0.7)],
				"grain_or_starch": [ing("jasmine rice", 0.7)],
				"dipping_sauce": [ing("sweet chili sauce", 1.0)],
			},
		},
	],
};

// ============================================================================
// 9. DONBURI
// ============================================================================
const DONBURI: SeedTemplate = {
	name: "donburi",
	slots: [
		slot("rice", true, 1, 1),
		slot("topping", true, 1, 2),
		slot("sauce", true, 1, 1),
		slot("garnish", true, 1, 3),
	],
	variant_sets: [
		{
			cuisine: "japanese_oyakodon",
			label: "Oyakodon",
			recipe_count: 0,
			slots: {
				"rice": [ing("short-grain rice", 1.0)],
				"topping": [ing("simmered yellow onion", 0.85), ing("soft-cooked egg", 1.0), ing("silken tofu", 0.5)],
				"sauce": [ing("soy-mirin-dashi sauce", 1.0)],
				"garnish": [ing("scallion", 0.85), ing("nori shreds", 0.7)],
			},
		},
		{
			cuisine: "japanese_katsudon",
			label: "Katsudon",
			recipe_count: 0,
			slots: {
				"rice": [ing("short-grain rice", 1.0)],
				"topping": [ing("panko-fried tofu cutlet", 0.7), ing("seitan cutlet", 0.4)],
				"sauce": [ing("soy-mirin-dashi-onion sauce", 1.0)],
				"garnish": [ing("nori", 0.7), ing("toasted sesame seeds", 0.6)],
			},
		},
		{
			cuisine: "japanese_butadon",
			label: "Butadon",
			recipe_count: 0,
			slots: {
				"rice": [ing("short-grain rice", 1.0)],
				"topping": [ing("soy-glazed king trumpet mushroom", 1.0)],
				"sauce": [ing("ginger-soy sauce", 1.0)],
				"garnish": [ing("scallion", 0.85), ing("benishoga", 0.4)],
			},
		},
		{
			cuisine: "mexican",
			label: "Mexican-Inspired Donburi",
			recipe_count: 0,
			slots: {
				"rice": [ing("cilantro-lime rice", 1.0)],
				"topping": [ing("black bean", 0.85), ing("roasted vegetable", 0.7)],
				"sauce": [ing("salsa verde", 1.0)],
				"garnish": [ing("queso fresco", 0.7), ing("lime", 0.7), ing("cilantro", 0.7)],
			},
		},
		{
			cuisine: "korean_bibimbap",
			label: "Bibimbap",
			recipe_count: 0,
			slots: {
				"rice": [ing("short-grain rice", 1.0)],
				"topping": [ing("gochujang-marinated tofu", 0.7), ing("blanched spinach", 0.85), ing("julienned carrot", 0.85), ing("bean sprout", 0.85), ing("shiitake mushroom", 0.7)],
				"sauce": [ing("gochujang and toasted sesame oil", 1.0)],
				"garnish": [ing("fried egg", 0.85), ing("nori", 0.7), ing("toasted sesame seeds", 0.7)],
			},
		},
	],
};

// ============================================================================
// 10. MEZZE_PLATE
// ============================================================================
const MEZZE_PLATE: SeedTemplate = {
	name: "mezze_plate",
	slots: [
		slot("dip", true, 2, 4),
		slot("bread", true, 1, 1),
		slot("pickle", true, 1, 2),
		slot("salad", true, 1, 2),
		slot("protein", false, 0, 1),
		slot("finish", false, 0, 1),
	],
	variant_sets: [
		{
			cuisine: "levantine",
			label: "Levantine Mezze",
			recipe_count: 0,
			slots: {
				"dip": [ing("hummus", 1.0), ing("baba ganoush", 0.85), ing("muhammara", 0.7)],
				"bread": [ing("warm pita", 1.0)],
				"pickle": [ing("pickled turnip", 0.7), ing("kalamata olives", 0.85)],
				"salad": [ing("fattoush", 0.85)],
				"protein": [ing("falafel", 0.85)],
				"finish": [ing("za'atar oil", 0.5)],
			},
		},
		{
			cuisine: "greek",
			label: "Greek Mezze",
			recipe_count: 0,
			slots: {
				"dip": [ing("tzatziki", 1.0), ing("taramasalata", 0.85), ing("melitzanosalata", 0.5)],
				"bread": [ing("pita", 1.0)],
				"pickle": [ing("pepperoncini", 0.85), ing("kalamata olives", 0.85)],
				"salad": [ing("greek salad", 1.0)],
				"protein": [ing("dolmas", 0.7)],
			},
		},
		{
			cuisine: "turkish",
			label: "Turkish Mezze",
			recipe_count: 0,
			slots: {
				"dip": [ing("hummus", 0.85), ing("ezme", 0.85), ing("cacık", 0.7)],
				"bread": [ing("lavash", 1.0)],
				"pickle": [ing("pickled cabbage", 0.7), ing("turşu", 0.7)],
				"salad": [ing("shepherd salad", 0.85)],
				"protein": [ing("sigara böreği", 0.7)],
			},
		},
		{
			cuisine: "california",
			label: "California Fusion Mezze",
			recipe_count: 0,
			slots: {
				"dip": [ing("lemon-tahini hummus", 1.0), ing("roasted red pepper spread", 0.85), ing("white bean dip", 0.5)],
				"bread": [ing("focaccia", 1.0)],
				"pickle": [ing("quick-pickled vegetables", 1.0)],
				"salad": [ing("herb salad", 0.85), ing("citrus-fennel salad", 0.5)],
				"protein": [ing("marinated chickpeas", 0.7)],
			},
		},
	],
};

// ============================================================================
// 11. TAGINE
// ============================================================================
const TAGINE: SeedTemplate = {
	name: "tagine",
	slots: [
		slot("protein", true, 1, 1),
		slot("vegetable", true, 2, 4),
		slot("spice_blend", true, 1, 1),
		slot("aromatic", true, 1, 2),
		slot("finish", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "moroccan",
			label: "Moroccan Chickpea Tagine",
			recipe_count: 0,
			slots: {
				"protein": [ing("cooked chickpea", 1.0), ing("dried apricot", 0.7)],
				"vegetable": [ing("carrot", 0.85), ing("yellow onion", 0.85), ing("zucchini", 0.7), ing("butternut squash", 0.5)],
				"spice_blend": [ing("ras el hanout", 1.0)],
				"aromatic": [ing("saffron", 0.85), ing("cinnamon stick", 0.7)],
				"finish": [ing("preserved lemon and cilantro over couscous", 1.0)],
			},
		},
		{
			cuisine: "tunisian",
			label: "Tunisian Tagine",
			recipe_count: 0,
			slots: {
				"protein": [ing("cooked chickpea", 0.85), ing("harissa-marinated tofu", 0.5)],
				"vegetable": [ing("fennel", 0.85), ing("tomato", 0.85), ing("cooked chickpea", 0.5)],
				"spice_blend": [ing("harissa", 1.0)],
				"aromatic": [ing("garlic", 0.85), ing("ground caraway", 0.7), ing("ground cumin", 0.7)],
				"finish": [ing("lemon and cilantro with crusty bread", 1.0)],
			},
		},
	],
};

// ============================================================================
// 12. PAELLA
// ============================================================================
const PAELLA: SeedTemplate = {
	name: "paella",
	slots: [
		slot("rice", true, 1, 1),
		slot("broth", true, 1, 1),
		slot("protein", true, 1, 2),
		slot("vegetable", true, 2, 3),
		slot("aromatic", true, 2, 3),
	],
	variant_sets: [
		{
			cuisine: "valenciana",
			label: "Valenciana Vegetarian Paella",
			recipe_count: 0,
			slots: {
				"rice": [ing("bomba rice", 1.0)],
				"broth": [ing("vegetable broth", 1.0)],
				"protein": [ing("artichoke heart", 0.85), ing("butter bean", 0.85)],
				"vegetable": [ing("green bean", 0.85), ing("tomato", 0.85), ing("red bell pepper", 0.7)],
				"aromatic": [ing("saffron", 1.0), ing("smoked paprika", 0.85), ing("garlic", 0.85)],
			},
		},
		{
			cuisine: "mar_y_montaña",
			label: "Mar y Montaña Paella",
			recipe_count: 0,
			slots: {
				"rice": [ing("bomba rice", 1.0)],
				"broth": [ing("seafood broth", 1.0)],
				"protein": [ing("king trumpet mushroom", 0.7), ing("cooked chickpea", 0.7)],
				"vegetable": [ing("asparagus", 0.85), ing("tomato", 0.85)],
				"aromatic": [ing("saffron", 1.0), ing("smoked paprika", 0.85), ing("lemon", 0.7)],
			},
		},
	],
};

// ============================================================================
// 13. RISOTTO
// ============================================================================
const RISOTTO: SeedTemplate = {
	name: "risotto",
	slots: [
		slot("rice", true, 1, 1),
		slot("broth", true, 1, 1),
		slot("aromatic", true, 1, 2),
		slot("additions", true, 1, 3),
		slot("finish", true, 1, 2),
	],
	variant_sets: [
		{
			cuisine: "italian_milanese",
			label: "Risotto alla Milanese",
			recipe_count: 0,
			slots: {
				"rice": [ing("arborio rice", 1.0)],
				"broth": [ing("vegetable broth", 1.0)],
				"aromatic": [ing("shallot", 0.85), ing("saffron", 1.0)],
				"additions": [ing("parmesan", 1.0)],
				"finish": [ing("butter", 1.0), ing("lemon zest", 0.5)],
			},
		},
		{
			cuisine: "italian_mushroom",
			label: "Mushroom Risotto",
			recipe_count: 0,
			slots: {
				"rice": [ing("arborio rice", 1.0)],
				"broth": [ing("mushroom broth", 1.0)],
				"aromatic": [ing("shallot", 0.85), ing("fresh thyme", 0.7)],
				"additions": [ing("mixed wild mushroom", 1.0), ing("heavy cream", 0.5)],
				"finish": [ing("parmesan", 0.85), ing("white truffle oil", 0.5)],
			},
		},
		{
			cuisine: "italian_asparagus_lemon",
			label: "Asparagus Lemon Risotto",
			recipe_count: 0,
			slots: {
				"rice": [ing("carnaroli rice", 1.0)],
				"broth": [ing("vegetable broth", 1.0)],
				"aromatic": [ing("leek", 1.0)],
				"additions": [ing("asparagus", 0.85), ing("english pea", 0.7), ing("ricotta", 0.5)],
				"finish": [ing("lemon zest", 0.85), ing("parmesan", 0.85)],
			},
		},
		{
			cuisine: "italian_pumpkin_sage",
			label: "Pumpkin Sage Risotto",
			recipe_count: 0,
			slots: {
				"rice": [ing("arborio rice", 1.0)],
				"broth": [ing("vegetable broth", 1.0)],
				"aromatic": [ing("shallot", 0.85), ing("fresh sage", 1.0)],
				"additions": [ing("roasted pumpkin", 0.85), ing("mascarpone", 0.5)],
				"finish": [ing("parmesan", 0.85), ing("brown butter", 0.7)],
			},
		},
	],
};

// ============================================================================
// 14. GRATIN
// ============================================================================
const GRATIN: SeedTemplate = {
	name: "gratin",
	slots: [
		slot("base", true, 1, 1),
		slot("bechamel_or_cream", true, 1, 1),
		slot("cheese", true, 1, 2),
		slot("aromatic", true, 1, 2),
		slot("topping", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "french_dauphinoise",
			label: "Gratin Dauphinoise",
			recipe_count: 0,
			slots: {
				"base": [ing("thinly sliced potato", 1.0)],
				"bechamel_or_cream": [ing("heavy cream with nutmeg", 1.0)],
				"cheese": [ing("gruyère", 1.0), ing("parmesan", 0.5)],
				"aromatic": [ing("garlic", 0.85), ing("fresh thyme", 0.7)],
				"topping": [ing("breadcrumb", 0.5)],
			},
		},
		{
			cuisine: "italian_eggplant_parmesan",
			label: "Eggplant Parmesan",
			recipe_count: 0,
			slots: {
				"base": [ing("roasted eggplant", 1.0)],
				"bechamel_or_cream": [ing("marinara sauce", 1.0)],
				"cheese": [ing("mozzarella", 1.0), ing("parmesan", 0.85)],
				"aromatic": [ing("fresh basil", 0.85), ing("garlic", 0.85)],
				"topping": [ing("breadcrumb crisp", 0.85)],
			},
		},
		{
			cuisine: "british_cauliflower_cheese",
			label: "Cauliflower Cheese",
			recipe_count: 0,
			slots: {
				"base": [ing("cauliflower florets", 1.0)],
				"bechamel_or_cream": [ing("bechamel with dijon", 1.0)],
				"cheese": [ing("sharp cheddar", 1.0), ing("parmesan", 0.5)],
				"aromatic": [ing("english mustard", 0.7), ing("nutmeg", 0.5)],
				"topping": [ing("panko with smoked paprika", 0.85)],
			},
		},
		{
			cuisine: "french_leek_celeriac",
			label: "Leek Celeriac Gratin",
			recipe_count: 0,
			slots: {
				"base": [ing("leek and celeriac", 1.0)],
				"bechamel_or_cream": [ing("cream-bechamel", 1.0)],
				"cheese": [ing("gruyère", 1.0)],
				"aromatic": [ing("fresh thyme", 0.85), ing("bay leaf", 0.5)],
				"topping": [ing("breadcrumb with parmesan", 0.85)],
			},
		},
	],
};

// ============================================================================
// 15. SOPES
// ============================================================================
const SOPES: SeedTemplate = {
	name: "sopes",
	slots: [
		slot("masa_base", true, 1, 1),
		slot("refried_bean_layer", true, 1, 1),
		slot("protein", false, 0, 1),
		slot("salsa", true, 1, 1),
		slot("garnish", true, 1, 3),
	],
	variant_sets: [
		{
			cuisine: "mexican_classic",
			label: "Sopes with Spiced Chickpea",
			recipe_count: 0,
			slots: {
				"masa_base": [ing("thick masa cup", 1.0)],
				"refried_bean_layer": [ing("refried black bean", 1.0)],
				"protein": [ing("spiced chickpea", 1.0)],
				"salsa": [ing("salsa verde", 1.0)],
				"garnish": [ing("queso fresco", 0.85), ing("crema", 0.85), ing("radish", 0.7), ing("cilantro", 0.7)],
			},
		},
		{
			cuisine: "mexican_tinga",
			label: "Sopes Tinga",
			recipe_count: 0,
			slots: {
				"masa_base": [ing("thick masa cup", 1.0)],
				"refried_bean_layer": [ing("refried pinto bean", 1.0)],
				"protein": [ing("chipotle-tomato mushroom tinga", 0.5), ing("jackfruit tinga", 0.5)],
				"salsa": [ing("escabeche", 0.85)],
				"garnish": [ing("queso fresco", 0.85), ing("shredded lettuce", 0.5), ing("crema", 0.5)],
			},
		},
	],
};

// ============================================================================
// 16. BANH_MI
// ============================================================================
const BANH_MI: SeedTemplate = {
	name: "banh_mi",
	slots: [
		slot("baguette", true, 1, 1),
		slot("pâté_or_spread", true, 1, 1),
		slot("protein", true, 1, 1),
		slot("pickle", true, 1, 1),
		slot("herb", true, 1, 1),
		slot("heat", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "vietnamese_classic",
			label: "Vietnamese Banh Mi",
			recipe_count: 0,
			slots: {
				"baguette": [ing("french-style vietnamese baguette", 1.0)],
				"pâté_or_spread": [ing("kewpie mayo with maggi seasoning", 1.0)],
				"protein": [ing("lemongrass tofu", 0.6), ing("lemongrass seitan", 0.4)],
				"pickle": [ing("daikon-carrot pickle", 1.0)],
				"herb": [ing("cilantro", 1.0)],
				"heat": [ing("fresh jalapeño", 1.0)],
			},
		},
		{
			cuisine: "korean_inspired",
			label: "Korean-Inspired Banh Mi",
			recipe_count: 0,
			slots: {
				"baguette": [ing("french-style baguette", 1.0)],
				"pâté_or_spread": [ing("gochujang aioli", 1.0)],
				"protein": [ing("bulgogi-style tofu", 0.6), ing("marinated king trumpet mushroom", 0.4)],
				"pickle": [ing("kimchi", 1.0)],
				"herb": [ing("scallion", 1.0)],
				"heat": [ing("fresh red chili", 1.0)],
			},
		},
	],
};

// ============================================================================
// 17. TOSTADA
// ============================================================================
const TOSTADA: SeedTemplate = {
	name: "tostada",
	slots: [
		slot("tortilla", true, 1, 1),
		slot("bean_layer", true, 1, 1),
		slot("protein", false, 0, 1),
		slot("salsa", true, 1, 1),
		slot("garnish", true, 1, 3),
	],
	variant_sets: [
		{
			cuisine: "mexican_classic",
			label: "Classic Mexican Tostada",
			recipe_count: 0,
			slots: {
				"tortilla": [ing("fried corn tostada", 1.0)],
				"bean_layer": [ing("refried pinto bean", 1.0)],
				"protein": [ing("spiced chickpea picadillo", 0.7), ing("seasoned mushroom picadillo", 0.4)],
				"salsa": [ing("salsa fresca", 1.0)],
				"garnish": [ing("queso fresco", 0.85), ing("crema", 0.7), ing("shredded lettuce", 0.7), ing("radish", 0.5)],
			},
		},
		{
			cuisine: "california",
			label: "California Tostada",
			recipe_count: 0,
			slots: {
				"tortilla": [ing("baked corn tostada", 1.0)],
				"bean_layer": [ing("mashed black bean with lime", 1.0)],
				"protein": [ing("marinated tofu", 0.85)],
				"salsa": [ing("salsa verde", 1.0)],
				"garnish": [ing("avocado", 0.85), ing("watermelon radish", 0.7), ing("microgreens", 0.5), ing("cotija", 0.5)],
			},
		},
	],
};

// ============================================================================
// 18. GALETTE
// ============================================================================
const GALETTE: SeedTemplate = {
	name: "galette",
	slots: [
		slot("dough", true, 1, 1),
		slot("filling", true, 1, 2),
		slot("aromatic", true, 1, 1),
		slot("cheese_or_richness", false, 0, 1),
		slot("finish", true, 1, 1),
	],
	variant_sets: [
		{
			cuisine: "french_classic",
			label: "French Classic Galette",
			recipe_count: 0,
			slots: {
				"dough": [ing("pâte brisée", 1.0)],
				"filling": [ing("leek", 0.85), ing("cremini mushroom", 0.85), ing("caramelized onion", 0.5)],
				"aromatic": [ing("fresh thyme and bay", 1.0)],
				"cheese_or_richness": [ing("gruyère", 0.85)],
				"finish": [ing("fresh herb with lemon zest", 1.0)],
			},
		},
		{
			cuisine: "mediterranean",
			label: "Mediterranean Galette",
			recipe_count: 0,
			slots: {
				"dough": [ing("pâte brisée", 1.0)],
				"filling": [ing("roasted eggplant", 0.85), ing("tomato", 0.85), ing("red bell pepper", 0.5)],
				"aromatic": [ing("dried oregano with garlic", 1.0)],
				"cheese_or_richness": [ing("feta with kalamata olives", 0.85)],
				"finish": [ing("fresh parsley and lemon", 1.0)],
			},
		},
		{
			cuisine: "autumn_squash",
			label: "Autumn Squash Galette",
			recipe_count: 0,
			slots: {
				"dough": [ing("rye pâte brisée", 1.0)],
				"filling": [ing("roasted butternut squash", 1.0), ing("caramelized onion", 0.85)],
				"aromatic": [ing("fresh sage and thyme", 1.0)],
				"cheese_or_richness": [ing("ricotta with parmesan", 0.85)],
				"finish": [ing("toasted walnut with brown butter", 1.0)],
			},
		},
	],
};

// ---------- All templates ----------

const ALL_TEMPLATES: SeedTemplate[] = [
	BURGER,
	SANDWICH,
	PIZZA,
	FLATBREAD,
	FRITTER,
	FRITTATA,
	DUMPLING,
	HOT_POT,
	DONBURI,
	MEZZE_PLATE,
	TAGINE,
	PAELLA,
	RISOTTO,
	GRATIN,
	SOPES,
	BANH_MI,
	TOSTADA,
	GALETTE,
];

// ---------- Public API ----------

/**
 * Seed the 18 hand-authored format templates into the `composition_templates`
 * D1 table.
 *
 * Behaviour:
 *   - Default: `INSERT OR IGNORE` — does NOT touch existing rows of the same
 *     name. Safe to run alongside the corpus-mined seeds.
 *   - With `overwrite: true`: `INSERT OR REPLACE` — overwrites rows of the
 *     same name. Use only when intentionally re-seeding authored templates.
 *
 * Returns counts of added / skipped templates plus any per-row error messages.
 * Does not throw on individual row failures — collects errors and continues so
 * a single bad row can't block the rest of the seed.
 */
export async function seedFormatLibrary(
	db: D1Database,
	opts?: { overwrite?: boolean },
): Promise<{ added: number; skipped: number; errors: string[] }> {
	const overwrite = opts?.overwrite === true;
	const verb = overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
	const sql = `${verb} INTO composition_templates (name, slots_json, variant_sets_json) VALUES (?, ?, ?)`;

	let added = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const template of ALL_TEMPLATES) {
		try {
			const slotsJson = JSON.stringify(template.slots);
			const variantsJson = JSON.stringify(template.variant_sets);
			const result = await db.prepare(sql).bind(template.name, slotsJson, variantsJson).run();
			// D1 .meta.changes reports affected row count; 0 means ignored.
			const changes = result.meta?.changes ?? 0;
			if (changes > 0) {
				added += 1;
			} else {
				skipped += 1;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${template.name}: ${msg}`);
			skipped += 1;
		}
	}

	return { added, skipped, errors };
}

/**
 * Returns the list of authored format names this module would seed. Exposed
 * primarily so callers (admin endpoints, tests) can introspect the library
 * without hitting D1.
 */
export function listAuthoredFormatNames(): string[] {
	return ALL_TEMPLATES.map(t => t.name);
}
