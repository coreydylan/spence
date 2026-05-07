// Onboarding question bank — tier 0 + tier 1 (Phase A) and tier 2/3/4 (Phase D).
//
// Each Question carries:
//   * kind            — stable identifier (used as primary key in responses)
//   * tier            — 0 (existence stub) or 1 (day-1 essentials)
//   * required        — if true, can't advance the tier without an answer or skip
//   * options/free_text_allowed — UX hint; bank also enforces forced-choice values
//   * inferred_traits — predicates that map an answer to one of the 7 trait deltas
//   * writes_to       — optional pointer to which household-level column the
//                       answer mirrors (e.g. dinner_ritual). The actual write
//                       happens in onboarding.ts so the question bank stays
//                       declarative.
//
// The 7 trait dimensions are listed in TRAIT_NAMES below. Phase A only fires
// inferred-trait deltas from tier 1.3 (dinner_ritual). The other six dims fill
// in via Phase C's observation pipeline.
//
// Phase D adds HookedQuestion: tier 2/3/4 questions that DON'T live on the
// linear answer-or-skip path. They're surfaced opportunistically by the
// scheduler when their named trigger predicate fires against runtime
// HookDeps. Each carries a TEMPLATE for question_text that is rendered with
// the deps at ask-time (e.g. "Tofu's shown up ${count} times — constant or
// phase?"). The trigger logic itself lives in onboarding-hooks.ts as a pure
// function `evaluateTrigger(kind, deps)` so the question bank stays
// declarative + serializable.

export type QuestionKind =
	| "tier_0_household_name"
	| "tier_0_primary_member"
	| "tier_0_location"
	| "tier_0_size"
	| "tier_0_first_help"
	| "tier_1_members_roster"
	| "tier_1_avoidances"
	| "tier_1_dinner_ritual"
	| "tier_1_cook_frequency"
	| "tier_1_pantry_intake"
	// Tier 2 — week-1 calibration (hook-matched).
	| "tier_2_skipped_meal"
	| "tier_2_cuisine_streak"
	| "tier_2_anchor_repeat"
	| "tier_2_equipment_unused"
	| "tier_2_weekend_food"
	| "tier_2_takeout_night"
	// Tier 3 — month-1 depth (opportunistic).
	| "tier_3_tired_night_default"
	| "tier_3_sunday_tradition"
	| "tier_3_loved_meal_followup"
	| "tier_3_holiday_approach"
	| "tier_3_cancel_alternative"
	| "tier_3_perfect_on_paper"
	| "tier_3_growing_up_meal"
	| "tier_3_cook_alone_or_together"
	| "tier_3_leftover_philosophy"
	| "tier_3_tired_response_pattern"
	// Tier 4 — seasonal / life-event recalibration.
	| "tier_4_season_summer"
	| "tier_4_season_winter"
	| "tier_4_season_fall"
	| "tier_4_season_spring"
	| "tier_4_new_member"
	| "tier_4_hosting_uptick";

export type TraitName =
	| "precision_vs_improvisation"
	| "ritual_vs_refueling"
	| "comfort_vs_adventure"
	| "solo_cook_vs_social_cook"
	| "quick_vs_project"
	| "pantry_first_vs_shop_fresh"
	| "equipment_rich_vs_minimalist";

export const TRAIT_NAMES: ReadonlyArray<TraitName> = [
	"precision_vs_improvisation",
	"ritual_vs_refueling",
	"comfort_vs_adventure",
	"solo_cook_vs_social_cook",
	"quick_vs_project",
	"pantry_first_vs_shop_fresh",
	"equipment_rich_vs_minimalist",
];

export interface QuestionOption {
	value: string;
	label: string;
}

export interface InferredTraitRule {
	response_predicate: (response: string) => boolean;
	trait_name: TraitName;
	delta_value: number;       // moves trait toward this value (0..1)
	delta_confidence: number;  // evidence weight added by this answer
}

export interface QuestionWritesTo {
	table: "mise_household_profiles" | "mise_household_members";
	column: string;
}

