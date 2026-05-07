# Wave 7B Track C — Task Graph + Equipment Resource Tracking

Status: shipped, all 72 fast tests pass, typecheck clean, wrangler dry-run clean.

## Files created

### Source modules

- `worker/src/mise-graph/task-graph-types.ts` — `TaskKind`, `SkillKind`, `TaskNode`, `TaskGraph`, `CrewMember`, `ScheduleResult`, `RecipeForDecomposition`.
- `worker/src/mise-graph/task-graph.ts` — heuristic decomposer + `criticalPath` + `scheduleTaskGraph` + D1 persistence (`mise_task_graphs`). Wraps mutations with `beginTrace`/`completeTrace` (`agent_kind="task_graph"`).
- `worker/src/mise-graph/equipment-types.ts` — `EquipmentKind`, `EquipmentDefinition`, `EquipmentClaim`, `ClaimRequest`, `ClaimResult`, `EquipmentLoad`.
- `worker/src/mise-graph/equipment.ts` — `defineEquipment`, `listEquipment`, `claimEquipment` (with `all_or_nothing` mode using `env.DB.batch()`), `releaseEquipment`, `releaseClaimsFor`, `findFreeWindow`, `getEquipmentLoad`. Wraps mutations with traces (`agent_kind="equipment"`).

### Schemas

- `worker/src/mise-graph/schemas/schema-task-graphs.sql` — `mise_task_graphs` table (full graph serialized to `tasks_json`), partial unique index on `meal_id`, recipe-id index.
- `worker/src/mise-graph/schemas/schema-equipment.sql` — `mise_equipment_definitions`, `mise_equipment_claims` tables; partial indexes on slug+window and claim_for for the hot read paths.

### Tests

- `worker/test/scenarios/u51_task_graph_decomposition.ts` — tagine fixture decomposes into 8 tasks, validates kind/skill/equipment per step, oven-gating, soft prep gate, critical-path / parallelism aggregates, persistence round-trip, sub-linear scaling.
- `worker/test/scenarios/u52_task_graph_scheduling.ts` — schedules graph against solo adult, two-cook crew (parallelism win confirmed), and toddler-only crew (skill-floor failure).
- `worker/test/scenarios/u53_equipment_claim_atomicity.ts` — non-overlap success, overlap conflict, all_or_nothing batch abort, capacity gating on shared equipment, in-flight conflict within a single batch.
- `worker/test/scenarios/u54_equipment_find_free_window.ts` — gap-finder over a 3-claim oven timeline, capacity-aware shared search, load_pct metric.
- `worker/test/scenarios/u55_equipment_release_lifecycle.ts` — single release frees the slot, bulk release-by-claim_for, idempotent re-release, released claims invisible to load report.
- `worker/test/fixtures/recipe-tagine.json` — 8-step lamb tagine (dice/brown/saute/roast/boil/plate) with 10 ingredients.
- `worker/test/lib/wave7c-fake-d1.ts` — two targeted FakeD1 implementations (TaskGraphFakeD1 + EquipmentFakeD1) covering the SQL surface each module actually issues, including `env.DB.batch()` for atomic claim writes.

### Modified

