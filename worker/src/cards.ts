/**
 * Card schema and stream builders.
 *
 * A recipe is an ordered stream of typed cards. Every field a user interacts
 * with is a card. The same cards render differently in browse/build/cook/remix.
 */

// ============================================================
// Card types
// ============================================================

export type CardType =
  // Identity
  | "title"
  | "description"
  | "photo"
  | "canonical_badge"
  // Classification
  | "tag_chips"
  | "time"
  | "yield"
  // Ingredients
  | "ingredient_group"
  | "ingredient"
  | "optional_ingredients"
  // Equipment
  | "equipment"
  // Steps
  | "step"
  | "timer"
  | "rest"
  | "parallel_task"
  // Enrichment
  | "variation_chips"
  | "storage"
  | "serving"
  // Contextual / dynamic
  | "hook"
  | "pitfall"
  | "causal_rule"
  | "swap"
  | "suggestion"
  | "diff"
  | "explanation"
  | "param";

export type LockState = "user" | "inferred" | "locked";
export type CardSource = "canonical" | "user" | "graph" | "session";

export interface Card<T = any> {
  id: string;
  type: CardType;
  content: T;
  lock: LockState;
  source: CardSource;
  // Data binding path into the recipe tree (e.g., "ingredients[0].quantity")
  binding?: string;
  // Metadata
  meta?: {
    editable?: boolean;
    deletable?: boolean;
    reorderable?: boolean;
    why?: string;           // Explanation for inference
    origin_count?: number;  // How many recipes this derives from (internal only)
  };
}

// ============================================================
// Card content shapes
// ============================================================

export interface TitleContent {
  title: string;
  canonical_id?: number;
}

export interface TagChipsContent {
  chips: Array<{ label: string; type: "composition" | "meal" | "sweet_savory" | "diet" | "method" | "equipment" | "cuisine" }>;
}

export interface TimeContent {
  prep_min?: number;
  cook_min?: number;
  total_min?: number;
  idle_min?: number;
}

export interface YieldContent {
  unit: "serves" | "makes";
  amount: number;
  item?: string;  // "cookies", "loaves", etc.
}

export interface IngredientGroupContent {
  label: string;  // "For the batter", "Main", "Topping"
}

export interface IngredientContent {
  name: string;
  canonical?: string;
  quantity?: number;
  unit?: string;
  prep?: string;       // "mashed", "finely chopped"
  optional?: boolean;
  notes?: string;
  role?: string;       // protein, fat, sweetener, etc.
  frequency?: number;  // 0-1 consensus frequency (internal)
}

export interface OptionalIngredientsContent {
  label: string;
  ingredients: IngredientContent[];
  collapsed: boolean;
}

export interface EquipmentContent {
  required: string[];
  alternatives?: { [item: string]: string[] };
}

export interface StepContent {
  index: number;
  text: string;
  primary_verb?: string;
  ingredient_refs?: string[];     // names of ingredients used
  equipment_refs?: string[];
  temp_f?: number;
  time_min?: { min: number; max?: number };
  heat_level?: string;
  sensory_cues?: string[];
  tips?: string[];
  warnings?: string[];
}

export interface TimerContent {
  label: string;
  duration_min: number;
  auto_start?: boolean;
}

export interface RestContent {
  action: string;       // "rise", "chill", "rest", "marinate", "cool"
  duration_min: number;
  temperature?: string; // "room temp", "fridge", "freezer"
}

export interface ParallelTaskContent {
  while_doing: string;  // what's happening concurrently
  suggested_task: string;
}

export interface VariationChipsContent {
  variations: Array<{
    label: string;
    recipe_count?: number;
    active?: boolean;
  }>;
}

export interface HookContent {
  trigger: string;       // "fold + dry_ingredients"
  tip: string;
  why?: string;
}

export interface PitfallContent {
  warning: string;
  frequency: number;     // how often this pitfall is mentioned
}

export interface CausalRuleContent {
  explanation: string;
  technique?: string;
}

