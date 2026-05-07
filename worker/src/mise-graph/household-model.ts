// Household model — durable identity + meal-history + anchor evolution.
// Persistent layer for who the household is, what they eat, and what
// anchor ingredients dominate their menu right now. Also writes to the
// append-only meal-history log and computes anchor evolution from it.
// Storage lives in `mise_household_profiles`, `mise_meal_history`, and
// `mise_anchor_evolution` (schema-household-memory.sql).
//
// Trend window is 28 days, split into recent (≤14d) vs older (14-28d)
// halves. Pressure = count / total_meals_in_window, clamped to [0,1].
// Saturated when pressure >= 0.6; rising/falling when half-rate delta
// > 0.15; otherwise stable. Cuisine prefs use exp(-d/14) decay, then
// normalize so the heaviest cuisine = 1.0.

import type { MiseGraphEnv } from "./types";
import {
	RECENCY_TAU_DAYS,
	parseStringArray,
	parseNumberMap,
	parseGenericObject,
	isoDateNDaysAgo,
	daysBetween,
	clamp01,
	round3,
	normalizeMaxToOne,
	canonicalAnchor,
	slugify,
} from "./household-memory-utils";

export interface HouseholdShopPreferences {
	available_slots: Array<{ day_of_week: number; window: string }>;
	preferred_strategy: string;
	max_runs_per_week: number;
	min_items_per_run: number;
	vendor_splits: unknown[];
	delivery_available: boolean;
}

export interface HouseholdProfile {
	household_id: string;
	display_name: string | null;
	people_count: number;
	dietary: string[];
	equipment: string[];
	current_anchors: string[];
	cuisine_preferences: Record<string, number>;
	default_pantry: string[];
	shop_preferences: HouseholdShopPreferences | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface CookedMealInput {
	date: string;
	slot: string;
	title: string;
	cuisine: string[];
	format: string;
	anchors_used: string[];
}

export interface AnchorEvolutionEntry {
	canonical_name: string;
	pressure: number;
	trend: "rising" | "falling" | "stable" | "saturated";
	recent_count_28d: number;
}

const ANCHOR_WINDOW_DAYS = 28;
const SATURATED_THRESHOLD = 0.6;
const TREND_DELTA = 0.15;

const PROFILE_COLS = `household_id, display_name, people_count,
	dietary_json, equipment_json, current_anchors_json,
	cuisine_preferences_json, default_pantry_json,
	shop_preferences_json, notes, created_at, updated_at`;
const HISTORY_COLS = `meal_history_id, household_id, cooked_on, slot, title,
	cuisine_json, format, anchors_json, recorded_at`;

// ---------- profile CRUD ----------

interface ProfileRow {
	household_id: string;
	display_name: string | null;
	people_count: number;
	dietary_json: string | null;
	equipment_json: string | null;
	current_anchors_json: string | null;
	cuisine_preferences_json: string | null;
	default_pantry_json: string | null;
	shop_preferences_json: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export async function getHouseholdProfile(
	env: MiseGraphEnv,
	household_id: string,
): Promise<HouseholdProfile | null> {
	const id = (household_id || "").trim();
	if (!id) return null;
	let row: ProfileRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT ${PROFILE_COLS} FROM mise_household_profiles WHERE household_id = ?`,
		).bind(id).first<ProfileRow>();
	} catch {
		return null;
	}
	return row ? rowToProfile(row) : null;
}

export async function upsertHouseholdProfile(
	env: MiseGraphEnv,
	profile: Partial<HouseholdProfile> & { household_id: string },
): Promise<HouseholdProfile> {
	const id = (profile.household_id || "").trim();
	if (!id) throw new Error("upsertHouseholdProfile: household_id required");

	const existing = await getHouseholdProfile(env, id);
	const now = new Date().toISOString();
	const created_at = existing?.created_at || now;

	const merged: HouseholdProfile = {
		household_id: id,
		display_name: profile.display_name !== undefined ? profile.display_name : (existing?.display_name ?? null),
		people_count: profile.people_count ?? existing?.people_count ?? 2,
		dietary: profile.dietary ?? existing?.dietary ?? [],
		equipment: profile.equipment ?? existing?.equipment ?? [],
		current_anchors: profile.current_anchors ?? existing?.current_anchors ?? [],
		cuisine_preferences: profile.cuisine_preferences ?? existing?.cuisine_preferences ?? {},
		default_pantry: profile.default_pantry ?? existing?.default_pantry ?? [],
		shop_preferences: profile.shop_preferences !== undefined ? profile.shop_preferences : (existing?.shop_preferences ?? null),
		notes: profile.notes !== undefined ? profile.notes : (existing?.notes ?? null),
		created_at,
		updated_at: now,
	};

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_household_profiles (${PROFILE_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		merged.household_id, merged.display_name, merged.people_count,
		JSON.stringify(merged.dietary), JSON.stringify(merged.equipment),
		JSON.stringify(merged.current_anchors), JSON.stringify(merged.cuisine_preferences),
		JSON.stringify(merged.default_pantry),
		merged.shop_preferences ? JSON.stringify(merged.shop_preferences) : null,
		merged.notes, merged.created_at, merged.updated_at,
	).run();

	return merged;
}

export async function listHouseholds(env: MiseGraphEnv): Promise<HouseholdProfile[]> {
	let rows: ProfileRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT ${PROFILE_COLS} FROM mise_household_profiles
			 ORDER BY updated_at DESC LIMIT 200`,
		).all<ProfileRow>();
		rows = (result.results || []) as ProfileRow[];
	} catch {
		return [];
	}
	return rows.map(rowToProfile);
}

