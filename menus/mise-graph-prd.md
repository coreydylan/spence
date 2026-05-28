# Mise-Graph PRD

Date: 2026-05-06

## Product Summary

Mise-graph is an agentic meal planning, inventory, prep, and recipe riffing system for households.

It turns the Spence culinary graph and a user's personal recipe memory into executable household food plans. It does this by modeling the kitchen as a time-aware resource ledger: grocery trips create resources, prep tasks transform resources, meals consume resources, audits correct projections, and repair agents update downstream plans when reality changes.

The product must produce plans that are:

- readable,
- culinarily coherent,
- resource-valid,
- quantity-aware,
- calendar-aware,
- provenance-linked,
- adaptive to real inventory,
- and explainable.

## Problem

Current meal planners generally produce static menus and shopping lists. They fail at the actual household problem:

- ingredients change state,
- prepared components expire,
- people snack on things,
- leftovers affect future meals,
- prep needs to fit real calendar windows,
- the user has saved recipes they love,
- seasonal/local availability matters,
- edits ripple downstream,
- and the system needs to ask the user targeted real-world questions.

The current mise-graph prototype proves that Spence can activate culinary prep edges and produce a plan, but it also exposes the next requirement: the system needs a resource ledger, calendar compiler, validation layer, audit loop, and recipe-riffing layer.

## Goals

1. Generate useful menus over arbitrary planning windows.
2. Track raw ingredients and prepared components as resource lots over time.
3. Compile menus into grocery/prep/cook/meal events.
4. Validate that every meal has resources available before service.
5. Use personal saved recipes as taste evidence and cookable provenance-linked artifacts.
6. Invent recipe riffs that are similar to what the user likes while using current resources efficiently.
7. Support user and agent audits of real-world inventory.
8. Repair future plans when inventory, schedule, or meal requirements change.
9. Map all state and execution onto the existing Cloudflare/Spence infrastructure.

## Non-Goals For The Next Lane

- Do not build a polished UI before the resource/event model works.
- Do not make every resource lot a Durable Object immediately.
- Do not pursue price tracking before the ledger and calendar compiler are valid.
- Do not optimize for every diet/cuisine at launch; start with the household vegetarian use case.
- Do not let agents mutate plans by unstructured prose.

## Users

Primary user:

- household cook planning meals for 2 people,
- vegetarian at home but flexible occasionally,
- likes homemade bread/flatbreads/pizza dough,
- cooks in afternoon/evening only,
- wants snack-box lunches and simple breakfasts,
- values creativity but needs prep to be manageable,
- has personal recipes from Instagram/Paprika/links.

Future users:

- households with multiple people,
- users planning events or dinners for guests,
- users planning partial slots only,
- users managing food waste and leftovers,
- users with more rigid dietary constraints.

## Current State

Live Worker facade:

- `https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev/mise-graph`

Current implemented routes:

- `GET /mise-graph/status`
- `GET /mise-graph/expand`
- `POST /mise-graph/expand`
- `POST /mise-graph/resolve`
- `POST /mise-graph/plan`
- `POST /mise-graph/compile`
- `POST /mise-graph/validate`
- `GET /mise-graph/plans`
- `GET /mise-graph/plans/:id`
- `GET /mise-graph/plans/:id/timeline`
- `GET /mise-graph/plans/:id/ledger`
- `GET /mise-graph/states`
- `POST /mise-graph/states`
- `GET /mise-graph/edges`
- `POST /mise-graph/edges`
- `GET /mise-graph/station-rules`
- `POST /mise-graph/station-rules`
- `POST /mise-graph/seed`

Current D1 tables added:

- `mise_ingredient_states`
- `mise_edges`
- `mise_station_rules`
- `mise_week_plans`
- `mise_plan_components`
- `mise_plan_tasks`
- `household_profiles`
- `household_taste_priors`
- `household_inventory_snapshots`
- `mise_context_runs`
- `mise_edge_scores`

Current gap:

- plans can now be compiled into a resource ledger, validated, and deterministically repaired.
- role/format compatibility has a first deterministic repair pass.
- quantities are not operational.
- prep tasks are dependency-aware enough to keep downstream prep from starting before upstream idle time completes.
- audits and user-driven downstream repair do not exist yet.

