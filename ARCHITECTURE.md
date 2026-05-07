# Spence — Architecture & Data Model

## Core Concept

A cooking app where every recipe is a **live configuration**, not a static document. Built on a knowledge graph derived from 42k+ editorial recipes, with every ingredient classified by role, every dish clustered by identity, and every recipe structurally matched to a composition type.

The user never sees the underlying data. Spence just knows how to cook.

---

## Three Axes (Independent Dimensions)

Every canonical dish is tagged on three independent axes. These are NOT hierarchy — they're graph edges.

### 1. Composition (structural shape of the dish)
How slots are arranged. This is the primary axis.

| Composition | Slots |
|---|---|
| **Baked Good** | flour + fat + sweetener + leavener + binder + flavor |
| **Soup** | aromatic + vegetable + protein(opt) + liquid + seasoning + finish |
| **Pasta** | pasta + sauce + protein(opt) + vegetable(opt) + cheese + herb |
| **Curry** | protein(opt) + aromatic + spice + liquid + vegetable(opt) + base |
| **Salad** | base/greens + vegetables + protein(opt) + dressing + crunch |
| **Bowl** | base + protein + vegetables + sauce + finish |
| **Stir Fry** | protein + vegetables + aromatic + sauce + base(opt) |
| **Pizza/Flatbread** | dough + sauce + cheese + toppings |
| **Sandwich/Wrap** | bread + protein + vegetables + spread/sauce + cheese |
| **Taco** | shell + protein + toppings + salsa + finish |
| **Casserole** | base + protein(opt) + vegetable + sauce + topping |
| **Dip/Spread** | base + acid + fat + seasoning |
| **Drink** | liquid + fruit/flavor + sweetener(opt) + boost(opt) |
| **Eggs/Breakfast** | egg + vegetable + cheese(opt) + base(opt) |

### 2. Method (how you cook it)
An edge/tag, NOT a composition.

Roasted, Stir-fried, Baked, Grilled, Braised, Fried, Raw/No-cook, Simmered, Steamed, Fermented, Pickled

### 3. Equipment (what you use)
An edge/tag, NOT a composition.

Sheet pan, Dutch oven, Instant pot, Slow cooker, Air fryer, Skillet, Wok, Grill, Stand mixer, Food processor

---

## Tag Dimensions (all are graph edges)

| Dimension | Values |
|---|---|
| **Sweet/Savory** | sweet, savory, both |
| **Meal** | breakfast, brunch, lunch, dinner, snack, dessert, drink |
| **Effort** | weeknight (<30min active), weekend, project |
| **Cuisine** | detected from ingredient fingerprints |
| **Season** | spring, summer, fall, winter, year-round |
| **Diet** | vegan, vegetarian, gluten-free, dairy-free (auto-detected) |

---

## Recipe Hierarchy (3 levels only)

```
Composition → Category → Canonical Dish → [Variations]
```

**Composition** = structural type (Baked Good, Soup, Pasta...)

**Category** = sub-grouping within a composition:
- Baked Goods → Cookies, Cakes, Quick Breads, Yeast Breads, Pies, Bars, Pastry
- Soups → Brothy, Creamy, Chili/Stew
- Pasta → Sauced, Baked, Cold/Salad, Asian Noodles
- Curries → Indian, Thai, Japanese
- Salads → Green, Grain/Bean, Vegetable, Protein
- etc.

**Canonical Dish** = the actual recipe (Banana Bread, Hummus, Tikka Masala)
- This is the deepest level. We don't go further.
- "Chocolate chip banana bread" is a VARIATION of Banana Bread, not its own dish.

**Variation** = a named diff from the canonical:
- Adds/removes/swaps ingredients in specific slots
- e.g., "vegan" variation of banana bread: swaps egg→flax egg, butter→coconut oil
- Each variation is a documented set of slot changes

---

## The Canonical Recipe Page

When a user searches "banana bread" and taps the result:

**What they see:**
- The Spence recipe — consensus ingredients with quantities, structured steps
- Every ingredient is tappable/swappable
- Variations surfaced below (chocolate chip, brown butter, vegan, pumpkin)
- Suggested swaps from the graph ("people also use: greek yogurt for sour cream")
- Context hooks that fire based on current recipe state

**What they DON'T see:**
- Source attribution (never — provenance is internal only)
- "Derived from 12 recipes" or any aggregation language
- Any reference to underlying data sources

The recipe is presented as Spence's recipe. Period.

---

## Object Model

- **Canonical** = the consensus recipe (one per dish, derived from cluster data)
- **Variation** = a named diff from the canonical
- **Swap** = an ingredient substitution with downstream effects (from the edge graph)
- **Hook** = a contextual tip triggered by recipe state (from instruction mining)
- **Slot** = a functional position in a composition (base, protein, sauce, etc.)

---

## Data Foundation (internal, never exposed)

| Layer | Count | Source |
|---|---|---|
| Editorial recipes | 42,331 | 70 curated food blog sources |
| Canonical ingredients | 12,537 | Normalized via GPT-5.4-nano |
| Ingredient roles | 11,287 | Rule-based + AI classified |
| Ingredient edges | 58,127 | PMI co-occurrence scores |
| Dish clusters | 1,590 | Title + ingredient clustering |
| Canonical recipes | 1,590 | Consensus extraction |
| Compositions | 14 types | Structural matching |
| Recipe→composition | 41,199 | Title + structural matching |
| Source weights | 70 sources | Chef / editorial / blogger tiers |

Future: 2.2M Common Crawl recipes as corpus tier (intelligence layer, never surfaced).

---

## Tech Stack

- **Cloudflare Workers** — API layer
- **Cloudflare D1** — canonical data store
- **Cloudflare Durable Objects** — live recipe sessions, swap engine
- **Cloudflare Queues** — batch processing
- **Cloudflare Workers AI** — embeddings, classification
- **Cloudflare R2** — images, raw data
- **Supabase** — user auth + profiles
- **OpenAI Batch API** — bulk processing (normalization, classification)
- **iOS (SwiftUI)** — native app
