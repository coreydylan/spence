# Track D — Real Equipment Claim Enforcement on cook_window Entry

## Files modified

- `worker/src/mise-graph/equipment.ts` — added `defaultEquipmentDefinition(slug, household_id)` and `ensureEquipmentDefined(env, household_id, slug)` helpers (lazy auto-define so MealAgent can claim equipment without PlanAgent pre-cataloguing every oven/skillet).
- `worker/src/mise-graph/agents/equipment-stub.ts` — re-exported the two new helpers so meal-phase-handlers can import from a single location.
- `worker/src/mise-graph/agents/meal-phase-handlers.ts` — wired three handlers to the canonical D1 tracker:
  - `cook_window_entry` now calls `claimEquipment(deps.env, …)` (after ensuring each slug is defined) with `all_or_nothing: true`. Granted/conflict counts ride on a new `household_equipment_claim` field on `PhaseHandlerResult`, surface in the briefing payload (`household_equipment_claim_summary`), and emit one `equipment_conflict` notification per adult per conflicting slug.
  - `eaten_entry` now calls `releaseClaimsFor(deps.env, {kind:"meal", id})` and reports the count via `equipment_released`.
  - `cancelled_entry` releases both legacy stub and canonical D1 claims, summing the counts.
- `worker/test/scenarios/u84_cook_window_equipment_claims.ts` — new scenario (45 assertions) covering all four required flows.

## Claim/release flow

1. `cook_window_entry` receives `MealSnapshot.equipment` (e.g. `["oven"]`).
2. For each slug, `ensureEquipmentDefined` inserts a default exclusive/shared row (oven=exclusive, stovetop=shared cap 4) when missing.
3. `claimEquipment` runs the batch with `all_or_nothing: true` for window `[cook_window_start_ms, eat_window_end_ms]`.
4. Conflicts → per-adult `equipment_conflict` notifications + zero claims persisted.
5. `eaten_entry` / `cancelled_entry` → `releaseClaimsFor({kind:"meal", id})` flips held rows to released so the next meal can claim.

## Test results

- u84 alone: 45/45 assertions pass, 8 ms.
- Full suite: 103/103 scenarios pass (was 102 before — Track C added u83). No regressions in u43, u53, u55, t22.
- `npx tsc --noEmit`: clean.
- `npx wrangler deploy --dry-run` (both `wrangler.toml` and `wrangler.mise.toml`): clean.

The legacy per-DO `claimEquipmentForMeal(sink, …)` call is preserved in cook_window_entry so the existing `equipment_claim` shape (consumed by u43 + others) is untouched; the new D1-backed result is additive on `household_equipment_claim`.
