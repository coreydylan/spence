// Onboarding Phase D — multi-member trait spread analyzer.
//
// Phase A's trait inference cached one row per (household_id, trait_name)
// in mise_household_traits — household-level only (member_id NULL). Phase B
// (parallel) is expected to start inserting per-member rows as the
// observation pipeline picks up per-person signals (e.g. who actually ate
// the cabbage dish, who skipped Tuesday).
//
// This module reads BOTH shapes — household-level and per-member — and
// reduces them into a TraitSpread per trait. The scheduler / compose-time
// hook can then ask: "do these humans agree on adventure-vs-comfort, or
// do we need to alternate / split the dishes?"
//
// Spread categories:
//   * "uncalibrated"  — confidence < 0.2 OR fewer than 2 members tracked.
//                       The household-level value is the only signal.
//   * "aligned"       — divergence ≤ 0.4 across members (and confidence ≥0.2
//                       for at least 2 members).
//   * "diverging"     — divergence > 0.4. The compose prompt should call
//                       this out to the LLM agent so it knows to alternate
//                       or split the dishes.
//
// Divergence is computed as `max(value) - min(value)` across known members
// (clamped to [0,1]). 0 = identical; 1 = diametrically opposed.
//
// The exposed MCP tool `household_get_trait_spread` returns the array of
// spreads for the household. plan-world-mcp.ts wires the dispatch.

import type { MiseGraphEnv } from "./types";
import { TRAIT_NAMES, isKnownTraitName, type TraitName } from "./onboarding-questions";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TraitSpreadStatus = "aligned" | "diverging" | "uncalibrated";

export interface MemberTraitView {
	member_id: string;
	value: number;
	confidence: number;
}

export interface TraitSpread {
	trait_name: TraitName;
	household_value: number;            // mean across known members (or household-level if no members)
	household_confidence: number;        // mean confidence — bounded [0,1]
	member_values: MemberTraitView[];    // empty when only household-level data exists
	divergence: number;                  // max - min across member_values; 0 if <2 members
	status: TraitSpreadStatus;
	description: string;                 // human-readable summary for compose prompt
}

