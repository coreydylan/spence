// Onboarding question bank — tier 0 + tier 1 (Phase A).
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
	| "tier_1_pantry_intake";

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

// ─── Lookup helpers ──────────────────────────────────────────────────────────

const ALL_QUESTIONS: ReadonlyArray<Question> = [...TIER_0_QUESTIONS, ...TIER_1_QUESTIONS];

export function allQuestions(): ReadonlyArray<Question> {
	return ALL_QUESTIONS;
}

export function questionsForTier(tier: 0 | 1): ReadonlyArray<Question> {
	return tier === 0 ? TIER_0_QUESTIONS : TIER_1_QUESTIONS;
}

export function findQuestion(kind: string): Question | null {
	for (const q of ALL_QUESTIONS) if (q.kind === kind) return q;
	return null;
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
