# Per-Household Equipment Scoping — Track Report

## Schema diff

**`mise_equipment_definitions`** — PK changed from `slug TEXT PRIMARY KEY` to `PRIMARY KEY (household_id, slug)`. Column order also reshuffled so `household_id, slug` lead.

**`mise_equipment_claims`** — added `household_id TEXT NOT NULL` column. Indexes rewritten:
- `ix_equip_claims_hh_slug_window (household_id, equipment_slug, start_ts, end_ts) WHERE status='held'`
- `ix_equip_claims_for (household_id, claim_for_kind, claim_for_id) WHERE status='held'`

## API signature changes

- `getDefinition(env, slug)` → `getDefinition(env, { household_id, slug })` and now exported.
- `findOverlappingHeldClaims(env, slug, start, end)` → adds `household_id` arg.
- `releaseClaimsFor(env, claim_for)` → `releaseClaimsFor(env, { household_id, claim_for })`. Throws if `household_id` missing (no silent global fallback).
- `EquipmentClaim` type adds `household_id: string` field.
- `defineEquipment`, `listEquipment`, `ensureEquipmentDefined`, `claimEquipment`, `findFreeWindow`, `getEquipmentLoad` were already household-scoped at the call site; their internal queries are now also scoped.

## Migrate logic

`migrateEquipmentSchemaWithRebuild` (new): inspects `PRAGMA table_info`, rebuilds the definitions table via `_new` shadow + `INSERT … SELECT … FROM mise_equipment_definitions` + `DROP` + `RENAME` when legacy PK is `slug` only. Adds `household_id` column to claims via `ALTER TABLE` and backfills via subquery against definitions. Idempotent.

Wired into `/admin/migrate-wave-7` step `equipment` so existing deployments rebuild on next migrate.

## Tests updated

- `u53`, `u54`, `u84` — pass unchanged.
- `u55` — updated to pass `{ household_id, claim_for }` to `releaseClaimsFor`.
- `u104` (new, 30 assertions) — two households defining the same slug; cross-household claims on the same slug don't conflict; same-household same-meal claim is idempotent; same-household different-meal claim conflicts; release is household-scoped.
- `EquipmentFakeD1` updated for new INSERT bindings, composite-keyed definitions Map, household-aware overlap/release SELECTs.

## Result

`npm test`: 120 pass, 1 pre-existing failure (`u102`, unrelated). `npx tsc --noEmit`: clean. `wrangler --dry-run`: clean.

## Deviations

None. Followed spec exactly: chose Option A (rebuild) for the migrate path; kept fresh-install `migrateEquipmentSchema` cheap and idempotent.
