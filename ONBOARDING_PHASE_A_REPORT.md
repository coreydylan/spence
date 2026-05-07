# Onboarding Phase A — Implementation Report

## Schema diff

Four new tables + three new profile columns, all idempotent.

* `mise_onboarding_state` (PK `household_id`) — tier counters, completion stamps, engagement signal.
* `mise_onboarding_responses` (PK `response_id`, indexed by `(household_id, asked_at_ms DESC)`) — append-only Q/A log; skips have `response_text=NULL`.
* `mise_household_traits` (PK `(household_id, trait_name)`) — 7-dimension personality cache with confidence + evidence count. Carries an optional `member_id` column reserved for Phase B's per-member tracking; Phase A leaves it NULL.
* `mise_household_traditions` (PK `tradition_id`) — placeholder table for Phase B (no MCP tools yet).
* `ALTER TABLE mise_household_profiles ADD COLUMN dinner_ritual / cook_frequency / pantry_intake_mode TEXT` — wrapped in `try/catch` so re-runs swallow D1's "duplicate column" error.

Migration entrypoint `migrateOnboardingSchema(env)` returns `{ migrated: string[], altered: string[] }`. Wired to `POST /mise-graph/admin/migrate-onboarding` (X-Spence-Admin gated).

## MCP tools added

Four tools wired into `plan-world-mcp.ts` dispatch + `PLAN_WORLD_TOOLS` schema list:

* `household_onboarding_start(household_id, household_name?)` — idempotent; returns `{ state, next_question, tier_progress }`.
* `household_onboarding_answer(household_id, question_kind, response_text, member_id?)` — appends response, fires trait deltas, mirrors to profile when `writes_to` is set, returns next question + advancement flag.
* `household_onboarding_skip(household_id, question_kind, member_id?)` — `response_text=NULL`, never fires deltas, never satisfies a required question.
* `household_onboarding_status(household_id)` — read-only snapshot incl. all 7 traits and `completion_pct = (tiers_complete / 5)`.

## Question bank summary

* **Tier 0 (5)**: `tier_0_household_name` (opt), `tier_0_primary_member` (req), `tier_0_location` (opt), `tier_0_size` (req), `tier_0_first_help` (req, options=`meal_planning|dinner_tonight|pantry`).
* **Tier 1 (5)**: `tier_1_members_roster` (opt), `tier_1_avoidances` (req), `tier_1_dinner_ritual` (req, options=`table|tv|desk|varies`, fires `ritual_vs_refueling` deltas), `tier_1_cook_frequency` (req, `most|sometimes|rarely`), `tier_1_pantry_intake` (req, `bulk|gradual|photo`).
* `applyTraitDelta()` implements the Bayesian-ish update with confidence decay 0.7. After one `dinner_ritual=table` answer: `value=0.0, confidence=0.21`.

## Test results

`npm test` — **106 passed / 0 failed / 0 pending** (was 103, +3 new). `npx tsc --noEmit` clean. `wrangler deploy --config wrangler.mise.toml --dry-run` clean.

* `u85` — 51 assertions: tier 0→1→2 walk, trait inference, profile-mirror writeback, completion_pct=0.4, household isolation.
* `u86` — 85 assertions: kind uniqueness, option shape, all rules reference one of 7 `TRAIT_NAMES`, dinner_ritual options match design, pantry_intake options match design.
* `u87` — 12 assertions: idempotent start, skip writes NULL response_text, required-skip stays on tier 0, optional-skip allows advancement.

## Deviations

* Added ALTER TABLE support to `test/lib/mock-d1.ts` (it didn't previously parse ALTER) so the migration's idempotency path is exercised under test. Throws `duplicate column name` to mirror real D1.
* Used `SELECT-then-INSERT-OR-REPLACE` in `applyWriteBack` instead of `INSERT OR IGNORE` because the mock-d1 doesn't implement IGNORE.
* `ritual_vs_refueling` is the only trait Phase A actively updates (per design — the other 6 dimensions fill in via Phase C observations).
