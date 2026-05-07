// Shelf-life lookup table — maps canonical ingredient names to refrigerator
// shelf life (in hours). Used by the dynamic shopping-run scheduler and by
// ShopFreshnessCritic to verify items aren't purchased too far ahead of use.
//
// Tiers:
//   - ultra_perishable (~3d): tender herbs, soft cheeses, sandwich breads
//   - perishable      (~4d): mushrooms, leafy greens, fresh fish/pasta
//   - medium          (5-7d): hardy produce (cauliflower, broccoli, peppers)
//   - hardy          (10-14d): apples, citrus, cabbage, root vegetables
//   - dairy          (14-21d): yogurt, milk, eggs, butter, sealed feta
//   - cheese            (~30d): hard cheeses (parmesan, gouda, gruyere)
//   - pantry_stable   (90d+): rice, dried goods, oils, vinegars, condiments
//
// Hours are kept rather than days so the critic can do exact comparisons
// against meal/cook scheduling deltas.

export type ShelfLifeCategory =
	| "ultra_perishable"
	| "perishable"
	| "medium"
	| "hardy"
	| "dairy"
	| "cheese"
	| "pantry_stable";

export interface ShelfLifeEntry {
	canonical_name: string;
	shelf_life_room_temp_hours: number | null;   // null for refrigerate-only
	shelf_life_fridge_hours: number;
	shelf_life_freezer_hours: number | null;
	category: ShelfLifeCategory;
}

const ULTRA = 72;       // 3 days fridge
const PERISH = 96;      // 4 days fridge
const MEDIUM = 144;     // 6 days fridge
const HARDY = 312;      // 13 days fridge
const DAIRY = 432;      // 18 days fridge
const CHEESE = 720;     // 30 days fridge
const PANTRY = 4320;    // 180 days

function ultra(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: 24, shelf_life_fridge_hours: ULTRA, shelf_life_freezer_hours: 720, category: "ultra_perishable" };
}
function perish(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: 24, shelf_life_fridge_hours: PERISH, shelf_life_freezer_hours: 1440, category: "perishable" };
}
function medium(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: 48, shelf_life_fridge_hours: MEDIUM, shelf_life_freezer_hours: 2160, category: "medium" };
}
function hardy(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: 96, shelf_life_fridge_hours: HARDY, shelf_life_freezer_hours: 4320, category: "hardy" };
}
function dairy(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: null, shelf_life_fridge_hours: DAIRY, shelf_life_freezer_hours: 2160, category: "dairy" };
}
function cheese(name: string): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: null, shelf_life_fridge_hours: CHEESE, shelf_life_freezer_hours: 4320, category: "cheese" };
}
function pantry(name: string, hours: number = PANTRY): ShelfLifeEntry {
	return { canonical_name: name, shelf_life_room_temp_hours: hours, shelf_life_fridge_hours: hours, shelf_life_freezer_hours: hours, category: "pantry_stable" };
}

