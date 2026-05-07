// Household signals — onboarding-collected personality + state, packaged for
// the LLM compose pipeline.
//
// Onboarding now captures a LOT: 7 personality dimensions
// (mise_household_traits), traditions (mise_household_traditions), pantry
// inventory (mise_kitchen_inventory), equipment (mise_equipment_definitions),
// and per-member dietary/preferences (mise_household_members). Until now, the
// composer had no easy way to absorb that signal — the agent could call each
// individual read tool, but the personality summary in particular needed
// rendering. This module is the integration point.
//
// `buildHouseholdSignals(env, household_id)` aggregates everything into a
// single compact bundle (<5KB typical) the composer prompt can grok in one
// turn. The most load-bearing field is `personality.summary` — a
// natural-language sentence rendered from the 7 trait dimensions. Examples:
//
//   "This household is precise, ritual-leaning, and adventurous — they cook
//    from recipes but love new cuisines. Weeknight cook windows are tight
//    (quick-cook leaning)."
//
//   "Still calibrating; preliminary signal: ritual-leaning at the table."
//
// The render rules (described in detail by `renderPersonalitySummary` below):
//   * Skip dimensions where confidence < 0.15 (under-evidenced).
//   * If NO dimension has confidence >= 0.15, return a "still calibrating"
//     stub that names the strongest preliminary lean (if any).
//   * Otherwise: build clauses for every dimension with conf >= 0.15 whose
//     value lives in the low (≤0.3) or high (≥0.7) band; mid-band traits
//     are deliberately omitted (they don't push the menu).
//
// `member_spread_guidance` is a one-line description rendered from the most
// divergent trait spread (using the existing onboarding-trait-spread reader).
// Null when no trait diverges OR when traits aren't yet calibrated for ≥2
// members. The composer can drop this into a meal's `notes` so the next
// downstream consumer (e.g. the meal-detail LLM) sees the suggestion.

import type { MiseGraphEnv } from "./types";
import { listMembers, type HouseholdMember } from "./household-members";
import { listInventory, type KitchenItem } from "./kitchen-inventory";
import { listEquipment } from "./equipment";
import { categorizeName } from "./onboarding-bulk";
import { getTraits, type TraitView } from "./onboarding-traits";
import { getHouseholdTraitSpread, type TraitSpread } from "./onboarding-trait-spread";
import type { TraitName } from "./onboarding-questions";

// ─── Public types ──────────────────────────────────────────────────────────

export interface HouseholdSignalDimension {
	trait_name: TraitName;
	value: number;
	confidence: number;
	label: string;             // short human-readable lean ("leans toward ritual")
}

export interface HouseholdSignalPersonality {
	summary: string;
	dimensions: HouseholdSignalDimension[];
}

export interface HouseholdSignalTradition {
	name: string;
	cadence: string;
	description?: string;
	must_include?: string[];
}

export interface HouseholdSignalPantryGroup {
	category: string;
	items: string[];           // top items in this category (canonical names)
}

export interface HouseholdSignalAvoidances {
	dietary: string[];
	allergies: string[];
	dislikes: string[];
}

export interface HouseholdSignals {
	household_id: string;
	generated_at_ms: number;
	personality: HouseholdSignalPersonality;
	traditions: HouseholdSignalTradition[];
	pantry_top: HouseholdSignalPantryGroup[];
	equipment_available: string[];
	avoidances: HouseholdSignalAvoidances;
	member_spread_guidance: string | null;
}

export interface BuildHouseholdSignalsOptions {
	include_personality?: boolean;     // default true
	include_traditions?: boolean;      // default true
	include_pantry?: boolean;          // default true
	include_equipment?: boolean;       // default true
	pantry_per_category_limit?: number; // default 10
	equipment_limit?: number;          // default 50
	traditions_limit?: number;         // default 20
}

// ─── Tunables for personality rendering ────────────────────────────────────

const MIN_CONFIDENCE = 0.15;       // skip dimensions less confident than this
const LOW_BAND = 0.3;              // value ≤ LOW_BAND → low pole
const HIGH_BAND = 0.7;             // value ≥ HIGH_BAND → high pole
const PRELIM_CONFIDENCE = 0.3;     // < this → "preliminary signal" tone

// Per-trait clause fragments for the composed personality.summary sentence.
// Each pole gets a short adjective (used in commas-and-and lists) AND a
// longer phrase (used as a tail clause when the trait deserves emphasis).
interface TraitRenderSpec {
	low_adjective: string;
	high_adjective: string;
	low_clause: string;        // tail clause when the trait is the primary signal
	high_clause: string;
}

