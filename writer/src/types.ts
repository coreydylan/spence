/**
 * Card types — copied from worker/src/cards.ts
 * This is the document model. Every field in a recipe is a Card.
 */

export type CardType =
  | "title"
  | "description"
  | "photo"
  | "canonical_badge"
  | "tag_chips"
  | "time"
  | "yield"
  | "ingredient_group"
  | "ingredient"
  | "optional_ingredients"
  | "equipment"
  | "step"
  | "timer"
  | "rest"
  | "parallel_task"
  | "variation_chips"
  | "storage"
  | "serving"
  | "hook"
  | "pitfall"
  | "causal_rule"
  | "swap"
  | "suggestion"
  | "diff"
  | "explanation"
  | "param"
  // Composition template card types
  | "composition_header"
  | "variant_set_carousel"
  | "slot"
  | "multi_slot";

export type LockState = "user" | "inferred" | "locked";
export type CardSource = "canonical" | "user" | "graph" | "session";

export interface Card<T = any> {
  id: string;
  type: CardType;
  content: T;
  lock: LockState;
  source: CardSource;
  binding?: string;
  meta?: {
    editable?: boolean;
    deletable?: boolean;
    reorderable?: boolean;
    why?: string;
    origin_count?: number;
  };
}

// Content shapes

export interface TitleContent {
  title: string;
  canonical_id?: number;
}

export interface TagChipsContent {
  chips: Array<{
    label: string;
    type: "composition" | "meal" | "sweet_savory" | "diet" | "method" | "equipment" | "cuisine";
  }>;
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
  item?: string;
}

export interface IngredientGroupContent {
  label: string;
}

export interface IngredientContent {
  name: string;
  canonical?: string;
  quantity?: number;
  unit?: string;
  prep?: string;
  optional?: boolean;
  notes?: string;
  role?: string;
  frequency?: number;
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
  ingredient_refs?: string[];
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
  action: string;
  duration_min: number;
  temperature?: string;
}

export interface ParallelTaskContent {
  while_doing: string;
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
  trigger: string;
  tip: string;
  why?: string;
}

export interface PitfallContent {
  warning: string;
  frequency: number;
}

export interface SuggestionContent {
  text: string;
  action?: string;
  dismiss?: boolean;
}

// API response types

export interface DishSearchResult {
  id: number;
  canonical_title: string;
  composition: string;
  recipe_count: number;
  source_count?: number;
  consensus_total_time?: number;
  consensus_servings?: number;
}

export interface IngredientSearchResult {
  id: number;
  name: string;
  category?: string;
  total_count: number;
}

export interface AffinitySuggestion {
  id: number;
  name: string;
  category?: string;
  subcategory?: string;
  score: number;
  co_occurrence: number;
  flavor_profile?: string[];
}
