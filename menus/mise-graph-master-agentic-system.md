# Mise-Graph Master Agentic System

Date: 2026-05-06

## Purpose

Mise-graph is the household food planning layer inside Spence.

It is not a static meal planner. It is a time-aware, audit-aware, resource-ledger system that uses:

- the global Spence culinary graph,
- personal recipe memory,
- household taste and equipment context,
- real and projected kitchen inventory,
- calendar constraints,
- and agentic repair loops

to produce menus, prep schedules, grocery plans, and recipe riffs that are actually executable in a household kitchen.

The center of the system is:

```text
time slots + resource lots + culinary transformations + household taste
```

A menu is only one projection of that system.

## Current Implementation Snapshot

The current vertical slice exists and has been tested live.

Live facade Worker:

- Worker: `mise-graph`
- URL: `https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev`
- Database: same production D1, `recipe-graph-db`

Integrated source:

- `worker/src/mise-graph.ts`
- `worker/src/mise-graph/resolver.ts`
- `worker/src/mise-graph/planner.ts`
- `worker/src/mise-graph/schema.sql`
- `worker/src/mise-graph/seed.ts`
- `worker/src/mise-graph-worker.ts`
- `worker/wrangler.mise.toml`

Current API supports:

- status
- ingredient/state expansion
- runtime graph resolution
- weekly plan generation
- plan persistence
- plan read-back
- starter mise state/edge/station seeding
- plan compilation into a resource/event ledger
- deterministic validation
- persisted timeline/ledger reads

Current live E2E proof:

- Input: 2 people, vegetarian at home, San Diego spring, chickpeas/tahini/flour/asparagus/radish/strawberries, Ooni, Instant Pot, food processor.
- Output: a persisted weekly plan with 8 component batches and 9 prep tasks.
- Ledger output: 38 resources, 41 timeline events, 70 event inputs, 35 event outputs, 46 reservations, and 40 validation issues.
- Limitation exposed: the current planner generates plausible shapes, and the ledger now exposes why the plan is not yet a fully valid kitchen simulation.

Important Cloudflare caveat:

- The source is integrated into `recipe-graph`.
- Publishing `recipe-graph` is currently blocked by Cloudflare API error `10023` on Durable Object binding permission.
- The `mise-graph` facade Worker is live against the same D1 as a temporary route surface.

## Existing Spence Graph

Spence already provides the global culinary intelligence layer.

Existing production graph tables include:

- `canonical_ingredients`
- `ingredient_edges`
- `canonical_dishes`
- `canonical_components`
- `produce_profiles`
- `produce_spots`
- `regional_seasons`
- `ingredient_compounds`
- `flavor_compounds`
- `tg_technique_ingredient`
- `tg_technique_equipment`
- `tg_technique_sequence`
- `composition_templates`

This answers:

- What is culinarily possible?
- What ingredients pair well?
- What components and dishes exist in the recipe corpus?
- What techniques are associated with ingredients?
- What equipment is associated with techniques?
- What is seasonal or local?
- What does the broader recipe corpus imply?

Mise-graph does not replace this. It layers household execution on top.

## Core Mental Model

The planner simulates the household kitchen over time.

At any timestamp it should know:

- raw ingredients available,
- prepared components available,
- quantities remaining,
- quality and expiration status,
- resources reserved for future meals,
- planned grocery/prep/cook events,
- household schedule,
- equipment state,
- user preferences,
- locked or flexible meal slots,
- personal recipes that can be cooked or riffed on.

The primary planning question is:

```text
At this point in time, what do we have, what can it become,
what should we make, what will that create for later,
and what needs to be bought, prepped, audited, or repaired?
```

## Foundational Objects

### Canonical Ingredient

A global Spence node.

Examples:

- chickpea
- tahini
- asparagus
- radish
- flour

Canonical ingredient records should connect to:

- seasonality,
- locality,
- taste compatibility,
- technique compatibility,
- common transformations,
- storage behavior,
- price observations later,
- personal household weights.

### Personal Recipe Source

A provenance-linked artifact imported from the user's world.

Sources:

- Instagram/social saves,
- Paprika exports,
- pasted URLs,
- screenshots,
- manually entered recipes,
- notes from past meals.

Every source keeps provenance:

- `source_url`
- `source_app`
- `author_or_account`
- `original_title`
- `raw_text_or_snapshot`
- `imported_at`
- `parser_confidence`
- source media in R2 when needed

The system can always trace a riff back to where the idea came from.

### Personal Recipe

A normalized cookable object derived from a personal source.

It should map to the Spence data shape:

- canonical ingredients,
- quantities,
- units,
- components,
- techniques,
- equipment,
- meal formats,
- cuisine grammar,
- flavor profile,
- prep/cook time,
- source provenance,
- household feedback.

A saved recipe is both:

1. something the user may want to cook,
2. taste evidence for future riffing.

### Taste Prior

A learned household preference or aversion.

Examples:

- likes vegetarian cooking at home,
- likes flatbreads and homemade dough,
- likes snack-box lunches,
- likes tahini/herb/pickle/crunch patterns,
- prefers dry beans/grains when manageable,
- tolerates Ooni projects,
- cooks only afternoon/evening,
- wants variety across cuisines,
- dislikes repetitive leftover use,
- often actually eats hummus quickly.

Taste priors are not direct recipes. They are weights that affect planning.

### Mise State

A culinary state of an ingredient or component.

Examples:

- dry chickpeas,
- soaked chickpeas,
- cooked whole chickpeas,
- hummus,
- crispy chickpeas,
- falafel mix,
- quick pickled radishes,
- lemon tahini sauce,
- mixed dough,
- cold-fermented dough.

States know:

- state kind,
- whether directly edible,
- role tags,
- storage defaults,
- quality windows,
- compatible meal formats,
- compatible cuisine grammars,
- valid transformations.

### Transformation

A culinary conversion from input resources to output resources.

Examples:

```text
dry chickpeas -> soaked chickpeas
soaked chickpeas -> cooked chickpeas
cooked chickpeas + tahini + lemon + garlic -> hummus
radish + vinegar + salt -> quick pickled radishes
flour + water + yeast -> dough
dough + 48-72 hr -> cold-fermented dough
```

Transformations need:

- required inputs,
- optional inputs,
- substitutions,
- output yields,
- active time,
- idle time,
- earliest/latest make-ahead windows,
- best quality window,
- equipment,
- station tags,
- storage result,
- shelf life,
- cuisine/format compatibility.

### Resource Lot

A real or projected thing in the household kitchen.

Examples:

- `900g dry chickpeas`, pantry, high confidence,
- `600g cooked chickpeas`, fridge, projected,
- `1 jar hummus`, fridge, expires Friday,
- `2 dough balls`, cold fermenting,
- `half jar mayo`, observed gone.

Fields:

- household id,
- canonical ingredient/component id,
- state id,
- label,
- quantity,
- unit,
- storage location,
- created_at,
- best_until,
- safe_until,
- quality status,
- confidence,
- source: projected, observed, corrected, consumed, discarded,
- reserved future uses.

Resource lots are the ledger's truth units.

### Plan Event

Something that happens in time.

Event types:

- grocery trip,
- prep task,
- cook window,
- meal service,
- snack box pack,
- leftover created,
- leftover consumed,
- audit prompt,
- inventory adjustment,
- discard expired item,
- cleanup/reset.

Each event can:

- consume resources,
- produce resources,
- reserve resources,
- depend on earlier events,
- belong to a calendar window,
- carry validation issues.

### Cook Event

A bounded calendar block where active kitchen work happens.

Example:

```text
Friday 5:45pm-6:45pm
Cook dinner / final assembly
```

Cook events expand as tasks are added.

If the user asks to shorten or move a cook event, the time compiler must repair by:

- moving make-ahead tasks earlier,
- simplifying the meal,
- substituting existing resources,
- creating another prep event,
- or asking for approval.

### Meal Event

The actual service event.

Examples:

- Wednesday dinner for 2,
- Friday lunch for 8,
- snack box packing,
- breakfast tray.

A meal event has:

- time,
- people,
- appetite/portion target,
- location,
- reheating availability,
- portability,
- meal format,
- cuisine direction,
- locked/flexible status,
- required resources,
- optional resources,
- expected leftovers.

### Reservation

A claim on a resource lot for a future event.

Reservation types:

- hard: required,
- soft: preferred,
- opportunistic: use if available,
- avoid-use: save this resource.

Reservations let the system detect downstream breakage.

### Audit Observation

A user or agent update about real kitchen state.

Examples:

- "We used all the hummus."
- "There are three dough balls."
- "We still have half the tahini sauce."
- "The mayo was never made."

Observed facts should override projections.

### Plan Revision

A persisted diff, not a silent mutation.

Examples:

- added prep task,
- moved cook event,
- replaced meal,
- released hummus reservation,
- added grocery item,
- warning introduced,
- audit question resolved.

## Compatibility Contracts

The current prototype showed why compatibility is mandatory.

Bad outputs happen when the system treats components as generic labels.

Every resource/component needs compatibility contracts:

```text
hummus:
  role_tags: dip, spread, sauce_when_thinned
  compatible_formats: snack_box, mezze, sandwich, bowl, flatbread
  incompatible_formats: sweet_breakfast

strawberry jam:
  role_tags: sweet_spread, fruit_component
  compatible_formats: breakfast, toast, yogurt, dessert
  incompatible_formats: tacos, soup, savory_bowl

soaked chickpeas:
  edible_directly: false
  valid_as_input_to: cooked_chickpeas, falafel_mix
```

Meal templates should be role-based:

```text
grain bowl:
  base: grain
  protein: legume/tofu/egg
  vegetable: one_or_more
  sauce: dressing
  crunch_or_pickle: optional
```

The planner should fill roles, not attach arbitrary components.

## Time Compiler

The time compiler turns a menu into an executable calendar.

Invariant:

```text
a meal cannot happen unless its required resources exist before service time
```

If a resource does not exist, the system schedules upstream events:

- grocery,
- prep,
- cook,
- idle wait,
- audit,
- repair.

Every transformation/component has timing windows:

```text
hummus:
  active_time: 12 min
  can_make_ahead: 0-4 days
  best_window: 0-3 days before service

quick pickled radishes:
  active_time: 10 min
  idle_time: 30 min
  best_window: 1-3 days before service

cold-fermented dough:
  active_time: 20 min
  idle_time: 48-96 hr
  best_window: 48-72 hr before service

tossed salad:
  active_time: 4 min
  must_be_done_within: 15 min before service
```

The compiler must optimize available cook windows.

It should cluster compatible tasks:

- food processor dirty: hummus, falafel mix, herb sauce,
- oven hot: roasted vegetables, crispy chickpeas,
- Ooni hot: flatbread, pizza, charred vegetables,
- pickle station: radishes, onions, cucumbers,
- herb wash: whole-leaf reserve, chopped mix, herb sauce.

It must avoid bad clusters:

- tossed salad days ahead,
- crispy toppings too early,
- 72-hour dough 12 hours before pizza,
- two Instant Pot tasks overlapping.

## Resource Ledger Loop

The ledger is the deterministic simulator.

For any planning window:

1. Load observed inventory.
2. Load overlapping existing plans.
3. Apply grocery events.
4. Apply prep/cook transformations.
5. Apply meal consumption.
6. Create leftovers.
7. Decay or expire resources.
8. Reconcile audit observations.
9. Expose projected availability at every timestamp.

Planning over 2 days, 2 weeks, or 2 months is the same operation: iterate the ledger forward in time.

## Audit Loop

The audit loop connects projections to reality.

Audit types:

- onboarding audit,
- user-initiated inventory update,
- targeted agent question,
- recurring expiration/use-up audit,
- pre-plan confidence check,
- post-meal feedback audit.

The system should only ask questions that matter.

Bad:

```text
Do you still have tahini?
Do you still have radishes?
Do you still have chickpeas?
```

Good:

```text
Before I lock Friday/Saturday, can you confirm whether the hummus is gone
and whether the radishes are still usable? Those affect three planned meals.
```

When an audit arrives:

1. Parse the observation.
2. Create or update observed resource lots.
3. Recompute the projected ledger.
4. Find affected future reservations/events.
5. Notify plan/event coordinators.
6. Generate repairs.
7. Return a revision diff.

## Repair Loop

Repair is triggered when a resource, time, or preference change breaks future assumptions.

Examples:

- mayo was used up,
- pizza dough was never made,
- Friday lunch changes from 2 to 8 people,
- grocery trip moved one day later,
- hummus expires unused,
- user asks to shorten a cook event.

Repair options:

- make missing component upstream,
- substitute compatible component,
- add grocery item,
- move meal,
- simplify meal,
- split prep into another cook window,
- ask user to choose.

Current deterministic implementation:

- `POST /mise-graph/repair` runs compile -> validate -> repair loops.
- The first pass rewrites generic snack resources, removes or replaces incompatible components, moves prep earlier, remakes expired components, and inserts upstream remakes when a downstream prep task needs a fresh input.
- Repair runs are stored in `mise_repair_runs`.
- The persisted sample plan now compiles to 49 resource lots, 67 events, 34 reservations, and 0 validation issues.

Example:

```text
Mayo gone:
  affected: Friday lunch, Saturday snack box
  options:
    1. make mayo during Thursday cook event
    2. substitute yogurt sauce
    3. add mayo to grocery list
```

## Personal Recipe Memory And Riffing

The system should know specific recipes the user loves.

Sources:

- saved social recipes,
- Paprika recipes,
- pasted links,
- screenshots,
- prior generated riffs,
- household feedback.