const TRAIT_RENDER: Record<TraitName, TraitRenderSpec> = {
	precision_vs_improvisation: {
		low_adjective: "precise",
		high_adjective: "improvisational",
		low_clause: "they cook from recipes",
		high_clause: "they freestyle and sub freely",
	},
	ritual_vs_refueling: {
		low_adjective: "ritual-leaning",
		high_adjective: "refueling-leaning",
		low_clause: "dinner is a moment, eaten at the table",
		high_clause: "dinner is fuel, eaten on the move",
	},
	comfort_vs_adventure: {
		low_adjective: "comfort-leaning",
		high_adjective: "adventurous",
		low_clause: "they rotate beloved dishes",
		high_clause: "they love new cuisines",
	},
	solo_cook_vs_social_cook: {
		low_adjective: "solo-cook",
		high_adjective: "social-cook",
		low_clause: "cooking is alone time",
		high_clause: "cooking is a brigade activity",
	},
	quick_vs_project: {
		low_adjective: "quick-cook leaning",
		high_adjective: "project-cook leaning",
		low_clause: "weeknight cook windows are tight",
		high_clause: "they accept long, multi-stage cooks",
	},
	pantry_first_vs_shop_fresh: {
		low_adjective: "pantry-first",
		high_adjective: "shop-fresh",
		low_clause: "they plan from what's already on the shelf",
		high_clause: "they plan from the market",
	},
	equipment_rich_vs_minimalist: {
		low_adjective: "equipment-rich",
		high_adjective: "minimalist-kitchen",
		low_clause: "they have the gear for any format",
		high_clause: "they keep it to one pan, one knife",
	},
};

// Short label rendered into HouseholdSignalDimension.label. Mirrors the
// describeTrait shape but keeps it terse — the LLM gets richer context from
// personality.summary.
function shortLabel(trait_name: TraitName, value: number): string {
	const spec = TRAIT_RENDER[trait_name];
	if (!spec) return "balanced";
	if (value <= LOW_BAND) return `leans ${spec.low_adjective}`;
	if (value >= HIGH_BAND) return `leans ${spec.high_adjective}`;
	return "balanced";
}

// ─── Public entrypoint ─────────────────────────────────────────────────────

export async function buildHouseholdSignals(
	env: MiseGraphEnv,
	household_id: string,
	options: BuildHouseholdSignalsOptions = {},
): Promise<HouseholdSignals> {
	const id = (household_id || "").trim();
	if (!id) throw new Error("buildHouseholdSignals: household_id required");

	const includePersonality = options.include_personality !== false;
	const includeTraditions = options.include_traditions !== false;
	const includePantry = options.include_pantry !== false;
	const includeEquipment = options.include_equipment !== false;
	const pantryPerCategory = clampPositiveInt(options.pantry_per_category_limit, 10);
	const equipmentLimit = clampPositiveInt(options.equipment_limit, 50);
	const traditionsLimit = clampPositiveInt(options.traditions_limit, 20);

	const [
		traitsResult,
		spreads,
		traditions,
		pantry,
		equipment,
		members,
	] = await Promise.all([
		includePersonality
			? getTraits(env, { household_id: id, with_descriptions: false })
			: Promise.resolve({ traits: [] as TraitView[] }),
		includePersonality
			? getHouseholdTraitSpread(env, id).catch(() => [] as TraitSpread[])
			: Promise.resolve([] as TraitSpread[]),
		includeTraditions
			? loadTraditions(env, id, traditionsLimit)
			: Promise.resolve([] as HouseholdSignalTradition[]),
		includePantry
			? listInventory(env, id).catch(() => [] as KitchenItem[])
			: Promise.resolve([] as KitchenItem[]),
		includeEquipment
			? listEquipment(env, id).catch(() => [] as Awaited<ReturnType<typeof listEquipment>>)
			: Promise.resolve([] as Awaited<ReturnType<typeof listEquipment>>),
		listMembers(env, id).catch(() => [] as HouseholdMember[]),
	]);

	const personality = includePersonality
		? buildPersonality(traitsResult.traits)
		: { summary: "", dimensions: [] as HouseholdSignalDimension[] };

	const pantry_top = includePantry ? groupPantry(pantry, pantryPerCategory) : [];
	const equipment_available = includeEquipment
		? equipment.map(e => e.slug).filter(Boolean).slice(0, equipmentLimit)
		: [];
	const avoidances = aggregateAvoidances(members);
	const member_spread_guidance = pickSpreadGuidance(spreads);

	return {
		household_id: id,
		generated_at_ms: Date.now(),
		personality,
		traditions,
		pantry_top,
		equipment_available,
		avoidances,
		member_spread_guidance,
	};
}

