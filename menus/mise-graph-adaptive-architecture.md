# Mise-Graph Adaptive Architecture

Purpose: prevent the planner from becoming a static household recipe library. The system should be seasonal, adaptive, context-aware, and connected to the full Spence culinary graph.

## Core Correction

Do not build a static "household edge library" as the primary intelligence layer.

Build:

```text
global Spence culinary graph
+ global mise-edge ontology
+ household context
+ seasonal/local context
+ inventory context
+ equipment/schedule context
+ learned feedback
= resolved runtime mise graph
```

The household layer should not own most edges. It should mostly provide:

- preferences,
- constraints,
- equipment defaults,
- pantry defaults,
- disliked patterns,
- favorite patterns,
- learned weights,
- actual historical outcomes.

The planner should resolve a new graph every time the week changes.

## Layer Model

### 1. Global Spence Graph

Already exists.

Provides:

- canonical ingredients,
- ingredient affinities,
- canonical dishes,
- canonical components,
- composition templates,
- technique graph,
- equipment links,
- flavor compounds,
- produce profiles,
- regional seasonality,
- source trust.

This answers:

```text
What is culinarily possible?
What is known from the corpus?
What dishes/components does this ingredient participate in?
What techniques/equipment are associated?
What produce is seasonal nearby?
```

### 2. Global Mise-Edge Ontology

This is the new `mise_*` layer.

It should contain general culinary state transitions:

```text
dry chickpeas -> soaked chickpeas
cooked chickpeas -> hummus
cooked chickpeas -> crispy chickpeas
washed herbs -> chopped herb mix
washed herbs -> whole-leaf reserve
cucumber -> quick pickle
mixed dough -> cold-fermented dough
```

These are not household-specific. They are reusable culinary facts with metadata:

- required input state,
- output state,
- technique,
- equipment,
- active time,
- idle time,
- quality window,
- storage,
- cuisine grammars,
- meal formats,
- station tags,
- difficulty,
- source/confidence.

This answers:

```text
What can this ingredient become?
What state does it need to be in?
What prep opportunity is created when a station is active?
```

### 3. Household Profile

This should be relatively small and mostly stable.

Examples:

- vegetarian at home,
- 2 people,
- one afternoon/evening cooking session per day,
- breakfast/lunch/snack-box preferences,
- Ooni, Instant Pot, food processor,
- loves homemade breads,
- prefers dry beans/grains,
- no hard vetoes,
- microclimate/home location,
- shopping habits.

This answers:

```text
What is allowed?
What is easy for this household?
What equipment is available?
What defaults should the planner assume?
```

### 4. Household Taste Priors

Derived from Instagram/Paprika/past plans.

These are not direct recipes. They become weights:

- frequent ingredients,
- favorite sauce families,
- favorite formats,
- cuisine clusters,
- texture preferences,
- project appetite,
- repetition tolerance,
- disliked or stale combinations.

This answers:

```text
What is this household likely to enjoy?
What does "interesting but still us" mean?
```

### 5. Current Context

This is different every run.

Inputs:

- date,
- location/microclimate,
- seasonal produce,
- pantry/inventory,
- fridge leftovers,
- equipment available this week,
- Ooni day,
- cooking windows,
- shopping constraints,
- ingredients user wants to use,
- recipes user wants to use as inspiration.

This answers:

```text
What is true this week?
What must be used?
What is newly available?
What should not be bought?
What days are constrained?
```

### 6. Learned Feedback

Captured after plans are cooked.

Examples:

- "we ate all the hummus fast,"
- "too much tahini/herb direction,"
- "Ooni Saturday worked,"
- "lentil salad lingered,"
- "weekday dough was too much,"
- "snack boxes were useful,"
- "falafel was too project-heavy."

This answers:

```text
What should the system adjust next time?
```

## Runtime Resolver

The planner should not directly read a household library and output a menu.

It should run a resolver:

```text
input context
  -> candidate seasonal ingredients
  -> candidate inventory ingredients
  -> candidate mise states
  -> candidate mise transitions
  -> candidate components/dishes
  -> candidate meal formats
  -> candidate prep tasks
  -> scored runtime graph
  -> scheduled weekly plan
```

## Edge Activation

An edge can exist globally but be inactive this week.

Example:

```text
dry chickpeas -> soaked chickpeas -> falafel mix
```

Why it may activate:

- user wants a project,
- herbs are abundant,
- Ooni/oven day is available,
- chickpeas are already soaking,
- personal taste prior likes falafel/mezze.

Why it may not activate:

- short weeknight schedule,
- dry chickpeas are being pressure-cooked instead,
- too many other processor tasks,
- fried/formed components are too much this week,
- menu already has enough chickpea outputs.

So the edge is not "in" or "out" permanently. It is scored.

## Edge Scoring

Each candidate edge should receive a contextual score.

Suggested dimensions:

- `seasonal_fit`
- `inventory_fit`
- `household_preference`
- `personal_recipe_signal`
- `equipment_fit`
- `station_reuse`
- `schedule_fit`
- `quality_window_fit`
- `format_variety`
- `cuisine_variety`
- `nutrition_fit`
- `waste_reduction`
- `prep_burden`
- `novelty`
- `confidence`