- `worker/src/mise-graph/agents/equipment-stub.ts` — replaced the original Track A header comments with re-exports from `../equipment` (real Wave 7B-C module). Phase 2 will swap `meal-phase-handlers.cook_window_entry` to call the real D1-backed `claimEquipment` directly. The original per-DO `claimEquipmentForMeal` / `releaseEquipmentForMeal` / `listEquipmentClaimsForMeal` / `ensureEquipmentClaimsStubTable` are KEPT alongside the re-exports because `meal-phase-handlers.ts` (Track A's territory, no-touch) still calls them with the per-DO `AgentSqlSink` signature. Renamed the local `EquipmentClaim` type's re-export alias to `EquipmentClaimRecord` to avoid the name clash with the pre-existing per-DO type.

## Decomposition heuristics

The lexicon (preheat / dice / sear / sauté / bake / roast / fry / boil / blend / knead / proof / mix / plate) covers the verbs the corpus and personal-recipes path actually emit. Each match returns a template with `kind`, `skill`, `skill_floor`, `equipment[]`, base `active_min` / `passive_min`, and a `parallelizable` bit. Step text time hints (e.g. "for 90 minutes") inflate the template's passive_min when the kind is `passive`. Sub-linear `peopleScale = sqrt(people/2)` capped at 1.6× tweaks prep durations so a 12-cover doesn't become a 3× job over 4-cover.

Dependencies are inferred three ways:
1. **Produces / consumes** — when an earlier prep step produces an ingredient name that a later step's `ingredients_in` mentions, the later task gains a `depends_on` pointer.
2. **Oven gate** — a `preheat oven` task gates every later oven user.
3. **Soft prep gate** — the first non-preheat cook task depends on every prep task that precedes it in the recipe's step order.

## Equipment semantics

- **Exclusive resources** conflict on any interval overlap (`start < other.end && end > other.start`).
- **Shared resources** with `capacity=N` only conflict when the count of currently held overlapping claims is already ≥ N.
- **Undefined slugs** are treated as exclusive (fail-safe).
- **In-flight conflict detection** — within a single `claimEquipment` call, two requested claims for the same exclusive resource that overlap each other will detect the conflict on the second one even though the first hasn't been written yet.
- **all_or_nothing** uses `env.DB.batch()` so all granted claims commit together. Any conflict short-circuits with `granted=[]` and the conflict list.

## Tracing

All write paths (`buildTaskGraph`, `defineEquipment`, `claimEquipment`, `releaseEquipment`, `releaseClaimsFor`) wrap their D1 mutations with `beginTrace` / `completeTrace`. The agent_kind is implicit in the `tool_name` prefix (`task_graph.*`, `equipment.*`). `claimEquipment` emits `triggered_mutations: [{kind:"equipment_claim", mutation_id}]` per granted row so the replay layer can walk back from a claim id to the agent reasoning that committed it.

## Test results

```
71 of 72 scenarios run
Passed:  72   Failed:  0   Pending:  0
```

The one not-run scenario is `t18_daily_brief_live` (live tier, requires real LLM bridge; opt-in via `npm run test:live`).

```
✓ u51 · Task graph: decompose a tagine recipe ...    (42/42)
   tasks: 8, critical_path: 109min, parallelism_max: 5
   active=43min passive=115min
✓ u52 · Task graph: schedule against a crew ...      (15/15)
   solo total: 121min, duo total: 111min, bobby's tasks: 3
✓ u53 · Equipment: atomic claim + interval-overlap ... (23/23)
✓ u54 · Equipment: findFreeWindow walks the timeline ... (14/14)
✓ u55 · Equipment: release lifecycle ...             (15/15)
```

## Deviations

- **Equipment-stub kept the per-DO functions alongside the new re-exports.** The original Track A stub used `AgentSqlSink` (per-MealAgent SQLite); `meal-phase-handlers.ts` (no-touch) calls `claimEquipmentForMeal(sink, ...)` with that signature. Replacing the file outright would break the call site, so I added the real-module re-exports and left the original per-DO API in place for Phase 2 to migrate. The real D1-backed `claimEquipment` is callable from anywhere with `env.DB`.
- **Recipe shape — `RecipeForDecomposition`.** No corpus-wide "recipe.steps" type existed; recipes are stored as `personal_recipes.method_summary` (a single text field) and `canonical_ingredients_json`. `buildTaskGraph` accepts an optional inline `recipe` arg and otherwise loads the row from `personal_recipes`, splitting `method_summary` on numbered prefixes / sentences to reconstruct steps. Tests pass an inline recipe to bypass the lookup.
- **Test fakes live in `worker/test/lib/wave7c-fake-d1.ts`.** The shared `mock-d1.ts` doesn't implement range predicates / batch / status filters. Two targeted FakeD1 classes (`TaskGraphFakeD1`, `EquipmentFakeD1`) were added there rather than extending the general engine. Pattern follows u37 (which inlines its own FakeD1) but is extracted because five scenarios share it.