export interface Question {
	kind: QuestionKind;
	tier: 0 | 1;
	required: boolean;
	question_text: string;
	options?: QuestionOption[];
	free_text_allowed: boolean;
	inferred_traits?: InferredTraitRule[];
	writes_to?: QuestionWritesTo;
}

// ─── Tier 0 — existence stub ─────────────────────────────────────────────────

export const TIER_0_QUESTIONS: ReadonlyArray<Question> = [
	{
		kind: "tier_0_household_name",
		tier: 0,
		required: false,
		question_text: "What should I call your household? (Skip and I'll pick something.)",
		free_text_allowed: true,
		writes_to: { table: "mise_household_profiles", column: "display_name" },
	},
	{
		kind: "tier_0_primary_member",
		tier: 0,
		required: true,
		question_text: "What's your name and rough age group?",
		free_text_allowed: true,
		writes_to: { table: "mise_household_members", column: "display_name" },
	},
	{
		kind: "tier_0_location",
		tier: 0,
		required: false,
		question_text: "Roughly where are you — city or zip is plenty.",
		free_text_allowed: true,
	},
	{
		kind: "tier_0_size",
		tier: 0,
		required: true,
		question_text: "How many adults eat regularly here? (Kids can come later.)",
		free_text_allowed: true,
		writes_to: { table: "mise_household_profiles", column: "people_count" },
	},
	{
		kind: "tier_0_first_help",
		tier: 0,
		required: true,
		question_text: "What's the most useful thing I could help with first?",
		options: [
			{ value: "meal_planning", label: "Plan the week's meals" },
			{ value: "dinner_tonight", label: "Just figure out dinner tonight" },
			{ value: "pantry", label: "Get my pantry organized" },
		],
		free_text_allowed: false,
	},
];

// ─── Tier 1 — day-1 essentials ───────────────────────────────────────────────

export const TIER_1_QUESTIONS: ReadonlyArray<Question> = [
	{
		kind: "tier_1_members_roster",
		tier: 1,
		required: false,
		question_text: "Who else lives here or eats with you regularly? (Names + ages, optional.)",
		free_text_allowed: true,
	},
	{
		kind: "tier_1_avoidances",
		tier: 1,
		required: true,
		question_text: "Anything anyone in the house can't or won't eat? Allergies, hard avoidances, vegetarian, etc.",
		free_text_allowed: true,
	},
	{
		// THE tier-1 identity probe (locked decision).
		kind: "tier_1_dinner_ritual",
		tier: 1,
		required: true,
		question_text: "When you say \"dinner,\" what does that usually look like — eat at the table, eat in front of the TV, eat at your desk, or it varies?",
		options: [
			{ value: "table", label: "At the table" },
			{ value: "tv", label: "In front of the TV" },
			{ value: "desk", label: "At my desk" },
			{ value: "varies", label: "It varies" },
		],
		free_text_allowed: false,
		writes_to: { table: "mise_household_profiles", column: "dinner_ritual" },
		inferred_traits: [
			{
				response_predicate: r => normalizeChoice(r) === "table",
				trait_name: "ritual_vs_refueling",
				delta_value: 0.0, // toward ritual
				delta_confidence: 0.3,
			},
			{
				response_predicate: r => {
					const v = normalizeChoice(r);
					return v === "desk" || v === "tv";
				},
				trait_name: "ritual_vs_refueling",
				delta_value: 1.0, // toward refueling
				delta_confidence: 0.3,
			},
		],
	},
	{
		kind: "tier_1_cook_frequency",
		tier: 1,
		required: true,
		question_text: "Do you cook most nights, sometimes, or rarely?",
		options: [
			{ value: "most", label: "Most nights" },
			{ value: "sometimes", label: "Sometimes" },
			{ value: "rarely", label: "Rarely" },
		],
		free_text_allowed: false,
		writes_to: { table: "mise_household_profiles", column: "cook_frequency" },
	},
	{
		kind: "tier_1_pantry_intake",
		tier: 1,
		required: true,
		question_text: "Pantry — would you rather take 5 minutes to tell me what's in there, snap a photo, or let me build it as we cook?",
		options: [
			{ value: "bulk", label: "I'll list it now (bulk paste)" },
			{ value: "photo", label: "Photo of the shelf" },
			{ value: "gradual", label: "Build it as we cook" },
		],
		free_text_allowed: false,
		writes_to: { table: "mise_household_profiles", column: "pantry_intake_mode" },
	},
];

