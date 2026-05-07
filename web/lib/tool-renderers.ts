/**
 * Maps tool result shapes to React components.
 *
 * The chat surface checks: if a tool result has a known renderer, render it
 * instead of the JSON blob. Phase 2+ agents will register more entries here
 * as they wire screens (RecipeStepRow, BriefCard, IngredientChip, etc.).
 */

import type { ComponentType } from "react";
import { MealCard } from "@/components/meal/meal-card";
import { OnboardingQuestionCard } from "@/components/chef/onboarding-question-card";
import { ShopSummary } from "@/components/chef/results/shop-summary";
import { PantrySummary } from "@/components/chef/results/pantry-summary";
import { MemberSummary } from "@/components/chef/results/member-summary";
import { TraitSpreadSummary } from "@/components/chef/results/trait-spread-summary";
import { BriefCardSummary } from "@/components/chef/results/brief-card-summary";
import type { UiComponent } from "@/lib/chef-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComp = ComponentType<any>;

const REGISTRY: Record<UiComponent["component"], AnyComp> = {
  meal_card: MealCard,
  onboarding_question: OnboardingQuestionCard,
  weather_strip: PlaceholderRenderer,
  shop_summary: ShopSummary,
  pantry_summary: PantrySummary,
  member_summary: MemberSummary,
  trait_spread: TraitSpreadSummary,
  brief_card: BriefCardSummary,
};

/**
 * Tool-result → UI component picker.
 *
 * Phase 1 wired this up only for plan_compose_meal / plan_read_meal in
 * chef-agent.ts. Phase 2 expands it: when chef_status_check returns a
 * `next_question` we want the inline OnboardingQuestionCard to surface in the
 * chat too — so the chat-driven onboarding path matches the wizard.
 *
 * Returns a UiComponent envelope or undefined.
 */
export function pickUiFromToolResult(
  toolName: string,
  result: unknown,
): UiComponent | undefined {
  if (!result || typeof result !== "object") return undefined;

  if (toolName === "chef_status_check") {
    const r = result as {
      onboarding?: { next_question?: unknown };
      recommendation?: { next_question?: unknown };
    };
    const q = r.recommendation?.next_question ?? r.onboarding?.next_question;
    if (q && typeof q === "object") {
      return {
        component: "onboarding_question",
        props: { question: q },
      };
    }
  }

  if (
    toolName === "household_onboarding_start" ||
    toolName === "household_onboarding_answer"
  ) {
    const r = result as { next_question?: unknown };
    if (r.next_question && typeof r.next_question === "object") {
      return {
        component: "onboarding_question",
        props: { question: r.next_question },
      };
    }
  }

  // Phase 3: plan_read_meal returns { meal } — render as a MealCard so the
  // chat surface previews the meal inline when the agent asks it about a slot.
  // plan_compose_meal is already wired in chef-agent.ts; this branch handles
  // the read-side.
  if (toolName === "plan_read_meal") {
    const r = result as { meal?: unknown };
    if (r.meal && typeof r.meal === "object") {
      return { component: "meal_card", props: { meal: r.meal } };
    }
  }

  // Phase 4: shop / member / trait-spread / brief tool surfaces.
  if (toolName === "plan_read_shopping_list") {
    const r = result as { sections?: unknown; runs?: unknown };
    if (Array.isArray(r.sections)) {
      return {
        component: "shop_summary",
        props: { sections: r.sections, runs: r.runs },
      };
    }
  }
  if (toolName === "member_list") {
    const r = result as { members?: unknown };
    if (Array.isArray(r.members)) {
      return { component: "member_summary", props: { members: r.members } };
    }
  }
  if (toolName === "household_get_trait_spread") {
    const r = result as { spreads?: unknown };
    if (Array.isArray(r.spreads)) {
      return { component: "trait_spread", props: { spreads: r.spreads } };
    }
  }
  if (toolName === "household_read_brief") {
    const r = result as { ok?: boolean; brief?: unknown };
    if (r.ok && r.brief && typeof r.brief === "object") {
      return { component: "brief_card", props: { brief: r.brief } };
    }
  }
  if (toolName === "inspire_read_household_signals") {
    const r = result as { pantry_top?: unknown };
    if (Array.isArray(r.pantry_top)) {
      return { component: "pantry_summary", props: { items: r.pantry_top } };
    }
  }

  return undefined;
}

function PlaceholderRenderer({ payload }: { payload?: unknown }) {
  return null;
}

export function getRenderer(name: UiComponent["component"]): AnyComp | null {
  return REGISTRY[name] ?? null;
}

/** Convenience: given a UiComponent envelope, return {Component, props}. */
export function resolve(ui: UiComponent): {
  Component: AnyComp;
  props: Record<string, unknown>;
} | null {
  const Component = getRenderer(ui.component);
  if (!Component) return null;
  return { Component, props: ui.props as Record<string, unknown> };
}
