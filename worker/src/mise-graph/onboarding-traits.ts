// Onboarding Phase B — read-only trait introspection.
//
// `getTraits` returns the canonical 7-dimension personality cache for a
// household, optionally enriched with human-readable descriptions explaining
// what each {value, confidence} pair signals. Phase B's compose context, the
// daily brief, and any UI that reveals "what the agent thinks of you" all
// route through here.
//
// Traits not yet present in mise_household_traits return as defaults
// (value=0.5, confidence=0, evidence_count=0) so the caller always sees the
// full 7-row roster. This keeps downstream consumers from having to special-
// case "trait hasn't been observed yet."

import type { MiseGraphEnv } from "./types";
import { listTraits, type Trait } from "./onboarding";
import { TRAIT_NAMES, type TraitName } from "./onboarding-questions";

// ─── Public types ──────────────────────────────────────────────────────────

export interface TraitView {
	trait_name: TraitName;
	value: number;
	confidence: number;
	evidence_count: number;
	last_evidence_at_ms: number;
	description?: string;
}

export interface GetTraitsInput {
	household_id: string;
	with_descriptions?: boolean;
}

export interface GetTraitsResult {
	traits: TraitView[];
}

// ─── Description map (the 7 dimensions) ────────────────────────────────────

interface DimensionLabels {
	low: string;       // value 0.0
	high: string;      // value 1.0
	low_summary: string;
	mid_summary: string;
	high_summary: string;
}

const DIMENSION_LABELS: Record<TraitName, DimensionLabels> = {
	precision_vs_improvisation: {
		low: "precision",
		high: "improvisation",
		low_summary: "leans toward precision: follows recipes exactly, measures, asks before subbing",
		mid_summary: "balanced / undetermined between precision and improvisation",
		high_summary: "leans toward improvisation: 'I'll figure it out,' frequent subs, recipe-as-vibe",
	},
	ritual_vs_refueling: {
		low: "ritual",
		high: "refueling",
		low_summary: "leans toward ritual: dinner is a moment, eats at the table, slow cooks",
		mid_summary: "balanced / undetermined between ritual and refueling",
		high_summary: "leans toward refueling: dinner is fuel, fast plates, eats at the desk or TV",
	},
	comfort_vs_adventure: {
		low: "comfort",
		high: "adventure",
		low_summary: "leans toward comfort: same beloved dishes on rotation, low novelty appetite",
		mid_summary: "balanced / undetermined between comfort and adventure",
		high_summary: "leans toward adventure: always something new, pushes for novelty",
	},
	solo_cook_vs_social_cook: {
		low: "solo cook",
		high: "social cook",
		low_summary: "leans toward solo cook: cooking is alone time, no brigade",
		mid_summary: "balanced / undetermined between solo and social cooking",
		high_summary: "leans toward social cook: cooking is together time, brigade-friendly",
	},
	quick_vs_project: {
		low: "quick",
		high: "project",
		low_summary: "leans toward quick: weeknight 20-min rule, low active-cook tolerance",
		mid_summary: "balanced / undetermined between quick and project cooking",
		high_summary: "leans toward project: no time pressure, accepts long cooks",
	},
	pantry_first_vs_shop_fresh: {
		low: "pantry-first",
		high: "shop-fresh",
		low_summary: "leans toward pantry-first: plans from what's already there",
		mid_summary: "balanced / undetermined between pantry-first and shop-fresh planning",
		high_summary: "leans toward shop-fresh: plans from the market, light pantry footprint",
	},
	equipment_rich_vs_minimalist: {
		low: "equipment-rich",
		high: "minimalist",
		low_summary: "leans toward equipment-rich: 30+ gadgets, format diversity easy",
		mid_summary: "balanced / undetermined between equipment-rich and minimalist",
		high_summary: "leans toward minimalist: one knife, one pan, narrow format set",
	},
};

const LOW_THRESHOLD = 0.3;
const HIGH_THRESHOLD = 0.7;
const PRELIM_CONFIDENCE = 0.3;

/**
 * Render the human-readable description for a trait observation.
 *
 *   value 0.0..0.3 → low_summary   ("leans toward [low label]")
 *   value 0.3..0.7 → mid_summary   ("balanced / undetermined")
 *   value 0.7..1.0 → high_summary  ("leans toward [high label]")
 *
 * Confidence < 0.3 prefixes with "preliminary signal:" to signal the caller
 * shouldn't over-index on an under-evidenced trait.
 */
export function describeTrait(trait_name: TraitName, value: number, confidence: number): string {
	const labels = DIMENSION_LABELS[trait_name];
	if (!labels) return "";
	let body: string;
	if (value <= LOW_THRESHOLD) body = labels.low_summary;
	else if (value >= HIGH_THRESHOLD) body = labels.high_summary;
	else body = labels.mid_summary;
	const prelim = confidence < PRELIM_CONFIDENCE;
	return prelim ? `preliminary signal: ${body}` : body;
}

// ─── Read API ──────────────────────────────────────────────────────────────

export async function getTraits(
	env: MiseGraphEnv,
	input: GetTraitsInput,
): Promise<GetTraitsResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("getTraits: household_id required");
	const withDescriptions = !!input.with_descriptions;

	const persisted = await listTraits(env, household_id);
	const persistedByName = new Map<TraitName, Trait>();
	for (const t of persisted) persistedByName.set(t.trait_name, t);

	const out: TraitView[] = [];
	for (const name of TRAIT_NAMES) {
		const row = persistedByName.get(name);
		const value = row ? row.trait_value : 0.5;
		const confidence = row ? row.confidence : 0;
		const evidence_count = row ? row.evidence_count : 0;
		const last_evidence_at_ms = row ? row.last_evidence_at_ms : 0;
		const view: TraitView = {
			trait_name: name,
			value,
			confidence,
			evidence_count,
			last_evidence_at_ms,
		};
		if (withDescriptions) view.description = describeTrait(name, value, confidence);
		out.push(view);
	}
	return { traits: out };
}
