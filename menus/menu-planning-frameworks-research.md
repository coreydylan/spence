# Menu Planning Framework Research

Purpose: identify existing frameworks we can draw from for a personal vegetarian weekly planner that behaves more like a chef building a menu, not a generic meal-plan generator.

Conclusion: there is no single off-the-shelf framework that captures the whole thing. The right system should combine several mature patterns:

1. Professional mise en place and prep sheets.
2. Ingredient cross-utilization and menu engineering.
3. Cycle menu planning.
4. Recipe/food ontologies.
5. Flavor networks and computational gastronomy.
6. Constraint optimization and task scheduling.
7. A custom ingredient-state graph for household cooking.

## 1. Mise En Place And Prep Sheets

Useful sources:

- Michelin Guide, "Kitchen Language: Mise en Place": https://guide.michelin.com/us/en/article/features/mise-en-place-cooking
- WebstaurantStore, "Kitchen Prep Lists for Restaurants": https://www.webstaurantstore.com/article/583/kitchen-prep-lists.html

What exists:

- Mise en place is the professional-kitchen habit of getting ingredients, tools, and stations ready before cooking.
- Prep sheets translate the menu into station-specific tasks, par levels, quantity on hand, quantity to prep, labels, and storage locations.
- The commercial kitchen pattern is not "what recipes do I want?" It is "what must each station have ready for service?"

What to steal:

- A weekly plan should generate prep sheets, not just recipes.
- Every prepped component needs:
  - state,
  - quantity,
  - target par,
  - expected uses,
  - storage container,
  - quality window,
  - next transformation.
- The daily session should start with "check quantity on hand" before making more.

How this maps to us:

```text
menu -> component demand -> par targets -> current inventory -> prep deltas
```

Example:

```text
H1 chopped herbs
target: 2 cups Tue-Fri
on hand: 0
prep: 2 cups
storage: paper-towel-lined deli quart
quality window: 4 days
future uses: cabbage, frittata, hummus garnish, herb yogurt, noodles
```

## 2. Cross-Utilization And Menu Engineering

Useful sources:

- Gordon Food Service, "3 Ways to Stretch the Menu Using Cross-Utilization": https://gfs.com/en-us/ideas/3-ways-stretch-menu-using-cross-utilization/
- KitchenNmbrs, "Cross-utilization of ingredients": https://kitchennmbrs.app/en/knowledge-base/inventory-management-stock-control/what-is-cross-utilization-of-ingredients-and-how-does-it-lower-my-food-costs
- Menu engineering matrix overview: https://www.menubly.com/blog/menu-engineering/

What exists:

- Restaurants use cross-utilization to make a smaller inventory feel like a larger menu.
- A common rule of thumb is that a product should have multiple planned uses before it earns a place in inventory.
- Menu engineering classifies dishes by performance, usually popularity and margin. That business version is not directly our goal, but the matrix idea is useful.

What to steal:

- Every ingredient should have a cross-utilization score:
  - number of distinct formats it can support,
  - number of cuisines/flavor directions it can support,
  - quality-window fit,
  - prep-effort amortization,
  - risk of monotony.
- The system should penalize single-use perishables unless they are seasonal/showcase ingredients.
- Reuse should be transformed reuse, not repeated leftovers.

Household version of menu engineering:

```text
Axes:
- joy / household preference
- effort / prep burden
- perishability / waste risk
- branch potential
- novelty / variety
```

Useful categories:

- Stars: high preference, high branch potential, manageable prep.
- Workhorses: reliable staples that need flavor rotation.
- Showpieces: seasonal or special items with lower reuse, allowed sparingly.
- Traps: high prep, low branch, short shelf life, low preference.

Example:

```text
chickpeas = star
asparagus = seasonal showpiece/workhorse
fresh herbs = high-risk star, must be routed
jarred artichokes = useful bridge
fresh tomatoes in early May = trap unless market quality is excellent
```

## 3. Cycle Menus

Useful sources:

- CDC Food Service Guidelines Toolkit, menu cycles: https://www.cdc.gov/food-service-guidelines-toolkit/php/monitor-evaluate/menu-data.html
- Connecticut Department of Education, cycle menu planning: https://portal.ct.gov/sde/nutrition/menu-planning/cycle-menus

What exists:

- Schools, hospitals, and institutions use menu cycles, often four to six weeks, to balance variety, purchasing, labor, nutrition, and repetition.
- Cycle menus make procurement and prep more predictable while still allowing seasonal swaps.

What to steal:

- A personal planner should have repeatable weekly archetypes, not repeat exact menus.
- We can define a four-week rotation of menu shapes:
  - Week A: mezze/flatbread/legume.
  - Week B: noodle/rice/soy-sesame.
  - Week C: tacos/tostadas/beans/salsas.
  - Week D: pasta/grain/salad/eggs.