Current repaired ledger test result for the persisted sample plan:

- 49 resource lots.
- 67 timeline events.
- 63 event inputs.
- 45 event outputs.
- 34 reservations.
- 0 validation issues.

The validator/repair loop currently catches and repairs:

- format incompatibility,
- generic resource labels,
- inedible intermediates used as meal components,
- expired component use,
- resources used before prep completion.
- resources used before ready,
- resources used after quality/safety window.

## Product Principles

### Deterministic Core, Agentic Edges

Use agents for interpretation, recipe import, riffing, audit language, and explanation.

Use deterministic code for:

- ledger simulation,
- unit/yield math,
- event dependencies,
- resource reservations,
- time compilation,
- validation,
- persisted diffs.

### Plans Are Revisions

Never silently mutate a plan. Every change should produce a revision diff.

### Existing Resources Are Opportunities, Not Shackles

The planner should lean toward using existing components, but not force them into bad meals.

### Provenance Matters

Every personal recipe, generated riff, and adapted meal should preserve lineage to:

- original source recipe,
- personal recipe cluster,
- Spence graph node,
- seasonal/local fact,
- household preference.

### Audits Are High Impact Only

The system should ask questions when the answer affects future events.

## Functional Requirements

## Module 1: Personal Recipe Memory

### Objective

Import, normalize, and store user-loved recipes with provenance.

### Inputs

- Paprika exports,
- Instagram/social URLs,
- pasted recipe links,
- screenshots,
- manually entered recipes,
- previous generated plans,
- feedback.

### Outputs

- normalized personal recipe,
- provenance record,
- canonical ingredient links,
- component/technique/equipment mapping,
- cuisine/flavor/format tags,
- taste vector.

### Requirements

- Preserve raw source snapshot in R2 when possible.
- Store original URL/app/author/title.
- Parse into structured ingredients, quantities, steps, equipment, components, and timings.
- Link ingredients to `canonical_ingredients`.
- Link techniques to technique graph.
- Derive household taste signals.
- Mark parser confidence and unresolved fields.

### Proposed Tables

- `personal_recipe_sources`
- `personal_recipes`
- `personal_recipe_ingredients`
- `personal_recipe_steps`
- `personal_recipe_components`
- `personal_recipe_lineage`
- `household_recipe_feedback`
- `recipe_taste_vectors`

### Cloudflare Mapping

- R2: raw source snapshots, screenshots, Paprika export files.
- D1: normalized recipe and provenance tables.
- Queue: `personal-recipe-ingest`.
- Workflow: `PersonalRecipeImportWorkflow`.
- Workers AI / external LLM: extraction, normalization, classification.

## Module 2: Taste And Preference Resolver

### Objective

Convert personal recipe memory and household feedback into runtime weights.

### Signals

- repeated saved ingredients,
- favorite components,
- favorite textures,
- cuisines,
- prep effort tolerance,
- leftover tolerance,
- breakfast/lunch/dinner patterns,
- rejected meals,
- actual prep completion,
- ingredients that often go unused.

### Outputs

- household taste priors,
- repetition penalties,
- component preference weights,
- cuisine direction weights,
- effort constraints.

### Requirements

- Keep canonical culinary facts separate from household preferences.
- Allow explicit overrides from user prompt.
- Learn from both saved recipes and actual cooked outcomes.

### Cloudflare Mapping

- D1: `household_taste_priors`, `recipe_taste_vectors`, feedback tables.
- Cron/Queue: periodic taste recalculation.
- Workers AI / external LLM: clustering and label extraction.

## Module 3: Mise State And Transformation Ontology

### Objective

Represent what ingredients/components can become.

### Requirements

Each state must include:

- canonical name/id,
- state name,
- direct edibility,
- role tags,
- component type,
- storage defaults,
- quality window,
- compatible formats,
- compatible cuisine grammars.

Each transformation must include:

- input states,
- output states,
- required inputs,
- optional inputs,
- substitutions,
- active time,
- idle time,
- yield ratio,
- equipment,
- station tags,
- make-ahead windows,
- shelf life,
- confidence,
- provenance/source.

