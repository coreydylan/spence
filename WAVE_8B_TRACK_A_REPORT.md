# Wave 8B Track A Report — Online Brigade Scheduler Heuristic

## Scope

Replaced the skeleton `tickScheduler` (returned zero assignments) with a
real online scheduler that gates DAG-readiness, scores (task, member)
candidates across five additive rules, respects equipment exclusivity,
flags duration-elapsed in-flight tasks for completion checks, and reports
ready-but-unassignable tasks for lead attention.

The scheduler is a PURE FUNCTION — every input explicit, no `Date.now`,
no `Math.random`, no I/O. Trivially unit-testable and trivially
deterministic.

## Files modified

| Path | Change |
|---|---|
| `worker/src/mise-graph/agents/cooking-lead-scheduler.ts` | Replaced 50-line skeleton with full heuristic implementation. `readyTasks` helper preserved for u57 + new tests. |
| `worker/src/mise-graph/agents/cooking-lead-types.ts` | **Additive only** — added optional `current_equipment_claims`, `equipment_defs`, `recently_completed`, `member_completed_dag_neighbors`, `max_concurrent_assignments` to `BrigadeSchedulerInput`; added `EquipmentClaimSnapshot`, `EquipmentDefSnapshot`, `RecentlyCompleted` value types; added optional `score?: number` to `BrigadeAssignmentDecision`. No existing field removed or renamed. |
| `worker/src/mise-graph/agents/cooking-lead-agent.ts` | Single method (`onSchedulerTick`): replaced empty stub input with hydrated input. Added 4 private helpers (`readCompletedTaskIds`, `readRecentlyCompleted`, `readMemberCompletedTaskMap`, `readCurrentEquipmentClaims`). The DO's existing state machine, WS handling, and broadcast paths are untouched. |

## Files created

| Path | Purpose |
|---|---|
| `worker/src/mise-graph/agents/scheduler-scoring.ts` | Pure scoring helpers (`scoreAssignment`, `criticalPathTaskIds`, scoring constants `CHURN_WINDOW_MS`, `CRITICAL_PATH_BONUS`, `DAG_AFFINITY_BONUS`, `CHURN_PENALTY`, `PASSIVE_BONUS`). |
| `worker/test/scenarios/u60_scheduler_basic_assignment.ts` | 4 tasks, 2 idle members → 2 assignments |
| `worker/test/scenarios/u61_scheduler_skill_floor_gate.ts` | task floor 0.7, member 0.5 → unassignable; floor 0.7 = 0.7 → assignable |
| `worker/test/scenarios/u62_scheduler_dag_dependency_gating.ts` | 3-task chain: only first ready until predecessor completes |
| `worker/test/scenarios/u63_scheduler_critical_path_priority.ts` | Two ready tasks, 1 member, capacity 1: critical-path task wins |
| `worker/test/scenarios/u64_scheduler_equipment_exclusion.ts` | Two oven tasks, 2 members → 1 assignment; outside claim blocks both |
| `worker/test/scenarios/u65_scheduler_churn_penalty.ts` | Same-skill members, one churned 10s ago → rested member wins |
| `worker/test/scenarios/u66_scheduler_passive_batching.ts` | Passive task wins under tight capacity; CP bonus dominates passive bonus |
| `worker/test/scenarios/u67_scheduler_completion_check.ts` | duration-aware completion check + fallback for unknown tasks |

## Scoring rules implemented

All additive (composable per candidate):

| Rule | Magnitude | Trigger |
|---|---|---|
| Skill fit | `member.skills[skill] - skill_floor` | base, always |
| Critical path bonus | `+0.5` | task is on the DAG critical path |
| DAG affinity bonus | `+0.2` | member completed an immediate parent of task |
| Churn penalty | `-0.1` | member completed a task in last 30s |
| Passive batching bonus | `+0.3` | task.kind === "passive" |

Special case: `supervision_only` tasks bypass the floor and use a
fixed `skillFit = 0.5` so any present member can supervise a
proofing dough.

Total range: roughly `[-0.6, +1.5]`. The `MIN_ACCEPTABLE_SCORE = -0.5`
filter discards candidates whose skill fit is materially short of the
floor (a skill_fit of -0.5 with the +0 from any other bonus = exactly
floor).

## Allocation algorithm

1. **DAG-ready** = tasks with all `depends_on` in `completed_task_ids`,
   not in `in_flight`, not done.
2. **Eligible (task, member) pairs** = member is `in_kitchen_idle` AND
   meets skill floor AND task's equipment is currently available
   (capacity-aware against `current_equipment_claims`).
3. **Score** every pair via `scoreAssignment`.
4. **Greedy by descending score**, capped at `max_concurrent_assignments`
   (default 4). Each member can take at most one task per tick. Each
   exclusive equipment slug can only be claimed once per tick (shared
   slugs respect `capacity` minus already-active outside claims).
