/**
 * Server-side data assembler for /recipe/[meal_id].
 *
 * The MCP `plan_read_meal` tool keys by (plan_id, slot=date+slot). The
 * /recipe page only has a meal_id from the URL, so we:
 *   1. plan_list to find every active plan for the household.
 *   2. For each plan, scan meals_by_day in plan_read_map (compact mode is
 *      cheap) until we find a slot whose meal_id matches.
 *   3. plan_read_meal({plan_id, slot}) to load the full meal.
 *   4. plan_read_dependency_edges to enrich the cook timeline.
 *   5. inspire_read_recipe_steps when meal.recipe_id is present (Track A
 *      data); fall back to the heuristic timeline derived from format.
 *
 * Returns null when the meal can't be located — the page renders a 404.
 */

import {
  mcp,
  mcp_call_any,
  type McpContext,
  type PlanMeal,
  type RecipeStepsResult,
} from "./mcp";

export interface CookTimelineStep {
  time: string;
  prose: string;
  source: "heuristic" | "recipe_steps";
  /** Optional minute offset from cook-window start. */
  offset_min?: number;
}

export interface RecipeData {
  meal: PlanMeal;
  plan_id: string;
  date: string;
  slot: "breakfast" | "lunch" | "dinner" | "snack";
  /** Active minutes — from the meal, falling back to the per-format heuristic. */
  active_minutes: number;
  /** "17:55" */
  start_cooking_time: string;
  /** "18:30" */
  eat_time: string;
  /** Real recipe ingredients/steps if available, else null. */
  recipe_steps: RecipeStepsResult | null;
  cook_timeline: CookTimelineStep[];
}

// Mirror of the worker's FORMAT_COOK_MIN heuristic.
const FORMAT_COOK_MIN: Record<string, number> = {
  salad: 15,
  sandwich: 10,
  taco: 25,
  tostada: 20,
  sopes: 25,
  banh_mi: 20,
  bowl: 30,
  donburi: 35,
  stir_fry: 25,
  soup: 35,
  curry: 40,
  pasta: 30,
  frittata: 25,
  pizza: 40,
  flatbread: 35,
  mezze: 60,
  mezze_plate: 60,
  fritter: 30,
  dumpling: 50,
  hot_pot: 45,
  risotto: 35,
  paella: 50,
  tagine: 70,
  gratin: 60,
  galette: 55,
  burger: 25,
};

/** Default eat time used when the meal lacks one. */
const DEFAULT_EAT_TIME: Record<string, string> = {
  breakfast: "08:00",
  lunch: "12:30",
  dinner: "18:30",
  snack: "15:00",
};

export function estimateCookMin(format: string | null | undefined): number {
  if (!format) return 30;
  const k = format.toLowerCase().trim().replace(/-/g, "_");
  return FORMAT_COOK_MIN[k] ?? FORMAT_COOK_MIN[k.replace(/_/g, " ")] ?? 30;
}

export async function loadRecipeData(
  ctx: McpContext,
  meal_id: string,
): Promise<RecipeData | null> {
  // 1. Locate the meal across active plans.
  const located = await locateMeal(ctx, meal_id);
  if (!located) return null;
  const { plan_id, meal } = located;
  const date = meal.date ?? meal.slot_date ?? "";
  const slot = (meal.slot ?? meal.slot_label ?? "dinner") as RecipeData["slot"];

  // 2. Optional: real recipe steps via Track A.
  let recipe_steps: RecipeStepsResult | null = null;
  if (meal.recipe_id) {
    try {
      const res = await mcp(
        "inspire_read_recipe_steps",
        { household_id: ctx.household_id, recipe_id: meal.recipe_id },
        ctx,
      );
      if (res.ok) recipe_steps = res;
    } catch {
      recipe_steps = null;
    }
  }

  // 3. Compute timing.
  const active_minutes = meal.active_minutes ?? meal.active_time_min ?? estimateCookMin(meal.format);
  const eat_time = meal.suggested_start_time
    ? backDateOpposite(meal.suggested_start_time, active_minutes)
    : DEFAULT_EAT_TIME[slot] ?? "18:30";
  const start_cooking_time = meal.suggested_start_time ?? backDate(eat_time, active_minutes);

  // 4. Build a cook timeline.
  const cook_timeline = recipe_steps
    ? recipeStepsToTimeline(recipe_steps, start_cooking_time)
    : heuristicTimeline(meal, start_cooking_time, eat_time, active_minutes);

  return {
    meal,
    plan_id,
    date,
    slot,
    active_minutes,
    start_cooking_time,
    eat_time,
    recipe_steps,
    cook_timeline,
  };
}

// ─── Locate meal by id ──────────────────────────────────────────────────────