### Proposed Tables

Current:

- `mise_ingredient_states`
- `mise_edges`
- `mise_station_rules`

Add:

- `mise_transformations`
- `mise_transformation_inputs`
- `mise_transformation_outputs`
- `mise_state_compatibility`
- `mise_role_tags`
- `mise_yield_rules`

### Cloudflare Mapping

- D1: source of truth.
- Existing Worker routes for CRUD/seed.
- Future admin/curation UI can update these tables.

## Module 4: Resource Ledger

### Objective

Track actual and projected resources over time.

### Resource Lot Fields

- id,
- household id,
- canonical ingredient/component id,
- state id,
- label,
- quantity,
- unit,
- storage,
- created_at,
- best_until,
- safe_until,
- quality status,
- confidence,
- source type,
- source event id,
- consumed/discarded status.

### Requirements

- Raw ingredients and prepared components are both resource lots.
- Projected lots can be overwritten by observed audit facts.
- Quantity decrements must be tracked by meal consumption.
- Expiration and quality decay must be deterministic.
- Future reservations must be visible.

### Proposed Tables

- `mise_resource_lots`
- `mise_resource_lot_events`
- `mise_resource_reservations`
- `mise_resource_quality_events`
- `mise_unit_conversions`

### Cloudflare Mapping

- D1: persisted truth.
- Durable Object later: `HouseholdInventoryDO` for live coordination.
- Queue: `mise-ledger-jobs` for recomputation after changes.

## Module 5: Plan Events

### Objective

Represent grocery, prep, cook, meal, snack, audit, and discard events as timeline objects.

### Event Types

- grocery_trip,
- prep_task,
- cook_window,
- meal_service,
- snack_pack,
- leftover_created,
- leftover_consumed,
- inventory_adjustment,
- audit_prompt,
- discard_expired,
- cleanup_reset.

### Requirements

- Events have start/end timestamps or windows.
- Events can consume and produce resource lots.
- Events can depend on other events.
- Events can be locked, flexible, or provisional.
- Events can belong to revisions.

### Proposed Tables

- `mise_plan_events`
- `mise_event_inputs`
- `mise_event_outputs`
- `mise_event_dependencies`
- `mise_event_locks`
- `mise_event_metadata`

### Cloudflare Mapping

- D1: event timeline.
- Durable Object later: `PlanCoordinatorDO`.
- Workflow: `MisePlanWorkflow`, `MiseReplanWorkflow`.

## Module 6: Calendar Time Compiler

### Objective

Compile meal/resource requirements into an executable calendar.

### Invariants

- A cook/prep event must precede any meal that needs its outputs.
- A grocery event must precede any event that needs purchased resources.
- A component must be made within its valid make-ahead window.
- A cook window expands as tasks are added.
- If a cook window is shortened or moved, downstream events must be revalidated.

### Requirements

- Support meal service times.
- Support available cook windows.
- Support max active time per window.
- Support equipment conflicts.
- Support station reuse.
- Support pre-service tasks.
- Support make-ahead tasks.
- Support idle waits and fermentation windows.

### Proposed Tables

- `mise_cook_windows`
- `mise_task_windows`
- `mise_calendar_constraints`
- `mise_task_compatibility`
- `mise_equipment_reservations`

### Cloudflare Mapping

- D1: schedule and constraints.
- Durable Object: `PlanCoordinatorDO` for active schedule edits.
- Deterministic Worker module: time compiler.

## Module 7: Validation Engine

### Objective

Detect impossible, unsafe, incoherent, or low-quality plans.

### Validation Rules

Hard errors:

- meal consumes missing resource,
- meal consumes expired resource,
- prep occurs after meal,
- quantity insufficient,
- resource state not edible,
- transformation input missing,
- locked event conflict.

Soft warnings:

- quality window poor,
- too much repeated flavor,
- component forced into incompatible format,
- cook window overloaded,
- high audit uncertainty,
- unused expiring component,
- shopping list incomplete.

### Proposed Tables

- `mise_validation_issues`
- `mise_validation_runs`
- `mise_rule_results`