Hard filters:

- dietary constraints,
- food safety,
- impossible state transitions,
- missing required equipment when no substitute exists,
- schedule impossibility.

Soft penalties:

- too repetitive,
- too many sauces in same flavor family,
- too many processor tasks,
- too many short-window components,
- produce not actually seasonal,
- ingredient only used once.

## Data Model Adjustment

The existing `mise_edges` table should remain global.

Add or use these future tables for context and scoring:

### `household_profiles`

Stable household defaults.

Fields:

- people,
- diet constraints,
- equipment,
- location,
- pantry defaults,
- meal preferences,
- schedule defaults.

### `household_taste_priors`

Learned taste weights.

Fields:

- target type: ingredient/component/dish/cuisine/format/technique,
- target id/name,
- weight,
- evidence source,
- recency,
- confidence.

### `household_inventory_snapshots`

Current pantry/fridge/freezer state.

Fields:

- item,
- quantity,
- unit,
- state,
- location,
- expires_at,
- confidence.

### `mise_edge_scores`

Ephemeral or persisted scoring traces for a planning run.

Fields:

- plan_id,
- edge_id,
- score_total,
- score_breakdown_json,
- activated,
- rejection_reason.

### `mise_context_runs`

Stores the context object used to resolve a plan.

Fields:

- household_id,
- run_date,
- location,
- date_range,
- inputs_json,
- candidate_graph_json,
- selected_graph_json,
- model_notes_json.

## API Shape

### Existing

```http
GET /mise-graph/expand?ingredients=chickpea,tahini
```

This should remain a low-level graph expansion endpoint.

### Needed Next

```http
POST /mise-graph/resolve
```

Input:

```json
{
  "household_id": "corey",
  "date_range": {
    "start": "2026-05-05",
    "end": "2026-05-11"
  },
  "location": {
    "lat": 32.7157,
    "lon": -117.1611,
    "label": "San Diego"
  },
  "constraints": {
    "diet": ["vegetarian"],
    "people": 2,
    "cook_sessions": "afternoon_evening_only"
  },
  "inventory": [
    {"name": "dry chickpeas", "state": "dry"},
    {"name": "tahini"},
    {"name": "flour"}
  ],
  "desired": {
    "formats": ["snack_box", "flatbread", "salad", "noodles"],
    "equipment_to_use": ["ooni", "instant_pot"],
    "breakfasts": ["chia", "overnight_oats"]
  }
}
```

Output:

```json
{
  "candidate_graph": {
    "nodes": [],
    "edges": []
  },
  "activated_edges": [],
  "rejected_edges": [],
  "candidate_components": [],
  "candidate_dishes": [],
  "seasonal_candidates": [],
  "score_breakdown": []
}
```

Then:

```http
POST /mise-graph/plan
```

Takes the resolved graph and produces:

- daily meals,
- component batches,
- prep schedule,
- shopping list,
- storage labels,
- recipes.

## Deterministic vs AI Responsibilities

### Deterministic

- graph traversal,
- dietary filtering,
- equipment filtering,
- seasonality lookup,
- inventory matching,
- quality-window math,
- dependency ordering,
- schedule feasibility,
- quantity rollups,
- shopping list aggregation.

### AI Agent

- culinary synthesis,
- cuisine pivots,
- pruning boring but technically valid branches,
- final menu narrative,
- detailed recipe writing,
- explaining tradeoffs,
- proposing new candidate mise edges when the graph is missing a useful transition.

AI-created edges should start as ephemeral suggestions. Persist them only after validation or repeated success.

## Practical Example

Input:

```text
date: early May
location: coastal San Diego
inventory: dry chickpeas, tahini, flour
equipment: Ooni, Instant Pot, food processor
household: vegetarian, snack boxes, homemade bread
```

Global graph says:

- chickpea pairs with tahini, pita, herbs, cucumber, cumin, turmeric.
- chickpea appears in hummus, falafel, chana masala, salads, curries.
- tahini appears in sauces, hummus, dressings.
- May San Diego supports asparagus, herbs, strawberries, radishes, greens.

Mise graph says:

- dry chickpeas can soak or pressure cook.
- cooked chickpeas can become hummus, crispy chickpeas, salad protein.
- flour can become fermented dough, flatbreads, pizza.
- herbs can split into chopped mix, whole-leaf reserve, stems for sauce.

Household context scores:

- pressure-cooked chickpeas high because dry beans preferred and Instant Pot exists.
- hummus high because snack boxes need dip.
- falafel medium/low this week if prep burden is already high.
- Ooni flatbread high if a weekend session exists.
- strawberries high for breakfast/snack boxes because seasonal and low prep.

Resolved plan emerges from scoring, not from static household edges.

## Design Principle

The household does not own a fixed library.

The household owns a lens.

The mise-graph is the flexible culinary state machine. The resolver projects it through the household lens, the season, the pantry, the equipment, and the schedule to create a plan.
