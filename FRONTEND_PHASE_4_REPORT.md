# Spence Frontend — Phase 4 Report

> Management surfaces under the "More" tab: `/shop`, `/pantry`, `/members`,
> `/inbox`. All four are RSC server-rendered against the existing worker MCP.

## What landed

- **`/shop`** — Server Component fetches `plan_list` → `plan_read_shop_runs`
  + `plan_read_shopping_list`, buckets sections into shop runs by category.
  Tab strip switches between runs (Big shop / Top-up); sections collapse;
  items toggle a localStorage-backed checkbox keyed `shop_${run_id}_checked`.
  Best-effort POST to `/api/shop/check` (accepted, not yet persisted to D1).
- **`/pantry`** — reads `inspire_read_household_signals.pantry_top` (the
  only public pantry surface today), classifies each item via
  `lib/perishability.ts` into Tier 1 (48h) / Tier 2 (5d) / Tier 3 (stable),
  and renders three tier sections with amber/terracotta/sage accents.
  Tier 1 rows expose an inline "Did you finish?" prompt. Quick-add chip
  posts to `/api/pantry/add` → wraps `household_set_pantry_bulk`.
- **`/members`** — `member_list` + `household_get_trait_spread`. Roster of
  cards with initials avatars, age/dietary line, top-3 trait readings per
  member; closes with a `MemberSpreadCard` summarizing diverging traits.
  `/members/[member_id]` shows full skills (confidence bars), presence,
  every trait reading, and preference chips.
- **`/inbox`** — fans out 7 `household_read_brief` calls (one per recent
  date) in parallel, buckets results into Today / Yesterday / Earlier this
  week, and renders a `BriefCard` per day. `/inbox/[brief_id]` (date-keyed)
  lays out weather, calendar, suggestions, plan health, daily question,
  and notification counts in a tall stack of cards.
- **Chat surface integration** — extended `UiComponent` union with
  `shop_summary`, `pantry_summary`, `member_summary`, `trait_spread`,
  `brief_card`. `chef-agent.ts pickUiComponent` and
  `tool-renderers.ts pickUiFromToolResult` route the matching tool results
  to inline cards in chat (`components/chef/results/*`).
- **Typed MCP** — added `HouseholdMember`, `TraitSpread`, `MemberTraitView`,
  `PresenceSnapshot` types and tool entries for `plan_read_shopping_list`,
  `plan_read_shop_runs`, `member_list`, `member_get`, `member_get_presence`,
  `household_get_traits`, `household_get_trait_spread`.

## Files

`app/shop/{layout,page}.tsx` + 5 components,
`app/pantry/{layout,page}.tsx` + 4 components,
`app/members/{layout,page}.tsx` + `[member_id]/page.tsx` + 4 components,
`app/inbox/{layout,page}.tsx` + `[brief_id]/page.tsx` + 3 components,
`app/api/shop/check/route.ts`, `app/api/pantry/add/route.ts`,
`lib/perishability.ts`, `lib/shop-state.ts`,
`components/chef/results/*` (5 inline result renderers),
8 Storybook stories, 2 vitest test files.

## Tests / TS

`tsc --noEmit` clean. `vitest run` → **22/22 passing** across 4 test files
(adds 13 new assertions covering perishability classifier and shop-state
localStorage round-trip).

## Open issues

1. Real pantry inventory tool is missing — we surface `pantry_top` (string
   lists) and infer tier from name. When a `kitchen_inventory_list` MCP tool
   ships, swap `app/pantry/page.tsx`'s data source for richer expiry tracking.
2. `/api/shop/check` accepts and acks but doesn't persist; localStorage is the
   source of truth. D1 schema is the next step.
3. "Did you finish?" prompt collapses on answer but doesn't write back —
   wiring to a future `kitchen_inventory_consume` tool is a one-liner.
4. Inbox iteration is N=7 parallel `household_read_brief` calls — fine for now
   but a dedicated `household_list_briefs` would halve latency.
