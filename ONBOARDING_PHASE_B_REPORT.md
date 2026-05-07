# Onboarding Phase B — Implementation Report

## Tools shipped

Four new MCP tools wired into `plan-world-mcp.ts` (dispatch + schema list):

* `household_set_pantry_bulk(household_id, mode?='text'|'photo', text?, image_b64?, image_mime?, replace_existing?)` — text path parses newline/comma-separated lists, dedupes case-insensitively, strips bullet/parenthetical artifacts, auto-categorizes, and writes `mise_kitchen_inventory` rows with `source='bulk_intake'`. `replace_existing` soft-deletes prior un-consumed inventory. Photo path calls `callBridgeVision`; if the MESH binding isn't wired, returns `{ok:false, error:"vision_unavailable: …"}` instead of throwing.
* `household_set_equipment_bulk(household_id, equipment_slugs[])` — runs each slug through `ensureEquipmentDefined`, dedupes case-insensitively, returns `{newly_defined, already_defined, defined_count}`.
* `household_set_traditions(household_id, traditions[])` — validates cadence against four kinds (`weekly:<day>`, `monthly:<1st-saturday>`, `seasonal:<season>`, `annual:<event>`), upserts by `(household_id, name)` so re-set replaces in place. Rejected entries return with reasons; valid entries still land.
* `household_get_traits(household_id, with_descriptions?)` — read-only roster of all 7 dimensions (defaults `0.5` / confidence `0` for never-observed traits). With `with_descriptions=true` each row gets a human-readable summary; confidence < 0.3 prefixes "preliminary signal:". Description map covers all 7 dimensions per the design spec.

## Schema additions

None. Phase A's `migrateOnboardingSchema` already ships `mise_household_traditions`; `mise_kitchen_inventory` and `mise_equipment_definitions` are pre-existing. Synthetic responses use existing `mise_onboarding_responses` with new `question_kind` values (`_pantry_bulk_intake`, `_equipment_bulk_intake`, `_traditions_bulk_set`).

## Trait deltas fired

* Pantry bulk → `pantry_first_vs_shop_fresh`. Items ≥ 30 → toward 0.0 (delta_confidence 0.4); items 1..8 → toward 1.0 (0.3). Mid-size pantries fire no delta.
* Equipment bulk → `equipment_rich_vs_minimalist`. Slug count ≥ 15 → toward 0.0 (0.4); ≤ 4 → toward 1.0 (0.3).
* Traditions bulk → no trait deltas (descriptive only).

All deltas use Phase A's `applyTraitDelta` (Bayesian-ish confidence-weighted average with 0.7 decay) and persist directly to `mise_household_traits`.

## Test results

`npm test` — **118 passed / 0 failed / 0 pending** (was 106; +4 Phase B + 8 from concurrent Phase C/D session). `npx tsc --noEmit` clean. `wrangler deploy --config wrangler.mise.toml --dry-run` clean.

* `u88` — 37 assertions: text parsing, dedupe, all 6 category buckets, rich/bare/mid trait paths, photo-stub vision_unavailable envelope, replace_existing soft-delete.
* `u89` — 18 assertions: rich (18 slugs) → trait at low end, minimalist (3 slugs) → high end, mid (7) → no delta, dedup of duplicates, idempotent re-run.
* `u90` — 24 assertions: 4 cadence kinds accepted, 6 invalid cadences rejected with reasons, replace semantics preserve `tradition_id`.
* `u91` — 35 assertions: defaults for all 7 traits, description threshold rendering, preliminary-signal prefix gating, evidence updates trait+confidence.

## New files

* `worker/src/mise-graph/onboarding-bulk.ts` (3 tools + parseFreeTextItems / categorizeName helpers).
* `worker/src/mise-graph/onboarding-traits.ts` (`getTraits` + `describeTrait` + 7-dimension label table).
* `worker/test/scenarios/u88..u91*.ts`.

## Deviations

* The MCP categorizer is local (mirrors `shopping-list.ts` rules) instead of importing the existing one — `categorize()` there is private and the bulk-intake path needed plural-form support for "chickpeas / strawberries / tomatoes" that the legacy regex skipped. The fix is intentional and additive.
* `replace_existing` UPDATE uses a placeholder for `consumed = ?` instead of a literal so the mock-d1 SET parser accepts it — D1 itself accepts both forms.