// ─── Tier 2 / 3 / 4 — HookedQuestion (Phase D) ───────────────────────────────
//
// Hooked questions are NOT part of the linear tier-advancement walk; they're
// scored + surfaced by the scheduler when their named trigger fires against
// runtime HookDeps. Each carries:
//
//   * trigger_kind   — a string key into onboarding-hooks.ts evaluateHook().
//                      Predicates are intentionally kept out of this file so
//                      the bank stays serializable + declarative.
//   * text_template  — a `${var}` template that renders with HookDeps at the
//                      moment we ask the question. Missing vars render as ''
//                      (the renderer never throws on missing keys).
//   * kind_priority  — "dietary" | "equipment" | "tradition" | "personality"
//                      — feeds the scheduler's question_kind_priority weight
//                      (dietary > equipment > tradition > personality).
//
// All HookedQuestion fields except trigger_kind / text_template are optional
// — they're free text from the user's vantage, so options/inferred_traits
// rarely apply. Where they DO apply (e.g. tier_3_cook_alone_or_together
// has options) we surface them just like a Question.

export type HookedTier = 2 | 3 | 4;

export type TriggerKind =
	// Tier 2 triggers
	| "skipped_meal"
	| "cuisine_streak"
	| "anchor_repeat"
	| "equipment_unused"
	| "weekend_food"
	| "takeout_night"
	// Tier 3 triggers
	| "tired_night_default"
	| "sunday_morning"
	| "loved_meal_followup"
	| "holiday_approach"
	| "cancel_alternative"
	| "perfect_on_paper"
	| "growing_up_meal"
	| "cook_alone_or_together"
	| "leftover_philosophy"
	| "tired_response_pattern"
	// Tier 4 triggers
	| "season_summer"
	| "season_winter"
	| "season_fall"
	| "season_spring"
	| "new_member"
	| "hosting_uptick";

export type QuestionKindPriority =
	| "dietary"
	| "equipment"
	| "tradition"
	| "personality";

export interface HookedQuestion {
	kind: QuestionKind;
	tier: HookedTier;
	trigger_kind: TriggerKind;
	text_template: string;             // rendered with HookDeps at ask-time
	kind_priority: QuestionKindPriority;
	options?: QuestionOption[];
	free_text_allowed: boolean;
	inferred_traits?: InferredTraitRule[];
	writes_to?: QuestionWritesTo;
}

// ─── Tier 2 — week-1 calibration ─────────────────────────────────────────────

