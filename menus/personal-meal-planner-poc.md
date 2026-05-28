# Personal Meal Planner POC

This is a scoped personal planner built on top of the existing Spence corpus, not a separate recipe app.

## What Spence Already Has

Spence already has most of the broad intelligence layer:

- Raw provenance: `data-pipeline/output/ingest.db` has source-aware recipes, including `instagram_captions` and `instagram_saved`.
- Canonical ingredient dictionary: normalized ingredient names, roles, categories, common preps.
- Ingredient affinity graph: `data-pipeline/output/ingredient_edges.db` has 50,833 PMI-scored co-occurrence edges.
- Ingredient hierarchy: `data-pipeline/output/ingredient_hierarchy.json` has `type_of` relationships and substitution-adjacent family logic.
- Composition model: `data-pipeline/compositions_v2.json` defines bowls, pastas, salads, dips, tacos, components, etc. with slots.
- Composition templates: `data-pipeline/output/composition_templates.json` has cuisine-patterned slot templates for bowls, salads, pasta, curry, tacos, soups, and stir-fries.
- Component detection: `data-pipeline/extract_components_v2.py` and related outputs identify sauces, bases, proteins, condiments, toppings, and other reusable components.
- Technique graph: `data-pipeline/output/technique_graph.db` has technique-to-ingredient, technique-to-equipment, cue, sequence, heat, timing, and composition links.
- Seasonal intelligence: `data-pipeline/output/regional_seasons/us_regional_seasons.json`, produce profiles, and the Worker `/seasonal` endpoint.
- Canonical recipe schema: `worker/src/types/canonical.ts` already models components, method variants, yield transformation, lifecycle, make-ahead, refresh tips, and second-day dishes.
- Builder APIs: `worker/src/index.ts` already has ingredient search, affinity suggestions, matching recipes, component matching, canonical dish matching, and seasonal queries.

## Current Personal Data Reality

The personal import layer exists, but it is uneven:

- Instagram: 707 personal imported records.
- Instagram with ingredient arrays: 115 records.
- Instagram with instructions: 12 records.
- Instagram parsed techniques/equipment: effectively none.
- Paprika test set: 9 clean normalized recipes.

So the personal planner should use the personal library mainly as taste signal: titles, authors, saved themes, ingredients when present, and normalized Paprika recipes. The broad Spence corpus supplies technique, composition, component, and affordance knowledge.

Known household constraints:

- Fully vegetarian. Assume eggs and dairy are allowed unless configured otherwise.
- Equipment includes Ooni wood-fired oven, Instant Pot, oven/stovetop, food processor, blender, and standard kitchen equipment.
- Meat, poultry, fish, shellfish, gelatin, and animal-derived stock should be excluded at generation and scoring time.

## Missing Layer

The main missing abstraction is not another recipe table. It is a stateful ingredient affordance graph.

Current ingredient edges mostly answer:

> What ingredients tend to appear together?

The planner needs edges that answer:

> If I am doing this action to this ingredient, what useful future states and meals does that unlock?

Example:

```text
chickpeas:dried
  --soak overnight--> chickpeas:soaked
  --simmer--> chickpeas:cooked_whole
  --instant pot cook--> chickpeas:cooked_whole
  --reserve cooking liquid--> aquafaba

chickpeas:cooked_whole
  --blend + tahini + lemon--> hummus
  --dry + roast--> crispy_chickpeas
  --mash + creamy dressing--> chickpea_salad
  --dress + herbs--> bean_salad
  --simmer + spice--> stew

chickpeas:soaked
  --grind raw + herbs--> falafel_mix
```

This graph should be explicit, typed, and inspectable.

## Proposed New Concepts

### Ingredient State

An ingredient is not just `chickpeas`. It is:

```json
{
  "ingredient": "chickpeas",
  "state": "cooked_whole",
  "storage": "fridge",
  "expires_in_days": 4,
  "texture": "tender",
  "seasoning_scope": "neutral"
}
```

### Mise Edge

Edges describe a useful transformation or branch:

```json
{
  "from": "chickpeas:cooked_whole",
  "to": "crispy_chickpeas",
  "edge_type": "state_transition",
  "technique": "roast",
  "equipment": ["oven", "sheet pan"],
  "active_min": 5,
  "idle_min": 25,
  "best_used_as": ["salad_crunch", "soup_topping", "snack"],
  "branch_trigger": "oven_hot",
  "notes": "Dry well before roasting; season after drying."
}
```

### Active Station

A cooking session has temporary opportunities:

- `oven_hot`
- `ooni_hot`
- `instant_pot_active`
- `boiling_water`
- `blender_dirty`
- `food_processor_dirty`
- `herb_board_active`
- `crunchy_veg_board_active`
- `legume_batch_active`
- `emulsion_base_active`
- `grain_batch_active`

The planner should branch from these, not from a generic prep checklist.

Ooni-specific branches should be high-heat vegetarian uses:

- blistered asparagus, peppers, onions, eggplant, zucchini, cabbage wedges
- vegetarian flatbread or pizza
- charred pita
- cast-iron crispy chickpeas or roasted vegetables

