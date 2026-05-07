/**
 * CanonicalRecipe — The structured source-of-truth object.
 * Prose is one rendering of this structure.
 */

// ============================================================
// Enums
// ============================================================

export type Composition =
  | "baked_good" | "soup" | "pasta" | "curry" | "salad" | "bowl"
  | "stir_fry" | "pizza" | "sandwich" | "taco" | "casserole"
  | "dip" | "drink" | "eggs" | "component" | "dessert"
  | "preserve" | "snack";

export type IngredientRole =
  | "protein" | "base" | "vegetable" | "fruit" | "dairy" | "fat"
  | "seasoning" | "herb" | "sauce" | "sweetener" | "leavener"
  | "acid" | "nut" | "liquid" | "thickener" | "grain" | "legume";

export type ComponentRole =
  | "protein" | "base" | "vegetable" | "sauce" | "condiment"
  | "topping" | "base_dough" | "liquid" | "dressing";

export type StepPhase =
  | "mise_en_place" | "prep" | "cook" | "combine"
  | "finish" | "rest" | "serve";

export type HeatLevel =
  | "high" | "medium-high" | "medium" | "medium-low" | "low";

export type Meal = "breakfast" | "brunch" | "lunch" | "dinner" | "snack" | "dessert" | "drink";
export type Diet = "vegan" | "vegetarian" | "gluten-free" | "dairy-free" | "keto" | "paleo" | "whole30";
export type Season = "spring" | "summer" | "fall" | "winter" | "year-round";
export type SweetSavory = "sweet" | "savory" | "both";
export type Effort = "weeknight" | "weekend" | "project";

export type RequiredState =
  | "room_temp" | "cold" | "warm" | "hot" | "softened" | "melted" | "frozen" | "chilled";

export type Importance = "core" | "expected" | "optional";
export type SensoryModality = "visual" | "tactile" | "olfactory" | "auditory";
export type CookingMethod =
  | "stovetop" | "oven" | "bake" | "roast" | "broil" | "grill"
  | "instant_pot" | "slow_cooker" | "rice_cooker" | "air_fryer"
  | "microwave" | "sous_vide" | "smoker" | "bread_machine"
  | "no_cook" | "raw" | "sheet_pan" | "skillet" | "dutch_oven";

// ============================================================
// Yield
// ============================================================

export interface YieldSpec {
  canonical_amount: number;
  canonical_unit: string;                // "cups" | "slices" | "loaves" | "servings"
  canonical_item: string | null;
  servings?: number | null;              // for composite dishes
  servings_unit?: string | null;          // "slices", "bowls", "tacos"

  // Transformation info (for components that cook/reduce)
  input_amount: number | null;
  input_unit: string | null;
  transformation_ratio: number | null;   // output / input (e.g. 2.0 = doubles)

  // Weight info
  weight_grams: number | null;
  input_weight_grams: number | null;

  // Vessel context
  pan_size: string | null;

  display: string;                       // human-readable ("Makes 2 cups (from 1 cup raw)")
}

// ============================================================
// Time
// ============================================================

export interface TimeSpec {
  prep_min: number;
  cook_min: number;
  active_min: number;       // hands-on time
  idle_min: number;         // waiting, rising, cooling
  total_min: number;
}

// ============================================================
// Ingredients
// ============================================================

export interface IngredientAlternative {
  name: string;
  impact: string;            // "denser crumb" | "richer flavor"
  ratio: number;             // 1.0 = direct 1:1 swap
}

export type ScalingType = "linear" | "sublinear" | "fixed" | "stepped";

export interface ScalingRule {
  type: ScalingType;
  factor: number | null;          // for sublinear: e.g. 0.75 means 2x recipe = 1.5x this ingredient
  note: string | null;            // "salt scales sublinearly — taste before adding more"
}

export interface CanonicalIngredient {
  role: IngredientRole;
  canonical_name: string;
  consensus_qty: number | null;
  unit: string | null;
  prep: string | null;
  required_state: RequiredState | null;
  state_timing: string | null;    // "pull from fridge 30 min before starting"
  importance: Importance;
  frequency: number;              // 0-1 corpus frequency (internal)
  slot_position: string | null;
  alternatives: IngredientAlternative[];
  scaling: ScalingRule | null;
}