export const SHELF_LIFE_TABLE: ShelfLifeEntry[] = [
	// --- ultra_perishable (3d fridge) ---
	ultra("arugula"),
	ultra("basil"),
	ultra("cilantro"),
	ultra("mint"),
	ultra("parsley"),
	ultra("dill"),
	ultra("sage"),
	ultra("chive"),
	ultra("tarragon"),
	ultra("sourdough"),
	ultra("brioche"),
	ultra("burrata"),
	ultra("fresh mozzarella"),
	ultra("ricotta"),

	// --- perishable (4d fridge) ---
	perish("shiitake"),
	perish("shiitake mushroom"),
	perish("swiss chard"),
	perish("baby spinach"),
	perish("spinach"),
	perish("cremini mushroom"),
	perish("oyster mushroom"),
	perish("mushroom"),
	perish("fresh fish"),
	perish("salmon"),
	perish("tuna"),
	perish("cod"),
	perish("halibut"),
	perish("trout"),
	perish("bean patty"),
	perish("black bean patty"),
	perish("fresh pasta"),
	perish("kale"),

	// --- medium (5-7d fridge) ---
	medium("cauliflower"),
	medium("broccoli"),
	medium("carrot"),
	medium("cucumber"),
	medium("bell pepper"),
	medium("zucchini"),
	medium("yellow squash"),
	medium("eggplant"),
	medium("tomato"),
	medium("cherry tomato"),
	medium("kalamata olive"),
	medium("olive"),
	medium("cold cut"),
	medium("pita"),
	medium("brioche bun"),
	medium("bun"),
	medium("tortilla"),
	medium("corn tortilla"),
	medium("flour tortilla"),
	medium("flatbread"),
	medium("scallion"),
	medium("lettuce"),
	medium("butter lettuce"),
	medium("romaine"),
	medium("asparagus"),
	medium("green bean"),
	medium("snap pea"),
	medium("avocado"),
	medium("strawberry"),
	medium("blueberry"),
	medium("raspberry"),
	medium("blackberry"),
	medium("mango"),

	// --- hardy (10-14d fridge) ---
	hardy("apple"),
	hardy("pear"),
	hardy("lemon"),
	hardy("lime"),
	hardy("orange"),
	hardy("grapefruit"),
	hardy("cabbage"),
	hardy("napa cabbage"),
	hardy("green cabbage"),
	hardy("hard squash"),
	hardy("butternut squash"),
	hardy("acorn squash"),
	hardy("kabocha squash"),
	hardy("delicata squash"),
	hardy("beet"),
	hardy("radish"),
	hardy("parsnip"),
	hardy("turnip"),
	hardy("onion"),
	hardy("red onion"),
	hardy("shallot"),
	hardy("garlic"),
	hardy("ginger"),
	hardy("potato"),
	hardy("sweet potato"),
	hardy("celery"),
	hardy("fennel"),
	hardy("leek"),
	hardy("daikon"),

	// --- dairy (14-21d fridge) ---
	dairy("yogurt"),
	dairy("greek yogurt"),
	dairy("milk"),
	dairy("butter"),
	dairy("egg"),
	dairy("feta"),
	dairy("cream"),
	dairy("sour cream"),
	dairy("cottage cheese"),
	dairy("labneh"),
	dairy("goat cheese"),

	// --- hard cheese (30d fridge) ---
	cheese("parmesan"),
	cheese("pecorino"),
	cheese("gouda"),
	cheese("gruyere"),
	cheese("cheddar"),
	cheese("manchego"),
	cheese("asiago"),

	// --- pantry_stable (90d+) ---
	pantry("rice"),
	pantry("jasmine rice"),
	pantry("basmati rice"),
	pantry("brown rice"),
	pantry("white rice"),
	pantry("short-grain rice"),
	pantry("arborio rice"),
	pantry("pasta"),
	pantry("spaghetti"),
	pantry("linguine"),
	pantry("penne"),
	pantry("rigatoni"),
	pantry("orecchiette"),
	pantry("farfalle"),
	pantry("fusilli"),
	pantry("oats"),
	pantry("rolled oats"),
	pantry("flour"),
	pantry("all-purpose flour"),
	pantry("sugar"),
	pantry("brown sugar"),
	pantry("dried bean"),
	pantry("black bean"),
	pantry("cooked black bean"),
	pantry("dried lentil"),
	pantry("lentil"),
	pantry("chickpea"),     // dry — when canned it's also pantry-stable
	pantry("canned tomato"),
	pantry("canned bean"),
	pantry("olive oil"),
	pantry("neutral oil"),
	pantry("sesame oil"),
	pantry("coconut oil"),
	pantry("vinegar"),
	pantry("rice vinegar"),
	pantry("white vinegar"),
	pantry("apple cider vinegar"),
	pantry("soy sauce"),
	pantry("tamari"),
	pantry("mirin"),
	pantry("miso"),
	pantry("white miso"),
	pantry("red miso"),
	pantry("gochujang"),
	pantry("harissa paste"),
	pantry("tahini"),
	pantry("honey"),
	pantry("maple syrup"),
	pantry("dried herb"),
	pantry("spice"),
	pantry("cumin"),
	pantry("chili flake"),
	pantry("coriander"),
	pantry("paprika"),
	pantry("smoked paprika"),
	pantry("turmeric"),
	pantry("cinnamon"),
	pantry("salt"),
	pantry("pepper"),
	pantry("baking soda"),
	pantry("baking powder"),
	pantry("yeast"),
	pantry("nori"),
	pantry("kombu"),
	pantry("dried shiitake"),
	pantry("almond"),
	pantry("pistachio"),
	pantry("walnut"),
	pantry("pecan"),
	pantry("cashew"),
	pantry("peanut"),
	pantry("sesame seed"),
	pantry("sunflower seed"),
	pantry("pumpkin seed"),
	pantry("chia seed"),
	pantry("cracker"),
	pantry("whole wheat cracker"),
];