export const TIER_2_QUESTIONS: ReadonlyArray<HookedQuestion> = [
	{
		kind: "tier_2_skipped_meal",
		tier: 2,
		trigger_kind: "skipped_meal",
		text_template: "Saw a meal didn't get cooked recently — was it the recipe, the timing, or just not feeling it?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_2_cuisine_streak",
		tier: 2,
		trigger_kind: "cuisine_streak",
		text_template: "We've leaned hard into ${dominant_cuisine} (${dominant_cuisine_streak} meals in a row) — deliberate streak or just path of least resistance?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_2_anchor_repeat",
		tier: 2,
		trigger_kind: "anchor_repeat",
		text_template: "${repeat_ingredient} has shown up ${repeat_ingredient_count} times in the last 2 weeks — is that a constant for you, or a phase you're working through?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_2_equipment_unused",
		tier: 2,
		trigger_kind: "equipment_unused",
		text_template: "Quick check on the kitchen — do you actually use the ${idle_equipment_label}? I'm avoiding recipes that lean on it until I know.",
		kind_priority: "equipment",
		free_text_allowed: true,
	},
	{
		kind: "tier_2_weekend_food",
		tier: 2,
		trigger_kind: "weekend_food",
		text_template: "What does Saturday morning food look like at your house — pancake ritual, leftovers, just coffee?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_2_takeout_night",
		tier: 2,
		trigger_kind: "takeout_night",
		text_template: "I noticed a takeout night recently — fine by me, but is that a once-a-week thing or did something specific happen?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
];

// ─── Tier 3 — month-1 depth (opportunistic) ──────────────────────────────────

export const TIER_3_QUESTIONS: ReadonlyArray<HookedQuestion> = [
	{
		kind: "tier_3_tired_night_default",
		tier: 3,
		trigger_kind: "tired_night_default",
		text_template: "When you're this kind of tired, what's the food you actually want vs what you usually settle for?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_sunday_tradition",
		tier: 3,
		trigger_kind: "sunday_morning",
		text_template: "Sunday morning question — is there a meal from when you were growing up that I should keep in rotation?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_loved_meal_followup",
		tier: 3,
		trigger_kind: "loved_meal_followup",
		text_template: "${recent_high_taste_meal_label} landed well — was it the dish, the timing, the prep amount, or the leftover potential?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_holiday_approach",
		tier: 3,
		trigger_kind: "holiday_approach",
		text_template: "${next_holiday_label} is ${days_until_next_holiday} days out — do you have your own version, or is it whatever lands on the table?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_cancel_alternative",
		tier: 3,
		trigger_kind: "cancel_alternative",
		text_template: "When you cancelled the planned meal — was there a specific dish that would have hit instead, or was it a no-cook night no matter what?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_perfect_on_paper",
		tier: 3,
		trigger_kind: "perfect_on_paper",
		text_template: "When a recipe technically nails the brief but you don't reach for it again — what was missing for you?",
		kind_priority: "personality",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_growing_up_meal",
		tier: 3,
		trigger_kind: "growing_up_meal",
		text_template: "Is there a dish from your childhood table that you'd actually want me to put in rotation — not as nostalgia, but as a real weeknight option?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_3_cook_alone_or_together",
		tier: 3,
		trigger_kind: "cook_alone_or_together",
		text_template: "Cooking — is that decompression alone time for you, or a together-time thing?",
		options: [
			{ value: "alone", label: "Alone time" },
			{ value: "together", label: "Together time" },
			{ value: "depends", label: "Depends on the day" },
		],
		kind_priority: "personality",
		free_text_allowed: false,
		inferred_traits: [
			{
				response_predicate: r => normalizeChoice(r) === "alone",
				trait_name: "solo_cook_vs_social_cook",
				delta_value: 0.0,
				delta_confidence: 0.3,
			},
			{
				response_predicate: r => normalizeChoice(r) === "together",
				trait_name: "solo_cook_vs_social_cook",
				delta_value: 1.0,
				delta_confidence: 0.3,
			},
		],
	},
	{
		kind: "tier_3_leftover_philosophy",
		tier: 3,
		trigger_kind: "leftover_philosophy",
		text_template: "On leftovers — gold (cook once, eat twice) or sad (rather start fresh)?",
		options: [
			{ value: "gold", label: "Gold — cook once, eat twice" },
			{ value: "sad", label: "Sad — rather start fresh" },
			{ value: "depends", label: "Depends on the meal" },
		],
		kind_priority: "personality",
		free_text_allowed: false,
	},
	{
		kind: "tier_3_tired_response_pattern",
		tier: 3,
		trigger_kind: "tired_response_pattern",
		text_template: "I've heard 'tired' from you a few times now — when that happens, do you want me to default to a no-cook night, a 15-minute meal, or just nudge takeout?",
		options: [
			{ value: "no_cook", label: "No-cook night (eggs / cereal / leftovers)" },
			{ value: "fifteen_min", label: "15-minute meal" },
			{ value: "takeout", label: "Just say takeout" },
		],
		kind_priority: "personality",
		free_text_allowed: false,
	},
];

// ─── Tier 4 — seasonal / life-event recalibration ────────────────────────────

export const TIER_4_QUESTIONS: ReadonlyArray<HookedQuestion> = [
	{
		kind: "tier_4_season_summer",
		tier: 4,
		trigger_kind: "season_summer",
		text_template: "Summer's coming — anything you want to lean into or avoid? (gazpacho? grill? cold noodles?)",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_4_season_winter",
		tier: 4,
		trigger_kind: "season_winter",
		text_template: "Winter's settling in — anything you want me to lean into for the cold months? (braises? stews? citrus?)",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_4_season_fall",
		tier: 4,
		trigger_kind: "season_fall",
		text_template: "Fall's rolling in — squash and braising weather. Anything specific you want me to lean into or skip?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_4_season_spring",
		tier: 4,
		trigger_kind: "season_spring",
		text_template: "Spring's arriving — peas, asparagus, herbs. Anything seasonal you want on the rotation?",
		kind_priority: "tradition",
		free_text_allowed: true,
	},
	{
		kind: "tier_4_new_member",
		tier: 4,
		trigger_kind: "new_member",
		text_template: "Got it — a new person at the table. What do they bring, dislike, or love?",
		kind_priority: "dietary",
		free_text_allowed: true,
	},
	{
		kind: "tier_4_hosting_uptick",
		tier: 4,
		trigger_kind: "hosting_uptick",
		text_template: "Looks like more people at the table lately (avg now ${avg_meal_people}) — should I default Friday/Saturday to higher headcount?",
		kind_priority: "dietary",
		free_text_allowed: true,
	},
];

// ─── Lookup helpers ──────────────────────────────────────────────────────────

const ALL_QUESTIONS: ReadonlyArray<Question> = [...TIER_0_QUESTIONS, ...TIER_1_QUESTIONS];
const ALL_HOOKED: ReadonlyArray<HookedQuestion> = [
	...TIER_2_QUESTIONS,
	...TIER_3_QUESTIONS,
	...TIER_4_QUESTIONS,
];

export function allQuestions(): ReadonlyArray<Question> {
	return ALL_QUESTIONS;
}

export function allHookedQuestions(): ReadonlyArray<HookedQuestion> {
	return ALL_HOOKED;
}

export function questionsForTier(tier: 0 | 1): ReadonlyArray<Question> {
	return tier === 0 ? TIER_0_QUESTIONS : TIER_1_QUESTIONS;
}

/**
 * Tier-aware lookup that spans all 5 tiers. Tier 0/1 returns Question; tier
 * 2/3/4 returns HookedQuestion. The scheduler iterates with this for
 * tiers 0..current_tier+1.
 */
export function getQuestionsForTier(tier: number): ReadonlyArray<Question | HookedQuestion> {
	switch (tier) {
		case 0: return TIER_0_QUESTIONS;
		case 1: return TIER_1_QUESTIONS;
		case 2: return TIER_2_QUESTIONS;
		case 3: return TIER_3_QUESTIONS;
		case 4: return TIER_4_QUESTIONS;
		default: return [];
	}
}

export function findQuestion(kind: string): Question | null {
	for (const q of ALL_QUESTIONS) if (q.kind === kind) return q;
	return null;
}

export function findHookedQuestion(kind: string): HookedQuestion | null {
	for (const q of ALL_HOOKED) if (q.kind === kind) return q;
	return null;
}

/** Returns the question (Question | HookedQuestion) for a given kind, or null. */
export function findAnyQuestion(kind: string): Question | HookedQuestion | null {
	return findQuestion(kind) || findHookedQuestion(kind);
}

export function isKnownTraitName(name: string): name is TraitName {
	return (TRAIT_NAMES as ReadonlyArray<string>).includes(name);
}

// Normalize a forced-choice response to the option value. We compare against
// both the canonical value AND the human-readable label so callers can pass
// either ("table" or "At the table"). Free-text answers fall through unchanged.
export function normalizeChoice(raw: string): string {
	if (typeof raw !== "string") return "";
	return raw.trim().toLowerCase();
}