5. **Unassignable** = DAG-ready tasks for which zero candidates passed
   the gates (no skilled member or all equipment busy).
6. **Completion checks** = in-flight assignments where
   `started_at_ms + (active_min + passive_min) * 60_000 < now_ms`. Falls
   back to a 30-min stale window if the task isn't found in the graph.

## DO data wiring (`onSchedulerTick`)

- `completed_task_ids`: distinct rows from embedded `task_assignments`
  where `completed_at_ms IS NOT NULL`.
- `in_flight_assignments`: existing `readInFlightAssignments` (unchanged).
- `current_equipment_claims`: D1 `mise_equipment_claims WHERE status='held' AND end_ts > now AND claim_for_id IN (cook_session_id, meal_id)`.
- `recently_completed`: embedded `task_assignments WHERE completed_at_ms >= now - 60000`.
- `member_completed_dag_neighbors`: embedded `task_assignments WHERE completed_at_ms IS NOT NULL`, grouped into a `Map<member_id, Set<task_id>>`.

`graph` and `members` remain empty — those will be hydrated by Track B
(graph) and a future MemberAgent presence read-through. The scheduler
heuristic gracefully degrades to zero-output on empty input.

## Test results

```
SPENCE PLANNER  —  86 of 87 scenarios run
─────────────────────────────────────────
  Passed:  86    Failed:  0    Pending:  0
```

(78 pre-existing + 8 new u60–u67 = 86. The 87th is `t18 daily-brief-live`
gated to `--tier=live`.)

`npx tsc --noEmit` — all NEW code is clean. The 21 remaining typecheck
errors are pre-existing references in `cooking-lead-agent.ts` (Track B/C
unimplemented stubs: `handleAckTask`, `handleManualAssign`,
`handleIterationResponse`, etc.) and `bridge-vision.ts` (Track B's
`Buffer` reference). These are not in this track's scope.

`npx wrangler deploy --config wrangler.mise.toml --dry-run` — validates;
all 7 DO bindings + R2 + D1 + VPC + bridge envs present.

## Determinism

- Scheduler does not call `Date.now`, `Math.random`, or perform any I/O.
- Greedy allocation uses `Array.prototype.sort` on score desc; ties
  broken by candidate insertion order (member-then-task iteration in
  the input). Stable in V8 since ES2019, so a given input yields the
  same output every tick.
- Critical-path computation mirrors the DP in `task-graph.ts#criticalPath`,
  also pure and deterministic.

## Deviations from the prompt

1. **Scoring constants in scheduler-scoring.ts**, not inline. Prompt
   sketched the math inline; I extracted to a module so each constant
   has one source of truth and individual rules are independently
   importable for tests / future tuning.
2. **`current_equipment_claims` keyed by `claim_for_id`**, not by
   `claim_for.kind` filter. The prompt suggested filtering by kind; I
   filter by `claim_for_id IN (cook_session_id, meal_id)` so we pick up
   meal-level claims and session-level claims in one query. Cross-meal
   leakage is impossible (different ids → no slug match → no conflict
   detected anyway, but cheaper to scope at SQL).
3. **`MIN_ACCEPTABLE_SCORE = -0.5`** — added a soft floor on the score
   so a candidate with skill_fit = -0.6 (well below floor) is dropped
   even if other bonuses might push it above zero. Keeps weakly-skilled
   members from being assigned heavy tasks via the CP+passive+affinity
   stack.
4. **Did not modify `members` / `graph` hydration** in the DO. The
   foundation report explicitly listed graph hydration from
   `mise_task_graphs` and member hydration from MemberAgent as "Wave 8B
   should pick up" items, and the prompt scoped this track to the
   *heuristic*. Track B owns graph wiring (it touches photo+vision and
   recipe iteration which need the same graph read path).

## What downstream tracks pick up

1. **Hydrate `graph`** in `onSchedulerTick` from
   `getTaskGraph(env, meal_id)` once Track B is wiring task graphs to
   active cook sessions.
2. **Hydrate `members`** from MemberAgent presence (each member's
   `BrigadeMember` shape is already in `cooking-lead-types.ts`).
3. **Wire `equipment_defs`** snapshot — currently absent, so the
   scheduler defaults every unknown slug to `exclusive=true,
   capacity=1`. When Track B adds the D1 query for
   `mise_equipment_definitions`, pass the snapshot through and shared
   resources (counter space, knife rack) will allocate up to capacity
   per tick.
4. **`max_concurrent_assignments`** — currently defaults to 4. A future
   tuning knob could pull this from the lead's session config (e.g.
   "single chef + dishwasher" mode = 2).
