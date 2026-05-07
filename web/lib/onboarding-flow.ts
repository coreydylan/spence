/**
 * Onboarding flow definition.
 *
 * The wizard is a finite, ordered list of steps. Each step:
 *   - Has a stable `id` (used for routing back-from-mid-flow + Storybook)
 *   - Lives in a tier (0, 1, or "bulk") for progress dot grouping
 *   - Maps to an MCP tool + question_kind so the wizard shell knows how to
 *     submit. The leaf step component returns the answer payload; the shell
 *     handles the call + advance.
 *   - Optionally has a `skipIf(state)` predicate so we can skip e.g. the
 *     pantry-paste step when the user picked "build over time".
 *
 * Resume logic: on mount the wizard calls `chef_status_check` and
 * `household_onboarding_status`. If `tier_0_done` we skip past the tier-0
 * pages; if `tier_1_done` we skip past tier-1. Within a tier, the
 * `next_question.kind` from the worker tells us which question to land on.
 */

export type StepId =
  | "household_name"
  | "primary_member"
  | "location"
  | "size"
  | "first_help"
  | "members_roster"
  | "avoidances"
  | "dinner_ritual"
  | "cook_frequency"
  | "pantry_intake"
  | "pantry_paste"
  | "equipment_grid"
  | "traditions"
  | "final";

export type StepTier = 0 | 1 | "bulk" | "done";

export interface OnboardingState {
  /** Free-form answers indexed by step id. The wizard shell stores everything
   * the user has answered so later steps + skip predicates can introspect. */
  answers: Partial<Record<StepId, unknown>>;
}

export interface StepDef {
  id: StepId;
  tier: StepTier;
  /** The worker-side question_kind sent to `household_onboarding_answer`. Null
   * for steps that hit a different tool (bulk, equipment, traditions, final). */
  questionKind: string | null;
  /** Which MCP tool the wizard shell should call when the step submits. */
  tool:
    | "household_onboarding_answer"
    | "household_set_pantry_bulk"
    | "household_set_equipment_bulk"
    | "household_set_traditions"
    | null;
  /** Whether this step can be skipped without an answer. */
  skippable?: boolean;
  /** Optional predicate that hides the step entirely. */
  skipIf?: (state: OnboardingState) => boolean;
}

export const STEPS: StepDef[] = [
  // Tier 0 — existence stub (5 dots)
  {
    id: "household_name",
    tier: 0,
    questionKind: "tier_0_household_name",
    tool: "household_onboarding_answer",
  },
  {
    id: "primary_member",
    tier: 0,
    questionKind: "tier_0_primary_member",
    tool: "household_onboarding_answer",
  },
  {
    id: "location",
    tier: 0,
    questionKind: "tier_0_location",
    tool: "household_onboarding_answer",
  },
  {
    id: "size",
    tier: 0,
    questionKind: "tier_0_size",
    tool: "household_onboarding_answer",
  },
  {
    id: "first_help",
    tier: 0,
    questionKind: "tier_0_first_help",
    tool: "household_onboarding_answer",
  },

  // Tier 1 — day-1 essentials (5 dots)
  {
    id: "members_roster",
    tier: 1,
    questionKind: "tier_1_members_roster",
    tool: "household_onboarding_answer",
    skippable: true,
  },
  {
    id: "avoidances",
    tier: 1,
    questionKind: "tier_1_avoidances",
    tool: "household_onboarding_answer",
    skippable: true,
  },
  {
    id: "dinner_ritual",
    tier: 1,
    questionKind: "tier_1_dinner_ritual",
    tool: "household_onboarding_answer",
  },
  {
    id: "cook_frequency",
    tier: 1,
    questionKind: "tier_1_cook_frequency",
    tool: "household_onboarding_answer",
  },
  {
    id: "pantry_intake",
    tier: 1,
    questionKind: "tier_1_pantry_intake",
    tool: "household_onboarding_answer",
  },

  // Bulk + traditions (3 dots)
  {
    id: "pantry_paste",
    tier: "bulk",
    questionKind: null,
    tool: "household_set_pantry_bulk",
    skippable: true,
    skipIf: (state) => {
      const v = state.answers.pantry_intake;
      // Only show paste step if user picked "bulk paste".
      return v !== "bulk" && v !== "bulk_paste";
    },
  },
  {
    id: "equipment_grid",
    tier: "bulk",
    questionKind: null,
    tool: "household_set_equipment_bulk",
    skippable: true,
  },
  {
    id: "traditions",
    tier: "bulk",
    questionKind: null,
    tool: "household_set_traditions",
    skippable: true,
  },

  // Final
  { id: "final", tier: "done", questionKind: null, tool: null },
];

/** Returns visible steps after applying skip predicates against current state. */
export function visibleSteps(state: OnboardingState): StepDef[] {
  return STEPS.filter((s) => !s.skipIf?.(state));
}

/** Group steps by tier for the progress dots. */
export interface TierProgress {
  tier: StepTier;
  total: number;
  index: number; // 0-based current within tier
}