// ---------- meal history & anchor evolution ----------

export async function recordCookedMeal(
	env: MiseGraphEnv,
	household_id: string,
	meal_data: CookedMealInput,
): Promise<void> {
	const hh = (household_id || "").trim();
	if (!hh) throw new Error("recordCookedMeal: household_id required");
	const date = (meal_data.date || "").trim();
	const slot = (meal_data.slot || "").trim().toLowerCase();
	if (!date) throw new Error("recordCookedMeal: meal_data.date required");

	const meal_history_id = `mh_${hh}__${date}__${slot || "any"}__${slugify(meal_data.title)}`;
	const recorded_at = new Date().toISOString();

	const cuisine = Array.isArray(meal_data.cuisine)
		? meal_data.cuisine.filter((c): c is string => typeof c === "string" && !!c.trim()).map(c => c.trim())
		: [];
	const anchors = Array.isArray(meal_data.anchors_used)
		? meal_data.anchors_used.filter((a): a is string => typeof a === "string" && !!a.trim()).map(a => canonicalAnchor(a))
		: [];

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_meal_history
			(meal_history_id, household_id, cooked_on, slot, title,
			 cuisine_json, format, anchors_json, recorded_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			meal_history_id,
			hh,
			date,
			slot || null,
			meal_data.title || null,
			JSON.stringify(cuisine),
			meal_data.format || null,
			JSON.stringify(anchors),
			recorded_at,
		)
		.run();

	// Snapshot anchor evolution for each anchor used.
	const evolution = await computeAnchorEvolution(env, hh);
	for (const entry of evolution) {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_anchor_evolution
				(household_id, canonical_name, recorded_at, pressure, trend)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(hh, entry.canonical_name, recorded_at, entry.pressure, entry.trend)
			.run();
	}
}

interface MealHistoryRow {
	meal_history_id: string;
	household_id: string;
	cooked_on: string;
	slot: string | null;
	title: string | null;
	cuisine_json: string | null;
	format: string | null;
	anchors_json: string | null;
	recorded_at: string;
}

async function loadMealHistory(env: MiseGraphEnv, household_id: string, lookbackDays: number): Promise<MealHistoryRow[]> {
	const cutoff = isoDateNDaysAgo(lookbackDays);
	try {
		const result = await env.DB.prepare(
			`SELECT ${HISTORY_COLS} FROM mise_meal_history
			 WHERE household_id = ? AND cooked_on >= ?
			 ORDER BY cooked_on DESC LIMIT 500`,
		).bind(household_id, cutoff).all<MealHistoryRow>();
		return (result.results || []) as MealHistoryRow[];
	} catch {
		return [];
	}
}