export interface IngredientGroup {
  label: string;
  slot: string | null;
  component_ref: string | null;  // references another CanonicalRecipe id
  items: CanonicalIngredient[];
}

// ============================================================
// Equipment
// ============================================================

export interface EquipmentItem {
  item: string;
  count: number;
  purpose: string;
  required: boolean;
  alternatives: string[];
  step_indices: number[];
}

export interface EquipmentSpec {
  full_inventory: EquipmentItem[];
  bowl_strategy: string;     // "one bowl" | "two bowls (wet + dry)"
  consumables: string[];     // ["parchment paper", "butter for greasing"]
}

// ============================================================
// Steps
// ============================================================

export interface ActionRef {
  verb: string;
  technique_ref: string | null;
}

export interface StrategyOverride {
  strategy_id: string;                        // "hand_mixer" | "by_hand" | "food_processor" | "immersion_blender"
  label: string;                              // "Hand mixer" | "By hand" | "Food processor"
  equipment: string[];                        // equipment required for this strategy
  prose: string;                              // rewritten step prose for this strategy
  parameter_changes: { [key: string]: any };  // e.g. { time_min: "8-10" } if by-hand takes longer
  cue_additions: string[];                    // extra sensory cues specific to this strategy
  note: string | null;                        // "takes ~2x longer than stand mixer"
}

export interface ConditionalHook {
  condition: string;                          // "if kitchen is warm (>75°F)" | "if using salted butter"
  advice: string;                             // "chill dough 10 min before scooping"
  priority: "subtle" | "important" | "critical";
}

export interface StepParameters {
  temperature_f: number | null;
  heat_level: HeatLevel | null;
  time: { min: number; max: number } | null;
  pan_size: string | null;
}

export interface SensoryCue {
  type: SensoryModality;
  text: string;
}

export interface CanonicalStep {
  index: number;
  phase: StepPhase;

  primary_action: ActionRef;
  secondary_actions: ActionRef[];

  ingredient_refs: string[];   // canonical_names used in this step
  equipment_refs: string[];

  parameters: StepParameters;

  sensory_cues: SensoryCue[];
  completion_signal: string | null;

  why_critical: boolean;
  causal_rule_ref: string | null;
  pitfall_refs: string[];
  expected_outcome: string | null;

  idle_time_min: number | null;
  parallel_task_hint: string | null;

  prose: string;
  expanded_explanation: string | null;

  // Equipment strategy variants — alternate prose for the same step
  // with different equipment (stand mixer vs hand mixer vs by hand)
  strategy_overrides: StrategyOverride[];

  // Step-level conditional tips that fire based on user/kitchen state
  conditional_hooks: ConditionalHook[];

  applies_to_variants: string[];  // ["base"] or ["base", "chocolate_chip"]
}

// ============================================================
// Method variants
// ============================================================

export interface MethodVariant {
  id: string;                           // "stovetop" | "instant_pot" | "baked"
  label: string;
  method: CookingMethod;
  is_default: boolean;
  equipment: string[];
  parameters: { [key: string]: any };   // method-specific params (water_ratio, etc.)
  steps: CanonicalStep[];
  total_time_min: number;
  notes?: string;                       // "smokier flavor" | "hands-off"
}

// ============================================================
// Variations
// ============================================================

export interface StepInsertion {
  insert_before_index: number;
  step: CanonicalStep;
}

export interface StepModification {
  step_index: number;
  ingredient_swap?: { from: string; to: string };
  parameter_change?: { field: string; new_value: any };
  prose_replace?: string;
  prose_append?: string;
}

export interface Variation {
  id: string;
  label: string;
  impact: string;
  step_insertions: StepInsertion[];
  step_modifications: StepModification[];
  step_skips: number[];
  ingredient_additions: CanonicalIngredient[];
  ingredient_swaps: { from: string; to: string }[];
  recipe_count: number;   // how many source recipes used this variant
}