### Cloudflare Mapping

- Worker module: deterministic validator.
- D1: validation history/issues.
- Queue: validation after plan, audit, or edit.

## Module 8: Audit Loop

### Objective

Allow agents and users to reconcile the projected ledger with the real kitchen.

### Audit Modes

- onboarding audit,
- user-initiated audit,
- targeted agent audit,
- pre-plan audit,
- pre-meal audit,
- expiration/use-up audit,
- post-meal feedback audit.

### Requirements

- Parse natural language inventory updates.
- Create or update observed resource lots.
- Track confidence and provenance.
- Determine affected future events.
- Batch questions by impact.
- Avoid low-value pings.

### Proposed Tables

- `mise_audit_sessions`
- `mise_audit_items`
- `mise_resource_observations`
- `mise_agent_notifications`

### Cloudflare Mapping

- D1: audit records.
- Durable Object: `AuditSessionDO` or `HouseholdInventoryDO` for active audits.
- Queue: `mise-audit-jobs`.
- Cron: periodic audit trigger generation.
- Worker/AI: natural language parsing.

## Module 9: Repair Engine

### Objective

Generate structured plan revisions when reality changes.

### Current Implementation

The first deterministic repair engine is implemented in `worker/src/mise-graph/repair.ts` and exposed at:

- `POST /mise-graph/repair`

The endpoint:

- loads a stored plan or accepts an inline plan,
- compiles it into the ledger,
- validates resource, time, and format issues,
- applies deterministic repairs,
- recompiles until convergence or iteration limit,
- optionally persists the repaired plan,
- saves the final ledger,
- records the repair run in D1.

### Triggers

- resource gone,
- resource quantity changed,
- component not made,
- meal people count changed,
- schedule moved,
- cook shortened,
- grocery delayed,
- user changes cuisine direction,
- validation failure.

### Repair Actions

- substitute component,
- make missing component,
- add grocery item,
- move prep earlier,
- move meal,
- simplify meal,
- split cook window,
- ask user.

Implemented actions:

- `specific_snack_items`
- `replace_invalid_component`
- `remove_invalid_component`
- `remove_unavailable_component`
- `move_prep_earlier`
- `remake_expired_component`
- `remake_upstream_component`

### Proposed Tables

- `mise_plan_revisions`
- `mise_revision_changes`
- `mise_repair_options`
- `mise_repair_decisions`

Implemented table:

- `mise_repair_runs`

### Cloudflare Mapping

- Durable Object: `PlanCoordinatorDO`.
- Workflow: `MiseReplanWorkflow`.
- Queue: `mise-repair-jobs`.
- D1: revision history.

## Module 10: Recipe Riffing

### Objective

Invent or adapt recipes from personal recipe memory, Spence knowledge, and current resource constraints.

### Inputs

- target meal slot,
- projected ledger,
- personal recipes,
- taste priors,
- Spence ingredient/component graph,
- seasonality/locality,
- cuisine prompt,
- prep constraints.

### Outputs

- structured recipe,
- resource requirements,
- produced leftovers/components,
- prep tasks,
- compatibility tags,
- source lineage,
- explanation.

### Requirements

- Riffs must compile into the ledger.
- Riffs must keep provenance.
- Riffs must pass compatibility validation.
- Riffs must be explainable.

### Proposed Tables

- `recipe_riffs`
- `recipe_riff_lineage`
- `recipe_riff_components`
- `recipe_riff_validation`

### Cloudflare Mapping

- D1: riff objects and lineage.
- R2: generated recipe exports/snapshots if needed.
- Worker/AI: recipe invention/adaptation.
- Validator: deterministic compile/validate before persistence.

## Module 11: Shopping And Pricing

### Objective

Turn resource gaps into grocery events and later enrich with price/local availability.

### Requirements

- Consolidate quantities.
- Subtract pantry/inventory.
- Separate required vs optional items.
- Tie grocery items to future events.
- Support shopping trip timing.
- Track substitutions.
- Future: location-aware price observations.

### Proposed Tables

- `mise_grocery_events`
- `mise_grocery_items`
- `mise_price_observations`
- `mise_store_preferences`

