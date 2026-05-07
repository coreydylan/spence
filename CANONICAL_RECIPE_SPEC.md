# Spence Canonical Recipe System — Spec & Plan

_Last updated: 2026-04-05_

## Part 1: Data Foundation (Built)

### Core corpus
- 42,263 editorial recipes from 70 curated sources
- 396,780 parsed ingredient lines (99.4% canonical name coverage)
- 284,682 mined steps with 40+ extracted dimensions each

### Ingredient intelligence
- 12,537 canonical ingredients (shopping-list names, not categories)
- 11,287 role classifications
- 50,832 co-occurrence edges (PMI-scored)
- 278 hierarchy edges (type_of relationships)
- 98,931 normalization mappings
- Molecular flavor compounds + perceptions
- Nutrition, sustainability, taxonomy, produce profiles

### Structural classification
- 18 composition types + component
- 14 technique categories
- 70 cultural variant sets (mined by cuisine fingerprint)
- 41,199 recipes classified with method + equipment tags

### Canonical library (draft)
- 1,157 canonical dish clusters
- 433 documented variations
- 140 high-confidence dishes ready for review

### Technique knowledge graph
- 105,283 edges in D1 across 13 tables
- Per-technique: ingredients, equipment, sensory cues, colors, consistency states, pitfalls, sequences, adverbs, compositions, heat levels, rest actions, parameters
- API: `GET /techniques/:verb` returns full traversal

### Mined libraries
- 327 canonical pitfalls
- 243 causal rules
- 386 recovery rules
- Complexity scores, voice signatures, modality preferences

### iOS app (deployed)
- CardStreamView renderer (10+ card types)
- Composition builder (Bowl, Pasta, etc.) with slot cards + variant carousels
- Search → canonical dish flow (Banana Bread renders as card stream)

---

## Part 2: Architecture Decisions (Finalized)

### Core principle
**Structure is truth, prose is a view.** A CanonicalRecipe is a structured data object. Same object renders as browse/cook/builder/learn modes.

### Three orthogonal axes
1. **Composition** — bowl, pasta, curry...
2. **Method** — stovetop, instant pot, oven...
3. **Equipment strategy** — by hand, stand mixer, food processor...

### Three-level variation model
- **Named editorial variations** (pre-written diffs) — chocolate chip, vegan, GF
- **Equipment strategies** (technique-library-driven, render-time) — stand mixer rewrites specific steps
- **Ad-hoc user swaps** (dynamic composition) — butter → olive oil

### Components as first-class
Canonical recipes can be components (pesto, rice, grilled chicken) OR composite dishes (bowls, pastas). Composites REFERENCE components rather than inlining them. Quality compounds.

### Method variants within canonicals
"White Rice" = ONE canonical with multiple method_variants (stovetop, instant pot, rice cooker, baked). Same identity, different paths.

### Yield as the interface
Every canonical has structured yield with canonical_amount, canonical_unit, input_amount, transformation_ratio. Enables automatic scaling across nested components. "1 cup raw rice → 2 cups cooked" is data.

### Human-in-the-loop editorial workflow
AI aggregates + drafts. Human reviews every canonical. Target 15 min editor time per recipe.

### Card stream UI
Recipes render as typed card streams. Same card types work in builder/browse/cook with different renderings. Dynamic card injection.

### No source attribution shown
Provenance internal only. Spence just knows how to cook.

---

## Part 3: CanonicalRecipe Schema

