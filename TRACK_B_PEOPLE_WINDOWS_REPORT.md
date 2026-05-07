# Track B — People-Aware Cook Window Adjustments

## Files modified

- `worker/src/mise-graph/agents/meal-phase-handlers.ts` — added new exported pure helper `adjustWindowsForPeopleAndCook(windows, people, cook_active_min)`. `defaultWindowsForSlot`, `pre_eve_entry`, `cook_window_entry`, and `loadMealSnapshotFromActivePlan` were not modified.
- `worker/src/mise-graph/agents/meal-agent.ts` — `handleInit` now calls the helper after loading the snapshot but before `setState`. The persisted SQLite snapshot keeps the raw slot-default windows; live state reflects adjusted windows. `computeInitialAlarmAt` is fed an adjusted snapshot copy so the cook_window alarm fires at the people-aware suggested start.
- `worker/test/scenarios/u82_people_aware_cook_window.ts` — new scenario, 13 pure-function assertions.

## Shifts

`cook_window_start_ms` only — `cook_window_end`, `eat_window_start`, `eat_window_end` never move.

- `people > 2`: earlier by `(people - 2) * 10` min, capped at 60 min.
- `people === 1`: later by 15 min.
- `cook_active_min > 60`: additionally earlier by `(cook_active_min - 60)` min.
- Shifts compose. `null`/non-finite inputs are no-ops.

`people` is sourced from `body.adult_member_ids.length` at init (best available proxy until `MealSnapshot` carries `people`).

## Test results

- `npm test` → **100 passed, 0 failed, 0 pending** (was 99; u82 adds 1).
- `npx tsc --noEmit` clean.
- `npx wrangler deploy --config wrangler.mise.toml --dry-run` clean.

## Deviations

None from scope. The cap test (Test 5) was split into 5a (6 people = 40 min, under cap) and 5b (10 people = 60 min, cap engaged) to actually exercise the cap path; the prompt's "verify cap" wording is ambiguous on cap engagement at 6 people specifically.