export interface SwapContent {
  from: string;
  to: string;
  cascading_effects?: string[];
}

export interface ParamContent {
  param: "temperature" | "time" | "servings" | "pan_size";
  current: number | string;
  median?: number;
  range?: [number, number];
  unit?: string;
}

// ============================================================
// Stream builder — convert a canonical dish to a card stream
// ============================================================

interface CanonicalIngredient {
  name: string;
  frequency: number;
  role?: string;
  quantity?: number;
  unit?: string;
}

interface CanonicalDish {
  id: number;
  canonical_title: string;
  composition?: string;
  sweet_savory?: string;
  meals?: string;           // JSON string
  methods?: string;          // JSON string
  equipment?: string;        // JSON string
  recipe_count?: number;
  core_ingredients?: string;     // JSON string
  expected_ingredients?: string; // JSON string
  optional_ingredients?: string; // JSON string
  consensus_servings?: number;
  consensus_total_time?: number;
  consensus_cook_time?: number;
  consensus_prep_time?: number;
}

interface CanonicalVariation {
  variation_label: string;
  recipe_count?: number;
}

function parseJson<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function titleCase(s: string): string {
  return s.split(" ").map(w =>
    w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w
  ).join(" ");
}

let cardIdCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++cardIdCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Build a card stream from a canonical dish.
 * This is the default render for a dish — user edits to customize.
 */