export async function computeAnchorEvolution(
	env: MiseGraphEnv,
	household_id: string,
): Promise<AnchorEvolutionEntry[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];

	const rows = await loadMealHistory(env, hh, ANCHOR_WINDOW_DAYS);
	if (rows.length === 0) return [];

	const today = new Date();
	const halfWindowDays = ANCHOR_WINDOW_DAYS / 2;
	const recentCount = new Map<string, number>();
	const olderCount = new Map<string, number>();
	const totalCount = new Map<string, number>();
	const totalMealsInWindow = rows.length;

	for (const row of rows) {
		const anchors = parseStringArray(row.anchors_json);
		const daysAgo = daysBetween(today, row.cooked_on);
		if (daysAgo === null) continue;
		const isRecent = daysAgo <= halfWindowDays;
		for (const raw of anchors) {
			const key = canonicalAnchor(raw);
			if (!key) continue;
			totalCount.set(key, (totalCount.get(key) || 0) + 1);
			if (isRecent) recentCount.set(key, (recentCount.get(key) || 0) + 1);
			else olderCount.set(key, (olderCount.get(key) || 0) + 1);
		}
	}

	const out: AnchorEvolutionEntry[] = [];
	for (const [name, count] of totalCount.entries()) {
		const pressure = clamp01(count / Math.max(1, totalMealsInWindow));
		const recent = recentCount.get(name) || 0;
		const older = olderCount.get(name) || 0;
		const recentRate = recent / Math.max(1, halfWindowDays);
		const olderRate = older / Math.max(1, halfWindowDays);
		let trend: AnchorEvolutionEntry["trend"];
		if (pressure >= SATURATED_THRESHOLD) trend = "saturated";
		else if (recentRate - olderRate > TREND_DELTA) trend = "rising";
		else if (olderRate - recentRate > TREND_DELTA) trend = "falling";
		else trend = "stable";
		out.push({ canonical_name: name, pressure: round3(pressure), trend, recent_count_28d: count });
	}
	out.sort((a, b) => b.pressure - a.pressure);
	return out;
}

export async function updateCuisinePreferences(
	env: MiseGraphEnv,
	household_id: string,
): Promise<Record<string, number>> {
	const hh = (household_id || "").trim();
	if (!hh) return {};

	const rows = await loadMealHistory(env, hh, 60);
	const today = new Date();
	const weighted = new Map<string, number>();
	for (const row of rows) {
		const cuisines = parseStringArray(row.cuisine_json);
		const daysAgo = daysBetween(today, row.cooked_on);
		if (daysAgo === null) continue;
		const w = Math.exp(-Math.max(0, daysAgo) / RECENCY_TAU_DAYS);
		for (const c of cuisines) {
			const key = c.toLowerCase().trim();
			if (!key) continue;
			weighted.set(key, (weighted.get(key) || 0) + w);
		}
	}
	const normalized = normalizeMaxToOne(weighted);

	const profile = await getHouseholdProfile(env, hh);
	if (profile) await upsertHouseholdProfile(env, { household_id: hh, cuisine_preferences: normalized });
	return normalized;
}

// ---------- helpers ----------

function rowToProfile(row: ProfileRow): HouseholdProfile {
	return {
		household_id: row.household_id,
		display_name: row.display_name,
		people_count: typeof row.people_count === "number" ? row.people_count : 2,
		dietary: parseStringArray(row.dietary_json),
		equipment: parseStringArray(row.equipment_json),
		current_anchors: parseStringArray(row.current_anchors_json),
		cuisine_preferences: parseNumberMap(row.cuisine_preferences_json),
		default_pantry: parseStringArray(row.default_pantry_json),
		shop_preferences: parseGenericObject<HouseholdShopPreferences>(row.shop_preferences_json),
		notes: row.notes,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