Personal recipes are normalized into Spence shape but keep provenance.

The system can then:

- cook exact saved recipes,
- adapt saved recipes to current resources,
- cluster similar saved recipes into taste priors,
- invent new recipes that feel like the household,
- explain the lineage of an invented recipe.

Example riff:

```text
For Thursday dinner, riff on your saved harissa chickpea flatbread,
but use the cooked chickpeas already in the ledger, pickled radishes
because they are in season, and lemon tahini sauce because it expires Friday.
```

Every riff should keep lineage:

```json
{
  "title": "Ooni Flatbread With Smashed Chickpeas And Pickled Radish",
  "lineage": [
    { "source_recipe_id": "instagram_abc", "influence": "format" },
    { "source_recipe_id": "paprika_456", "influence": "dough formula" },
    { "spence_node": "chickpea+tahini affinity", "influence": "flavor pairing" },
    { "spence_node": "radish spring CA", "influence": "seasonality" }
  ]
}
```

## Agent Roles

Agents should not free-write plans. They should propose structured mutations to the event/resource model.

### PlannerAgent

Creates meal/event candidates for a requested window.

Inputs:

- target slots,
- existing plan,
- ledger projection,
- personal recipe memory,
- user prompt,
- constraints.

Outputs:

- candidate meal events,
- required resources,
- expected outputs,
- prep dependencies.

### RecipeRiffAgent

Adapts or invents recipes from personal recipe memory and Spence knowledge.

Outputs:

- recipe object,
- lineage,
- compatibility tags,
- resource requirements,
- leftovers/components produced.

### LedgerAgent

Simulates resource flow over time.

Outputs:

- projected resource availability,
- broken reservations,
- expiration warnings,
- resource confidence.

### CalendarCompilerAgent

Schedules grocery/prep/cook tasks into real calendar windows.

Outputs:

- cook windows,
- task ordering,
- duration expansion,
- timing conflicts.

### ValidatorAgent

Finds impossible or low-quality plans.

Checks:

- missing resources,
- expired resources,
- incompatible component use,
- prep after meal,
- overloaded cook windows,
- repeated flavors,
- bad leftovers,
- user constraints.

### RepairAgent

Responds to changes and validation failures.

Outputs:

- proposed revisions,
- substitutions,
- new prep/grocery events,
- user questions.

### AuditAgent

Manages real-world inventory questions and updates.

Outputs:

- audit sessions,
- parsed observations,
- impacted resources/events.

### TasteAgent

Learns household preferences from saved recipes, plans, and feedback.

Outputs:

- taste priors,
- repetition penalties,
- component affinities,
- prep-completion likelihood.

### ShoppingAgent

Turns resource gaps into grocery trips and shopping lists.

Outputs:

- grocery event,
- store sections,
- quantities,
- pantry subtraction,
- optional price observations later.

### PrepAgent

Optimizes prep tasks across available cook windows and stations.

Outputs:

- task clustering,
- make-ahead schedule,
- station reuse suggestions.

## Structured Proposal Protocol

Agents communicate through proposals.

Example:

```json
{
  "proposal_type": "replace_meal",
  "target_event_id": "meal_2026_05_08_lunch",
  "remove_reservations": ["reservation_hummus_200g"],
  "add_events": ["prep_salsa_roja", "meal_taco_lunch_for_8"],
  "add_resource_requirements": ["tortillas", "cabbage", "lime"],
  "expected_outputs": ["leftover_black_beans_400g"],
  "validation_notes": ["requires grocery before Friday noon"]
}
```

The coordinator validates and persists proposals as plan revisions.

## Product Views

The eventual UI should have four primary views.

### Calendar

Shows:

- meals,
- cook windows,
- prep tasks,
- grocery trips,
- audit prompts,
- resource expiration events.

Supports:

- move meal,
- shorten cook,
- lock event,
- change people count,
- plan only selected slots.

### Inventory

Shows:

- actual resources,
- projected resources,
- quantities,
- storage,
- expiration,
- confidence,
- reservations,
- audit status.

Supports:

- user-initiated audits,
- mark gone,
- add resource,
- correct quantity,
- reserve/save item.

### Graph

Shows:

- ingredients,
- states,
- transformations,
- personal recipe links,
- activated edges,
- possible branches.

Supports:

- inspect why a component exists,
- see what an ingredient can become,
- seed a branch.

### Inbox

Shows:

- audit questions,
- warnings,
- repair options,
- plan diffs,
- approval requests.

Supports:

- approve revision,
- choose repair,
- answer inventory question,
- reject suggestion.