- Seasonal ingredients drop into the archetype.

Key distinction:

- The cycle should repeat structure, not dishes.
- This avoids rebuilding the whole planning problem every week.

## 4. Recipe And Food Ontologies

Useful sources:

- Schema.org Recipe: https://schema.org/Recipe
- FoodOn food ontology: https://foodon.org/
- FoodOn transformation process: https://foodon.org/food-facets/food-transformation-process/
- FoodOn paper: https://www.nature.com/articles/s41538-018-0032-6

What exists:

- Schema.org has a broad web standard for recipe fields: ingredients, instructions, prep time, cook time, cuisine, category, yield, nutrition, tools/supplies via HowTo.
- FoodOn is a formal ontology for food products, ingredients, processes, and transformations. It explicitly models food transformation processes.

What to steal:

- Use Schema.org-like recipe fields for compatibility.
- Use FoodOn-like process/state thinking for ingredient transformations.
- Do not stop at `ingredient = chickpeas`; represent `chickpeas:dried`, `chickpeas:cooked`, `chickpeas:crispy`, `chickpeas:pureed`, `aquafaba`.

Critical FoodOn-inspired rule:

- Transformation processes are directional and sequential.
- A planner must avoid impossible merged states.

Example:

```text
raw kale -> blanched kale -> frozen kale
```

not:

```text
kale simultaneously raw/frozen/blanched
```

For us:

```text
dry chickpeas -> cooked chickpeas -> hummus
dry chickpeas -> soaked raw chickpeas -> falafel mix
```

Those are different branches, and choosing one affects what is possible later.

## 5. Flavor Networks And Computational Gastronomy

Useful sources:

- Ahn et al., "Flavor network and the principles of food pairing": https://www.nature.com/articles/srep00196
- FlavorGraph, large-scale food-chemical graph: https://www.nature.com/articles/s41598-020-79422-8
- Computational gastronomy overview: https://www.nature.com/articles/s41540-024-00399-5

What exists:

- Flavor network research models ingredients as graphs connected by shared flavor compounds and recipe usage.
- Different cuisines use different pairing logics. Western cuisines often lean toward shared compounds; some East Asian cuisines often use more contrastive pairings.
- FlavorGraph combines recipe co-occurrence and food-chemical data to recommend pairings.
- Computational gastronomy treats recipes as computable cultural/chemical/nutritional objects.

What to steal:

- The planner should separate:
  - proven co-occurrence,
  - chemical/flavor affinity,
  - cultural/cuisine pattern,
  - novelty distance.
- To avoid monotony, use the same base component with different culinary grammars.

Example:

```text
chickpeas + tahini + lemon + parsley -> Levantine-ish hummus plate
chickpeas + cumin + chili + lime + cabbage -> taco/tostada direction
chickpeas + miso + sesame + scallion -> Japanese/Korean-ish salad direction
chickpeas + yogurt + garam masala-ish spices -> Indian-ish chaat/bowl direction
```

This is the missing creativity layer in the current plan.

## 6. Optimization And Task Scheduling

Useful sources:

- Sklan and Dariel, "Diet planning for humans using mixed-integer linear programming": https://pubmed.ncbi.nlm.nih.gov/8399108/
- Recipe-based diet-planning model: https://www.cambridge.org/core/journals/british-journal-of-nutrition/article/recipebased-dietplanning-modelling-system/A582EB0B7B33754C4EEE25A6FCCE446F
- Cooking task scheduling with mixed integer programming: https://www.mdpi.com/2076-3417/12/8/4018

What exists:

- Diet planning has long been modeled with linear or mixed-integer programming.
- Recipe-based models optimize over actual recipes rather than individual foods.
- Cooking task scheduling can be modeled as tasks with dependencies, processing times, equipment constraints, and a makespan objective.

What to steal:

- Our planner can be a constraint/scoring problem:
  - hard constraints: vegetarian, one cooking session/day, no morning cooking, Ooni day, food safety, storage windows.
  - soft goals: flavor variety, seasonal fit, low waste, household preference, prep efficiency, novelty, nutrition.
- Prep scheduling should be a dependency graph:

```text
mix dough Tuesday -> divide Wednesday -> flatbread Thursday -> pizza Saturday
cook chickpeas Wednesday -> hummus Thursday -> crispy Sunday
wash herbs Tuesday -> chopped mix Tue-Fri + whole leaves Sat-Mon + stems Thu sauce
```

## 7. What Is Still Missing

None of the existing frameworks fully solve your problem because they usually optimize one layer:

- Restaurants optimize service, cost, inventory, and consistency.
- Institutions optimize nutrition, procurement, repetition, and waste.
- Computational gastronomy optimizes pairings, novelty, recipe generation, and data representation.
- Diet planners optimize nutrition/cost/preferences.
- Recipe schemas describe final recipes, not multi-day ingredient lifecycles.

Your problem is a combined household-chef planning problem:

```text
personal taste
+ seasonal availability
+ ingredient state graph
+ prep task graph
+ equipment/station reuse
+ cuisine/flavor variety
+ breakfast/lunch/dinner/snack allocation
+ household schedule
+ leftovers and quality windows
```

That needs a custom orchestration layer.

## Proposed Framework: Mise Graph Planning

This is the working name for our system.

### Layer 1: Intake

- people,
- meals,
- diet,
- location/microclimate,
- pantry,
- equipment,
- schedule,
- energy level,
- project appetite,
- vetoes,
- favorite formats,
- personal recipe/taste priors.

### Layer 2: Seasonal Candidate Set

Generate candidate seasonal ingredients, then classify:

- peak,
- strong,
- still good,
- emerging,
- wait unless excellent.

### Layer 3: Ingredient State Expansion

For each candidate ingredient:

```text
ingredient -> possible states -> transformations -> outputs -> storage windows
```

Example:

```text
herbs
  -> washed whole leaves
  -> chopped herb mix
  -> stems
  -> herb yogurt
  -> herb oil
  -> garnish
```

### Layer 4: Cross-Cuisine Grammar

For each base component, generate flavor routes:

```text
component + cuisine grammar + format = dish candidate
```

Example:

```text
cooked chickpeas + Levantine + dip/mezze = hummus plate
cooked chickpeas + Indian-ish + chaat/salad = yogurt-tamarind chickpea bowl
cooked chickpeas + Spanish-ish + stew/toast = chickpeas with spinach, smoked paprika, sherry vinegar
cooked chickpeas + Japanese-ish + salad/noodle = sesame-miso chickpea cucumber salad
```

### Layer 5: Prep Station Detection

Identify active stations:

- oven hot,
- Ooni hot,
- food processor dirty,
- blender dirty,
- boiling water,
- Instant Pot active,
- herb board active,
- crunchy vegetable board active,
- dough fermentation active.

When a station is active, the planner asks:

```text
What future-use branch becomes cheap right now?
```

### Layer 6: Menu Tetris

Fit meals into slots:

- dinners,
- lunches,
- snack boxes,
- breakfasts.

Score for:

- variety of formats,
- variety of cuisines/flavor families,
- ingredient branch utilization,
- prep burden by day,
- perishability,
- household preference,
- leftovers that remain attractive.

### Layer 7: Prep Sheet Generation

Produce not just recipes but:

- daily prep sheet,
- component pars,
- storage labels,
- shopping list,
- quality clocks,
- fallback rules,
- next-day assembly notes.

## Concrete Improvement To The Current Menu

The current detailed plan is still too same-family: Mediterranean/tahini/herbs dominate.

A more creative version should keep the same base ingredients but route them through different grammars:

- Tue: California spring vegetable plate with lemon-tahini.
- Wed: Persian-ish herb frittata / kuku-inspired dinner with pickles.
- Thu: Levantine mezze with hummus and flatbread.
- Fri: Japanese-ish miso-sesame asparagus noodles.
- Sat: Ooni Italian-ish artichoke/asparagus pizzas.
- Sun: Indian-ish chickpea/lentil chaat salad with yogurt, herbs, crispy chickpeas, cucumber/radish.
- Mon: Spanish-ish chickpeas/lentils with smoked paprika, greens, garlic yogurt, and flatbread.

Same anchors, more cultural and textural movement.

## Implementation Implication

We should add a new data object that does not currently exist in normal recipe schemas:

```json
{
  "component_id": "cooked_chickpeas",
  "source_ingredient": "dry_chickpeas",
  "state": "cooked_whole",
  "quantity": "6 cups",
  "quality_window_days": 5,
  "storage": "covered deli quart, refrigerated",
  "possible_edges": [
    {
      "to": "hummus",
      "technique": "puree",
      "equipment": ["food_processor"],
      "flavor_grammars": ["levantine", "mediterranean"]
    },
    {
      "to": "crispy_chickpeas",
      "technique": "roast",
      "equipment": ["oven", "ooni_cast_iron"],
      "flavor_grammars": ["levantine", "indian", "spanish", "california"]
    },
    {
      "to": "chaat_salad",
      "technique": "dress_and_toss",
      "equipment": ["mixing_bowl"],
      "flavor_grammars": ["indian"]
    }
  ]
}
```

That is the thing existing frameworks point toward but do not hand us directly.