// ─── Personality rendering ─────────────────────────────────────────────────

interface RenderPick {
	trait_name: TraitName;
	value: number;
	confidence: number;
	pole: "low" | "high";
	adjective: string;
	clause: string;
}

function buildPersonality(traits: TraitView[]): HouseholdSignalPersonality {
	const dimensions: HouseholdSignalDimension[] = traits.map(t => ({
		trait_name: t.trait_name,
		value: round3(t.value),
		confidence: round3(t.confidence),
		label: shortLabel(t.trait_name, t.value),
	}));
	const summary = renderPersonalitySummary(traits);
	return { summary, dimensions };
}

/**
 * Render the 7-trait personality cache into a single sentence the LLM can
 * absorb in one beat.
 *
 * Rules (load-bearing — repeat in HOUSEHOLD_SIGNALS_REPORT.md):
 *
 * 1. Pick traits with confidence >= MIN_CONFIDENCE (0.15) AND value in a
 *    decisive band (<= 0.3 or >= 0.7). These are the "the household clearly
 *    leans X" signals.
 * 2. If at least one passes: build adjective list for traits 0..N-1
 *    ("precise, ritual-leaning, and adventurous"), then a tail clause for
 *    the most decisive 1-2 traits ("they cook from recipes but love new
 *    cuisines. Weeknight cook windows are tight (quick-cook leaning).").
 *    Returns a complete sentence.
 * 3. If none pass: fall back to "Still calibrating;" plus the strongest
 *    preliminary lean (highest confidence among low-confidence traits, if
 *    any has confidence > 0). If everything is at default (confidence 0),
 *    return a generic "Still calibrating; no personality signal yet."
 */
export function renderPersonalitySummary(traits: TraitView[]): string {
	const decisive: RenderPick[] = [];
	for (const t of traits) {
		if (!Number.isFinite(t.value) || !Number.isFinite(t.confidence)) continue;
		if (t.confidence < MIN_CONFIDENCE) continue;
		const spec = TRAIT_RENDER[t.trait_name];
		if (!spec) continue;
		if (t.value <= LOW_BAND) {
			decisive.push({
				trait_name: t.trait_name,
				value: t.value,
				confidence: t.confidence,
				pole: "low",
				adjective: spec.low_adjective,
				clause: spec.low_clause,
			});
		} else if (t.value >= HIGH_BAND) {
			decisive.push({
				trait_name: t.trait_name,
				value: t.value,
				confidence: t.confidence,
				pole: "high",
				adjective: spec.high_adjective,
				clause: spec.high_clause,
			});
		}
	}

	if (decisive.length === 0) {
		return renderPreliminaryFallback(traits);
	}

	// Sort by descending confidence so the most-evidenced traits lead the
	// adjective list and pick the tail clause.
	decisive.sort((a, b) => b.confidence - a.confidence);

	const adjectives = decisive.map(p => p.adjective);
	const adjPhrase = joinList(adjectives);

	// Tail clause: the single most-confident pick gets a clause; if there's a
	// second pick with confidence >= PRELIM_CONFIDENCE, append it too with a
	// connector. Keeps the sentence from getting unwieldy.
	const head = decisive[0];
	const second = decisive[1];
	const includeSecondClause = !!second && second.confidence >= PRELIM_CONFIDENCE;
	let tail = `${head.clause}`;
	if (includeSecondClause) {
		tail += ` and ${second.clause}`;
	}
	tail += ".";

	const preliminary = head.confidence < PRELIM_CONFIDENCE;
	const lead = preliminary
		? `Preliminary read — this household is ${adjPhrase}`
		: `This household is ${adjPhrase}`;
	return `${lead} — ${tail}`;
}

function renderPreliminaryFallback(traits: TraitView[]): string {
	const candidates = traits
		.filter(t => Number.isFinite(t.confidence) && t.confidence > 0)
		.filter(t => Number.isFinite(t.value) && (t.value <= LOW_BAND || t.value >= HIGH_BAND))
		.sort((a, b) => b.confidence - a.confidence);
	if (candidates.length === 0) {
		return "Still calibrating; no personality signal yet.";
	}
	const top = candidates[0];
	const spec = TRAIT_RENDER[top.trait_name];
	if (!spec) return "Still calibrating; no personality signal yet.";
	const adjective = top.value <= LOW_BAND ? spec.low_adjective : spec.high_adjective;
	return `Still calibrating; preliminary signal: ${adjective} at the table.`;
}

