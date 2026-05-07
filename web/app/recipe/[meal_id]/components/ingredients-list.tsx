import * as React from "react";
import { IngredientChip } from "@/components/meal/ingredient-chip";
import type { PlanMeal, RecipeIngredient } from "@/lib/mcp";

interface Props {
  meal: PlanMeal;
  /** When real recipe steps are available (Track A), prefer their ingredient list. */
  ingredients?: RecipeIngredient[];
}

interface NormalizedIngredient {
  name: string;
  qty: number | string | null;
  unit: string | null;
  prep: string | null;
  importance: string | null;
  group: string;
}

/**
 * IngredientsList — grouped ingredient list for the /recipe page.
 *
 * Order of preference for the data source:
 *   1. `ingredients` from inspire_read_recipe_steps (real canonical recipe).
 *   2. `meal.components[].raw_ingredients` from the composer.
 *   3. `meal.raw_ingredients` (flat fallback).
 *   4. `meal.ingredient_names` (last-resort: just names).
 *
 * Items are grouped by `group` (recipe ingredients) or by component role
 * (composer ingredients). Required vs optional shows up as a lighter row.
 */
export function IngredientsList({ meal, ingredients }: Props) {
  const grouped = groupIngredients(meal, ingredients);
  const totalCount = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

  if (totalCount === 0) {
    return (
      <p className="text-sm text-ink-soft italic">
        No ingredient list yet — Spence will fill this in once you confirm the recipe.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group} className="flex flex-col gap-1">
          <h3 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            {group}
          </h3>
          <ul className="flex flex-col">
            {items.map((it, i) => (
              <IngredientChip
                key={`${group}-${i}-${it.name}`}
                name={it.name}
                qty={it.qty}
                unit={it.unit}
                prep={it.prep}
                importance={it.importance ?? undefined}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function groupIngredients(
  meal: PlanMeal,
  recipeIngredients?: RecipeIngredient[],
): Record<string, NormalizedIngredient[]> {
  const groups: Record<string, NormalizedIngredient[]> = {};

  if (recipeIngredients && recipeIngredients.length > 0) {
    for (const ing of recipeIngredients) {
      const key = (ing.group || "main").toUpperCase();
      groups[key] = groups[key] || [];
      groups[key].push({
        name: ing.name,
        qty: ing.qty,
        unit: ing.unit,
        prep: ing.prep,
        importance: ing.importance,
        group: key,
      });
    }
    return groups;
  }

  if (meal.components && meal.components.length > 0) {
    for (const comp of meal.components) {
      const key = (comp.role || comp.title || "main").toUpperCase().replace(/_/g, " ");
      groups[key] = groups[key] || [];
      const raws = comp.raw_ingredients || [];
      for (const r of raws) {
        if (typeof r === "string") {
          groups[key].push({
            name: r,
            qty: null,
            unit: null,
            prep: null,
            importance: null,
            group: key,
          });
        } else if (r && typeof r === "object") {
          groups[key].push({
            name: r.name || "(unnamed)",
            qty: r.qty ?? null,
            unit: r.unit ?? null,
            prep: null,
            importance: null,
            group: key,
          });
        }
      }
    }
    if (Object.values(groups).some((arr) => arr.length > 0)) return groups;
  }

  if (meal.raw_ingredients && meal.raw_ingredients.length > 0) {
    groups.MAIN = meal.raw_ingredients.map((r) =>
      typeof r === "string"
        ? { name: r, qty: null, unit: null, prep: null, importance: null, group: "MAIN" }
        : {
            name: r.name || "(unnamed)",
            qty: r.qty ?? null,
            unit: r.unit ?? null,
            prep: r.prep ?? null,
            importance: null,
            group: "MAIN",
          },
    );
    return groups;
  }

  if (meal.ingredient_names && meal.ingredient_names.length > 0) {
    groups.MAIN = meal.ingredient_names.map((name) => ({
      name,
      qty: null,
      unit: null,
      prep: null,
      importance: null,
      group: "MAIN",
    }));
  }
  return groups;
}
