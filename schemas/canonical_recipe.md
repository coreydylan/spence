# CanonicalRecipe — The Source-of-Truth Object

A Spence canonical recipe is a **structured data object**. Prose is one rendering of it.

## Design Principles

1. **Structure is truth.** Prose is a view.
2. **Every field is typed and linkable.** No freeform text where structure can exist.
3. **Multi-mode rendering.** The same object renders as browse/cook/build/learn.
4. **Graph-linked.** Techniques, pitfalls, ingredients, causal rules all reference shared libraries.
5. **Source-invisible.** No attribution shown to users; provenance lives in `_internal`.
6. **Composable.** Variations, slots, and swaps are first-class.
7. **Living.** Confidence grows with corpus size. Fields can be null until enough data exists.

---

## Object Schema

```typescript
interface CanonicalRecipe {
  // === IDENTITY ===
  id: string;                    // stable ID
  title: string;                 // "Banana Bread"
  description: string;           // 2-3 sentence headnote
  composition: Composition;       // "baked_good" | "soup" | "bowl" | ...
  category: string;               // "quick_bread" | "cookies" | "sauced_pasta" | ...

  // === CLASSIFICATION (graph tags) ===
  tags: {
    meal: Meal[];                  // ["breakfast", "snack"]
    diet: Diet[];                  // ["vegetarian"]
    cuisine: string | null;         // "american" | "thai" | "indian" | ...
    sweet_savory: "sweet" | "savory" | "both";
    effort: "weeknight" | "weekend" | "project";
    season: Season[];              // ["year-round"] or ["fall", "winter"]
  };

  // === STRUCTURE ===
  yield: {
    amount: number;                // 10
    item: string;                   // "slices" | "servings" | "loaves" | "cookies"
  };
  time: {
    prep_min: number;
    cook_min: number;
    active_min: number;             // hands-on time
    idle_min: number;               // rising, cooling, resting
    total_min: number;
  };

  // === INGREDIENTS (typed tree) ===
  ingredient_groups: IngredientGroup[];

  // === EQUIPMENT ===
  equipment: {
    required: EquipmentItem[];
    alternatives: { [item: string]: string[] };
  };

  // === STEPS (structured DAG) ===
  steps: CanonicalStep[];

  // === VARIATIONS ===
  variations: Variation[];

  // === CONTEXT HOOKS (dynamic cards) ===
  context_hooks: ContextHook[];

  // === PROVENANCE (internal only) ===
  _internal: {
    source_recipe_ids: number[];
    confidence_score: number;      // 0-1
    corpus_count: number;           // how many recipes aggregated
    last_computed: string;          // ISO timestamp
  };
}

interface IngredientGroup {
  label: string;                   // "For the batter" | "Main"
  items: CanonicalIngredient[];
}

interface CanonicalIngredient {
  role: IngredientRole;             // "protein" | "base" | "fat" | "sweetener" | ...
  canonical_name: string;           // "banana"
  consensus_qty: number | null;
  unit: string | null;              // "cup" | "tsp" | "g"
  prep: string | null;              // "mashed" | "finely chopped" | "softened"
  importance: "core" | "expected" | "optional";
  frequency: number;                // 0-1, how often this appears across cluster
  slot_position: string | null;     // for composition-based recipes
  alternatives: {
    name: string;
    impact: string;                 // "richer, denser crumb"
    ratio: number;                   // 1.0 if 1:1 swap
  }[];
}

interface CanonicalStep {
  index: number;
  phase: StepPhase;                 // "mise_en_place" | "prep" | "cook" | "finish" | "serve"

  // ACTIONS
  primary_action: {
    verb: string;                    // "whisk" | "fold" | "bake"
    technique_ref: string | null;    // links to Technique library
  };
  secondary_actions: {
    verb: string;
    technique_ref: string | null;
  }[];

  // REFS
  ingredient_refs: string[];        // canonical_names used in this step
  equipment_refs: string[];

  // PARAMETERS
  parameters: {
    temperature_f: number | null;
    heat_level: HeatLevel | null;    // "high" | "medium-high" | "medium" | "medium-low" | "low"
    time: { min: number; max: number } | null;
    pan_size: string | null;
  };

  // SENSORY
  sensory_cues: {
    visual: string[];                 // ["golden brown", "set around the edges"]
    tactile: string[];                // ["toothpick comes out clean"]
    olfactory: string[];              // ["fragrant"]
    auditory: string[];               // ["sizzling stops"]
  };
  completion_signal: string | null;  // primary "done" indicator

  // TEACHING
  why_critical: boolean;
  causal_rule_ref: string | null;   // links to causal_rules library
  pitfall_refs: string[];            // links to pitfalls library
  expected_outcome: string | null;   // "batter will look curdled — that's fine"

  // TIMING
  idle_time_min: number | null;     // time where user isn't active
  parallel_task_hint: string | null; // "while this bakes, you can..."

  // RENDERING (generated from structure)
  prose: {
    browse: string;                  // default view
    cook: string;                    // hands-busy mode
    terse: string;                   // expert scan mode
  };
}

interface Variation {
  label: string;                    // "chocolate chip"
  impact: string;                   // "adds texture and sweetness"
  ingredient_additions: CanonicalIngredient[];
  ingredient_swaps: { from: string; to: string }[];
  parameter_changes: { step_index: number; change: string }[];
  recipe_count: number;              // how many source recipes used this variant
}

interface ContextHook {
  trigger: {
    step_index: number | null;       // fires at this step
    ingredient_present: string | null; // fires if ingredient is in recipe
    user_state: string | null;       // "first_time_cooking_this"
  };
  card_type: "hook" | "pitfall" | "swap" | "why" | "technique";
  content: string;
  why: string;                       // brief justification
}
```