Instant Pot branches should cover low-attention batch bases:

- chickpeas
- lentils
- beans
- rice
- farro
- wheat berries
- steel-cut oats if breakfast planning expands later

### Menu Format

Meals are formats, not only recipes:

- dinner plate
- lunch bowl
- pita/sandwich
- snack tray
- breakfast jar
- salad
- pasta/noodle
- dip/spread
- rescue meal

The planner can transform a state into formats:

```text
hummus -> dip, pita spread, bowl base, thinned dressing
edamame_smash -> toast, pita spread, snack dip, bowl protein
quick_pickles -> salad crunch, sandwich crunch, mezze, rescue garnish
```

## POC Planner Flow

1. Load week constraints.
   - Date range.
   - Location/season.
   - One afternoon/evening cooking session per day.
   - Breakfast/lunch must be no-cook or assembled.
   - Vegetarian diet boundary.
   - Equipment: Ooni, Instant Pot, food processor, blender, standard kitchen.

2. Build personal taste profile.
   - Weight saved Instagram titles and Paprika recipes.
   - Extract favored compositions: salad, bowl, dip, pasta/noodle, sandwich/flatbread, eggs.
   - Extract favored ingredients: chickpeas, tahini, miso, herbs, cucumber/radish, cabbage, asparagus, peas, edamame, citrus.
   - Extract favored flavors: lemon/lime, sesame, sumac, harissa/chili, yogurt, herbs.

3. Choose seasonal anchors.
   - Use regional seasonality plus personal preference.
   - Prefer anchors that have many affordance edges.

4. Expand candidate mise graph.
   - For each anchor, add possible states, techniques, outputs, storage windows, and meal formats.
   - Add station-triggered branches.

5. Score candidate menu paths.
   - Hard constraints: vegetarian, one session/day, shelf life, no morning cooking, required equipment.
   - Soft rewards: personal taste match, seasonality, station reuse, ingredient reuse, variety, format contrast.
   - Soft penalties: repetitive texture, too many same-family meals in a row, high active time on weeknights, orphaned perishables.

6. Schedule the graph.
   - Pick dinner nodes.
   - Assign branch work to the same session as the triggering station.
   - Assign outputs to future breakfast/lunch/snack/dinner slots.

7. Produce an explainable plan.
   - Each day shows dinner, active stations, branches, tomorrow's lunch, snack/breakfast outputs, and why that work belongs there.

## MVP Data Model

Start with JSON files before adding D1 tables:

```text
data-pipeline/personal_planner/
  affordances/
    chickpeas.json
    edamame.json
    cabbage.json
    asparagus.json
    herbs.json
    cucumber_radish.json
    tahini.json
    mayo.json
    ooni_flatbread.json
    instant_pot_legumes.json
  personal_profile.json
  planner_rules.json
```

Later D1 tables:

```sql
ingredient_states(
  id,
  ingredient,
  state,
  storage_location,
  shelf_life_days,
  seasoning_scope,
  notes
);

mise_edges(
  id,
  from_state_id,
  to_state_id,
  edge_type,
  technique,
  equipment_json,
  active_min,
  idle_min,
  branch_trigger,
  best_used_as_json,
  constraints_json,
  source,
  confidence
);

meal_formats(
  id,
  format,
  required_slots_json,
  good_states_json,
  contrast_rules_json
);
```

## How To Use Existing Spence Pieces

- Use `ingredient_edges.db` for flavor and ingredient companion suggestions.
- Use `ingredient_hierarchy.json` for substitutions and family-level fallback.
- Use `technique_graph.db` for realistic technique/equipment/time hints.
- Use `composition_templates.json` for meal shape and cuisine coherence.
- Use canonical recipe lifecycle fields as the long-term destination for make-ahead, refresh, leftovers, and second-day uses.
- Use personal Instagram/Paprika imports as preference weighting, not as the full knowledge base.
- Add a hard vegetarian filter before dish/component scoring, and prefer vegetable/legume/dairy/egg protein routes.
- Add Ooni and Instant Pot as high-value active stations, not generic equipment.

## What Not To Do

- Do not make the LLM invent the whole week in one pass.
- Do not treat recipes as indivisible units.
- Do not optimize only for ingredient overlap.
- Do not make every branch a leftover.
- Do not overfit to noisy Instagram ingredient extraction.

The planner should generate candidate graph paths, score them, and then use language generation only to explain and polish the chosen plan.

## First POC Target

Build a deterministic planner for 6 to 8 ingredients:

- chickpeas
- tahini
- herbs
- cucumber/radish
- cabbage
- asparagus/peas
- edamame
- yogurt or mayo
- eggs/dairy as optional vegetarian proteins and creamy bases

Support these active stations first:

- oven hot
- Ooni hot
- Instant Pot active
- boiling water
- blender or food processor dirty
- herb board active
- crunchy vegetable board active
- legume batch active
- creamy sauce/emulsion base active

Output:

- 7 dinners
- 7 lunches
- 4 breakfast/snack trays
- daily cooking-session plan
- explanation of every reuse branch
