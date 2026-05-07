// Pantry pressure — real pantry awareness with expiration urgency.
//
// The mise-graph composer was previously fed only a flat list of pantry NAMES.
// That left huge signal on the table: which lots expire inside the plan window
// (compose around them!), which jars have been open too long (use them or lose
// them), which staples are abundant vs. depleted.
//
// loadPantryPressure() reads mise_pantry_lots for a household, classifies each
// lot's urgency against the plan-date window, and emits a compact context
// bundle that the composer-context loader passes to the menu-composer LLM.
//
// Storage decay assumptions are drawn from public food-safety guidance
// (USDA FoodKeeper, StillTasty, manufacturer guidelines). They are *defaults*
// applied only when a lot has no best_until / safe_until set; an explicit row
// value always wins. See OPENED_DECAY_DAYS below for sources.

import type { MiseGraphEnv } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PantryLot {
	id: string;
	household_id: string;
	canonical_name: string;
	storage_location: string | null; // pantry | fridge | freezer | counter
	quantity: number | null;
	unit: string | null;
	grams: number | null;
	opened_at: string | null;
	best_until: string | null;
	safe_until: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string | null;
}

export interface AddPantryLotInput {
	id?: string;
	household_id: string;
	canonical_name: string;
	storage_location?: string | null;
	quantity?: number | null;
	unit?: string | null;
	grams?: number | null;
	opened_at?: string | null;
	best_until?: string | null;
	safe_until?: string | null;
	notes?: string | null;
	meta?: Record<string, unknown>;
}

export type PantryUrgency = "critical" | "high" | "medium" | "low";

export interface PantryExpiringInWindow {
	name: string;
	qty: number | null;
	unit: string | null;
	days_until_expiry: number;
	suggested_use_by: string;
	urgency: PantryUrgency;
	storage_location: string | null;
	lot_id: string;
}

export interface PantryExpiringAfterWindow {
	name: string;
	days_until_expiry: number;
	storage_location: string | null;
}

export interface PantryOpenedPerishable {
	name: string;
	opened_days_ago: number;
	urgency: PantryUrgency;
	expected_open_window_days: number;
	storage_location: string | null;
	lot_id: string;
}

