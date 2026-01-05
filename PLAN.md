# Spence

**An opinionated recipe app that teaches home cooks to cook like pros.**

---

## The Problem

Recipes today are broken:

1. **Inconsistent format** — Every blog, cookbook, and chef writes differently
2. **Assumed knowledge** — "Sauté until translucent" means nothing to a beginner
3. **No skill building** — You follow blindly, never learn *why*
4. **Static & dumb** — Same recipe whether you have a thermometer or not, scale or not
5. **No workflow guidance** — Just a list of steps, figure out the dance yourself
6. **Measurements are a mess** — "1 medium onion" vs "150g onion" vs "1 cup diced onion"
7. **No mise en place habits** — Recipes bury "dice the carrots" in step 5 while something's burning

---

## The Solution

**Spence** is a cooking education system disguised as a recipe app.

### Our Moat

> Every recipe flows the same way, teaches the same habits, and actually sets you up to succeed before you turn on the stove.

We are **opinionated** about how recipes should be structured. When you import any recipe into Spence, our AI normalization layer transforms it into our proven three-phase workflow.

---

## MVP: Three Phases, Every Recipe

### Phase 1: CHECK ✓

**"Do you have everything?"**

- Equipment needed (filtered by what user owns)
- Ingredients needed (displayed in user's preferred units)
- Clear yes/no before proceeding
- Substitution suggestions if something's missing

### Phase 2: PREP 🔪

**"Get everything ready before you touch the stove."**

- Step-by-step mise en place instructions
- ALL cutting, measuring, portioning happens here
- Each prep step produces a clear output ("diced onion → small bowl")
- Prep is grouped logically (all knife work together, all measuring together)
- When complete: "Your prep is done. Nothing left to chop mid-cook."

### Phase 3: COOK 🔥

**"Now you're just assembling and applying heat."**

- Focused only on cooking technique and timing
- No surprise prep work mid-stir
- Clear sequencing with dependencies noted
- Time estimates per step
- "While X is happening, you can Y" guidance

---

## Differentiation

| Other Recipe Apps | Spence |
|-------------------|--------|
| Ingredients + Steps blob | Three distinct phases |
| "Dice onion" buried in step 3 | All knife work done upfront in Prep |
| You figure out the workflow | We give you the workflow |
| Same recipe for everyone | Adapts to your equipment & preferences |
| Measurements one way only | Weight or volume, your choice |
| Recipe assumes you know things | Teaches good habits every single time |

---

## User Profile (MVP)

### Equipment Inventory

Users indicate what they have:

- [ ] Kitchen scale
- [ ] Instant-read thermometer
- [ ] Stand mixer
- [ ] Immersion blender
- [ ] Food processor
- [ ] Dutch oven
- [ ] Cast iron skillet
- [ ] etc.

**Impact:** Recipe adapts based on equipment. No scale? Show volume measurements. No stand mixer? Show hand-mixing alternative.

### Preferences

- **Measurement style:** Weight (grams) vs Volume (cups/tbsp)
- **Unit system:** Metric vs Imperial
- **Verbosity:** Concise vs Detailed instructions

---

## Ingredient Intelligence

We need a data layer that understands:

```
1 medium onion ≈ 150g ≈ 1 cup diced
1 clove garlic ≈ 5g ≈ 1 tsp minced
1 cup all-purpose flour ≈ 125g
1 cup granulated sugar ≈ 200g
```

### Potential Sources / APIs

- **USDA FoodData Central API** — Has weight/volume conversions for many foods
- **Open Food Facts** — Community database with nutrition + packaging data
- **Spoonacular API** — Recipe API with ingredient parsing
- **Custom curated database** — Start with top 200 ingredients, expand over time

### Data Model

```json
{
  "ingredient": "onion",
  "variants": {
    "small": { "weight_g": 100, "volume_cups_diced": 0.66 },
    "medium": { "weight_g": 150, "volume_cups_diced": 1.0 },
    "large": { "weight_g": 200, "volume_cups_diced": 1.33 }
  },
  "prep_conversions": {
    "whole": 1.0,
    "diced": 0.9,
    "minced": 0.85,
    "sliced": 0.95
  }
}
```

---

## AI Normalization Layer

### Purpose

Take ANY recipe from ANY source and transform it into Spence's structured format.

### Input

Raw recipe text (from URL, image, copy-paste, Paprika import, etc.)

### Output

```json
{
  "name": "Corey's Calabrian Chili",
  "source": "Original",
  "servings": "6-8",
  "total_time_minutes": 55,

  "equipment": [
    { "item": "Dutch oven or large heavy pot", "required": true },
    { "item": "Cutting board", "required": true },
    { "item": "Chef's knife", "required": true },
    { "item": "Immersion blender", "required": false, "alternative": "Regular blender" },
    { "item": "Kitchen scale", "required": false }
  ],

  "ingredients": [
    {
      "item": "butter",
      "quantity_volume": "3 tablespoons",
      "quantity_weight_g": 42,
      "prep": null,
      "category": "dairy"
    },
    {
      "item": "red onion",
      "quantity_volume": "1 medium",
      "quantity_weight_g": 150,
      "prep": "diced",
      "category": "produce"
    }
  ],

  "prep_steps": [
    {
      "id": "prep_1",
      "instruction": "Dice the red onion",
      "outputs": ["diced red onion"],
      "station": "knife",
      "time_minutes": 3,
      "skill_link": "dice-an-onion"
    },
    {
      "id": "prep_2",
      "instruction": "Chop the carrots",
      "outputs": ["chopped carrots"],
      "station": "knife",
      "time_minutes": 3
    },
    {
      "id": "prep_3",
      "instruction": "Mince the garlic",
      "outputs": ["minced garlic"],
      "station": "knife",
      "time_minutes": 2,
      "skill_link": "mince-garlic"
    },
    {
      "id": "prep_4",
      "instruction": "Measure out spices: cumin, smoked paprika, oregano, Aleppo pepper, cayenne, black pepper",
      "outputs": ["spice blend"],
      "station": "measuring",
      "time_minutes": 2
    },
    {
      "id": "prep_5",
      "instruction": "Drain and rinse all beans",
      "outputs": ["prepped black beans", "prepped pinto beans"],
      "station": "sink",
      "time_minutes": 2
    },
    {
      "id": "prep_6",
      "instruction": "Measure gochujang, Calabrian chili paste, and chili oil into a small bowl",
      "outputs": ["chili paste mixture"],
      "station": "measuring",
      "time_minutes": 1
    }
  ],

  "cook_steps": [
    {
      "id": "cook_1",
      "instruction": "Melt butter in Dutch oven over medium heat",
      "time_minutes": 1,
      "depends_on": [],
      "uses": ["butter"]
    },
    {
      "id": "cook_2",
      "instruction": "Add onion, sweat until translucent, seasoning with salt",
      "time_minutes": 8,
      "depends_on": ["cook_1"],
      "uses": ["diced red onion"],
      "cues": ["Onion should be soft and slightly translucent"]
    },
    {
      "id": "cook_3",
      "instruction": "Add spice blend to onions, bloom until fragrant",
      "time_minutes": 2,
      "depends_on": ["cook_2"],
      "uses": ["spice blend"],
      "cues": ["Should smell toasty and aromatic"]
    }
  ]
}
```

### Master Prompt (Draft)

```
You are a culinary expert helping to normalize recipes into a structured, educational format for home cooks.

Given any recipe, transform it into our three-phase format:

## PHASE 1: CHECK
Extract all equipment and ingredients. For ingredients:
- Identify the item, quantity, and any prep work required
- Provide both volume AND weight measurements where possible
- Categorize for shopping (produce, dairy, pantry, protein, etc.)

## PHASE 2: PREP
Break out ALL prep work into discrete steps:
- Every cutting, dicing, mincing, measuring task
- Group by station: knife work, measuring, sink work, etc.
- Each step should produce a clear output
- Estimate time for each step
- Nothing that requires heat belongs here

## PHASE 3: COOK
The actual cooking, with:
- Clear dependencies (what must happen before this step)
- Time estimates
- Sensory cues (what to look/smell/listen for)
- Only uses prepped ingredients from Phase 2

## RULES
1. NEVER include knife work in cooking steps
2. ALL measuring happens in prep
3. Be specific about quantities and timing
4. Include sensory cues, not just times
5. Note when steps can run concurrently
6. Identify required vs optional equipment
```

---

## Tech Stack (Proposed)

### iOS App
- **SwiftUI** for UI
- **SwiftData** for local persistence
- **CloudKit** for sync (optional, future)

### Backend / AI
- **Claude API** for recipe normalization
- **Supabase** for:
  - User profiles
  - Recipe storage
  - Ingredient database
  - Auth

### Data Sources
- Paprika import (we have access to the SQLite schema)
- URL ingestion (scrape + normalize)
- Manual entry
- Photo/OCR (future)

---

## Test Plan

Pull 5 diverse recipes from Paprika to test normalization:

1. **Simple/No-cook** — Salad or cold dish
2. **Knife-heavy** — Stir fry or chopped salad
3. **Long cook time** — Braise, chili, or stew
4. **Baking precision** — Cake or bread
5. **Multi-component** — Full meal with sides

### Success Criteria
- All knife work extracted to prep phase
- All measurements provided in both weight and volume
- Cook phase has zero surprise prep
- Dependencies are accurate
- Time estimates are reasonable

---

## Future Features (Post-MVP)

### Skills Library
- Atomic techniques with video/text
- Recipes link to skills
- Users track skills learned
- Progressive difficulty

### Smart Scaling
- Scale recipes up/down
- Mise en place adjusts accordingly
- Equipment suggestions adjust (bigger pot, etc.)

### Meal Planning
- Multi-recipe mise en place consolidation
- Prep once for multiple meals
- Shopping list generation

### Cooking Mode
- Step-by-step guided view
- Voice control ("next step")
- Timers integrated
- Screen stays on

### Social
- Share recipes in Spence format
- "I made this" with notes
- Modifications tracked

---

## Open Questions

1. **Ingredient database** — Build our own or use existing API? Start curated + expand?
2. **Offline support** — How much works without internet?
3. **Import formats** — Paprika, Mela, copy/paste, URL — prioritize which?
4. **Monetization** — Free with limits? Subscription? One-time purchase?
5. **Recipe ownership** — Can users edit normalized recipes? Fork them?

---

## Next Steps

1. [ ] Draft master normalization prompt
2. [ ] Test with 5 Paprika recipes
3. [ ] Design ingredient data model
4. [ ] Wireframe the three-phase UI
5. [ ] Set up Xcode project
6. [ ] Set up Supabase backend

---

*Last updated: January 2025*
