/**
 * Recipe aggregator — builds CanonicalRecipe structure from clustered source recipes.
 * TypeScript port of aggregate_canonical_v2.py, running on D1.
 */

interface AggregatedIngredient {
  canonical_name: string;
  role: string;
  consensus_qty: number | null;
  unit: string | null;
  prep: string | null;
  importance: "core" | "expected" | "optional";
  frequency: number;
  alternatives: any[];
}

interface AggregatedRecipe {
  title: string;
  composition: string;
  recipe_count: number;
  ingredient_groups: Array<{
    label: string;
    slot: string | null;
    component_ref: string | null;
    items: AggregatedIngredient[];
  }>;
  equipment: {
    full_inventory: Array<{ item: string; count: number; purpose: string; required: boolean; alternatives: string[]; step_indices: number[] }>;
    bowl_strategy: string;
    consumables: string[];
  };
  time: { prep_min: number; cook_min: number; active_min: number; idle_min: number; total_min: number };
  yield: { canonical_amount: number; canonical_unit: string; display: string };
  difficulty: { overall: number; notes: string | null };
  allergens: { contains: string[]; may_contain: string[]; free_of_certifications: string[] };
  matched_components: any[];
  variations_meta: any[];
}

// Allergen detection from ingredient names
const ALLERGEN_MAP: Record<string, string[]> = {
  gluten: ["flour", "bread", "pasta", "wheat", "semolina", "couscous", "barley", "rye", "noodle"],
  dairy: ["butter", "milk", "cream", "cheese", "yogurt", "sour cream", "whey", "ghee", "buttermilk"],
  eggs: ["egg"],
  soy: ["soy sauce", "tofu", "tempeh", "edamame", "soy milk", "tamari", "miso"],
  tree_nuts: ["almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia", "pine nut"],
  peanuts: ["peanut", "peanut butter"],
  shellfish: ["shrimp", "crab", "lobster", "crawfish", "prawn"],
  fish: ["anchovy", "salmon", "tuna", "cod", "fish sauce", "sardine"],
  sesame: ["sesame", "tahini"],
};

