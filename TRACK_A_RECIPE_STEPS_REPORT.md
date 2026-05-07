# Track A — Real Recipe-Step Lookup Report

## Schema discovered

`canonical_recipes_v2` (D1 table `recipe-graph-db`, currently 1 row in prod —
the seed `banana_bread`; not 1100+ as the spec hinted): `id` (TEXT PK), `title`,
`description`, `composition`, `category`, `is_component`, `default_method`,
`status`, `confidence_score`, `corpus_count`, `reviewer`, `document_json` (TEXT
NOT NULL), `created_at`, `updated_at`.

`document_json` is the meaty payload, shaped as: `{ id, title, description,
composition, time:{prep_min,cook_min,total_min,...}, yield:{servings,...},
ingredient_groups:[{label, items:[{canonical_name, consensus_qty, unit, prep,
importance, ...}]}], steps:[{index, phase, primary_action:{verb}, prose,
ingredient_refs, equipment_refs, completion_signal, idle_time_min, ...}],
_internal:{source_url?, ...} }`. No `source_url` column on the row itself —
surfaced from `_internal.source_url` (or top-level `source_url`) when present.

## Files

- **Created** `worker/src/mise-graph/recipe-lookup.ts` — `loadRecipeSteps()`
  (raw DB lookup) + `inspireReadRecipeSteps()` (MCP wrapper that returns
  `{ok,...}` envelopes). Three lookup paths: exact `recipe_id`,
  `canonical_dish_id` joined through `canonical_dishes.canonical_title`,
  and fuzzy `canonical_dish_title` via case-insensitive LIKE. All DB calls
  wrapped in try/catch → return `null` on schema mismatch.
- **Modified** `worker/src/mise-graph/plan-world-mcp.ts` — added the import,
  one dispatch case, and one `tool(...)` schema entry next to the existing
  `inspire_read_canonical_components` tool. Additive only.
- **Created** `worker/test/scenarios/u81_recipe_steps_lookup.ts` — 30
  assertions covering all 3 lookup paths, fuzzy LIKE, missing-identifier
  error path, unknown recipe path, and a JSON-RPC `tools/call` round-trip.

## Test + quality results

- `npm test` → **102 passed, 0 failed** (suite grew by my u81 plus parallel
  unrelated tests u82/u83 from sibling sessions).
- `npx tsc --noEmit` → clean.
- `npx wrangler deploy --config wrangler.mise.toml --dry-run` → clean
  (3071 KiB upload, all bindings resolved).
- Live D1 probe `SELECT id,title FROM canonical_recipes_v2 WHERE LOWER(title)
  LIKE '%banana%' LIMIT 1` → returns `{id:"banana_bread", title:"Banana Bread"}`.

## Example call + response

```jsonc
// → callPlanWorldTool("inspire_read_recipe_steps", { recipe_id: "banana_bread" })
{
  "ok": true,
  "recipe_id": "banana_bread",
  "title": "Banana Bread",
  "matched_by": "recipe_id",
  "total_time_min": 70, "prep_time_min": 15, "cook_time_min": 55,
  "servings": 10,
  "source_url": "https://example.com/banana-bread",
  "ingredients": [
    { "name": "banana", "qty": 3, "unit": "whole", "prep": "mashed", "importance": "core", "group": "Main" },
    { "name": "all-purpose flour", "qty": 1.5, "unit": "cup", "importance": "core", "group": "Main" },
    { "name": "baking soda", "qty": 1, "unit": "tsp", "importance": "core", "group": "Main" }
  ],
  "steps": [
    { "index": 1, "phase": "mise_en_place", "verb": "preheat", "equipment": ["oven","9x5 loaf pan"], "idle_time_min": 10, "prose": "Preheat the oven to 350°F. Grease a 9x5 loaf pan." },
    { "index": 2, "phase": "prep", "verb": "mash", "ingredients": ["banana"], "completion_signal": "mostly smooth, a few small lumps are fine", "prose": "In a large mixing bowl, mash 3 ripe bananas with a fork until mostly smooth." }
  ]
}
```

## Deviations

- **Spec said 1100+ recipes**, prod has 1 — built the lookup against the
  observed schema; corpus growth is a separate workstream.
- Added a `matched_by` field to the result so the agent can tell which
  identifier path resolved (useful for debugging). Not in the original
  spec but cheap and disambiguates fuzzy matches.
- `limit` arg is accepted but unused (single-recipe return); kept in the
  schema as future expansion hook.