## Cloudflare Infrastructure Mapping

### Current Deployed Infrastructure

`recipe-graph` Worker:

- Main Spence Worker.
- Routes existing graph APIs, ingest/process APIs, and source-integrated mise-graph routes.
- Currently blocked from redeploy by Cloudflare Durable Object binding permission error `10023`.

`mise-graph` Worker:

- Temporary facade exposing mise-graph routes.
- Bound only to D1.
- Deployed and live.

D1 `recipe-graph-db`:

- Source of truth for Spence graph and mise-graph.
- Current size about 389 MB.
- Existing graph and current mise tables live here.

R2 `recipe-graph-ingest`:

- Raw recipe/source ingest storage.
- Should also store personal recipe snapshots, screenshots, exports, and parse artifacts.

Queues:

- `recipe-pipeline`
- `ingredient-normalize`

Durable Objects:

- `PipelineOrchestrator` currently exists for recipe pipeline orchestration.

Workflow:

- `recipe-pipeline`

Workers AI:

- Available as `AI` binding for classification/normalization tasks.

Secret:

- `ANTHROPIC_API_KEY`

Cron:

- Current recipe graph cron every 6 hours.

### Proposed Cloudflare Components

D1 remains canonical persisted truth.

Add D1 table groups:

- personal recipe memory,
- recipe lineage,
- recipe taste vectors,
- resource lots,
- plan events,
- event inputs/outputs,
- resource reservations,
- audit sessions,
- audit items,
- plan revisions,
- validation issues,
- transformations,
- time compiler task windows,
- price observations later.

Durable Objects should coordinate active mutable sessions, not own all truth.

Recommended DOs:

- `PlanCoordinatorDO`: active plan/revision coordination for one household/window.
- `HouseholdInventoryDO`: audit and inventory update coordination for one household.
- `AuditSessionDO`: optional live audit interview state.

Avoid one Durable Object per ingredient/component initially. Model resources as D1 lots first. Promote to DO only if live concurrent coordination requires it.

Queues:

- `mise-plan-jobs`: async long planning/replanning.
- `mise-audit-jobs`: audit prompts and parsing.
- `mise-repair-jobs`: downstream repair after inventory changes.
- `personal-recipe-ingest`: social/Paprika/link imports.
- `price-observation-jobs`: future local pricing research.

Workflows:

- `MisePlanWorkflow`: long-running plan generation for large windows.
- `MiseReplanWorkflow`: repair a plan revision after changes.
- `PersonalRecipeImportWorkflow`: ingest, parse, normalize, link provenance.
- `AuditWorkflow`: recurring or triggered audit sessions.

R2:

- raw personal recipe sources,
- screenshots,
- HTML snapshots,
- Paprika exports,
- parser intermediate artifacts,
- generated plan exports if needed.

Cron triggers:

- expiration scan,
- low-confidence audit prompt generation,
- upcoming-meal validation,
- seasonal context refresh,
- price observation refresh later.

AI bindings/external model calls:

- parsing personal recipes,
- classifying recipe roles,
- generating recipe riffs,
- summarizing plan diffs,
- natural language audit parsing.

Deterministic modules should still own:

- ledger simulation,
- validation,
- quantity math,
- time compilation,
- reservation logic,
- compatibility checks.

## Build Philosophy

The system should be agentic at the edges and deterministic at the core.

Agentic:

- interpreting user prompts,
- importing messy recipes,
- proposing riffs,
- asking audits,
- explaining tradeoffs.

Deterministic:

- resource ledger,
- quantities,
- reservations,
- timing,
- event dependencies,
- expiration,
- validation,
- persisted revisions.

This keeps the system flexible without becoming uninspectable.

## North Star Acceptance Test

User asks:

```text
Plan 14 days of vegetarian dinners, breakfasts, and snack-box lunches for 2.
Use seasonal San Diego produce.
Use existing pantry and projected leftovers.
Cook only afternoon/evening.
We want Japanese and Mexican flavors this week.
Friday lunch is for 8.
Try to use the hummus, but do not force it into weird meals.
```

The system returns:

- readable menu,
- grocery events,
- prep schedule,
- cook windows,
- meal events,
- snack boxes,
- resource ledger,
- expiration warnings,
- audit questions,
- validation issues,
- proposed repairs,
- plan revision diff,
- recipe lineage for any riffs.

Then the user says:

```text
We used all the hummus.
```

The system:

1. updates the resource ledger,
2. finds affected future meals,
3. releases/rescinds reservations,
4. proposes repairs,
5. inserts prep/grocery events if needed,
6. returns an understandable diff.

That is the full agentic household food operating system.