function detectAllergens(ingredients: string[]): string[] {
  const found = new Set<string>();
  for (const ing of ingredients) {
    const lower = ing.toLowerCase();
    for (const [allergen, keywords] of Object.entries(ALLERGEN_MAP)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        found.add(allergen);
      }
    }
  }
  return [...found].sort();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function aggregateCanonical(
  db: D1Database,
  canonicalTitle: string,
  recipeIds: number[],
  composition: string,
): Promise<AggregatedRecipe> {
  const recipeCount = recipeIds.length;
  const placeholders = recipeIds.map(() => "?").join(",");

  // ── Aggregate ingredients ──
  const ingRows = await db.prepare(`
    SELECT canonical_name, unit, quantity, prep, group_name,
           COUNT(*) as cnt
    FROM parsed_ingredients
    WHERE raw_recipe_id IN (${placeholders})
      AND canonical_name IS NOT NULL AND canonical_name != ''
    GROUP BY canonical_name, unit
    ORDER BY cnt DESC
  `).bind(...recipeIds).all<{
    canonical_name: string;
    unit: string | null;
    quantity: number | null;
    prep: string | null;
    group_name: string | null;
    cnt: number;
  }>();

  // Dedupe by canonical_name, keep the most common unit
  const ingMap = new Map<string, {
    name: string;
    unit: string | null;
    quantities: number[];
    preps: string[];
    count: number;
  }>();

  for (const row of ingRows.results) {
    const existing = ingMap.get(row.canonical_name);
    if (!existing || row.cnt > existing.count) {
      ingMap.set(row.canonical_name, {
        name: row.canonical_name,
        unit: row.unit,
        quantities: row.quantity ? [row.quantity] : [],
        preps: row.prep ? [row.prep] : [],
        count: row.cnt,
      });
    } else {
      if (row.quantity) existing.quantities.push(row.quantity);
      if (row.prep) existing.preps.push(row.prep);
    }
  }

  // Count distinct recipes per ingredient
  const freqRows = await db.prepare(`
    SELECT canonical_name, COUNT(DISTINCT raw_recipe_id) as recipe_cnt
    FROM parsed_ingredients
    WHERE raw_recipe_id IN (${placeholders})
      AND canonical_name IS NOT NULL AND canonical_name != ''
    GROUP BY canonical_name
  `).bind(...recipeIds).all<{ canonical_name: string; recipe_cnt: number }>();

  const freqMap = new Map<string, number>();
  for (const row of freqRows.results) {
    freqMap.set(row.canonical_name, row.recipe_cnt);
  }

  const ingredients: AggregatedIngredient[] = [];
  for (const [name, data] of ingMap) {
    const recipesWithIng = freqMap.get(name) || 0;
    const frequency = recipesWithIng / recipeCount;

    let importance: "core" | "expected" | "optional";
    if (frequency >= 0.8) importance = "core";
    else if (frequency >= 0.5) importance = "expected";
    else if (frequency >= 0.2) importance = "optional";
    else continue; // Skip very rare ingredients

    ingredients.push({
      canonical_name: name,
      role: guessRole(name),
      consensus_qty: data.quantities.length > 0 ? median(data.quantities) : null,
      unit: data.unit,
      prep: data.preps.length > 0 ? mostCommon(data.preps) : null,
      importance,
      frequency: Math.round(frequency * 100) / 100,
      alternatives: [],
    });
  }

  // Sort: core first, then expected, then optional; within tier by frequency
  ingredients.sort((a, b) => {
    const tierOrder = { core: 0, expected: 1, optional: 2 };
    if (tierOrder[a.importance] !== tierOrder[b.importance]) {
      return tierOrder[a.importance] - tierOrder[b.importance];
    }
    return b.frequency - a.frequency;
  });

  // ── Aggregate times ──
  const timeRows = await db.prepare(`
    SELECT prep_time_min, cook_time_min, total_time_min
    FROM raw_recipes
    WHERE id IN (${placeholders})
      AND total_time_min IS NOT NULL
  `).bind(...recipeIds).all<{
    prep_time_min: number | null;
    cook_time_min: number | null;
    total_time_min: number | null;
  }>();

  const prepTimes = timeRows.results.filter((r) => r.prep_time_min).map((r) => r.prep_time_min!);
  const cookTimes = timeRows.results.filter((r) => r.cook_time_min).map((r) => r.cook_time_min!);
  const totalTimes = timeRows.results.filter((r) => r.total_time_min).map((r) => r.total_time_min!);

  const prepMin = prepTimes.length > 0 ? median(prepTimes) : 15;
  const cookMin = cookTimes.length > 0 ? median(cookTimes) : 30;
  const totalMin = totalTimes.length > 0 ? median(totalTimes) : prepMin + cookMin;

  // ── Aggregate servings ──
  const servingRows = await db.prepare(`
    SELECT servings FROM raw_recipes
    WHERE id IN (${placeholders}) AND servings IS NOT NULL AND servings > 0
  `).bind(...recipeIds).all<{ servings: number }>();

  const servings = servingRows.results.length > 0
    ? median(servingRows.results.map((r) => r.servings))
    : 4;

  // ── Allergens ──
  const allIngNames = ingredients.map((i) => i.canonical_name);
  const allergens = detectAllergens(allIngNames);

  // ── Difficulty (heuristic) ──
  const stepCountAvg = allIngNames.length > 12 ? 4 : allIngNames.length > 8 ? 3 : 2;
  const timeComplexity = totalMin > 120 ? 5 : totalMin > 60 ? 4 : totalMin > 30 ? 3 : 2;
  const overall = Math.round((stepCountAvg + timeComplexity) / 2);

  // ── Yield display ──
  const yieldUnit = composition === "baked_good" ? "pieces" : "servings";

  return {
    title: canonicalTitle,
    composition,
    recipe_count: recipeCount,
    ingredient_groups: [{
      label: "Main",
      slot: null,
      component_ref: null,
      items: ingredients,
    }],
    equipment: {
      full_inventory: [],
      bowl_strategy: "one bowl",
      consumables: [],
    },
    time: {
      prep_min: Math.round(prepMin),
      cook_min: Math.round(cookMin),
      active_min: Math.round(prepMin + cookMin * 0.5),
      idle_min: Math.round(cookMin * 0.5),
      total_min: Math.round(totalMin),
    },
    yield: {
      canonical_amount: servings,
      canonical_unit: yieldUnit,
      display: `Makes ${servings} ${yieldUnit}`,
    },
    difficulty: { overall: Math.min(overall, 5), notes: null },
    allergens: { contains: allergens, may_contain: [], free_of_certifications: [] },
    matched_components: [],
    variations_meta: [],
  };
}

// ── Helpers ──

function guessRole(name: string): string {
  const lower = name.toLowerCase();
  if (/chicken|beef|pork|salmon|shrimp|tofu|tempeh|turkey|lamb|fish|sausage/.test(lower)) return "protein";
  if (/flour|rice|pasta|noodle|bread|tortilla|quinoa|oat/.test(lower)) return "grain";
  if (/butter|oil|ghee|lard|shortening/.test(lower)) return "fat";
  if (/salt|pepper|cumin|paprika|cinnamon|turmeric|oregano|chili powder|cayenne/.test(lower)) return "seasoning";
  if (/sugar|honey|maple|molasses|agave/.test(lower)) return "sweetener";
  if (/milk|cream|yogurt|cheese|sour cream|buttermilk/.test(lower)) return "dairy";
  if (/lemon|lime|vinegar/.test(lower)) return "acid";
  if (/baking soda|baking powder|yeast/.test(lower)) return "leavener";
  if (/basil|cilantro|parsley|thyme|rosemary|mint|dill|sage|chive/.test(lower)) return "herb";
  if (/soy sauce|hot sauce|worcestershire|fish sauce|tomato paste/.test(lower)) return "sauce";
  if (/broth|stock|water|coconut milk/.test(lower)) return "liquid";
  if (/onion|garlic|celery|carrot|ginger|shallot/.test(lower)) return "vegetable";
  if (/tomato|potato|squash|pepper|zucchini|corn|spinach|kale|broccoli|cauliflower/.test(lower)) return "vegetable";
  if (/banana|apple|berry|lemon|orange|mango|avocado/.test(lower)) return "fruit";
  if (/almond|walnut|pecan|cashew|peanut|pistachio|pine nut/.test(lower)) return "nut";
  if (/egg/.test(lower)) return "dairy";
  if (/vanilla|chocolate|cocoa/.test(lower)) return "sweetener";
  return "vegetable";
}

function mostCommon(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const v of arr) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}