interface PlanMapMealRef {
  id?: string;
  meal_id?: string;
  date?: string;
  slot?: "breakfast" | "lunch" | "dinner" | "snack";
}

/**
 * Walk active plans to find the slot containing `meal_id`. We use the
 * `mcp_call_any` escape hatch to fetch the raw plan JSON via plan_list +
 * plan_read_map. Worker emits the map as compact markdown — for ID matching
 * we fall through to inspecting the loaded plan JSON via the MCP `plan_read_meal`
 * route, scanning slot by slot. To keep this efficient we use the worker's
 * /mcp/plan-world `plan_list` then load each plan's structured form by
 * iterating only dates where dinners exist via the `plan_read_recent_meals`
 * tool which gives us {id, date, slot} tuples.
 */
async function locateMeal(
  ctx: McpContext,
  meal_id: string,
): Promise<{ plan_id: string; meal: PlanMeal } | null> {
  const plans = await mcp("plan_list", { household_id: ctx.household_id }, ctx);
  for (const summary of plans.plans) {
    try {
      const recent = (await mcp_call_any(
        "plan_read_recent_meals",
        { plan_id: summary.plan_id, n: 50 },
        ctx,
      )) as { meals?: PlanMapMealRef[] };
      const match = (recent.meals ?? []).find(
        (m) => m.id === meal_id || m.meal_id === meal_id,
      );
      if (!match || !match.date || !match.slot) continue;
      const read = await mcp(
        "plan_read_meal",
        { plan_id: summary.plan_id, slot: { date: match.date, slot: match.slot } },
        ctx,
      );
      if (read.meal) {
        // Ensure the meal carries date/slot so downstream UI never has to guess.
        const meal: PlanMeal = {
          ...read.meal,
          date: read.meal.date ?? match.date,
          slot: read.meal.slot ?? match.slot,
        };
        return { plan_id: summary.plan_id, meal };
      }
    } catch {
      // Try the next plan.
      continue;
    }
  }
  return null;
}

// ─── Timeline helpers ──────────────────────────────────────────────────────

function heuristicTimeline(
  meal: PlanMeal,
  start_cooking: string,
  eat_time: string,
  active_minutes: number,
): CookTimelineStep[] {
  const steps: CookTimelineStep[] = [];
  // Approximate phases: prep (40%), cook (50%), plate (10%).
  const prepMin = Math.round(active_minutes * 0.4);
  const cookMin = Math.round(active_minutes * 0.5);

  steps.push({
    time: start_cooking,
    prose: "Pull ingredients, set up the station, and start any soaks or rests.",
    source: "heuristic",
    offset_min: 0,
  });

  if (prepMin > 5) {
    steps.push({
      time: addMinsToTime(start_cooking, Math.max(1, Math.floor(prepMin / 2))),
      prose: `Prep components: chop, measure, and season for ${meal.format ?? "the dish"}.`,
      source: "heuristic",
      offset_min: Math.max(1, Math.floor(prepMin / 2)),
    });
  }

  steps.push({
    time: addMinsToTime(start_cooking, prepMin),
    prose: `Begin the heat — the ${meal.format ?? "main"} cooks for about ${cookMin} minutes.`,
    source: "heuristic",
    offset_min: prepMin,
  });

  steps.push({
    time: addMinsToTime(eat_time, -5),
    prose: "Plate and garnish; bring to the table.",
    source: "heuristic",
    offset_min: active_minutes - 5,
  });

  steps.push({
    time: eat_time,
    prose: "Eat.",
    source: "heuristic",
    offset_min: active_minutes,
  });

  return steps.filter((s, i, arr) => i === 0 || s.time !== arr[i - 1].time);
}

function recipeStepsToTimeline(
  recipe: RecipeStepsResult,
  start_cooking: string,
): CookTimelineStep[] {
  let cursor = 0; // minute offset
  return recipe.steps.map((step) => {
    const offset = cursor;
    cursor += Math.max(2, step.idle_time_min ?? 5);
    return {
      time: addMinsToTime(start_cooking, offset),
      prose: step.prose,
      source: "recipe_steps" as const,
      offset_min: offset,
    };
  });
}

// ─── Time math ─────────────────────────────────────────────────────────────

function addMinsToTime(hhmm: string, mins: number): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  let total = Number(m[1]) * 60 + Number(m[2]) + mins;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Treats `t` as a cooking-start time and returns the implied eat time. */
function backDateOpposite(startCookTime: string, mins: number): string {
  return addMinsToTime(startCookTime, mins);
}

/** Subtract minutes from `t` to compute a cooking-start time. */
function backDate(eatTime: string, mins: number): string {
  return addMinsToTime(eatTime, -mins);
}
