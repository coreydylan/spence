# Mise-Graph Cloudflare Architecture

Date checked: 2026-05-05.

Cloudflare account: `me@coreydylan.net`.

Related planning docs:

- `menus/mise-graph-master-agentic-system.md`
- `menus/mise-graph-prd.md`

## Live Spence Worker

- Worker: `recipe-graph`
- URL: `https://recipe-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev`
- Bindings:
  - D1: `recipe-graph-db`
  - R2: `recipe-graph-ingest`
  - Queue producer/consumer: `recipe-pipeline`
  - Queue producer/consumer: `ingredient-normalize`
  - Durable Object: `PipelineOrchestrator`
  - Workflow: `recipe-pipeline`
  - Workers AI binding
  - Secret: `ANTHROPIC_API_KEY`
- Cron: every 6 hours.

## Live D1

- Database: `recipe-graph-db`
- ID: `99cd2c21-0901-409b-8f46-3d046b52da76`
- Region: `WNAM`
- Size after mise-graph schema: about 389 MB.

Important existing counts:

- `sources`: 70
- `raw_recipes`: 58,673
- `parsed_ingredients`: 396,375
- `canonical_ingredients`: 12,537
- `ingredient_edges`: 50,832
- `canonical_dishes`: 1,157
- `canonical_components`: 105
- `produce_profiles`: 2,399
- `produce_spots`: 18,738
- `regional_seasons`: 606
- `ingredient_compounds`: 57,050
- `flavor_compounds`: 1,339
- `tg_technique_ingredient`: 57,455
- `tg_technique_equipment`: 7,584
- `tg_technique_sequence`: 10,728
- `composition_templates`: 7

## Mise-Graph Tables Added

Created in the same D1 database:

- `mise_ingredient_states`
- `mise_edges`
- `mise_station_rules`
- `mise_week_plans`
- `mise_plan_components`
- `mise_plan_tasks`

Adaptive planner context tables:

- `household_profiles`
- `household_taste_priors`
- `household_inventory_snapshots`
- `mise_context_runs`
- `mise_edge_scores`

Schema file:

- `worker/src/mise-graph/schema.sql`

Seed file:

- `worker/src/mise-graph/seed.ts`

The seed exports `miseGraphSeed` with API-compatible `states`, `edges`, and `station_rules` arrays. It also exports `seedMiseGraph(db)`, which inserts the same payload directly into D1 with `INSERT OR IGNORE` so existing curated rows are not overwritten.

First seed coverage:

- Station rules for legume batching, herb washing, quick pickles, dough, sauces, and blender/processor cleanup reuse.
- Global states and edges for chickpeas, herbs, cucumber, radish, dough, tahini, yogurt, and lentils.
- Transition branches for soaking/pressure-cooking chickpeas, hummus, crispy chickpeas, falafel mix, herb reserves, quick pickles, cold-fermented dough, flatbread, pizza shells, tahini/yogurt sauces, marinated lentils, and lentil dip.

## Mise-Graph Worker Routes

Added to the same `recipe-graph` Worker:

- `GET /mise-graph`
- `GET /mise-graph/status`
- `GET /mise-graph/expand?ingredients=chickpea,tahini`
- `POST /mise-graph/expand`
- `POST /mise-graph/resolve`
- `POST /mise-graph/plan`
- `POST /mise-graph/compile`
- `POST /mise-graph/validate`
- `GET /mise-graph/plans`
- `GET /mise-graph/plans/:id`
- `GET /mise-graph/plans/:id/timeline`
- `GET /mise-graph/plans/:id/ledger`
- `POST /mise-graph/repair`
- `GET /mise-graph/states`
- `POST /mise-graph/states`
- `GET /mise-graph/edges`
- `POST /mise-graph/edges`
- `GET /mise-graph/station-rules`
- `POST /mise-graph/station-rules`
- `POST /mise-graph/seed`

The same route module is also deployed as a temporary standalone facade:

- Worker: `mise-graph`
- URL: `https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev`
- Binding: same production D1 database, `recipe-graph-db`

Reason: publishing the existing `recipe-graph` Worker is currently blocked by Cloudflare API error `10023` on Durable Object binding permissions. The source is integrated into `recipe-graph`, but this facade keeps the mise-graph API live while that account permission is fixed.

Smoke test:

- `/mise-graph/status` returns the existing Spence graph counts plus mise counts, including seeded states, edges, and station rules.
- `/mise-graph/seed` idempotently inserts the starter state/edge ontology.
- `/mise-graph/resolve` activates scored prep edges from household inputs, inventory, equipment, seasonality, and desired formats.
- `/mise-graph/plan` resolves, plans, schedules prep tasks, builds breakfasts/snack boxes/dinners, and persists weekly plans.
- `/mise-graph/plans/:id` reads the stored plan plus component and task rows.
- `/mise-graph/compile` converts a stored plan into ledger resources, timeline events, event inputs/outputs, reservations, and validation issues.
- `/mise-graph/validate` runs the deterministic ledger validator without requiring persistence.
- `/mise-graph/repair` runs deterministic compile -> validate -> repair iterations, persists the repaired plan, and writes a clean final ledger when convergence succeeds.
- `/mise-graph/plans/:id/timeline` reads ordered timeline events with attached issues.
- `/mise-graph/plans/:id/ledger` reads persisted resources, events, inputs, outputs, reservations, validation runs, and validation issues.

Current repaired ledger smoke test for `mise_plan:corey:2026_05_06:chickpea_tahini_asparagus_radish_strawberries_flour`:

- `mise_resource_lots`: 49
- `mise_plan_events`: 67
- `mise_event_inputs`: 63
- `mise_event_outputs`: 45
- `mise_resource_reservations`: 34
- `mise_validation_runs`: 1
- `mise_validation_issues`: 0
- `mise_repair_runs`: 1

The first repair pass fixes the prototype plan defects that the validator originally surfaced:

- incompatible component formats,
- generic resource labels,
- inedible intermediates used as meal components,
- expired component uses,
- resources used before prep completion.

Current deployed facade version after the repair pass:

- `mise-graph` Worker version: `2209dee7-7b79-494d-bb28-a11071910bee`

## Architecture Decision

Mise-graph is not a separate backend.

It is a module inside Spence's existing food/culinary intelligence API:

```text
existing Spence graph
  -> ingredients
  -> ingredient affinities
  -> canonical dishes
  -> canonical components
  -> produce/seasonality
  -> techniques/equipment

mise-graph
  -> ingredient states
  -> prep/state transitions
  -> active station rules
  -> weekly plan objects
  -> scheduled prep tasks
```

The standalone UI should consume `/mise-graph/expand` first, then later write selected states, edges, plans, and tasks back into the `mise_*` tables.
