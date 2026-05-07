# Compose-time enforcement of household_signals

## 4 critics shipped (preference severity only)

All in `worker/src/mise-graph/household-critics.ts` — pure functions
`(plan, householdContext) => Grievance[]`, severity exclusively `"preference"`.

1. **TraditionRespectCritic** — for each meal whose date matches a household
   tradition's `weekly:<day>` cadence, emit a grievance unless the meal honors
   `must_include_format` (case/separator-insensitive) OR title contains a
   tradition keyword (must_include items + tokenized tradition name minus
   noise words like "night"). Cadence helper `cadenceMatchesDate` only
   handles weekly today; monthly/seasonal/annual are skipped.
2. **QuickPersonalityCritic** — fires per meal when
   `personality.dimensions[quick_vs_project].value > 0.7 AND confidence > 0.2`
   AND `estimated_cook_min > 60`. Estimation prefers `meal.active_time_min`,
   else uses a `FORMAT_COOK_MIN` table mirroring `agents/meal-agent.ts`
   (touching meal-agent was off-limits — table duplicated, documented).
3. **PantryUnderusedCritic** — pantry must have ≥10 unique items; meal must
   have at least one ingredient_name OR raw_ingredient; emits when zero
   ingredients match any pantry item via substring containment (cheap fallback
   so canonicalization gaps don't false-flag).
4. **MemberSpreadCritic** — one meta-grievance per plan when
   `signals.member_spread_guidance` is non-null, anchored to the first meal
   chronologically (`date.localeCompare` then slot order
   breakfast<lunch<snack<dinner). Choice documented inline: keeps Grievance
   shape stable so renderer/agent loop need no changes.

## householdContext loader pattern

`loadHouseholdContextForAudit(env, plan)` (Option A from brief) returns
`{ household_id, signals, traditions: TraditionWithMeta[] } | null`. Returns
null when `plan.household_id` is empty so caller skips. Uses
`buildHouseholdSignals` (read-only) plus a separate `loadTraditionsWithMeta`
SQL that exposes `tradition_id` + `must_include_format` (the public signals
bundle deliberately omits these to stay <5KB).

`runHouseholdAwareCritics(plan, context)` aggregates all 4. Re-exported from
`critics.ts` so callers have one import path. `toolAudit` in `plan-world-mcp.ts`
runs household-aware critics when `run_critics === "all" | "preference"` and
plan has a household_id — best-effort try/catch, never blocks. Audit response
gains `signals` field so the agent sees the personality context alongside the
grievances. `plan-map-renderer.ts` already had `preference` in
`SEVERITY_ORDER`; updated heading to "Preferences" (plural).

## Test results

- `u105_tradition_respect_critic` — 17 assertions
- `u106_quick_personality_critic` — 18 assertions
- `u107_pantry_underused_critic` — 11 assertions
- `u108_member_spread_critic` — 11 assertions

Each test covers a violation case AND ≥2 negative cases (no traditions, low
confidence, pantry < 10, null guidance). **127/127 pass** (123 existing + 4
new). `npx tsc --noEmit` clean. `wrangler deploy --dry-run` clean.