### Cloudflare Mapping

- D1: grocery events and price observations.
- Queue: `price-observation-jobs`.
- Cron: refresh price data.
- Worker fetch: external/local pricing sources if available.

## Agent System Requirements

Agents must use structured proposals.

Each proposal should include:

- proposal type,
- target event/resource/plan,
- added events,
- removed events,
- changed reservations,
- required resources,
- produced resources,
- grocery additions,
- validation notes,
- explanation,
- confidence.

The system coordinator must:

1. validate proposals,
2. apply them to a working ledger,
3. generate diffs,
4. persist accepted revisions,
5. reject or ask user about invalid proposals.

## API Requirements

Current APIs remain:

- `/mise-graph/status`
- `/mise-graph/expand`
- `/mise-graph/resolve`
- `/mise-graph/plan`
- `/mise-graph/plans`
- `/mise-graph/plans/:id`

Add next-lane APIs:

### Compile

`POST /mise-graph/compile`

Converts an existing plan or candidate plan into event/resource form.

Outputs:

- plan events,
- resource lots,
- reservations,
- validation issues.

### Validate

`POST /mise-graph/validate`

Runs deterministic validation against the ledger.

Outputs:

- hard errors,
- soft warnings,
- repair hints.

### Timeline

`GET /mise-graph/plans/:id/timeline`

Returns ordered events:

- grocery,
- prep,
- cook,
- meal,
- audit,
- expiry.

### Ledger

`GET /mise-graph/plans/:id/ledger`

Returns projected resources by time.

### Audit

`POST /mise-graph/audits`

Starts or records an audit.

`POST /mise-graph/audits/:id/observations`

Adds user observations and triggers downstream impact analysis.

### Replan

`POST /mise-graph/replan`

Takes an edit instruction or target window and returns a revision proposal.

### Riff

`POST /mise-graph/riff`

Generates a structured recipe riff for a target meal slot.

### Personal Recipe Import

`POST /mise-graph/personal-recipes/import`

Starts import from URL, Paprika export, text, or R2 object.

## Cloudflare Infrastructure Plan

## Current

### Workers

`recipe-graph`

- Main existing Worker.
- Current bindings: D1, R2, Queues, Durable Object, Workflow, Workers AI.
- Source contains mise-graph routes.
- Deploy blocked by DO permission error `10023`.

`mise-graph`

- Temporary facade Worker.
- Binding: D1 only.
- Live and tested.

### D1

`recipe-graph-db`

- Existing Spence graph.
- Current mise-graph schema.
- Future source of truth for ledger/events/audits/revisions.

### R2

`recipe-graph-ingest`

- Existing recipe ingest bucket.
- Future personal recipe source archive.

### Queues

- `recipe-pipeline`
- `ingredient-normalize`

### Durable Objects

- `PipelineOrchestrator`

### Workflows

- `recipe-pipeline`

### Cron

- every 6 hours.

## Proposed Additions

### Workers

Keep `recipe-graph` as the main API after permissions are fixed.

Optionally keep `mise-graph` as a smaller facade or preview worker for rapid product iteration.

### D1 Table Groups

Personal recipes:

- `personal_recipe_sources`
- `personal_recipes`
- `personal_recipe_ingredients`
- `personal_recipe_steps`
- `personal_recipe_lineage`
- `recipe_taste_vectors`

Ledger:

- `mise_resource_lots`
- `mise_resource_lot_events`
- `mise_resource_reservations`
- `mise_resource_observations`

Events:

- `mise_plan_events`
- `mise_event_inputs`
- `mise_event_outputs`
- `mise_event_dependencies`

Calendar:

- `mise_cook_windows`
- `mise_task_windows`
- `mise_calendar_constraints`
- `mise_equipment_reservations`

Validation/repair:

- `mise_validation_runs`
- `mise_validation_issues`
- `mise_plan_revisions`
- `mise_revision_changes`
- `mise_repair_options`

Audits:

- `mise_audit_sessions`
- `mise_audit_items`
- `mise_agent_notifications`

Shopping/pricing:

- `mise_grocery_events`
- `mise_grocery_items`
- `mise_price_observations`

