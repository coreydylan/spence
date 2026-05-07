# Chef Dispatch — onboarding-aware turn router

## Tools

`chef_status_check({household_id})` — single first-call tool. Returns:

- `onboarding`: `{current_tier, tier_0_done, tier_1_done, completion_pct, next_question, blocked_actions, engagement_signal}`
- `recommendation`: `{primary_action, rationale, next_question?, suggested_compose_args?}`
- `signals`: full `HouseholdSignals` bundle once tier 1 done; `null` otherwise

`chef_dispatch({household_id, user_intent})` — Phase 1 stub. Calls
`chef_status_check`, then emits a 1-action `turn_plan` based on
`primary_action`. Real intent parsing is deferred.

## Recommendation ladder

1. **No onboarding state OR tier 0 incomplete** → `primary_action =
   answer_onboarding_question`. `blocked_actions` holds the 5 plan_* write
   tools. `signals = null`.
2. **Tier 0 done, tier 1 partial** → `answer_onboarding_question` again, but
   `blocked_actions = []` (planning is allowed if user pushes). `signals =
   null` because personality summary needs tier 1 dinner_ritual.
3. **Tier 1 done, no hooked tier-2 firing** → `ready_to_plan`,
   `suggested_compose_args` populated, `signals` bundle returned.
4. **Tier 1 done + tier-2 hook fires + engagement ≥ 0.7** →
   `compose_with_inline_question`, `next_question` is the rendered hook,
   `signals` populated.

Hook selection reuses `computeHookDeps` + `evaluateHook` from
`onboarding-hooks.ts`; lower-tier (2 before 3) wins ties. Engagement gate is
`ENGAGEMENT_TERSE` (0.7).

## Soft-warn on plan_compose_meal

`toolComposeMeal` calls `checkOnboardingForCompose` after `loadPlan`. When
`mise_onboarding_state` row is missing OR `tier_0_completed_at` is null, the
result gets a `notes: ["onboarding_incomplete: …"]` entry. Compose flow is
otherwise untouched. Failures (table missing) degrade to silent.

## Test results

- `u109_chef_status_check.ts` — 49 assertions. Covers all 4 ladder rungs +
  MCP dispatch round-trip for both new tools.
- `u110_compose_with_incomplete_onboarding.ts` — 8 assertions. No state →
  warning; tier 0 partial → warning; tier 0 complete → no warning.
- Full suite: **129/129 pass** (127 baseline + 2 new). `tsc --noEmit` clean.
  `wrangler deploy --dry-run` clean.

## Files

- New: `worker/src/mise-graph/chef-dispatch.ts`,
  `worker/test/scenarios/u109_chef_status_check.ts`,
  `worker/test/scenarios/u110_compose_with_incomplete_onboarding.ts`.
- Modified: `worker/src/mise-graph/plan-world-mcp.ts` (2 dispatch cases, 2
  schema entries, soft-warn helper, compose result wiring).