// ============================================================
// Context hooks (dynamic card injection)
// ============================================================

export interface HookTrigger {
  step_index: number | null;
  ingredient_present: string | null;
  user_state: string | null;
}

export interface ContextHook {
  trigger: HookTrigger;
  card_type: "hook" | "pitfall" | "swap" | "why" | "technique";
  content: string;
  why: string;
}

// ============================================================
// Storage & Lifecycle
// ============================================================

export type StorageContainer =
  | "airtight_container" | "zip_bag" | "wrapped_in_plastic"
  | "wrapped_in_foil" | "covered_with_plastic" | "glass_jar"
  | "freezer_bag" | "vacuum_sealed" | "uncovered_on_counter";

export type StorageLocation =
  | "counter" | "pantry" | "fridge" | "freezer" | "cold_storage" | "wine_fridge";

export interface StoragePhase {
  location: StorageLocation;
  container: StorageContainer;
  duration_days: number | null;
  duration_max_days: number | null;
  notes: string | null;              // "let cool completely before sealing"
}

export interface ReheatMethod {
  method: string;                     // "oven" | "microwave" | "stovetop" | "air_fryer" | "toaster"
  temperature_f: number | null;
  duration_min: number | null;
  instructions: string;               // "325°F for 10 min, tent with foil"
  serving_tip: string | null;         // "add a splash of broth before reheating"
}

export interface FreezerInfo {
  can_freeze: boolean;
  freeze_duration_months: number | null;
  freeze_prep: string | null;         // "cool completely, wrap tightly in plastic then foil"
  thaw_method: string | null;         // "overnight in fridge" | "counter 1 hour"
  quality_note: string | null;        // "texture softens slightly after thawing"
  freeze_portions: string | null;     // "freeze individual slices wrapped separately"
}

export interface MakeAheadInfo {
  can_make_ahead: boolean;
  prep_ahead_days: number | null;       // full make-ahead days
  partial_prep_ahead: string | null;    // "prep dry ingredients + measure wet night before"
  improves_with_time: boolean;           // tastes better the next day
  improves_note: string | null;          // "flavors deepen after 24 hours"
}

export interface ServingInfo {
  serve_temperature: "hot" | "warm" | "room_temp" | "cold" | "chilled" | "frozen";
  serve_immediately: boolean;
  holds_well: boolean;                   // can sit out during meal without degrading
  holds_duration_hours: number | null;
  garnish_timing: string | null;         // "add garnishes just before serving"
}

export interface LeftoverInfo {
  generates_leftovers: boolean;
  storage: StoragePhase[];               // sequential storage stages if applicable
  reheat_methods: ReheatMethod[];
  freezer: FreezerInfo;
  refresh_tips: string[];                // ["add fresh herbs", "squeeze of lemon", "splash of olive oil"]
  second_day_dishes: string[];           // ["use in sandwiches", "turn into a salad"]
  safety_notes: string[];                // ["reheat to 165°F before serving"]
}

export interface LifecycleInfo {
  make_ahead: MakeAheadInfo;
  serving: ServingInfo;
  leftovers: LeftoverInfo;
}

// ============================================================
// Allergens
// ============================================================

export type Allergen =
  | "gluten" | "wheat" | "dairy" | "eggs" | "soy" | "tree_nuts"
  | "peanuts" | "shellfish" | "fish" | "sesame" | "sulfites"
  | "corn" | "nightshades";

export interface AllergenInfo {
  contains: Allergen[];
  may_contain: Allergen[];              // cross-contamination risk
  free_of_certifications: Allergen[];   // user can mark "verified GF"
}

// ============================================================
// Nutrition
// ============================================================

export interface NutritionInfo {
  per_serving: {
    calories: number | null;
    protein_g: number | null;
    fat_g: number | null;
    saturated_fat_g: number | null;
    carbs_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    sodium_mg: number | null;
    cholesterol_mg: number | null;
  };
  serving_size_g: number | null;
  is_estimate: boolean;                  // derived from ingredient data
  data_source: string;                    // "derived" | "verified"
}

