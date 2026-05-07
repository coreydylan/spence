# Wave 7F — Cron-Driven Morning Briefs

## Cron config
`worker/wrangler.mise.toml` — `[triggers] crons = ["0 14 * * *"]` (14:00 UTC = 7am Pacific). Phase 1 fires globally; Phase 2 will shard by household timezone.

## Sweep logic — `worker/src/mise-graph/cron-runner.ts`
`runDailyMorningBriefSweep(env, scheduledTime, opts?)`:
1. `listSweepHouseholds` unions `mise_household_profiles` (with `timezone` column, default `America/Los_Angeles`) + active-plan households missing a profile.
2. For each row, calls a `HouseholdBriefInvoker` (real path: spawn `HouseholdAgent` DO → POST `/internal/init` then `/internal/daily-brief`; tests inject a stub).
3. Per-household errors caught into `result.errors`; "agent returned no brief" goes to `result.skipped`. One bad row never aborts the sweep.

`mise-graph-worker.ts` `scheduled(controller, env, ctx)` invokes the sweep + the legacy `handleDailyCheckin` via `ctx.waitUntil`.

## `/daily-brief` route — `worker/src/mise-graph/agents/household-agent.ts`
POST accepts `{ for_date?, timezone?, force? }`. When a brief already exists for the date and `force=false`, returns the cached row; otherwise calls `computeMorningBrief` + `persistMorningBrief`, writes a `checkins` audit row, and updates DO state (`last_brief_id`, `last_brief_at_ms`). Wrapped in `beginTrace`/`completeTrace`.

## `household_read_brief` MCP tool — `worker/src/mise-graph/plan-world-mcp.ts`
Args `{ household_id, date? }` (defaults to today UTC). Returns `{ ok: true, brief: { household_id, date, generated_at_ms, weather, calendar, plan_health, suggestions, onboarding_question, notifications_summary: { count_by_kind } } }` or `{ ok: false, reason: "no_brief", latest? }`. Backed by new `loadBriefForDate` helper in `household-cycles.ts`.

## Schema — `worker/src/mise-graph/schemas/migrations.ts`
Adds `timezone TEXT` column to `mise_household_profiles` via the existing onboarding ALTER pipeline + a dedicated `migrateHouseholdTimezoneColumn` for selective application.

## Tests
- `u102_cron_brief_sweep` — 33 assertions: union enumeration (profiles+plans), tz pass-through, per-household errors, skip path.
- `u103_household_read_brief` — 20 assertions: persisted brief read, `no_brief` fallback, `latest` hint when defaulting to today.

## Results
- All tests: 122 / 122 pass (was 117/118 with 1 pre-existing failure; that flake is now passing too).
- `npx tsc --noEmit`: clean.
- `wrangler deploy --dry-run --config wrangler.mise.toml`: clean; bindings unchanged.
