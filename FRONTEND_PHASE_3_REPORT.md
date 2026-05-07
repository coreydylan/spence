# Spence Frontend — Phase 3 Report

> /today, /plan, /recipe/[meal_id] now ship as server-rendered surfaces
> backed by `mise-graph` MCP. The brigade hand-off is wired through
> `/api/cook/start`, staging a `cook_session_id` Phase 5 consumes.

## Routes shipped

- **`/today`** — RSC. Day + date headline, `WeatherStrip`, `MealCardHero`
  for tonight's dinner, `ComingUp` cards for the next 2-3 days with
  calendar-conflict badges, soft amber `PreferenceWarning`s, and an
  inline `QuestionCallout` (the brief's `onboarding_question`).
  Tier-0-incomplete households redirect to `/onboarding`.
- **`/plan`** — RSC. `Week of <date>` header with prev/next nav via
  `?start=YYYY-MM-DD`, vertical list of `WeekRow` cards (weather glyph,
  meal title, conflict + locked badges, long-press to open
  `MealOptionsSheet`), `AddDayCta` to extend the window into chat, and a
  no-plan affordance when `plan_list` is empty.
- **`/recipe/[meal_id]`** — RSC. Locates the meal by scanning
  `plan_read_recent_meals` across active plans, hydrates via
  `plan_read_meal`, optionally pulls real `inspire_read_recipe_steps`,
  then renders `RecipeHero` (gradient/photo, method summary, start-time
  math, `StartCookingButton` client island), grouped `IngredientsList`,
  `EquipmentRow`, `CookTimeline` (real steps or format heuristic),
  `NotesSection`.

## MCP tools

`household_read_brief`, `plan_list`, `plan_read_meal`,
`plan_read_recent_meals`, `plan_read_grievances`, `plan_read_dependency_edges`,
`inspire_read_recipe_steps`, `inspire_read_weather` (typed; consumed
indirectly via the brief), `chef_status_check`, `brigade_start`,
`household_onboarding_answer`. Typed entries added to `lib/mcp.ts`
`ToolMap`. `tool-renderers.ts` now maps `plan_read_meal` → `MealCard`.

## Storybook coverage

7 new stories: `WeatherStrip`, `MealCardHero`, `IngredientChip`,
`EquipmentChip`, `PreferenceWarning`, `CookTimeline`, `RecipeHero`. Each
covers 2-5 variants.

## /cook hand-off

`StartCookingButton` POSTs `{meal_id, plan_id}` to `/api/cook/start`.
The route mints `cook_session_id` (`cs_<base36 ts>_<rand>`), calls MCP
`brigade_start({cook_session_id, meal_id, plan_id, household_id})` —
which initializes the `CookingLeadAgent` DO — and returns
`{cook_session_id}`. The button then `router.push(/cook/<id>)`. Phase
5's `/cook/[cook_session_id]` route already exists as a stub. Brigade
failures (`{ok:false}`, unbound DO, network) surface as 502 and the
button shows the message inline.

## Open polish

- Heuristic cook timeline is coarse (4-5 rows). Real `recipe_steps` data
  flows through automatically when populated.
- `MealOptionsSheet` actions deep-link to chat with prefilled prompts
  instead of one-tap mutations — keeps conversational surface canonical.
- Last-cooked / taste feedback notes await a future MCP tool; the
  section renders `meal.notes[]` only for now.
- `inspire_read_weather` direct fallback (when no brief yet) is TODO.
- Pre-existing untracked `lib/markdown.ts` has JSX-in-`.ts` syntax
  errors; not from my changes. Tsc clean otherwise.