// ============================================================
// Difficulty
// ============================================================

export interface DifficultyBreakdown {
  overall: number;                        // 1-5
  knife_skills: number;                   // 1-5
  timing_sensitivity: number;             // 1-5 (does timing matter? dough rising, custards)
  technique_complexity: number;           // 1-5
  active_attention: number;               // 1-5 (hands-busy vs set-it-and-forget-it)
  equipment_dependency: number;           // 1-5 (need specialty gear?)
  recovery_tolerance: number;             // 1-5 (how forgiving of mistakes)
  notes: string | null;                    // "main challenge is not overmixing"
}

// ============================================================
// Troubleshooting
// ============================================================

export interface TroubleshootingEntry {
  symptom: string;                         // "bread is gummy in the center"
  likely_causes: string[];                 // ["underbaked", "too much banana", "sliced too soon"]
  fix: string;                             // "bake 5-10 min longer next time; test with toothpick"
  prevention: string | null;               // "always wait 15 min before slicing"
}

// ============================================================
// Success Indicators
// ============================================================

export interface SuccessIndicator {
  dimension: "appearance" | "texture" | "flavor" | "aroma";
  description: string;                     // "top is deeply golden, cracked down the middle"
}

// ============================================================
// Pairings
// ============================================================

export type PairingCategory =
  | "side" | "beverage" | "sauce" | "topping" | "accompaniment"
  | "dessert" | "starter" | "garnish";

export interface Pairing {
  category: PairingCategory;
  name: string;                            // "strong black coffee"
  reason: string | null;                    // "the bitterness balances the sweetness"
  recipe_ref?: string | null;               // link to another canonical recipe if applicable
}

// ============================================================
// Tags
// ============================================================

export interface RecipeTags {
  meal: Meal[];
  diet: Diet[];
  cuisine: string | null;
  sweet_savory: SweetSavory;
  effort: Effort;
  season: Season[];
}

// ============================================================
// Top-level object
// ============================================================

export interface CanonicalRecipe {
  // Identity
  id: string;
  title: string;
  description: string;
  composition: Composition;
  category: string;

  // Classification
  tags: RecipeTags;

  // Structure
  yield: YieldSpec;
  time: TimeSpec;

  // Component flags
  is_component: boolean;
  component_role: ComponentRole | null;
  can_be_used_in: Composition[];

  // Ingredients
  ingredient_groups: IngredientGroup[];

  // Equipment
  equipment: EquipmentSpec;

  // Methods (different cooking paths — "stovetop" vs "instant pot" rice)
  method_variants: MethodVariant[];
  default_method: string;           // id of default method variant

  // Steps (base path — most recipes have only one method, use these)
  steps: CanonicalStep[];

  // Variations (ingredient-level differences — "chocolate chip", "vegan")
  variations: Variation[];

  // Sub-recipes (multi-component dishes with inline prep)
  sub_recipes: CanonicalRecipe[];

  // Dynamic cards
  context_hooks: ContextHook[];

  // Lifecycle: make-ahead, serving, leftovers, freezing, reheating
  lifecycle: LifecycleInfo;

  // Allergens (auto-derived + manual)
  allergens: AllergenInfo;

  // Nutrition (derived from ingredient data)
  nutrition: NutritionInfo;

  // Difficulty breakdown (multi-dimensional)
  difficulty: DifficultyBreakdown;

  // Troubleshooting (recipe-level)
  troubleshooting: TroubleshootingEntry[];

  // Success indicators (what "right" looks like)
  success_indicators: SuccessIndicator[];

  // Pairings (what to serve with this)
  pairings: Pairing[];

  // Internal provenance (never shown to users)
  _internal: {
    source_recipe_ids: number[];
    confidence_score: number;       // 0-1
    corpus_count: number;
    last_computed: string;          // ISO timestamp
    reviewed_at: string | null;
    reviewer: string | null;
    status: "draft" | "ai_drafted" | "linted" | "reviewed" | "published";
  };
}