const TABLE_BY_NAME = new Map<string, ShelfLifeEntry>();
for (const entry of SHELF_LIFE_TABLE) TABLE_BY_NAME.set(entry.canonical_name.toLowerCase(), entry);

/**
 * lookupShelfLife — case-insensitive lookup with fuzzy fallback.
 * Tries exact match, then strips common modifiers (fresh/raw/cooked),
 * then substring containment in either direction.
 * Falls back to defaultShelfLife() for unknown items.
 */
export function lookupShelfLife(canonical_name: string): ShelfLifeEntry {
	const raw = (canonical_name || "").trim().toLowerCase();
	if (!raw) return defaultShelfLife(canonical_name);

	const exact = TABLE_BY_NAME.get(raw);
	if (exact) return exact;

	// Strip common modifier prefixes ("fresh basil", "raw spinach", etc.)
	const stripped = raw
		.replace(/^(fresh|raw|cooked|whole|sliced|chopped|diced|baby|wild|organic|loose|bagged|sealed|fresh-cut)\s+/g, "")
		.replace(/\s+(leaves|leaf|sprig|bunch|head|cloves?|root)$/g, "")
		.trim();
	if (stripped !== raw) {
		const stripHit = TABLE_BY_NAME.get(stripped);
		if (stripHit) return stripHit;
	}

	// Singularize trailing "s" defensively
	if (raw.endsWith("s")) {
		const singular = raw.replace(/s$/, "");
		const singHit = TABLE_BY_NAME.get(singular);
		if (singHit) return singHit;
	}

	// Substring containment — pick the longest matching key (most specific).
	let best: ShelfLifeEntry | null = null;
	let bestLen = 0;
	for (const [key, entry] of TABLE_BY_NAME) {
		if (key.length < 4) continue;          // avoid noise like "egg" matching "eggplant"
		if (raw.includes(key) || key.includes(stripped)) {
			if (key.length > bestLen) {
				bestLen = key.length;
				best = entry;
			}
		}
	}
	if (best) return best;

	return defaultShelfLife(canonical_name);
}

/**
 * defaultShelfLife — heuristic fallback when an item isn't in the table.
 * Routes by keyword to a reasonable category. Always returns non-zero hours.
 */
export function defaultShelfLife(name: string): ShelfLifeEntry {
	const n = (name || "unknown").trim().toLowerCase();
	if (/herb|leaf|leaves|sprig|microgreen/.test(n))      return ultra(n);
	if (/mushroom|fish|seafood|fillet|ground meat|sushi/.test(n))    return perish(n);
	if (/yogurt|milk|cream|butter|labneh|egg/.test(n))    return dairy(n);
	if (/cheese|parmesan|gouda|gruyere/.test(n))          return cheese(n);
	if (/oil|vinegar|sauce|paste|miso|honey|syrup|spice|flake|powder|seed|nut|rice|pasta|flour|sugar|salt|dried|canned|cracker/.test(n)) return pantry(n);
	if (/apple|pear|citrus|lemon|lime|orange|cabbage|onion|garlic|ginger|potato|squash|root/.test(n))     return hardy(n);
	if (/lettuce|green|spinach|kale|chard|sprout|berry/.test(n))     return perish(n);
	// Default: medium produce (5-7 days). Better to over-warn than to silently allow a 14-day gap.
	return medium(n);
}