---

## Supporting Library Schemas

### Technique
```typescript
interface Technique {
  id: string;                     // "fold" | "sear" | "braise"
  name: string;
  category: "combine" | "heat" | "prep" | "assembly" | "transformation" | "check" | "service";
  definition: string;             // one-sentence explanation
  procedure: string[];            // 3-6 step how-to
  purpose: string;                // the WHY
  difficulty: "easy" | "moderate" | "advanced";
  when_to_use: string[];
  pitfalls: string[];             // IDs
  variations: { name: string; description: string }[];
  equipment: { primary: string[]; alternatives: string[] };
  pairs_with: { precedes: string[]; follows: string[] };
  appears_in: {
    compositions: { name: string; frequency: number }[];
    ingredients: string[];
  };
  sensory_outcomes: {
    visual: string[];
    tactile: string[];
  };
  _internal: { source_frequency: number };
}
```

### Pitfall
```typescript
interface Pitfall {
  id: string;
  warning: string;                // "don't overmix"
  consequence: string;            // "creates tough, dense crumb"
  applies_to_techniques: string[]; // ["fold", "whisk", "stir"]
  applies_to_compositions: string[]; // ["baked_good"]
  frequency: number;              // how often mentioned in corpus
}
```

### CausalRule
```typescript
interface CausalRule {
  id: string;
  cause: string;                  // "cream butter and sugar"
  effect: string;                 // "incorporates air, makes cake light"
  why: string;                    // deeper scientific reason
  technique_ref: string;
  frequency: number;
}
```

### RecoveryRule
```typescript
interface RecoveryRule {
  id: string;
  problem: string;                // "batter is too thick"
  fix: string;                    // "add 1 tbsp water at a time"
  stage: string;                  // "during mixing"
  applies_to_techniques: string[];
}
```

---

## Enums

```typescript
type Composition =
  | "baked_good" | "soup" | "pasta" | "curry" | "salad" | "bowl"
  | "stir_fry" | "pizza" | "sandwich" | "taco" | "casserole"
  | "dip" | "drink" | "eggs" | "component" | "dessert"
  | "preserve" | "snack";

type IngredientRole =
  | "protein" | "base" | "vegetable" | "fruit" | "dairy" | "fat"
  | "seasoning" | "herb" | "sauce" | "sweetener" | "leavener"
  | "acid" | "nut" | "liquid" | "thickener" | "grain" | "legume";

type StepPhase =
  | "mise_en_place" | "prep" | "cook" | "combine"
  | "finish" | "rest" | "serve";

type HeatLevel =
  | "high" | "medium-high" | "medium" | "medium-low" | "low";

type Meal = "breakfast" | "brunch" | "lunch" | "dinner" | "snack" | "dessert" | "drink";
type Diet = "vegan" | "vegetarian" | "gluten-free" | "dairy-free" | "keto" | "paleo";
type Season = "spring" | "summer" | "fall" | "winter" | "year-round";
```

---

## Validation Rules

A CanonicalRecipe is valid if:

1. **Required fields present**: id, title, composition, steps (at least 3), ingredient_groups (at least 1)
2. **Steps**:
   - First step's `phase` is `"mise_en_place"` OR `"prep"`
   - Last step's `phase` is `"serve"` OR `"finish"` OR `"rest"`
   - Every cooking action step has at least one `sensory_cue` OR a `time` parameter with a completion signal
   - Every step's `ingredient_refs` must exist in `ingredient_groups`
3. **Ingredients**:
   - At least one ingredient has `importance: "core"`
   - Every ingredient has a `role`
4. **Time**: `prep_min + cook_min <= total_min + idle_min`
5. **Variations**: every `ingredient_swaps.from` must exist in base recipe
6. **Technique refs**: every `technique_ref` resolves to the Technique library
7. **Pitfall/causal refs**: every library reference resolves
