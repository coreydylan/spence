# Planner Mock Run

Week: Tuesday, May 5 through Monday, May 11, 2026.

Purpose: model the manual thinking process before building the automated planner.

## Assumptions

These are placeholders the future system should request or infer.

- Location/season: Southern California / Southwest spring.
- Cooking window: one afternoon/evening session per day.
- Morning constraint: no cooking; breakfast must be assembled or ready.
- Household: assumed 2 adults with lunch leftovers.
- Diet: fully vegetarian. Assumes eggs and dairy are okay unless specified otherwise.
- Equipment: Ooni wood-fired oven, Instant Pot, oven, stovetop, food processor, blender, and standard kitchen equipment.
- Style: vegetarian, beans/legumes, tahini/miso/sesame, herbs, crunchy vegetables, flatbread/toast, pasta/noodle, bowls, salads.
- Personal library role: taste signal, not strict recipe source.

## Information Needed

The system should collect this before planning:

- People and appetite: number of eaters, lunch portions, leftover tolerance.
- Diet boundaries: vegetarian, vegan, dairy, eggs, gluten, nuts, sesame, soy.
- Cooking sessions: which days are normal, short, long, or unavailable.
- Equipment: oven, Ooni/wood-fired oven, blender, food processor, rice cooker, pressure cooker/Instant Pot, grill, air fryer.
- Pantry state: beans/grains/pasta/tahini/miso/yogurt/mayo/eggs/herbs/spices already on hand.
- Shopping tolerance: one shop or multiple, budget level, produce market access.
- Breakfast/lunch style: savory vs sweet, repeat tolerance, snack tray preference.
- Cleanup tolerance: whether dirty-equipment batching matters a lot.
- Waste tolerance: prioritize using all herbs/greens/perishables or prioritize novelty.
- Nutrition goals: protein floor, fiber, calories, lower sodium, etc.
- Human vetoes: ingredients you dislike this week.

For this mock run, missing information is handled by conservative defaults.

## Manual Planning Process

### 1. Define Hard Constraints

Hard constraints:

- Only one cooking session per day.
- No morning cooking.
- Every lunch must be leftover, assembled, or cold/room-temp friendly.
- Perishables need planned paths.
- Long-lead tasks must happen before they are needed.
- No meat, poultry, fish, shellfish, gelatin, or animal-derived stock.

Soft constraints:

- Favor personal-library patterns.
- Favor seasonal produce.
- Reuse active stations.
- Avoid monotony across adjacent meals.
- Make snacks and breakfasts emerge from the same work.

### 2. Build Taste Profile

From the personal import set:

- Frequent formats: salad, bowl, pasta/noodle, dip/spread, flatbread/sandwich, eggs.
- Frequent ingredient families: chickpeas/beans/lentils, edamame, tahini, miso, yogurt, herbs, cucumber/radish, cabbage, asparagus/peas, citrus.
- Frequent flavors: lemon/lime, sesame, sumac, harissa/chili, cumin, mint/cilantro/parsley.
- Preferred texture logic: creamy + crunchy + fresh herbs + warm/starchy carrier.

Interpretation:

The week should not be seven recipes. It should be a rotating mezze/bowl/salad/pasta system with strong sauces and crunchy fresh components.

### 3. Select Seasonal Anchors

Candidate seasonal anchors:

- Cabbage: sturdy, roast/slaw/salad/toast.
- Asparagus: blanch/roast/frittata/pasta/salad.
- Peas/edamame: blanch/smash/salad/frittata/snack.
- Cucumber/radish: raw/pickle/salad/snack/sandwich crunch.
- Herbs: garnish/sauce/herb oil/salad.
- Strawberries: breakfast/snack/salad accent.
- Citrus: dressing/sauce/finish.

Chosen anchors:

- Chickpeas
- Tahini
- Cabbage
- Asparagus/peas
- Edamame
- Cucumber/radish
- Herbs
- Yogurt or mayo-style creamy base
- Strawberries

Reason:

These produce the highest number of useful branches while staying coherent with the personal library.

### 4. Expand Ingredient Affordances

#### Chickpeas

States:

- dried
- soaked
- cooked whole
- hummus
- crispy chickpeas
- chickpea salad
- falafel mix
- aquafaba

Branches:

- Dried -> soak -> raw soaked chickpeas for falafel.
- Dried -> simmer -> cooked whole chickpeas.
- Cooked whole -> hummus using tahini/lemon.
- Cooked whole -> crispy chickpeas if oven is hot.
- Cooked whole -> chickpea salad with yogurt/mayo/herbs.
- Aquafaba -> mayo-like emulsion or dressing.

Planning note:

Do not season the whole batch immediately. Reserve some neutral.

#### Tahini

States:

- thick paste
- lemon-tahini sauce
- miso-tahini sauce
- thinned dressing
- dip

Branches:

- Thick sauce for dinner.
- Thin with water/lemon for lunch bowl dressing.
- Mix with yogurt for dip.
- Use as hummus input.

Planning note:

Make a neutral tahini base once, then split.

#### Edamame

States:

- frozen
- blanched
- whole salad protein
- smashed spread
- dip

Branches:

- Blanch while water is already boiling.
- Split into whole edamame for salad and smashed edamame for toast/pita.
- Fold into cold noodle/orzo/couscous lunch.

Planning note:

Edamame is a good bridge ingredient because it works as snack, protein, spread, and salad bulk.

#### Cucumber/Radish

States:

- raw sliced
- salted salad
- quick pickle
- snack tray

Branches:

- Slice once, split into three bowls.
- Raw for snack.
- Salted for dinner salad.
- Vinegared for later sandwich/bowl crunch.

Planning note:

This is a board-active branch, not a separate prep task.

#### Herbs

States:

- washed leaves
- chopped garnish
- herb yogurt sauce
- herb oil
- herb salad

Branches:

- Wash once, dry well.
- Stems into sauce.
- Leaves into garnish and salad.
- Tired herbs become sauce/oil.

Planning note:

Herbs should be routed early because they decay fast.

### 5. Identify Active Stations

The future system should infer branches from active stations:

- Oven hot: roast cabbage, asparagus, carrots/cauliflower, crispy chickpeas, pita chips.
- Ooni hot: char flatbreads, blister vegetables, crisp chickpeas in cast iron, make vegetarian pizza/flatbread, roast peppers/onions/eggplant/zucchini quickly.
- Instant Pot active: cook chickpeas, lentils, beans, farro, rice, wheat berries, or grains with low attention.
- Boiling water: blanch asparagus, peas, edamame; cook pasta/grain; boil eggs.
- Blender/processor dirty: hummus, edamame smash, herb sauce, mayo/aioli.
- Herb board active: garnish, sauce, dressing, herb oil.
- Crunchy vegetable board active: raw snack, salted salad, quick pickle.
- Legume batch active: reserve neutral, sauce some, crisp some, blend some.
- Creamy base active: dip, dressing, sandwich spread.

### 6. Sketch Menu Shapes

Candidate meals:

- Charred cabbage with tahini, herbs, sourdough/pita.
- Asparagus/pea frittata with cucumber-radish salad.
- Miso-tahini asparagus/pea pasta or gnocchi.
- Spinach/artichoke/chickpea flatbread or bowl.
- Falafel/hummus mezze.
- Zucchini/asparagus/pea pasta with mint and cheese.
- Lentil/pea/herb salad with crispy chickpeas.

Format rhythm:

- Tue: warm roasted/toast plate.
- Wed: egg/green dinner.
- Thu: pasta/gnocchi.
- Fri: flatbread/bowl.
- Sat: mezze/project-ish.
- Sun: pasta, lighter and herb-heavy.
- Mon: composed salad/rescue meal.

This avoids seven bowls in a row.

### 7. Schedule Long-Lead Work

Long-lead dependencies:

- Chickpeas for falafel need soaking the night before, unless the plan chooses an Instant Pot cooked-chickpea branch instead.
- Cooked lentils hold well and can be made midweek in the Instant Pot.
- Pickles improve after sitting.
- Chia/oat jars need a few hours.
- Herbs should be washed early but cut close to use.

Schedule:

- Tuesday: quick pickles, tahini base, breakfast jars.
- Wednesday: blanch edamame/peas/asparagus; cook lentils in the Instant Pot; make herb yogurt.
- Friday: soak chickpeas for Saturday.
- Saturday: process falafel/hummus while processor is active.

### 8. Assemble Week Plan

#### Tuesday

Dinner:

- Charred cabbage and asparagus with lemon-tahini sauce, sumac, herbs, pita or sourdough.

Active stations:

- Oven hot.
- Ooni optional if firing it anyway: char cabbage/asparagus/flatbread fast instead of oven roasting.
- Tahini jar open.
- Herb board active.
- Crunchy vegetable board active.

Branches:

- Roast extra cabbage/asparagus neutral.
- Split tahini base into thick dinner sauce and thinner lunch dressing.
- Slice cucumber/radish into raw snack, salted salad, and quick pickle.
- Make strawberry chia/oat jars.

Outputs:

- Wednesday breakfast: strawberry jars.
- Wednesday lunch: cabbage/asparagus pita or bowl with tahini dressing and pickles.
- Snack tray: cucumber, radish, strawberries, tahini dip.

#### Wednesday

Dinner:

- Asparagus, pea, herb, and feta frittata with cucumber-radish salad.

Active stations:

- Boiling water.
- Instant Pot for lentils or chickpeas if not already cooked.
- Egg bowl.
- Herb board active.

Branches:

- Blanch peas, edamame, and extra asparagus before dinner.
- Split edamame into whole salad protein and edamame smash.
- Cook lentils in the Instant Pot while the kitchen is already active.
- Make herb yogurt sauce.
- Save frittata squares.

Outputs:

- Thursday breakfast: frittata square.
- Thursday lunch: edamame smash pita/toast with pickles and herbs.
- Later base: cooked lentils for Monday.

#### Thursday

Dinner:

- Miso-tahini gnocchi or pasta with asparagus, peas, lemon, herbs, and black pepper.

Active stations:

- Boiling water.
- Creamy sauce base.

Branches:

- Cook extra orzo/couscous/pasta after blanching greens if useful.
- Split miso-tahini base into pasta sauce and salad dressing.
- Build undressed green salad box.

Outputs:

- Friday lunch: asparagus-pea couscous/orzo salad with edamame or chickpeas.
- Snack tray: yogurt herb sauce with vegetables and pita.

#### Friday

Dinner:

- Warm spinach-artichoke chickpea flatbreads or bowls with lemon yogurt-tahini sauce.

Active stations:

- Creamy sauce base.
- Oven hot or skillet hot.
- Ooni optional: use it for flatbreads/pita pizzas and blistered vegetable toppings.
- Legume branch begins.

Branches:

- Soak dried chickpeas for Saturday falafel.
- Reserve some chickpeas plain before saucing dinner.
- Roast harissa carrots/cauliflower if oven is on.
- Chop mezze vegetables and herbs.
- Make weekend breakfast jars.

Outputs:

- Saturday lunch: chickpea flatbread or bowl.
- Saturday dinner prep: soaked chickpeas.
- Snack/breakfast: strawberry jars.

#### Saturday

Dinner:

- Falafel and hummus mezze with pita, cucumber-radish-herb salad, pickles, tahini/yogurt sauce, strawberries.

Active stations:

- Food processor dirty.
- Legume batch active.
- Oven/skillet/fryer active.
- Ooni optional: char pita/flatbread and blister vegetables for the mezze tray.
- Crunchy vegetable board active.

Branches:

- Process falafel mix first.
- Before washing processor, make hummus.
- If edamame remains, make a green edamame-herb smash.
- Crisp some chickpeas or pita if oven is hot.
- Make cabbage/cucumber/radish slaw.

Outputs:

- Sunday lunch: falafel pita or hummus bowl.
- Snack tray: hummus, pita, vegetables.
- Crunch: pita chips or crispy chickpeas.

#### Sunday

Dinner:

- Zucchini, asparagus, pea, lemon, mint, and pecorino pasta. If zucchini looks weak, skip it and use asparagus/peas.

Active stations:

- Pasta water.
- Herb board active.
- Remaining vegetable cleanup.
- Ooni optional: if fired, make a vegetarian flatbread instead of pasta, using the same asparagus/peas/herbs as toppings after firing.

Branches:

- Turn remaining herbs into herb oil or loose pesto.
- Cook extra pasta only if Monday lunch needs it.
- Roast remaining vegetables if oven use makes sense.

Outputs:

- Monday lunch: pasta salad with chickpeas, herb oil, cucumber/radish.
- Monday snack: remaining hummus or edamame smash with vegetables.

#### Monday

Dinner:

- Lentil, pea, cucumber/radish, herb, and crispy chickpea salad with yogurt-tahini dressing and pita chips.

Active stations:

- Rescue board.
- Creamy sauce final use.
- Crunch final use.

Branches:

- Thin any remaining sauce into dressing.
- Crisp remaining chickpeas or pita.
- Use remaining herbs, greens, pickles, roasted vegetables, and lentils.
- Make Tuesday breakfast jars if continuing.

Outputs:

- Tuesday lunch: lentil salad pita/bowl.
- Waste check: list remaining ingredients for next plan.

## What The System Should Learn From This Run

### Menu Planning Is Graph Selection

The main choice is not "what recipes sound good?" It is:

> Which ingredient-state graph produces the best set of meals under the week constraints?

### Reuse Must Be Typed

Good reuse is not simply repeating an ingredient.

Good:

- Chickpeas -> hummus, falafel, crispy topping.
- Tahini -> dinner sauce, dressing, hummus input.
- Cucumber/radish -> snack, pickle, salad crunch.

Bad:

- Chickpea bowl every day.
- Same tahini sauce with no format or texture change.

### Stations Are Planning Events

The future planner should attach branch opportunities to station events:

- If `blender_dirty`, suggest smooth sauces/spreads now.
- If `boiling_water`, suggest blanching greens before starch.
- If `oven_hot`, suggest crisping or roasting compatible items.
- If `ooni_hot`, suggest flatbread/pizza, blistered vegetables, charred greens, or cast-iron crisped toppings.
- If `instant_pot_active`, suggest beans, lentils, grains, or sturdy meal bases.
- If `herb_board_active`, suggest sauce/oil/garnish routing.

### Long-Lead Work Is Not Prep, It Is Dependency Management

Soaking chickpeas is not "meal prep." It is unlocking Saturday's falafel branch.

### The Final Output Should Be Explainable

Every scheduled branch should have a reason:

- "Do this now because the processor is already dirty."
- "Keep this neutral because it has three future paths."
- "Use this tomorrow because herbs decline quickly."
- "Do not season the whole batch because hummus, salad, and crispy chickpeas need different profiles."

## System Modules Implied

1. Intake model.
2. Personal taste profiler.
3. Seasonal anchor selector.
4. Ingredient affordance graph.
5. Active station detector.
6. Candidate menu generator.
7. Constraint/scoring engine.
8. Schedule builder.
9. Explanation renderer.
10. Feedback recorder.

## Minimal Next Test

Run this same process on one ingredient only: chickpeas.

Input:

- `chickpeas:dried`
- week has one longer weekend session
- Instant Pot available for fast bean/grain cooking
- Ooni available for high-heat vegetarian flatbreads and blistered vegetables
- household wants lunches
- household is vegetarian

Expected graph expansion:

- soak
- Instant Pot cook
- falafel
- hummus
- cooked whole reserve
- crispy topping
- chickpea salad
- aquafaba dressing

Expected output:

- one shopping quantity
- one long-lead reminder
- one cooking session
- three to five distinct meal formats
- storage windows
- branch explanations