export interface PantryPressureContext {
	expiring_within_window: PantryExpiringInWindow[];
	expiring_after_window: PantryExpiringAfterWindow[];
	opened_perishable: PantryOpenedPerishable[];
	fresh_pantry_summary: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Opened-item decay defaults (days after opening, refrigerated unless noted).
//
// These are pragmatic kitchen heuristics — when a row has best_until /
// safe_until set we always defer to it. These only fire when a lot has been
// marked opened_at but has no explicit expiry.
//
// Sources:
//   - USDA FoodKeeper app (foodsafety.gov/keep-food-safe/foodkeeper-app)
//   - StillTasty.com (consumer guidance compiled from FDA/USDA refs)
//   - Manufacturer labels for packaged condiments (Kewpie, Marukome, etc.)
// ---------------------------------------------------------------------------
const OPENED_DECAY_DAYS: Record<string, number> = {
	// Fresh herbs (whole, refrigerated, in damp paper towel) ~ 7d unopened;
	// once "opened"/un-bagged the clock is short.
	"cilantro": 7,
	"parsley": 7,
	"mint": 7,
	"basil": 5,             // basil hates the cold — 5d is generous
	"dill": 5,
	"chives": 7,
	"tarragon": 7,
	"scallion": 10,
	"green onion": 10,

	// Pre-chopped herbs decay much faster — caller can pass canonical_name
	// "cilantro_chopped" or note it on the row; we treat as 2d default.
	"cilantro_chopped": 2,
	"parsley_chopped": 2,
	"mint_chopped": 2,

	// Dairy
	"milk": 7,                // opened gallon
	"heavy cream": 7,
	"yogurt": 14,
	"butter": 30,
	"cream cheese": 14,

	// Eggs (opened carton kept cold) — USDA: 3-5 weeks from purchase
	"eggs": 28,

	// Pastes / fermented condiments (refrigerated after opening)
	"miso": 180,              // ~6 months refrigerated
	"tahini": 180,            // ~6 months refrigerated, halva fat splits sooner
	"hummus": 7,
	"mayonnaise": 60,         // opened jar, refrigerated
	"mustard": 365,
	"ketchup": 180,
	"soy sauce": 365,
	"fish sauce": 365,
	"gochujang": 180,
	"harissa": 90,
	"pesto": 7,
	"olive tapenade": 14,

	// Pickles / jars in vinegar brine
	"pickles": 90,
	"capers": 365,
	"olives": 60,
	"kimchi": 180,            // continues to ferment
	"sauerkraut": 180,

	// Oils & nut butters (opened, room temp unless noted)
	"olive oil": 90,          // opened, away from light & heat
	"toasted sesame oil": 180,
	"peanut butter": 90,
	"almond butter": 60,

	// Nuts & seeds (opened bag, sealed) — go rancid faster than you'd think
	"almonds": 90,
	"walnuts": 60,            // high PUFA, oxidize fast
	"pecans": 60,
	"cashews": 90,
	"pistachios": 90,
	"sesame seeds": 60,
	"pumpkin seeds": 60,
	"sunflower seeds": 60,
	"toasted nuts": 30,       // any toasted nut, rancidity accelerates

	// Dry goods (opened) — pests/rancidity rather than spoilage
	"flour": 240,             // ~8 months, all-purpose, sealed
	"whole wheat flour": 90,  // bran oils oxidize
	"rice": 365,              // white rice; brown is ~180
	"brown rice": 180,
	"oats": 240,
	"pasta": 730,             // 2y, very stable
	"sugar": 730,
	"salt": 1825,             // basically forever

	// Spices ground (lose potency rather than spoil) — flag at 180
	"ground cumin": 180,
	"ground coriander": 180,
	"paprika": 180,
	"black pepper": 365,       // whole peppercorns much longer
	"cinnamon": 365,

	// Protein
	"tofu": 5,                 // opened, submerged in fresh water daily
	"tempeh": 7,
	"deli meat": 5,
	"smoked salmon": 5,        // opened pack
	"feta": 30,                // in brine
	"parmesan": 60,            // hard cheese, wedge

	// Produce default — most fresh produce lasts ~5-7d once cut
	"avocado": 2,              // cut, browns fast
	"lemon": 21,               // whole, refrigerated; cut: ~3
	"lime": 21,
	"ginger": 21,              // refrigerated whole knob
	"garlic": 90,              // whole head; peeled cloves: ~7

	// Greens
	"spinach": 5,
	"arugula": 5,
	"kale": 7,
	"lettuce": 7,
	"cabbage": 30,             // whole head
};

// Default fallback when we have no entry — assume 14 days for opened
// refrigerated items, which is roughly the median across the table above.
const OPENED_DECAY_FALLBACK_DAYS = 14;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function addPantryLot(env: MiseGraphEnv, input: AddPantryLotInput): Promise<PantryLot> {
	const id = stringValue(input.id) || slugId(
		"lot",
		input.household_id,
		input.canonical_name,
		Date.now(),
		Math.floor(Math.random() * 9999),
	);
	const now = new Date().toISOString();
	const lot: PantryLot = {
		id,
		household_id: input.household_id,
		canonical_name: input.canonical_name.trim().toLowerCase(),
		storage_location: stringValue(input.storage_location) || "pantry",
		quantity: numberValue(input.quantity),
		unit: stringValue(input.unit) || null,
		grams: numberValue(input.grams),
		opened_at: stringValue(input.opened_at) || null,
		best_until: stringValue(input.best_until) || null,
		safe_until: stringValue(input.safe_until) || null,
		notes: stringValue(input.notes) || null,
		created_at: now,
		updated_at: now,
	};
	await env.DB.prepare(`
		INSERT INTO mise_pantry_lots
		(id, household_id, canonical_name, storage_location, quantity, unit, grams,
		 opened_at, best_until, safe_until, notes, meta_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		lot.id,
		lot.household_id,
		lot.canonical_name,
		lot.storage_location,
		lot.quantity,
		lot.unit,
		lot.grams,
		lot.opened_at,
		lot.best_until,
		lot.safe_until,
		lot.notes,
		JSON.stringify(input.meta || {}),
		lot.created_at,
		lot.updated_at,
	).run();
	return lot;
}

export async function removePantryLot(env: MiseGraphEnv, id: string): Promise<void> {
	await env.DB.prepare(`DELETE FROM mise_pantry_lots WHERE id = ?`).bind(id).run();
}

export async function listPantryLots(env: MiseGraphEnv, household_id: string): Promise<PantryLot[]> {
	try {
		const result = await env.DB.prepare(`
			SELECT id, household_id, canonical_name, storage_location, quantity, unit, grams,
				opened_at, best_until, safe_until, notes, created_at, updated_at
			FROM mise_pantry_lots
			WHERE household_id = ?
			ORDER BY canonical_name ASC, created_at ASC
		`).bind(household_id).all<PantryLotRow>();
		return (result.results || []).map(rowToLot);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Pressure analysis
// ---------------------------------------------------------------------------

export async function loadPantryPressure(
	env: MiseGraphEnv,
	household_id: string,
	plan_dates: string[],
): Promise<PantryPressureContext> {
	const lots = await listPantryLots(env, household_id);
	const today = todayIso();
	const windowEnd = pickWindowEnd(plan_dates, today);

	const expiring_within_window: PantryExpiringInWindow[] = [];
	const expiring_after_window: PantryExpiringAfterWindow[] = [];
	const opened_perishable: PantryOpenedPerishable[] = [];
	const fresh_pantry_summary: Record<string, number> = {};
	// Tracks whether a key's running total is grams (preferred) or a lot count.
	// Once we see grams for a key, we never demote to count.
	const pantrySummaryMode = new Map<string, "grams" | "count" | "empty">();

	for (const lot of lots) {
		// Effective expiry: prefer best_until > safe_until > derived from
		// opened_at + decay default. Falls back to null (no signal).
		const effectiveExpiry = effectiveExpiryFor(lot);

		if (effectiveExpiry) {
			const days = daysBetween(today, effectiveExpiry);
			const inWindow = effectiveExpiry <= windowEnd;
			if (inWindow && days <= 0) {
				// Already expired or expiring today — surface as critical.
				expiring_within_window.push({
					name: lot.canonical_name,
					qty: lot.quantity,
					unit: lot.unit,
					days_until_expiry: days,
					suggested_use_by: effectiveExpiry,
					urgency: "critical",
					storage_location: lot.storage_location,
					lot_id: lot.id,
				});
			} else if (inWindow) {
				expiring_within_window.push({
					name: lot.canonical_name,
					qty: lot.quantity,
					unit: lot.unit,
					days_until_expiry: days,
					suggested_use_by: effectiveExpiry,
					urgency: urgencyFromDays(days),
					storage_location: lot.storage_location,
					lot_id: lot.id,
				});
			} else {
				expiring_after_window.push({
					name: lot.canonical_name,
					days_until_expiry: days,
					storage_location: lot.storage_location,
				});
			}
		}

		// Opened-perishable signal is independent — even a jar with a
		// far-future best_until can be "stop sleeping on this open jar"
		// if it's been open beyond the typical opened-life.
		if (lot.opened_at) {
			const openedDays = daysBetween(lot.opened_at, today);
			if (openedDays >= 7) {
				const window = openedLifeFor(lot.canonical_name);
				const remaining = window - openedDays;
				const urgency = urgencyFromDays(remaining);
				opened_perishable.push({
					name: lot.canonical_name,
					opened_days_ago: openedDays,
					urgency,
					expected_open_window_days: window,
					storage_location: lot.storage_location,
					lot_id: lot.id,
				});
			}
		}

		// Fresh pantry summary — aggregate by canonical_name. Use grams when
		// present (most informative for composition); fall back to count of
		// lots so the LLM at least knows "we have 3 of these". Grams always
		// wins: if any lot for a canonical has grams, we prefer the sum of
		// gram totals over a lot count.
		const key = lot.canonical_name;
		const grams = lot.grams ?? null;
		const existing = fresh_pantry_summary[key];
		const existingMode = pantrySummaryMode.get(key) || (existing !== undefined ? "count" : "empty");

		if (grams !== null) {
			if (existingMode === "grams") {
				fresh_pantry_summary[key] = (existing || 0) + grams;
			} else {
				// Switching from count → grams; replace.
				fresh_pantry_summary[key] = grams;
				pantrySummaryMode.set(key, "grams");
			}
		} else if (existingMode !== "grams") {
			fresh_pantry_summary[key] = (existing || 0) + 1;
			pantrySummaryMode.set(key, "count");
		}
	}

	// Sort lists for stable, prioritized output.
	expiring_within_window.sort((a, b) => a.days_until_expiry - b.days_until_expiry);
	expiring_after_window.sort((a, b) => a.days_until_expiry - b.days_until_expiry);
	opened_perishable.sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));

	return {
		expiring_within_window,
		expiring_after_window,
		opened_perishable,
		fresh_pantry_summary,
	};
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface PantryLotRow {
	id: string;
	household_id: string;
	canonical_name: string;
	storage_location: string | null;
	quantity: number | null;
	unit: string | null;
	grams: number | null;
	opened_at: string | null;
	best_until: string | null;
	safe_until: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string | null;
}

function rowToLot(row: PantryLotRow): PantryLot {
	return {
		id: row.id,
		household_id: row.household_id,
		canonical_name: row.canonical_name,
		storage_location: row.storage_location,
		quantity: row.quantity,
		unit: row.unit,
		grams: row.grams,
		opened_at: row.opened_at,
		best_until: row.best_until,
		safe_until: row.safe_until,
		notes: row.notes,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function effectiveExpiryFor(lot: PantryLot): string | null {
	if (lot.best_until) return normalizeDate(lot.best_until);
	if (lot.safe_until) return normalizeDate(lot.safe_until);
	if (lot.opened_at) {
		const window = openedLifeFor(lot.canonical_name);
		const opened = parseDate(lot.opened_at);
		if (!opened) return null;
		const expiry = new Date(opened);
		expiry.setUTCDate(expiry.getUTCDate() + window);
		return expiry.toISOString().slice(0, 10);
	}
	return null;
}

function openedLifeFor(canonical_name: string): number {
	const key = canonical_name.toLowerCase().trim();
	if (key in OPENED_DECAY_DAYS) return OPENED_DECAY_DAYS[key];
	// Loose match: "opened miso paste" should hit "miso", "toasted walnuts" → "walnuts".
	for (const candidate of Object.keys(OPENED_DECAY_DAYS)) {
		if (key.includes(candidate)) return OPENED_DECAY_DAYS[candidate];
	}
	return OPENED_DECAY_FALLBACK_DAYS;
}

function urgencyFromDays(days: number): PantryUrgency {
	if (days <= 3) return "critical";
	if (days <= 7) return "high";
	if (days <= 14) return "medium";
	return "low";
}

function urgencyRank(u: PantryUrgency): number {
	if (u === "critical") return 0;
	if (u === "high") return 1;
	if (u === "medium") return 2;
	return 3;
}

function pickWindowEnd(plan_dates: string[], fallback: string): string {
	if (plan_dates.length === 0) return fallback;
	const sorted = [...plan_dates].map(normalizeDate).filter(Boolean).sort();
	return sorted[sorted.length - 1] || fallback;
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value: string): string {
	const trimmed = value.trim();
	if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
	const d = new Date(trimmed);
	if (Number.isNaN(d.getTime())) return trimmed;
	return d.toISOString().slice(0, 10);
}

function parseDate(value: string): Date | null {
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(fromIso: string, toIso: string): number {
	const a = parseDate(fromIso);
	const b = parseDate(toIso);
	if (!a || !b) return 0;
	const ms = b.getTime() - a.getTime();
	return Math.round(ms / (1000 * 60 * 60 * 24));
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(part => String(part ?? "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}
