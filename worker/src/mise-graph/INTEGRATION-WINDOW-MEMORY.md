# Integration: window memory + meal feedback

Two new modules. No edits to existing code yet — the integrator wires them in.

## 1. Apply schema

Run `worker/src/mise-graph/schema-window-memory.sql` against remote D1. It only adds `mise_meal_feedback` (additive, no edits to `mise_week_plans`).

## 2. Wire into the composer-context loader

In `composer-context.ts` (the function that assembles the bundle handed to `composeMenuWithLlm`), import and call:

```ts
import { loadRecentMenuContext } from "./window-memory";
import { loadRecentFeedback, mealFeedbackHints } from "./recipe-feedback";

const recent = await loadRecentMenuContext(env, {
  household_id,
  lookback_days: 28,
  exclude_plan_id: currentPlanId, // skip the plan we're regenerating, if any
});
const feedback = await loadRecentFeedback(env, household_id, 60);
const hints = mealFeedbackHints(feedback);
```

Add both `recent` and `hints` onto the `ComposerContextBundle` (or whatever shape the composer reads). Then in `menu-composer.ts`'s prompt builder, surface them as a section like:

- "Recent dinners (last 28 days, do not repeat verbatim): …recent_dinner_titles"
- "Anchor pressure (avoid > 0.6): …recent_anchor_pressure"
- "Recent cuisines, count: …recent_cuisines"
- "Loved last 60 days: …loved_titles, loved_anchors, loved_cuisines"
- "Rejected (do NOT plan again): …rejected_titles, rejected_anchors"
- "Would repeat: …would_repeat_titles"

The composer LLM already understands "avoid this", "lean into this" — pass it as readable bullets, not JSON.

## 3. Wire the feedback route

Add a route handler that accepts `MealFeedbackInput` and calls `recordMealFeedback(env, input)`. Idempotent on `(plan_id, meal_id)` — re-submitting overwrites. Expose `loadRecentFeedback` for a "what did I rate" UI if needed.

## 4. Anchors

`window-memory.ts` does coarse canonicalization (lowercase, strip cooking-state prefixes). If you want canonical-ingredient resolution to back the anchor keys, post-process `recent_anchor_pressure` against the existing resolver before handing it to the prompt — but the simple form is good enough for the LLM.

## Function signatures (quick reference)

```ts
loadRecentMenuContext(env, { household_id, lookback_days?, exclude_plan_id? }): Promise<RecentMenuContext>
recordMealFeedback(env, MealFeedbackInput): Promise<MealFeedbackRecord>
loadRecentFeedback(env, household_id, lookback_days?): Promise<MealFeedbackRecord[]>
mealFeedbackHints(records): MealFeedbackHints
```