### Durable Objects

Use DOs for active coordination only:

- `PlanCoordinatorDO`
- `HouseholdInventoryDO`
- `AuditSessionDO` if live multi-turn audit state needs isolation.

D1 remains source of truth.

### Queues

Add:

- `mise-plan-jobs`
- `mise-repair-jobs`
- `mise-audit-jobs`
- `personal-recipe-ingest`
- `price-observation-jobs`

### Workflows

Add:

- `MisePlanWorkflow`
- `MiseReplanWorkflow`
- `PersonalRecipeImportWorkflow`
- `AuditWorkflow`

### R2

Store:

- original recipe exports,
- screenshots,
- source HTML snapshots,
- parser artifacts,
- generated recipe exports if needed.

### Cron

Add scheduled scans for:

- expiration/use-up pressure,
- pre-plan audit prompts,
- upcoming meal validation,
- seasonal refresh,
- price refresh later.

## Roadmap

### Phase 0: Stabilize Current Vertical Slice

Goals:

- keep live `mise-graph` facade working,
- fix `recipe-graph` deploy permissions,
- keep schema/docs aligned,
- improve current planner's obvious compatibility issues.

Acceptance:

- current E2E test passes,
- plan can be persisted/read back,
- main Worker can deploy with mise routes.

### Phase 1: Ledger Compiler

Build:

- resource lots,
- plan events,
- event inputs/outputs,
- reservations,
- compile endpoint.

Status:

- Implemented first slice.
- `POST /mise-graph/compile` compiles and persists resources/events/reservations/issues.
- `GET /mise-graph/plans/:id/ledger` reads persisted ledger objects.
- `GET /mise-graph/plans/:id/timeline` reads ordered events with attached issues.

Acceptance:

- current weekly plan compiles into resources and events.
- validator can tell which meals consume which lots.
- intermediate states are not treated as edible meal components.

### Phase 2: Validation Engine

Build:

- hard/soft validation rules,
- compatibility checks,
- resource existence checks,
- expiration checks,
- timing checks.

Status:

- Implemented first deterministic validator slice.
- The current sample plan produces 37 hard errors and 3 warnings.

Acceptance:

- current bad issues are detected:
  - strawberry jam on tacos,
  - tahini sauce in breakfasts,
  - soaked chickpeas used as edible component,
  - prep after meal,
  - expired resource use.

### Phase 3: Calendar Time Compiler

Build:

- cook windows,
- task scheduling,
- make-ahead windows,
- duration expansion,
- move/shorten operations.

Acceptance:

- pizza dough schedules 48-72 hours ahead.
- salad finishing is scheduled pre-service.
- crispy toppings are scheduled close to serving.
- weekday cook max active time is respected.

### Phase 4: Audit And Repair

Build:

- audit sessions,
- observations,
- impact analysis,
- repair proposals.

Acceptance:

- user says "all hummus is gone."
- system finds affected events.
- system proposes make/substitute/shop/meal-change options.
- accepted repair persists as revision.

### Phase 5: Personal Recipe Import

Build:

- Paprika import,
- URL/text import,
- provenance tables,
- normalized recipe shape,
- taste vector extraction.

Acceptance:

- imported recipe maps to canonical ingredients/components.
- original source is preserved.
- recipe can be used as exact candidate or taste evidence.

### Phase 6: Recipe Riffing

Build:

- riff endpoint,
- recipe lineage,
- compile-to-ledger integration.

Acceptance:

- system riffs from a saved recipe using current resources.
- explanation includes source recipe and Spence facts.
- riff validates before becoming a meal event.

### Phase 7: UI

Build:

- Calendar view,
- Inventory view,
- Graph view,
- Inbox view.

Acceptance:

- user can inspect, edit, audit, approve repairs.

### Phase 8: Shopping And Price Intelligence

Build:

- grocery events,
- quantity consolidation,
- store/price observations,
- location-aware estimates.

Acceptance:

- shopping list is quantity-aware and tied to events.
- price estimates can be attached but do not block planning.

## Acceptance Test Suite

### Test 1: Current E2E

Input:

- 7 days,
- vegetarian,
- 2 people,
- chickpeas/tahini/flour/asparagus/radish/strawberries,
- San Diego spring,
- Ooni/Instant Pot/food processor,
- evening cooking.

Expected:

- plan generated,
- components created,
- prep scheduled,
- persisted and read back.

### Test 2: 14-Day Ledger Plan

Input:

- 14 days,
- dinners, breakfasts, snack-box lunches,
- seasonal San Diego produce,
- current pantry,
- Japanese and Mexican flavor direction.

Expected:

- grocery events,
- resource lots,
- prep/cook/meal events,
- valid reservations,
- expiration warnings,
- readable menu.

### Test 3: Hummus Gone

Initial:

- future events reserve hummus.

Audit:

- "We used all the hummus."

Expected:

- observed resource update,
- affected events identified,
- repair options generated,
- accepted repair persisted.

### Test 4: Friday Lunch For 8

Initial:

- Friday lunch planned for 2.

Edit:

- "Friday lunch is now for 8 and should be Mexican."

Expected:

- old reservations released,
- new meal event generated,
- groceries/prep added,
- future leftovers projected,
- downstream plan revalidated.

### Test 5: Pizza Dough Missing

Initial:

- Saturday pizza depends on 72-hour dough.

Audit:

- "The dough was never made."

Expected:

- repair options:
  - schedule dough if time window exists,
  - switch to same-day dough,
  - move pizza,
  - change meal.

### Test 6: Shorten Cook Window

Initial:

- Wednesday cook window has 75 minutes active.

Edit:

- "Make Wednesday cook 30 minutes."

Expected:

- make-ahead tasks moved,
- meal simplified or substituted,
- validation passes or user approval requested.

### Test 7: Saved Recipe Riff

Input:

- saved chickpea flatbread recipe,
- projected cooked chickpeas,
- expiring tahini sauce,
- seasonal radishes.

Expected:

- riff generated,
- provenance lineage attached,
- resource requirements compiled,
- plan validates.

## Success Metrics

Functional:

- percent of generated plans with zero hard validation errors,
- percent of meals with valid resource reservations,
- percent of prep tasks scheduled before dependency deadlines,
- number of manual fixes required per plan.

User value:

- plans accepted without major rewrite,
- grocery list usefulness,
- reduction in wasted components,
- user-reported "feels like us" score,
- prep completion rate.

System quality:

- audit question precision,
- repair success rate,
- provenance coverage,
- quantity conversion coverage,
- validation false positive/negative rate.

## Risks

### Over-Agentic Planning

Risk: agents invent plausible but invalid plans.

Mitigation:

- structured proposal protocol,
- deterministic validator,
- D1 ledger truth,
- no direct free-form mutation.

### Data Model Explosion

Risk: too many entities before value.

Mitigation:

- build ledger/events first,
- only add fields needed for acceptance tests,
- keep DOs for coordination, not per-resource truth.

### Bad Recipe Riffs

Risk: creative output becomes culinarily incoherent.

Mitigation:

- role compatibility,
- cuisine grammar,
- household taste priors,
- validation before persistence.

### User Audit Fatigue

Risk: too many questions.

Mitigation:

- impact-based audit triggers,
- batch questions,
- allow confidence-based planning when low stakes.

### Cloudflare Permission Blockers

Risk: main Worker deploy blocked by binding permissions.

Mitigation:

- keep `mise-graph` facade Worker,
- fix account token/permissions,
- deploy main `recipe-graph` once Durable Object bind permission is available.

## Immediate Next Build Recommendation

Build the formula/yield layer as the next lane:

```text
mise-formulas
  -> exact inputs and yields for component batches
  -> shelf-life and make-ahead windows per formula
  -> quantity reservation and depletion
  -> shopping quantities from planned usage
```

The first target should be the current repaired persisted plan.

Expected first output:

- cooked chickpea yield from dry weight,
- hummus, tahini sauce, crispy chickpea, quick pickle, dough, and breakfast formulas,
- per-meal quantity deductions,
- shopping list quantities tied to resource reservations.

That gives the repaired timeline real operational quantities before adding UI, recipe import, or advanced agents.
