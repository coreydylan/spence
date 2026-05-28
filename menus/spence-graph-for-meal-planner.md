# Spence Recipe Graph Assessment For The Personal Meal Planner

Question: is the existing Spence recipe graph useful for a personal, flexible, graphical mise/menu planner?

Short answer: yes, but as the culinary intelligence substrate, not as the whole planner.

The existing graph can answer "what ingredients, recipes, formats, techniques, and pairings are connected?" The missing layer is "what state is this ingredient in, what can it become next, when should I prep it, and how does that affect the week?"

## What Exists Locally

### Recipe Graph DB

File: `data-pipeline/output/recipe_graph.db`

Tables:

- `recipes`
- `ingredients`
- `recipe_ingredients`
- `ingredient_edges`
- `techniques`
- `recipe_techniques`
- `ingredient_groups`
- `ingredient_group_members`

Counts checked:

- 16,527 recipes.
- 3,480 ingredients.
- 125,126 recipe-ingredient links.
- 8,041 ingredient edges.
- 40 techniques.
- 60,807 recipe-technique links.

Useful for:

- ingredient -> recipes,
- ingredient -> other ingredients,
- recipe -> ingredient set,
- recipe -> techniques,
- basic graph traversal.

### Ingredient Edge DB

File: `data-pipeline/output/ingredient_edges.db`

Counts checked:

- 50,833 co-occurrence edges.

Schema:

- `from_ingredient`
- `to_ingredient`
- `cooccurrence`
- `pmi`
- `npmi`
- `freq_from`
- `freq_to`

Useful for:

- pairings,
- co-occurrence,
- affinity suggestions,
- "what often appears with chickpeas/tahini/asparagus?"

Limit:

- It is statistical co-occurrence, not culinary state logic.
- It can be noisy without ingredient cleanup. Example chickpea edges included valid signals like tahini, turmeric, harissa, farro, couscous, hummus, preserved lemon, cucumber, and mustard, but also unit/noise terms like liters, gram, milliliter.

### Composition DB

File: `data-pipeline/output/recipe_compositions_v2.db`

Counts checked:

- 41,234 classified recipes.

Top composition counts:

- baked_good: 10,011
- soup: 4,587
- pasta: 2,596
- eggs: 2,571
- salad: 2,367
- sandwich: 2,169
- taco: 1,695
- curry: 1,505
- dip: 1,230
- stir_fry: 1,220
- pizza: 662
- bowl: 535

Useful for:

- turning an ingredient set into dish-format candidates,
- enforcing variety across the week,
- preventing seven bowls in a row,
- finding format pivots for the same ingredients.

### Technique Graph DB

File: `data-pipeline/output/technique_graph.db`

Counts checked:

- `technique_ingredient`: 57,455
- `technique_equipment`: 7,584
- `technique_sequence`: 10,728
- `technique_params`: 1,535
- `composition_technique`: 13,151

Useful for:

- technique/equipment implications,
- detecting active stations,
- connecting ingredients to likely verbs,
- suggesting parallel tasks.

Limit:

- It is mined from recipe text, so some verbs are generic.
- It helps generate station candidates, but it does not yet model household prep states.

### Canonical Recipes DB

File: `data-pipeline/output/canonical_recipes.db`

Counts checked:

- 1,590 canonical recipes.

Useful for:

- canonical dish clusters,
- expected/core/optional ingredients,
- variations,
- composition,
- meal tags,
- consensus time/servings.

Example useful outputs:

- chickpea -> falafel, Mediterranean chickpea salad, chana masala, hummus variations, crispy roasted chickpeas, bean salads.
- edamame/tahini -> edamame hummus.
- lentil -> lentil salad.

Limit:

- Some canonical rows still need editorial cleanup.
- The current canonical recipe table is dish-centric, not week-plan-centric.

### Worker API

File: `worker/src/index.ts`

Existing endpoints:

- `GET /builder/search`
- `POST /builder/suggest`
- `POST /builder/recipes`
- `POST /builder/components`
- `POST /builder/dishes`
- `GET /seasonal`

Wrangler binding:

- `recipe-graph-db` D1 database in `worker/wrangler.toml`.

What the endpoints do:

- search canonical ingredients,
- suggest ingredient affinities,
- find matching recipes,
- detect components,
- detect dish candidates,
- query geo-seasonal produce.

Important caveat:

- The local `data-pipeline/output/ingest.db` has `raw_recipes` and `parsed_ingredients`, but its `canonical_ingredients`, `ingredient_edges`, `recipe_classifications`, `parsed_techniques`, and `parsed_equipment` tables are empty in this checkout.
- The built output DBs have the useful data.
- The Worker code is active, but queryability depends on whether the Cloudflare D1 database has been populated with the corresponding tables. I did not verify the remote D1 state.

## How It Helps The Personal Planner

The Spence graph should power these planner layers:

### 1. Ingredient Affinity

Input:

```text
chickpeas, tahini, cucumber
```

Graph can suggest:

```text
mint, parsley, turmeric, harissa, couscous, farro, preserved lemon, feta, mustard, yogurt
```

Planner use:

- propose flavor routes,
- fill missing supporting ingredients,
- rank likely combinations.

### 2. Format Diversity

Input:

```text
chickpeas + spring vegetables
```

Composition graph can suggest:

```text
dip, salad, curry, sandwich, pasta, taco, bowl, pizza
```

Planner use:

- enforce different dish shapes across the week,
- avoid same-format repetition,
- map leftovers into different eating experiences.

### 3. Canonical Dish Families

Input:

```text
cooked chickpeas
```

Canonical graph can surface:

```text
hummus
falafel
chana masala
mediterranean chickpea salad
crispy roasted chickpeas
three bean salad
chickpea sandwich
```

Planner use:

- generate candidate branches,
- choose culturally distinct routes,
- use personal-library recipes as taste priors instead of strict recipes.

### 4. Techniques And Equipment

Input:

```text
Ooni hot, food processor dirty, Instant Pot active
```

Technique graph can help with:

- which ingredients commonly roast, blend, simmer, blanch, knead, toast, pickle,
- which equipment/techniques are implicated by a dish format,
- when a future branch becomes cheap.

Planner use:

```text
food_processor_dirty -> hummus + herb yogurt + edamame smash
Ooni_hot -> pizza + charred vegetables + flatbread dippers
Instant_Pot_active -> chickpeas + lentils/grains depending on timing
```

### 5. Seasonality

Existing `/seasonal` endpoint and produce profile work can feed:

- local seasonal candidates,
- peak/available months,
- produce descriptions,
- regional fallbacks.

Planner use:

- build the candidate ingredient set before menu generation,
- avoid generic "spring" menus that ignore local microclimate.

## What Is Missing

The current graph is mostly a recipe/ingredient graph.

The new planner needs a mise graph:

```text
ingredient state -> transformation -> component -> meal use -> storage window -> next transformation
```

Missing tables/objects:

- ingredient states,
- mise edges,
- component inventory,
- prep task dependencies,
- storage windows,
- quality clocks,
- station activation rules,
- cuisine grammar routes,
- household schedule constraints,
- planned leftovers,
- actual leftovers,
- user feedback on what lingered or got eaten fast.

## Proposed Graph Model

### Node Types

- ingredient
- ingredient_state
- component
- recipe
- canonical_dish
- cuisine_grammar
- technique
- equipment
- station
- storage_container
- meal_slot
- prep_task
- shopping_item
- leftover_state

### Edge Types

- `co_occurs_with`
- `substitutes_for`
- `is_family_of`
- `can_transform_to`
- `requires_technique`
- `uses_equipment`
- `activates_station`
- `stores_as`
- `expires_after`
- `fits_meal_slot`
- `belongs_to_cuisine_grammar`
- `supports_format`
- `derived_from_recipe`
- `inspired_by_personal_recipe`
- `scheduled_before`
- `blocks`
- `creates_leftover`

### Example

```text
dry_chickpeas
  -> soaked_chickpeas
    -> falafel_mix
      -> falafel_pita

dry_chickpeas
  -> cooked_chickpeas
    -> hummus
      -> snack_box_dip
    -> crispy_chickpeas
      -> salad_topping
    -> chana_masala
      -> dinner
```

The current graph can suggest the dish and ingredient targets. The new mise graph decides the state path.

## Graphical Product Idea

The user experience could be a live graph canvas plus a weekly timeline.

User can plug in:

- ingredients they have,
- recipes they like,
- seasonal produce,
- desired cuisines,
- equipment,
- available cooking windows.

The graph updates with:

- candidate ingredients,
- candidate components,
- possible transformations,
- dish families,
- prep dependencies,
- storage windows,
- meal slots,
- shopping gaps.

Deterministic engine handles:

- constraints,
- dependencies,
- food safety windows,
- quantities,
- schedule feasibility,
- vegetarian filters,
- equipment conflicts.

AI agent handles:

- creative cuisine pivots,
- menu synthesis,
- taste reasoning,
- pruning boring branches,
- writing final recipes/prep notes,
- explaining tradeoffs.

The final plan is not "AI made seven recipes." It is:

```text
graph search + constraint scheduling + taste-agent synthesis + recipe rendering
```

## Recommendation

Use Spence as the base.

Do not rebuild ingredient intelligence, recipe matching, composition classification, technique mining, or seasonality from scratch.

Build a scoped personal planner on top:

1. Normalize the personal recipe/Paprika/Instagram set into taste priors.
2. Add ingredient-state and mise-edge tables.
3. Add a weekly planning object with meal slots, prep sessions, and component inventory.
4. Query Spence graph for candidate branches and dish families.
5. Score candidates with seasonality, personal taste, vegetarian constraints, variety, and prep efficiency.
6. Let an AI agent synthesize the final menu from the scored candidate graph.
7. Render a graphical graph/timeline view and an executable recipe pack.

That would be genuinely interesting and different from a normal recipe app.