export function tierProgressFor(stepId: StepId, state: OnboardingState): TierProgress[] {
  const visible = visibleSteps(state);
  const groups: { tier: StepTier; ids: StepId[] }[] = [];
  for (const step of visible) {
    const last = groups[groups.length - 1];
    if (last && last.tier === step.tier) {
      last.ids.push(step.id);
    } else {
      groups.push({ tier: step.tier, ids: [step.id] });
    }
  }
  return groups.map((g) => {
    const idx = g.ids.indexOf(stepId);
    return {
      tier: g.tier,
      total: g.ids.length,
      index: idx === -1 ? -1 : idx,
    };
  });
}

/**
 * Map a worker question_kind to a step id. Used when resuming mid-flow:
 * `chef_status_check.recommendation.next_question.kind` tells us where to
 * land.
 */
export function stepFromQuestionKind(kind: string | undefined): StepId | null {
  if (!kind) return null;
  const map: Record<string, StepId> = {
    tier_0_household_name: "household_name",
    tier_0_primary_member: "primary_member",
    tier_0_location: "location",
    tier_0_size: "size",
    tier_0_first_help: "first_help",
    tier_1_members_roster: "members_roster",
    tier_1_avoidances: "avoidances",
    tier_1_dinner_ritual: "dinner_ritual",
    tier_1_cook_frequency: "cook_frequency",
    tier_1_pantry_intake: "pantry_intake",
  };
  return map[kind] ?? null;
}

export function findStepIndex(steps: StepDef[], id: StepId): number {
  return steps.findIndex((s) => s.id === id);
}

/** Static tier-1 size choice options. */
export const SIZE_CHOICES: { id: string; label: string }[] = [
  { id: "1", label: "1" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "4", label: "4" },
  { id: "5+", label: "5+" },
];

export const FIRST_HELP_CHOICES: { id: string; label: string; hint: string }[] = [
  { id: "weekly_plan", label: "Plan my week", hint: "Draft 4–7 dinners I'll actually cook" },
  { id: "tonight", label: "Dinner tonight", hint: "Just figure out what's for dinner" },
  { id: "pantry", label: "Sort my pantry", hint: "Know what I have, what's expiring" },
];

export const DINNER_RITUAL_CHOICES: {
  id: string;
  label: string;
  hint: string;
}[] = [
  { id: "table", label: "At the table", hint: "Dinner is a moment" },
  { id: "tv", label: "In front of the TV", hint: "Cozy and casual" },
  { id: "desk", label: "At my desk", hint: "Refuel and keep moving" },
  { id: "varies", label: "It varies", hint: "Depends on the day" },
];

export const COOK_FREQUENCY_CHOICES: {
  id: string;
  label: string;
  hint: string;
}[] = [
  { id: "most", label: "Most nights", hint: "5+ nights a week" },
  { id: "sometimes", label: "Sometimes", hint: "2–4 nights a week" },
  { id: "rarely", label: "Rarely", hint: "Once a week or less" },
];

export const PANTRY_INTAKE_CHOICES: {
  id: string;
  label: string;
  hint: string;
}[] = [
  { id: "bulk", label: "Bulk paste", hint: "I'll list what's in there now" },
  { id: "photo", label: "Take a photo", hint: "Show you my shelves" },
  { id: "gradual", label: "Build over time", hint: "Learn it as we cook" },
];

export const AVOIDANCE_CHOICES: { id: string; label: string }[] = [
  { id: "vegetarian", label: "Vegetarian" },
  { id: "vegan", label: "Vegan" },
  { id: "pescatarian", label: "Pescatarian" },
  { id: "gluten_free", label: "Gluten-free" },
  { id: "dairy_free", label: "Dairy-free" },
  { id: "nut_free", label: "Nut-free" },
  { id: "no_pork", label: "No pork" },
  { id: "no_shellfish", label: "No shellfish" },
  { id: "low_carb", label: "Low-carb" },
  { id: "kosher", label: "Kosher" },
  { id: "halal", label: "Halal" },
];

export const EQUIPMENT_CHOICES: { id: string; label: string }[] = [
  { id: "oven", label: "Oven" },
  { id: "stovetop", label: "Stovetop" },
  { id: "microwave", label: "Microwave" },
  { id: "instant_pot", label: "Instant Pot" },
  { id: "slow_cooker", label: "Slow cooker" },
  { id: "grill", label: "Grill" },
  { id: "dutch_oven", label: "Dutch oven" },
  { id: "cast_iron", label: "Cast iron skillet" },
  { id: "wok", label: "Wok" },
  { id: "blender", label: "Blender" },
  { id: "food_processor", label: "Food processor" },
  { id: "stand_mixer", label: "Stand mixer" },
  { id: "air_fryer", label: "Air fryer" },
  { id: "rice_cooker", label: "Rice cooker" },
  { id: "sheet_pan", label: "Sheet pan" },
  { id: "sous_vide", label: "Sous vide" },
];

export const AGE_GROUP_CHOICES: { id: string; label: string }[] = [
  { id: "infant", label: "Infant" },
  { id: "toddler", label: "Toddler" },
  { id: "kid", label: "Kid (5–12)" },
  { id: "teen", label: "Teen" },
  { id: "adult", label: "Adult" },
  { id: "senior", label: "Senior" },
];