```typescript
CanonicalRecipe {
  // Identity
  id, title, description, composition, category

  // Classification (graph tags)
  tags { meal, diet, cuisine, sweet_savory, effort, season }

  // Structure
  yield { canonical_amount, canonical_unit, input_amount,
          transformation_ratio, weight_grams, display }
  time { prep, cook, active, idle, total }

  // Component flags
  is_component, component_role, can_be_used_in[]

  // Ingredients (slot-aware)
  ingredient_groups[] {
    label, slot, component_ref?, items[]
  }
  items: CanonicalIngredient {
    role, canonical_name, consensus_qty, unit, prep,
    required_state, importance, frequency,
    alternatives[] { name, impact, ratio }
  }

  // Equipment
  equipment {
    full_inventory[] { item, count, purpose, required, step_indices[] }
    bowl_strategy, consumables[]
  }

  // Method variants
  method_variants[] {
    id, label, is_default, equipment[],
    parameters, steps[], total_time_min
  }
  default_method

  // Steps (per method)
  steps: CanonicalStep[] {
    index, phase, primary_action, secondary_actions[],
    ingredient_refs[], equipment_refs[],
    parameters { temp_f, heat_level, time, pan_size },
    sensory_cues[] { type, text },
    completion_signal, why_critical,
    causal_rule_ref, pitfall_refs[],
    expected_outcome, idle_time_min, parallel_task_hint,
    prose, expanded_explanation,
    applies_to_variants[]
  }

  // Variations as structured diffs
  variations[] {
    id, label, impact,
    step_insertions[], step_modifications[], step_skips[],
    ingredient_additions[], ingredient_swaps[]
  }

  // Sub-recipes (for multi-component dishes)
  sub_recipes[] // nested CanonicalRecipe objects

  // Dynamic cards
  context_hooks[]

  // Lifecycle: make-ahead, serving, leftovers, freezing, reheating
  lifecycle {
    make_ahead { can_make_ahead, prep_ahead_days, partial_prep_ahead,
                 improves_with_time, improves_note }
    serving { serve_temperature, serve_immediately, holds_well,
              holds_duration_hours, garnish_timing }
    leftovers {
      generates_leftovers,
      storage[] { location, container, duration_days, duration_max_days, notes },
      reheat_methods[] { method, temperature_f, duration_min, instructions, serving_tip },
      freezer { can_freeze, freeze_duration_months, freeze_prep,
                thaw_method, quality_note, freeze_portions },
      refresh_tips[], second_day_dishes[], safety_notes[]
    }
  }

  // Internal only
  _internal { source_recipe_ids, confidence, corpus_count,
              reviewed_at, reviewer }
}
```

---

## Part 4: Build Phases

### Phase 0: Schema + Infrastructure (Week 1)
- Finalize TypeScript types
- Create D1 tables: canonical_recipes, technique_library, pitfalls, causal_rules, recovery_rules, component_usage_graph
- Write JSON schema validator
- Hand-craft Banana Bread as first fully-structured canonical
- Verify schema handles all cases

### Phase 1: Pipeline Components (Weeks 2-4)
- **Aggregator**: extend extract_consensus.py for new schema
- **Component Matcher**: identify when inline ingredients match canonical components
- **Equipment Inventory Builder**: infer full equipment list
- **Method Variant Detector**: cluster source recipes by method within a canonical

### Phase 2: Technique Library (Week 5)
- Define ~50 core techniques
- Write technique pages (definition, procedure, purpose, pitfalls, equipment variants)
- Populate D1
- Link techniques to verbs in step structure

### Phase 3: AI Drafter + Linter (Week 6)
- Write Spence Recipe Style Guide
- Build AI prompt template
- Build structural linter
- Test on 10 diverse dishes

### Phase 4: Component Canonicalization (Weeks 7-10)
Review order: components first (50-70 items)
- Tier 1: 20 sauces
- Tier 2: 15 bases
- Tier 3: 15 proteins
- Tier 4: 15 condiments/toppings

Each component has method_variants.

### Phase 5: Composite Dish Canonicalization (Weeks 11-14)
Top 140 high-confidence dishes
- Reference Phase A components
- Inline only what isn't reusable
- AI draft → linter → editor review

### Phase 6: Rolling Publication (Ongoing)
- Remaining ~900 dishes, released as review time allows
- Lower-confidence dishes wait for Common Crawl ingestion

---

## Part 5: Success Metrics

**Per recipe:**
- Linter pass rate: 100%
- Editor time: ≤ 15 min
- Every cooking-action step has completion signal
- Component reuse where applicable

**Library:**
- Phase 4 complete: 50-70 components
- Phase 5 complete: 140 composite dishes
- Phase 6 ongoing: 500+ by end of quarter

**Cost:**
- AI inference (GPT-5.4-nano batch): $30-35 one-time
- Editor time: 50-60 hours (Phases 4+5 combined)
- D1 storage: ~20 MB for 1,157 recipes

---

## Part 6: Explicit Scope Cuts

- No three-prose-versions per step
- No per-recipe equipment strategy prose
- No pre-written variant prose for simple swaps
- No Common Crawl 2.2M ingestion yet
- No auto-ship (every recipe human-reviewed)

---

## Immediate Next Actions

1. Save this plan (DONE — `spence/CANONICAL_RECIPE_SPEC.md`)
2. Week 1 kickoff: finalize CanonicalRecipe TypeScript types + D1 schema
3. Hand-craft Banana Bread as reference example
4. Validate schema handles components, method variants, yield transformations
5. Build first pipeline stage (extend aggregator)