export function buildStreamFromCanonical(
  dish: CanonicalDish,
  variations: CanonicalVariation[] = []
): Card[] {
  const stream: Card[] = [];

  // 1. Title
  stream.push({
    id: nextId("title"),
    type: "title",
    content: {
      title: titleCase(dish.canonical_title),
      canonical_id: dish.id,
    } as TitleContent,
    lock: "inferred",
    source: "canonical",
    binding: "identity.title",
    meta: { editable: true },
  });

  // 2. Canonical badge
  stream.push({
    id: nextId("badge"),
    type: "canonical_badge",
    content: { text: "Spence's canonical recipe" },
    lock: "inferred",
    source: "canonical",
    meta: { editable: false, deletable: false },
  });

  // 3. Tag chips
  const chips: TagChipsContent["chips"] = [];
  if (dish.composition) chips.push({ label: dish.composition, type: "composition" });
  if (dish.sweet_savory && dish.sweet_savory !== "savory") chips.push({ label: dish.sweet_savory, type: "sweet_savory" });
  const meals: string[] = parseJson(dish.meals, []);
  meals.forEach(m => chips.push({ label: m, type: "meal" }));
  const methods: string[] = parseJson(dish.methods, []);
  methods.forEach(m => chips.push({ label: m, type: "method" }));
  if (chips.length > 0) {
    stream.push({
      id: nextId("tags"),
      type: "tag_chips",
      content: { chips } as TagChipsContent,
      lock: "inferred",
      source: "canonical",
      binding: "classification",
    });
  }

  // 4. Time
  if (dish.consensus_total_time || dish.consensus_cook_time || dish.consensus_prep_time) {
    stream.push({
      id: nextId("time"),
      type: "time",
      content: {
        prep_min: dish.consensus_prep_time,
        cook_min: dish.consensus_cook_time,
        total_min: dish.consensus_total_time,
      } as TimeContent,
      lock: "inferred",
      source: "canonical",
      binding: "structure.time",
    });
  }

  // 5. Yield
  if (dish.consensus_servings) {
    const unit = dish.composition === "baked_good" ? "makes" : "serves";
    stream.push({
      id: nextId("yield"),
      type: "yield",
      content: { unit, amount: dish.consensus_servings } as YieldContent,
      lock: "inferred",
      source: "canonical",
      binding: "structure.yield",
    });
  }

  // 6. Ingredient group header
  stream.push({
    id: nextId("group"),
    type: "ingredient_group",
    content: { label: "Main" } as IngredientGroupContent,
    lock: "inferred",
    source: "canonical",
  });

  // 7. Core ingredients (always visible)
  const core: CanonicalIngredient[] = parseJson(dish.core_ingredients, []);
  for (const ing of core) {
    stream.push({
      id: nextId("ing"),
      type: "ingredient",
      content: {
        name: ing.name,
        canonical: ing.name,
        quantity: ing.quantity ?? undefined,
        unit: ing.unit ?? undefined,
        role: ing.role,
        frequency: ing.frequency,
      } as IngredientContent,
      lock: "inferred",
      source: "canonical",
      binding: `ingredients.${ing.name}`,
      meta: { editable: true, deletable: true, origin_count: dish.recipe_count },
    });
  }

  // 8. Expected ingredients
  const expected: CanonicalIngredient[] = parseJson(dish.expected_ingredients, []);
  for (const ing of expected) {
    stream.push({
      id: nextId("ing"),
      type: "ingredient",
      content: {
        name: ing.name,
        canonical: ing.name,
        quantity: ing.quantity ?? undefined,
        unit: ing.unit ?? undefined,
        role: ing.role,
        frequency: ing.frequency,
      } as IngredientContent,
      lock: "inferred",
      source: "canonical",
      binding: `ingredients.${ing.name}`,
      meta: { editable: true, deletable: true },
    });
  }

  // 9. Optional ingredients (collapsed group)
  const optional: CanonicalIngredient[] = parseJson(dish.optional_ingredients, []);
  if (optional.length > 0) {
    stream.push({
      id: nextId("optgroup"),
      type: "optional_ingredients",
      content: {
        label: "Common add-ins",
        ingredients: optional.map(ing => ({
          name: ing.name,
          canonical: ing.name,
          quantity: ing.quantity ?? undefined,
          unit: ing.unit ?? undefined,
          role: ing.role,
          frequency: ing.frequency,
          optional: true,
        })),
        collapsed: true,
      } as OptionalIngredientsContent,
      lock: "inferred",
      source: "canonical",
    });
  }

  // 10. Equipment (inferred from composition + recipe)
  const equipmentList = parseJson<string[]>(dish.equipment, []);
  if (equipmentList.length > 0) {
    stream.push({
      id: nextId("equip"),
      type: "equipment",
      content: { required: equipmentList } as EquipmentContent,
      lock: "inferred",
      source: "canonical",
      binding: "equipment",
    });
  }

  // 11. Variations
  if (variations.length > 0) {
    stream.push({
      id: nextId("var"),
      type: "variation_chips",
      content: {
        variations: variations.map(v => ({
          label: v.variation_label,
          recipe_count: v.recipe_count,
        })),
      } as VariationChipsContent,
      lock: "inferred",
      source: "canonical",
      binding: "enrichment.variations",
    });
  }

  return stream;
}

/**
 * Build an empty blank stream for a new recipe.
 * All cards are empty but pre-positioned.
 */
export function buildBlankStream(): Card[] {
  const stream: Card[] = [];

  stream.push({
    id: nextId("title"),
    type: "title",
    content: { title: "" } as TitleContent,
    lock: "user",
    source: "user",
    binding: "identity.title",
    meta: { editable: true, deletable: false },
  });

  stream.push({
    id: nextId("tags"),
    type: "tag_chips",
    content: { chips: [] } as TagChipsContent,
    lock: "user",
    source: "user",
    binding: "classification",
  });

  stream.push({
    id: nextId("time"),
    type: "time",
    content: {} as TimeContent,
    lock: "user",
    source: "user",
    binding: "structure.time",
  });

  stream.push({
    id: nextId("yield"),
    type: "yield",
    content: { unit: "serves", amount: 4 } as YieldContent,
    lock: "user",
    source: "user",
    binding: "structure.yield",
  });

  stream.push({
    id: nextId("group"),
    type: "ingredient_group",
    content: { label: "Main" } as IngredientGroupContent,
    lock: "user",
    source: "user",
  });

  return stream;
}
