# Household signals → LLM compose context

## Shape
`buildHouseholdSignals(env, household_id)` returns:
```
{ household_id, generated_at_ms,
  personality: { summary, dimensions[7] },
  traditions[],            // {name, cadence, description?, must_include?}
  pantry_top[],            // {category, items[≤10]} grouped
  equipment_available[],   // slugs
  avoidances: { dietary, allergies, dislikes },
  member_spread_guidance   // null | description }
```
Typical payload <5KB; hard-tested ≤8KB.

## personality.summary rendering rules
1. Pick traits with `confidence ≥ 0.15` AND `value ≤ 0.3` (low pole) or `value ≥ 0.7` (high pole).
2. If ≥1 decisive: build adjective list ("precise, ritual-leaning, and adventurous") sorted by descending confidence; tail with the top trait's clause and the second trait's clause when its confidence ≥ 0.3. Lead with "Preliminary read —" when top confidence < 0.3.
3. If no decisive traits but at least one low-confidence pole exists: "Still calibrating; preliminary signal: <adjective> at the table."
4. Otherwise: "Still calibrating; no personality signal yet."

## Integration points
- `worker/src/mise-graph/household-signals.ts` (NEW) — builder + render pure functions.
- `worker/src/mise-graph/composer-context.ts` — `loadHouseholdSignals` wrapper; `ComposerContextBundle.household_signals` now populated when `household_id` provided. Existing fields untouched.
- `worker/src/mise-graph/inspire-tools.ts` — `inspireReadHouseholdContext` includes signals by default (`include_household_signals=true`); new `inspireReadHouseholdSignals` direct read.
- `worker/src/mise-graph/plan-world-mcp.ts` — new MCP tool `inspire_read_household_signals` + extended schema for `inspire_read_household_context`.
- Compose-time enforcement (warn on long active-cook when quick-leaning, prefer pantry items, honor traditions, drop spread guidance into meal notes) is **deliberately deferred** — Track follow-up.

## Tests
`worker/test/scenarios/u101_household_signals_assembly.ts` — 48 assertions, all pass. Full suite: 122/122 passing. `tsc --noEmit` clean. `wrangler --dry-run` clean.
