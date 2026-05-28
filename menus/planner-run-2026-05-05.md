# Planner Run: Vegetarian Spring Week

Week: Tuesday, May 5 through Monday, May 11, 2026.

Assumed location: coastal Southern California / San Diego. A ZIP or neighborhood would refine the microclimate layer.

Detailed executable recipe pack: `menus/planner-run-2026-05-05-detailed.md`.

## Intake

- People: 2.
- Meals: dinners, lunches, snack boxes, breakfast jars/oats.
- Home diet: vegetarian. Meat is eaten out, with rare at-home flex such as pepperoni on pizza. Default plan stays vegetarian.
- Breakfast style: chia puddings, overnight oats, assembled breakfasts.
- Lunch style: leftovers plus Mediterranean-style snack boxes with dips and homemade pita/naan/flatbread dippers.
- Beans/grains: prefer dry beans/grains, with cans acceptable when needed.
- Equipment: Ooni wood-fired oven, Instant Pot, oven/stovetop, food processor, blender, standard equipment.
- Bread preference: high interest in homemade pita, naan, pizza dough, milk bread, buns, etc.
- Goals: manageable prep, ingredient/state reuse, real seasonality, cuisine/flavor variety.
- Vetoes: none.

## Seasonal Read

For early May in coastal California/San Diego, prioritize:

- Peak/strong: asparagus, artichokes, peas/snap peas, fava beans, radishes, lettuces, spinach/kale, herbs, strawberries, avocado.
- Still good: citrus, cabbage, broccoli, cauliflower, beets, spring onions.
- Emerging/market-dependent: cherries, apricots, cucumbers, zucchini.
- Wait unless excellent: tomatoes, corn, peppers, eggplant, peaches, melons.

System interpretation:

- Use asparagus/peas/radishes/strawberries/herbs as the week’s fresh spring signal.
- Use chickpeas/lentils/tahini/yogurt/bread as the durable backbone.
- Use Ooni for high-heat vegetarian flatbreads and blistered vegetables, not as a novelty add-on.

Source check:

- San Diego has a year-round growing season, with local strengths in avocados, citrus, mushrooms, and strawberries, and many neighborhood farmers markets. Source: https://www.sandiego.org/things-to-do/shopping/farmers-markets
- California/SoCal May guides point to asparagus, artichokes, peas, radishes, leafy greens, strawberries, avocados, and early apricots/cherries as the right seasonal frame. Sources: https://www.cspi.org/cspi-news/whats-season-may-produce-guide and https://www.nohomarket.org/california_crop_calendar/
- Southern California farm availability also supports fava beans, peas, radishes, spinach, spring berries, citrus, and summer crops later in the season. Source: https://underwoodfamilyfarms.com/seasonal-produce-guide/
- Tomatoes, peppers, corn, eggplant, peaches, and melons are treated as summer-leaning unless the market quality is obviously good.

## Step 1: Hard Constraints

- Vegetarian at home.
- One afternoon/evening cooking session per day.
- Breakfast requires no cooking.
- Lunch should be assembled, leftover-based, or snack-box style.
- Prep must stay manageable.
- Avoid monotony despite ingredient reuse.

## Step 2: Build The Taste Shape

From your personal-library pattern:

- Formats: mezze, bowls, salads, pasta/noodles, flatbreads, eggs, dips/spreads.
- Flavors: tahini, miso, sesame, lemon/lime, herbs, sumac, harissa/chili.
- Textures: creamy dip/sauce, crunchy raw/pickled vegetables, warm bread/starch, fresh herbs.
- Cooking style: vegetarian but substantial, with legumes and grains doing real work.

This points toward a week built around:

- Chickpea/lentil backbone.
- Spring vegetables.
- Homemade bread/flatbread.
- Two sauce families: tahini/yogurt/herb and miso/sesame.
- Snack boxes as a deliberate output.

## Step 3: Choose Anchors

Chosen anchors:

- Chickpeas: dry -> Instant Pot cooked -> hummus, crispy topping, chickpea salad, snack-box protein.
- Lentils: dry -> Instant Pot cooked -> salad base, lunch bowls, rescue dinner.
- Tahini: sauce, hummus input, dressing, snack-box dip.
- Yogurt: herb sauce, breakfast, dressing.
- Asparagus/peas: spring dinner, pasta/noodle, snack/lunch salad.
- Cucumber/radish: raw snack, quick pickle, salad crunch, flatbread crunch.
- Herbs: garnish, herb yogurt, green sauce, herb oil.
- Strawberries: chia/oat jars, snack boxes.
- Dough: pita/naan/flatbread/pizza dough as a carrier cycle.

Rejected/pruned for this run:

- Full falafel branch: good but not chosen because cooked chickpeas, Ooni dough, hummus, and snack boxes already create enough work. Falafel can be a later branch if a soaked raw chickpea batch is planned.
- Tomatoes/corn/peppers as primary anchors: too early for peak coastal spring.
- Multiple elaborate breads: choose one flatbread/pita cycle and one pizza dough cycle, not milk bread/buns this week.

