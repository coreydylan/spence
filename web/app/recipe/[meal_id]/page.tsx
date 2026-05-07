import * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { loadRecipeData } from "@/lib/recipe-data";
import { dayShort } from "@/lib/dates";
import { RecipeHero } from "./components/recipe-hero";
import { IngredientsList } from "./components/ingredients-list";
import { EquipmentRow } from "./components/equipment-row";
import { CookTimeline } from "./components/cook-timeline";
import { NotesSection } from "./components/notes-section";
import { StartCookingButton } from "./start-cooking-button";

export const dynamic = "force-dynamic";

interface Params {
  meal_id: string;
}

/**
 * /recipe/[meal_id] — full recipe view.
 *
 * Server Component. Locates the meal across active plans, optionally
 * pulls real recipe steps + ingredients from canonical_recipes_v2 (Track
 * A's `inspire_read_recipe_steps`), and falls back to the heuristic
 * timeline derived from format when the recipe corpus has no match.
 */
export default async function RecipePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { meal_id } = await params;
  const h = await headers();
  const session = await getSessionFromHeaders(h);

  const data = await loadRecipeData(
    {
      household_id: session.household_id,
      caller_kind: "human",
      caller_id: "spence-web-recipe",
    },
    meal_id,
  );
  if (!data) {
    notFound();
  }

  const equipment = pullEquipment(data);

  return (
    <div className="flex flex-col gap-10 animate-fade-up">
      {/* Breadcrumb back-link */}
      <nav>
        <Link
          href="/plan"
          className="text-sm text-ink-soft hover:text-terracotta inline-flex items-center gap-1"
        >
          ← Plan
        </Link>
      </nav>

      <RecipeHero
        meal={data.meal}
        active_minutes={data.active_minutes}
        start_cooking_time={data.start_cooking_time}
        eat_time={data.eat_time}
        cta={
          <StartCookingButton meal_id={data.meal.id} plan_id={data.plan_id} />
        }
      />

      <SectionHeading>Ingredients</SectionHeading>
      <IngredientsList
        meal={data.meal}
        ingredients={data.recipe_steps?.ingredients}
      />

      {equipment.length > 0 && (
        <>
          <SectionHeading>Equipment</SectionHeading>
          <EquipmentRow equipment={equipment} />
        </>
      )}

      <SectionHeading>Cook timeline</SectionHeading>
      <CookTimeline steps={data.cook_timeline} />

      {(data.meal.notes && data.meal.notes.length > 0) && (
        <>
          <SectionHeading>Notes</SectionHeading>
          <NotesSection meal={data.meal} />
        </>
      )}

      {data.recipe_steps?.source_url && (
        <p className="text-xs text-ink-soft">
          Source:{" "}
          <a
            href={data.recipe_steps.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 text-terracotta"
          >
            {new URL(data.recipe_steps.source_url).hostname}
          </a>
        </p>
      )}

      {data.date && (
        <p className="text-xs text-ink-soft text-right uppercase tracking-wide">
          on the plan for {dayShort(data.date)}
        </p>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-ink/10" />
      <h2 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
        {children}
      </h2>
      <span className="h-px flex-1 bg-ink/10" />
    </div>
  );
}

interface RecipeDataLike {
  meal: {
    components?: Array<{ raw_ingredients?: unknown; equipment?: unknown }>;
    meta?: Record<string, unknown>;
  };
  recipe_steps: { steps: Array<{ equipment: string[] }> } | null;
}

function pullEquipment(data: RecipeDataLike): string[] {
  const set = new Set<string>();
  if (data.recipe_steps) {
    for (const s of data.recipe_steps.steps) {
      for (const e of s.equipment) set.add(e);
    }
  }
  // Composer-derived equipment, when present in component meta.
  const equipMeta = data.meal.meta?.equipment;
  if (Array.isArray(equipMeta)) {
    for (const e of equipMeta) if (typeof e === "string") set.add(e);
  }
  for (const c of data.meal.components ?? []) {
    if (Array.isArray((c as { equipment?: unknown }).equipment)) {
      for (const e of (c as { equipment?: unknown[] }).equipment as unknown[]) {
        if (typeof e === "string") set.add(e);
      }
    }
  }
  return Array.from(set).slice(0, 16);
}