interface TraitRow {
	household_id: string;
	trait_name: string;
	member_id: string | null;
	trait_value: number;
	confidence: number;
	last_evidence_at_ms: number;
	evidence_count: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

const DIVERGENCE_THRESHOLD = 0.4;
const MIN_CONFIDENCE_FOR_CALIBRATED = 0.2;

/**
 * Get the trait spread for a household. One TraitSpread per trait_name
 * tracked in mise_household_traits (typically all 7 dimensions). If a trait
 * has zero rows, it's omitted — the scheduler decides whether that's a
 * "go ask the user" signal.
 */
export async function getHouseholdTraitSpread(
	env: MiseGraphEnv,
	household_id: string,
): Promise<TraitSpread[]> {
	const id = (household_id || "").trim();
	if (!id) return [];

	const rows = await loadAllTraits(env, id);
	if (rows.length === 0) return [];

	// Optional: pull the human display names for members so the description
	// reads naturally ("Corey leans comfort"). Falls back to the member_id
	// itself when names aren't available.
	const memberNames = await loadMemberNames(env, id);

	const byTrait = new Map<string, TraitRow[]>();
	for (const row of rows) {
		if (!isKnownTraitName(row.trait_name)) continue;
		const list = byTrait.get(row.trait_name) ?? [];
		list.push(row);
		byTrait.set(row.trait_name, list);
	}

	const spreads: TraitSpread[] = [];
	for (const trait of TRAIT_NAMES) {
		const list = byTrait.get(trait) || [];
		if (list.length === 0) continue;
		spreads.push(buildSpread(trait, list, memberNames));
	}
	return spreads;
}

// ─── Spread calculation ─────────────────────────────────────────────────────

function buildSpread(
	trait: TraitName,
	rows: TraitRow[],
	memberNames: Map<string, string>,
): TraitSpread {
	const memberRows = rows.filter(r => r.member_id !== null && r.member_id !== "");
	const householdRow = rows.find(r => r.member_id === null || r.member_id === "");

	const member_values: MemberTraitView[] = memberRows.map(r => ({
		member_id: r.member_id || "",
		value: clamp01(r.trait_value),
		confidence: clamp01(r.confidence),
	}));

	let household_value: number;
	let household_confidence: number;

	if (member_values.length >= 1) {
		const sum = member_values.reduce((acc, m) => acc + m.value, 0);
		const conf = member_values.reduce((acc, m) => acc + m.confidence, 0);
		household_value = round3(sum / member_values.length);
		household_confidence = round3(conf / member_values.length);
	} else if (householdRow) {
		household_value = round3(clamp01(householdRow.trait_value));
		household_confidence = round3(clamp01(householdRow.confidence));
	} else {
		// Defensive — list is non-empty so this is unreachable.
		household_value = 0.5;
		household_confidence = 0;
	}

	let divergence = 0;
	if (member_values.length >= 2) {
		let min = 1;
		let max = 0;
		for (const m of member_values) {
			if (m.value < min) min = m.value;
			if (m.value > max) max = m.value;
		}
		divergence = round3(Math.max(0, max - min));
	}

	const calibrated = householdRow
		? clamp01(householdRow.confidence) >= MIN_CONFIDENCE_FOR_CALIBRATED
		: member_values.some(m => m.confidence >= MIN_CONFIDENCE_FOR_CALIBRATED);

	let status: TraitSpreadStatus;
	if (member_values.length < 2 || !calibrated) {
		status = "uncalibrated";
	} else if (divergence > DIVERGENCE_THRESHOLD) {
		status = "diverging";
	} else {
		status = "aligned";
	}

	const description = describeSpread(trait, status, household_value, member_values, divergence, memberNames);

	return {
		trait_name: trait,
		household_value,
		household_confidence,
		member_values,
		divergence,
		status,
		description,
	};
}

// ─── Description rendering ──────────────────────────────────────────────────

interface TraitPole {
	low: string;     // toward 0
	high: string;    // toward 1
}

const TRAIT_POLES: Record<TraitName, TraitPole> = {
	precision_vs_improvisation: { low: "precision", high: "improvisation" },
	ritual_vs_refueling:        { low: "ritual",    high: "refueling" },
	comfort_vs_adventure:       { low: "comfort",   high: "adventure" },
	solo_cook_vs_social_cook:   { low: "solo cook", high: "social cook" },
	quick_vs_project:           { low: "quick",     high: "project cooking" },
	pantry_first_vs_shop_fresh: { low: "pantry-first", high: "shop-fresh" },
	equipment_rich_vs_minimalist: { low: "equipment-rich", high: "minimalist" },
};

function describeSpread(
	trait: TraitName,
	status: TraitSpreadStatus,
	household_value: number,
	member_values: MemberTraitView[],
	divergence: number,
	memberNames: Map<string, string>,
): string {
	const poles = TRAIT_POLES[trait];
	if (status === "uncalibrated") {
		if (member_values.length === 0) {
			return `${trait}: not enough evidence to call (household-level only).`;
		}
		return `${trait}: not enough confidence yet to read members apart.`;
	}
	if (status === "aligned") {
		const lean = household_value < 0.5 ? poles.low : poles.high;
		return `${trait}: aligned — household leans ${lean} (avg ${household_value.toFixed(2)}).`;
	}
	// diverging
	const sorted = [...member_values].sort((a, b) => a.value - b.value);
	const lowest = sorted[0];
	const highest = sorted[sorted.length - 1];
	const lowName = memberNames.get(lowest.member_id) || lowest.member_id || "Member A";
	const highName = memberNames.get(highest.member_id) || highest.member_id || "Member B";
	return `${trait}: ${lowName} leans ${poles.low} (${lowest.value.toFixed(2)}), ` +
		`${highName} leans ${poles.high} (${highest.value.toFixed(2)}). ` +
		`Try alternating or splitting the dishes.`;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function loadAllTraits(env: MiseGraphEnv, household_id: string): Promise<TraitRow[]> {
	const out: TraitRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT household_id, trait_name, member_id, trait_value, confidence,
				last_evidence_at_ms, evidence_count
			 FROM mise_household_traits
			 WHERE household_id = ?
			 ORDER BY trait_name ASC`,
		).bind(household_id).all<TraitRow>();
		for (const r of result.results || []) {
			if (!r || typeof r.trait_name !== "string") continue;
			out.push({
				household_id: r.household_id,
				trait_name: r.trait_name,
				member_id: r.member_id ?? null,
				trait_value: typeof r.trait_value === "number" ? r.trait_value : 0.5,
				confidence: typeof r.confidence === "number" ? r.confidence : 0,
				last_evidence_at_ms: typeof r.last_evidence_at_ms === "number" ? r.last_evidence_at_ms : 0,
				evidence_count: typeof r.evidence_count === "number" ? r.evidence_count : 0,
			});
		}
	} catch {
		// Traits table missing.
	}
	return out;
}

async function loadMemberNames(env: MiseGraphEnv, household_id: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const result = await env.DB.prepare(
			`SELECT member_id, display_name FROM mise_household_members
			 WHERE household_id = ?`,
		).bind(household_id).all<{ member_id: string; display_name: string }>();
		for (const r of result.results || []) {
			if (r && typeof r.member_id === "string" && typeof r.display_name === "string") {
				out.set(r.member_id, r.display_name);
			}
		}
	} catch {
		// Members table missing.
	}
	return out;
}

// ─── Math helpers ───────────────────────────────────────────────────────────

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

function round3(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.round(v * 1000) / 1000;
}