## Step 4: Ingredient-State Graph

### Chickpeas

```text
dry chickpeas
  -> Instant Pot cooked chickpeas
  -> reserve neutral whole chickpeas
  -> hummus
  -> crispy chickpeas
  -> chickpea salad / snack-box protein
  -> aquafaba for optional mayo/dressing
```

Rules:

- Cook unseasoned.
- Reserve cooking liquid.
- Dry some cooked chickpeas overnight or before roasting if crispy topping is planned.
- Do not turn all chickpeas into hummus.

### Dough

```text
basic flatbread/pita dough
  -> dinner bread
  -> snack-box dippers
  -> pita chips

pizza dough
  -> Ooni vegetarian flatbreads/pizzas
  -> next-day lunch wedges
```

Rules:

- Dough is a carrier system, not just a side.
- Cook extra flatbread only if it will be used within 2 days or crisped into chips.
- Ooni day should also char vegetables while hot.

### Cucumber/Radish

```text
washed/sliced
  -> raw snack
  -> salted salad
  -> quick pickle
```

Rules:

- Slice once, split immediately.
- Pickled portion supports lunches and flatbreads.

### Herbs

```text
washed herbs
  -> garnish leaves
  -> herb yogurt
  -> herb oil / loose green sauce
  -> chopped salad
```

Rules:

- Wash early, chop late.
- Stems go into sauces.

### Tahini/Yogurt

```text
tahini base
  -> lemon tahini sauce
  -> hummus
  -> thinned dressing

yogurt base
  -> herb yogurt dip
  -> breakfast
  -> salad dressing
```

Rules:

- Split before seasoning too specifically.
- Keep one thick dip and one thin dressing.

## Step 5: Active Stations

Active stations this week:

- `instant_pot_active`: chickpeas, lentils.
- `food_processor_dirty`: hummus, herb yogurt, optional edamame/herb smash.
- `crunchy_veg_board_active`: snack raw, salad, pickle.
- `herb_board_active`: garnish, yogurt sauce, herb oil.
- `boiling_water`: blanch asparagus/peas, cook pasta/noodles.
- `ooni_hot`: pizza/flatbread, char asparagus/spring onions/artichokes/zucchini if good.
- `oven_hot`: crispy chickpeas, pita chips, roasted cabbage/cauliflower.

## Step 6: Week Schedule

### Tuesday

Dinner:

- Charred cabbage/asparagus plates with lemon-tahini sauce, sumac, herbs, and fresh flatbread or toasted bread.

Session branches:

- Slice cucumber/radish into three states: raw snack, salted salad, quick pickle.
- Make lemon-tahini base; split into thick dinner sauce and thinner lunch dressing.
- Make strawberry chia jars for Wednesday/Thursday breakfast.
- Mix a simple pita/flatbread dough if energy allows; otherwise use bought pita tonight and mix dough Wednesday.

Outputs:

- Wednesday lunch: cabbage/asparagus pita or bowl with tahini dressing and pickles.
- Snack box: cucumber, radish, strawberries, tahini dip, bread.
- Breakfast: strawberry chia jars.

System note:

- If Tuesday is too busy, dough is postponed. Do not overload the first night.

### Wednesday

Dinner:

- Asparagus, pea, herb, and feta frittata with cucumber-radish salad.

Session branches:

- Instant Pot: cook dry chickpeas, unseasoned.
- Boiling water: blanch peas/asparagus before dinner if needed.
- Split cooked chickpeas: whole reserve, hummus portion, crispy-chickpea portion.
- Save aquafaba.
- Cook or griddle pita/flatbread if dough was mixed Tuesday.

Outputs:

- Thursday lunch: frittata square plus cucumber/radish/pita snack box.
- Future: cooked chickpeas for hummus, crispy topping, chickpea salad.

System note:

- Chickpea cooking happens while dinner is egg/veg, so the session has useful parallelism without making dinner harder.

### Thursday

Dinner:

- Spring mezze/flatbread dinner: hummus, herb yogurt, warm pita/flatbread, asparagus/peas, pickles, herbs, olives/feta if desired.

Session branches:

- Food processor dirty: make hummus first, then herb yogurt or edamame-herb smash before washing.
- Keep some hummus thick for snack boxes.
- Thin some hummus/tahini into dressing for Friday lunch.
- Dry a tray of chickpeas for crisping Friday or Saturday.

Outputs:

- Friday lunch: Mediterranean snack boxes with hummus, herb yogurt, pickles, raw veg, pita.
- Breakfast: refresh chia/oats if needed.

System note:

- This is the main processor batching session. It turns cooked chickpeas into multiple formats.

### Friday

Dinner:

- Miso-tahini asparagus/pea noodles or gnocchi with herbs, lemon, sesame, and black pepper.

Session branches:

- Boiling water: blanch extra asparagus/peas before noodles.
- Make miso-tahini sauce; split into pasta sauce and a thinner cold noodle/salad dressing.
- Mix Ooni pizza dough for Saturday if making dough from scratch.
- Oven optional: crisp chickpeas or pita chips.

Outputs:

- Saturday lunch: cold noodle/asparagus/pea box or snack box.
- Saturday Ooni setup: pizza dough ready.
- Crunch: crispy chickpeas or pita chips.

System note:

- This is the cuisine pivot: sesame/miso rather than Mediterranean tahini/herb.

### Saturday

Dinner:

- Ooni vegetarian spring flatbreads/pizzas: asparagus, artichoke or spring onion, ricotta/mozzarella/feta, herbs after firing, lemon, chili oil. Optional pepperoni can be a flex topping on part of the batch.

Session branches:

- Ooni hot: char extra asparagus/spring onions/zucchini if good.
- Cast iron in Ooni: crisp chickpeas or blister vegetables.
- Turn extra dough into flatbread dippers if useful.
- Build Sunday snack boxes while toppings are out.

Outputs:

- Sunday lunch: pizza/flatbread wedges with salad/pickles.
- Snack box: hummus/herb yogurt, charred vegetables, pita/flatbread chips, strawberries.

System note:

- Ooni heat is expensive in effort, so use it for dinner plus at least one charred vegetable branch.

### Sunday

Dinner:

- Lentil, herb, pea, cucumber/radish, and crispy chickpea salad with yogurt-tahini dressing and flatbread chips.

Session branches:

- Instant Pot: cook lentils if not already cooked, or cook a grain for Monday.
- Herb board: turn remaining herbs into herb oil/green sauce.
- Crunch finalization: crisp remaining chickpeas/pita if needed.
- Make overnight oats/chia jars for Monday/Tuesday breakfast.

Outputs:

- Monday lunch: lentil salad boxes.
- Breakfast: oats/chia jars.

System note:

- This is not a sad cleanup salad; it is the planned convergence of lentils, herbs, crispy chickpeas, pickles, and dressing.

### Monday

Dinner:

- Rescue mezze bowls or pita pockets: remaining hummus/herb sauce, lentils or chickpeas, pickles, herbs, charred veg, crispy bits, greens.

Session branches:

- Thin final sauce into dressing.
- Use remaining perishable herbs/greens.
- Inventory leftovers before next shopping cycle.

Outputs:

- Tuesday lunch if needed.
- Next-week notes: what was eaten fast, what lingered, what felt too much.

System note:

- Monday is intentionally flexible. The planner should not over-specify the rescue meal until it knows what remains.

## Snack Boxes

Default snack-box template:

- Homemade pita/flatbread/naan dippers.
- Hummus or herb yogurt.
- Cucumber/radish pickles.
- Raw snap peas or blanched asparagus if available.
- Strawberries.
- Optional feta/olives/nuts.

Rotation:

- Wednesday: tahini dip + raw vegetables + strawberries.
- Friday: hummus + herb yogurt + pita + pickles.
- Saturday/Sunday: charred vegetables + hummus + crispy chickpeas.
- Monday: lentil/herb salad + pita chips + yogurt dressing.

## Breakfasts

- Wednesday/Thursday: strawberry chia pudding.
- Friday: yogurt with strawberries, tahini/maple drizzle, nuts/seeds.
- Saturday/Sunday: overnight oats with strawberries or early cherries/apricots if good.
- Monday/Tuesday: chia/oats refreshed Sunday night.

## Shopping List Draft

Produce:

- Asparagus
- Snap peas or shelling peas
- Radishes
- Cucumbers
- Cabbage
- Herbs: mint, parsley, cilantro, dill if good
- Strawberries
- Lemons/limes
- Spring onions
- Artichokes if good
- Avocados if good
- Greens/lettuce
- Optional: favas, early zucchini, early cherries/apricots

Dry/pantry:

- Dry chickpeas
- Lentils
- Flour and yeast for pita/pizza dough
- Pasta/noodles or gnocchi
- Tahini
- Miso
- Sesame seeds/oil
- Sumac
- Harissa or chili crisp
- Oats/chia

Dairy/eggs:

- Eggs
- Yogurt
- Feta or ricotta
- Mozzarella if doing Ooni pizza

## What The System Did In This Run

1. Converted household constraints into hard filters.
2. Read seasonal reality for the actual week.
3. Used personal-library patterns as taste priors.
4. Selected high-branch ingredients.
5. Expanded ingredient states.
6. Pruned tempting but high-effort branches, especially falafel.
7. Scheduled active stations.
8. Made lunches/snacks emerge from branch outputs.
9. Kept Monday flexible because actual leftovers should drive it.

## Missing Data For A Better Run

- Exact ZIP/neighborhood for microclimate and market availability.
- Which day you want to fire the Ooni.
- Pantry/fridge inventory.
- Whether eggs/dairy are always okay or should be limited.
- How much active cooking time is realistic on each weekday.
- Whether you want a true baking project this week or just dough as a functional carrier.