function joinList(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ─── Pantry grouping ───────────────────────────────────────────────────────

function groupPantry(items: KitchenItem[], perCategoryLimit: number): HouseholdSignalPantryGroup[] {
	const buckets = new Map<string, string[]>();
	for (const item of items) {
		const name = (item.canonical_name || "").trim();
		if (!name) continue;
		const category = categorizeName(name);
		const bucket = buckets.get(category) ?? [];
		// Avoid duplicates within a category (case-insensitive).
		if (!bucket.some(existing => existing.toLowerCase() === name.toLowerCase())) {
			bucket.push(name);
		}
		buckets.set(category, bucket);
	}
	const out: HouseholdSignalPantryGroup[] = [];
	// Stable category order: pantry, produce, fruit, protein, dairy, grains,
	// then anything else alphabetically.
	const preferredOrder = ["pantry", "produce", "fruit", "protein", "dairy", "grains"];
	const seen = new Set<string>();
	for (const cat of preferredOrder) {
		const bucket = buckets.get(cat);
		if (!bucket || bucket.length === 0) continue;
		out.push({ category: cat, items: bucket.slice(0, perCategoryLimit) });
		seen.add(cat);
	}
	for (const [cat, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (seen.has(cat)) continue;
		if (bucket.length === 0) continue;
		out.push({ category: cat, items: bucket.slice(0, perCategoryLimit) });
	}
	return out;
}

// ─── Avoidances ────────────────────────────────────────────────────────────

function aggregateAvoidances(members: HouseholdMember[]): HouseholdSignalAvoidances {
	const dietary = new Set<string>();
	const allergies = new Set<string>();
	const dislikes = new Set<string>();
	for (const m of members) {
		for (const d of m.dietary || []) {
			const v = (d || "").trim();
			if (v) dietary.add(v.toLowerCase());
		}
		for (const a of m.preferences?.allergies || []) {
			const v = (a || "").trim();
			if (v) allergies.add(v.toLowerCase());
		}
		for (const d of m.preferences?.dislikes || []) {
			const v = (d || "").trim();
			if (v) dislikes.add(v.toLowerCase());
		}
	}
	return {
		dietary: [...dietary].sort(),
		allergies: [...allergies].sort(),
		dislikes: [...dislikes].sort(),
	};
}

// ─── Spread guidance ───────────────────────────────────────────────────────

/**
 * From the full TraitSpread[], pick the description for the single most
 * divergent diverging spread. Returns null when nothing diverges (aligned or
 * uncalibrated across the board).
 */
function pickSpreadGuidance(spreads: TraitSpread[]): string | null {
	const diverging = spreads.filter(s => s.status === "diverging");
	if (diverging.length === 0) return null;
	diverging.sort((a, b) => b.divergence - a.divergence);
	return diverging[0].description;
}

// ─── Traditions loader ─────────────────────────────────────────────────────

interface TraditionRow {
	tradition_id: string;
	household_id: string;
	name: string;
	cadence: string;
	description: string | null;
	must_include_ingredients_json: string | null;
	must_include_format: string | null;
	origin_note: string | null;
	active: number;
	created_at_ms: number;
}

async function loadTraditions(
	env: MiseGraphEnv,
	household_id: string,
	limit: number,
): Promise<HouseholdSignalTradition[]> {
	try {
		const result = await env.DB.prepare(
			`SELECT tradition_id, household_id, name, cadence, description,
				must_include_ingredients_json, must_include_format, origin_note,
				active, created_at_ms
			 FROM mise_household_traditions
			 WHERE household_id = ? AND active = 1
			 ORDER BY created_at_ms ASC
			 LIMIT ?`,
		).bind(household_id, limit).all<TraditionRow>();
		const out: HouseholdSignalTradition[] = [];
		for (const r of result.results || []) {
			if (!r || typeof r.name !== "string" || typeof r.cadence !== "string") continue;
			const tradition: HouseholdSignalTradition = {
				name: r.name,
				cadence: r.cadence,
			};
			if (r.description) tradition.description = r.description;
			const must = parseStringArray(r.must_include_ingredients_json);
			if (must.length > 0) tradition.must_include = must;
			out.push(tradition);
		}
		return out;
	} catch {
		return [];
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string");
		}
		return [];
	} catch {
		return [];
	}
}

function clampPositiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function round3(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.round(v * 1000) / 1000;
}
