# Onboarding Calibration Nudges — Implementation Report

Four small fixes called out by the first-week simulation, all narrowly scoped
inside the onboarding subsystem.

## Fix 1 — pantry threshold

`onboarding-bulk.ts::pantryCountToDelta`. Replaced the two-band 30/8 split
with a four-band calibrated curve so realistic intakes actually move traits:

| Items | Before | After                                      |
|-------|--------|--------------------------------------------|
| ≥20   | none   | delta_value=0.0, conf=0.3 (strongly pantry)|
| ≥10   | none   | delta_value=0.25, conf=0.2 (somewhat)      |
| 5–9   | none   | none (ambiguous middle)                    |
| ≤4    | 1.0/0.3| delta_value=0.85, conf=0.15 (shop-fresh)   |
| ≥30   | 0.0/0.4| folded into the new ≥20 band               |

## Fix 2 — equipment threshold

`onboarding-bulk.ts::equipmentCountToDelta`. New bands: ≥15 → 0.0/0.3 rich,
≥8 → 0.3/0.2 somewhat-rich, 5-7 → no delta, ≤4 → 0.9/0.2 minimalist. Old
single 15/4 split missed the 8-12 bulk-list case the sim flagged.

## Fix 3 — engagement signal parity

`onboarding.ts::statusOnboarding` now calls `computeEngagementSignal(recent_responses, now)` directly and refreshes `state.engagement_signal` cache when the live value drifts. `plan-world-mcp.ts::toolGetNextQuestion` was already live; pre-fix the two callers could disagree by 0.5. Both now return the
same rounded value (round3 → 1e-3 tolerance, asserted in u100).

## Fix 4 — member_id threaded through observations

Schema PK on `mise_household_traits` extended to `(household_id, trait_name, member_id)` (legacy NULLs preserved on read via an OR clause). New
`applyTraitDeltaForHousehold(env, hh, trait, delta_v, delta_c, {member_id})`
helper centralises the load→apply→store dance. `observeFromTool` /
`observeResponse` now pin the trait write to the observation's `member_id`,
and the compose / cancel / swap / replace handlers in `plan-world-mcp.ts`
forward `args.member_id` when present. Per-member rows now coexist with
the household-level cache so multi-member trait spread can detect divergence.

## Tests

`worker/test/scenarios/u100_calibration_nudges.ts` — 43 assertions covering
all four fixes (pantry bands, equipment bands, engagement parity, per-member
trait write + coexistence). Full suite: 123 passed / 0 failed,
`npx tsc --noEmit` clean, `wrangler --dry-run` clean.
