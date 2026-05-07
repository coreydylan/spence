// Recipe Feedback — taste-rating loop for the menu composer.
//
// This module is the write/read side of the user-feedback signal. After a
// meal, the app calls `recordMealFeedback` with a 1-5 rating, optional
// would-repeat / finished bits, and free-text notes. Future composer runs
// call `loadRecentFeedback` (default 60-day window) and pass the result
// through `mealFeedbackHints` to get composer-shaped advice: titles to
// repeat, anchors to lean into, cuisines that landed well, plus dishes the
// household actively rejected.
//
// Storage lives in `mise_meal_feedback` (see schema-window-memory.sql). We
// use INSERT OR REPLACE keyed on (plan_id, meal_id) via the synthesized id
// so a household can correct or update a rating without piling up rows.
//
// Recency weighting uses the same exp(-d/14) curve as window-memory.ts so
// callers that combine the two signals get consistent decay.

import type { MiseGraphEnv } from "./types";

export type MealRating = 1 | 2 | 3 | 4 | 5;

export interface MealFeedbackInput {
	household_id: string;
	plan_id: string;
	meal_id: string;
	rating: MealRating;
	would_repeat?: boolean;
	finished?: boolean;
	notes?: string;
	// Optional denorm fields — let the caller pass what it already knows so we
	// don't have to re-walk plan_json on every read.
	meal_date?: string;
	meal_slot?: string;
	meal_title?: string;
	meal_cuisine?: string[];
	meal_format?: string;
	meal_anchors?: string[]; // canonical anchors, e.g. ["chickpea", "tahini"]
	meta?: Record<string, unknown>;
}

export interface MealFeedbackRecord {
	id: string;
	household_id: string;
	plan_id: string;
	meal_id: string;
	meal_date: string | null;
	meal_slot: string | null;
	meal_title: string | null;
	meal_cuisine: string[];
	meal_format: string | null;
	rating: MealRating | null;
	would_repeat: boolean | null;
	finished: boolean | null;
	notes: string | null;
	recorded_at: string;
	meta: Record<string, unknown>;
}

export interface MealFeedbackHints {
	loved_titles: string[];                       // rating >= 4
	loved_anchors: Record<string, number>;        // recency-weighted, normalized 0..1
	loved_cuisines: Record<string, number>;       // recency-weighted, normalized 0..1
	loved_formats: Record<string, number>;        // recency-weighted, normalized 0..1
	rejected_titles: string[];                    // rating <= 2
	rejected_anchors: Record<string, number>;     // recency-weighted, normalized 0..1
	rejected_cuisines: Record<string, number>;    // recency-weighted, normalized 0..1
	would_repeat_titles: string[];                // explicit thumbs-up
	wont_repeat_titles: string[];                 // explicit thumbs-down
	unfinished_titles: string[];                  // finished === false (signal of dislike or portion miss)
	count_total: number;
	count_loved: number;
	count_rejected: number;
}

const RECENCY_TAU_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 60;

// ---------- writes ----------

export async function recordMealFeedback(
	env: MiseGraphEnv,
	input: MealFeedbackInput,
): Promise<MealFeedbackRecord> {
	const householdId = input.household_id?.trim();
	const planId = input.plan_id?.trim();
	const mealId = input.meal_id?.trim();
	if (!householdId) throw new Error("recordMealFeedback: household_id required");
	if (!planId) throw new Error("recordMealFeedback: plan_id required");
	if (!mealId) throw new Error("recordMealFeedback: meal_id required");
	if (!isValidRating(input.rating)) throw new Error("recordMealFeedback: rating must be 1..5");

	const id = `mf_${planId}__${mealId}`;
	const recordedAt = new Date().toISOString();
	const meta = mergeMeta(input);

	const cuisineJson = JSON.stringify(Array.isArray(input.meal_cuisine) ? input.meal_cuisine.filter(c => typeof c === "string") : []);
	const wouldRepeatInt = boolToInt(input.would_repeat);
	const finishedInt = boolToInt(input.finished);

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_meal_feedback
			(id, household_id, plan_id, meal_id, meal_date, meal_slot, meal_title,
			 meal_cuisine_json, meal_format, rating, would_repeat, finished,
			 notes, recorded_at, meta_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			householdId,
			planId,
			mealId,
			input.meal_date ?? null,
			input.meal_slot ?? null,
			input.meal_title ?? null,
			cuisineJson,
			input.meal_format ?? null,
			input.rating,
			wouldRepeatInt,
			finishedInt,
			input.notes ?? null,
			recordedAt,
			JSON.stringify(meta),
		)
		.run();

	return {
		id,
		household_id: householdId,
		plan_id: planId,
		meal_id: mealId,
		meal_date: input.meal_date ?? null,
		meal_slot: input.meal_slot ?? null,
		meal_title: input.meal_title ?? null,
		meal_cuisine: Array.isArray(input.meal_cuisine) ? input.meal_cuisine.filter(c => typeof c === "string") : [],
		meal_format: input.meal_format ?? null,
		rating: input.rating,
		would_repeat: input.would_repeat ?? null,
		finished: input.finished ?? null,
		notes: input.notes ?? null,
		recorded_at: recordedAt,
		meta,
	};
}

// ---------- reads ----------

export async function loadRecentFeedback(
	env: MiseGraphEnv,
	householdId: string,
	lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<MealFeedbackRecord[]> {
	const id = householdId?.trim();
	if (!id) return [];
	const days = Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : DEFAULT_LOOKBACK_DAYS;
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	let rows: FeedbackRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT id, household_id, plan_id, meal_id, meal_date, meal_slot, meal_title,
			        meal_cuisine_json, meal_format, rating, would_repeat, finished,
			        notes, recorded_at, meta_json
			 FROM mise_meal_feedback
			 WHERE household_id = ?
			   AND recorded_at >= ?
			 ORDER BY recorded_at DESC
			 LIMIT 500`,
		)
			.bind(id, cutoff)
			.all<FeedbackRow>();
		rows = (result.results || []) as FeedbackRow[];
	} catch {
		return [];
	}
	return rows.map(rowToRecord);
}

// ---------- shaping for composer ----------

export function mealFeedbackHints(records: MealFeedbackRecord[]): MealFeedbackHints {
	const empty: MealFeedbackHints = {
		loved_titles: [],
		loved_anchors: {},
		loved_cuisines: {},
		loved_formats: {},
		rejected_titles: [],
		rejected_anchors: {},
		rejected_cuisines: {},
		would_repeat_titles: [],
		wont_repeat_titles: [],
		unfinished_titles: [],
		count_total: 0,
		count_loved: 0,
		count_rejected: 0,
	};
	if (!Array.isArray(records) || records.length === 0) return empty;

	const today = new Date();
	const lovedAnchors = new Map<string, number>();
	const lovedCuisines = new Map<string, number>();
	const lovedFormats = new Map<string, number>();
	const rejectedAnchors = new Map<string, number>();
	const rejectedCuisines = new Map<string, number>();
	const lovedTitles: Array<{ title: string; date: string }> = [];
	const rejectedTitles: Array<{ title: string; date: string }> = [];
	const wouldRepeat: string[] = [];
	const wontRepeat: string[] = [];
	const unfinished: string[] = [];
	let countLoved = 0;
	let countRejected = 0;

	for (const r of records) {
		const rating = r.rating;
		const dateRef = r.meal_date || r.recorded_at.slice(0, 10);
		const daysAgo = daysBetween(today, dateRef) ?? 7;
		const w = Math.exp(-Math.max(0, daysAgo) / RECENCY_TAU_DAYS);
		const anchors = extractMetaAnchors(r.meta);
		const title = (r.meal_title || "").trim();

		if (typeof rating === "number" && rating >= 4) {
			countLoved++;
			if (title) lovedTitles.push({ title, date: dateRef });
			for (const c of r.meal_cuisine) {
				if (c) lovedCuisines.set(c, (lovedCuisines.get(c) || 0) + w);
			}
			if (r.meal_format) {
				lovedFormats.set(r.meal_format, (lovedFormats.get(r.meal_format) || 0) + w);
			}
			for (const a of anchors) {
				lovedAnchors.set(a, (lovedAnchors.get(a) || 0) + w);
			}
		} else if (typeof rating === "number" && rating <= 2) {
			countRejected++;
			if (title) rejectedTitles.push({ title, date: dateRef });
			for (const c of r.meal_cuisine) {
				if (c) rejectedCuisines.set(c, (rejectedCuisines.get(c) || 0) + w);
			}
			for (const a of anchors) {
				rejectedAnchors.set(a, (rejectedAnchors.get(a) || 0) + w);
			}
		}

		if (r.would_repeat === true && title) wouldRepeat.push(title);
		if (r.would_repeat === false && title) wontRepeat.push(title);
		if (r.finished === false && title) unfinished.push(title);
	}

	return {
		loved_titles: dedupeMostRecent(lovedTitles),
		loved_anchors: normalizeMaxToOne(lovedAnchors),
		loved_cuisines: normalizeMaxToOne(lovedCuisines),
		loved_formats: normalizeMaxToOne(lovedFormats),
		rejected_titles: dedupeMostRecent(rejectedTitles),
		rejected_anchors: normalizeMaxToOne(rejectedAnchors),
		rejected_cuisines: normalizeMaxToOne(rejectedCuisines),
		would_repeat_titles: dedupe(wouldRepeat),
		wont_repeat_titles: dedupe(wontRepeat),
		unfinished_titles: dedupe(unfinished),
		count_total: records.length,
		count_loved: countLoved,
		count_rejected: countRejected,
	};
}

// ---------- internal helpers ----------

interface FeedbackRow {
	id: string;
	household_id: string;
	plan_id: string;
	meal_id: string;
	meal_date: string | null;
	meal_slot: string | null;
	meal_title: string | null;
	meal_cuisine_json: string | null;
	meal_format: string | null;
	rating: number | null;
	would_repeat: number | null;
	finished: number | null;
	notes: string | null;
	recorded_at: string;
	meta_json: string | null;
}

function rowToRecord(row: FeedbackRow): MealFeedbackRecord {
	return {
		id: row.id,
		household_id: row.household_id,
		plan_id: row.plan_id,
		meal_id: row.meal_id,
		meal_date: row.meal_date,
		meal_slot: row.meal_slot,
		meal_title: row.meal_title,
		meal_cuisine: parseJsonStringArray(row.meal_cuisine_json),
		meal_format: row.meal_format,
		rating: isValidRating(row.rating) ? (row.rating as MealRating) : null,
		would_repeat: intToBool(row.would_repeat),
		finished: intToBool(row.finished),
		notes: row.notes,
		recorded_at: row.recorded_at,
		meta: parseJsonObject(row.meta_json) || {},
	};
}

function isValidRating(v: unknown): v is MealRating {
	return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

function boolToInt(v: boolean | undefined): number | null {
	if (v === true) return 1;
	if (v === false) return 0;
	return null;
}

function intToBool(v: number | null): boolean | null {
	if (v === 1) return true;
	if (v === 0) return false;
	return null;
}

function mergeMeta(input: MealFeedbackInput): Record<string, unknown> {
	const meta: Record<string, unknown> = { ...(input.meta || {}) };
	if (Array.isArray(input.meal_anchors) && input.meal_anchors.length > 0) {
		meta["anchors"] = input.meal_anchors.filter(a => typeof a === "string");
	}
	return meta;
}

function extractMetaAnchors(meta: Record<string, unknown>): string[] {
	const raw = meta?.["anchors"];
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v === "string" && v.trim()) out.push(v.trim().toLowerCase());
	}
	return out;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
	if (!value || typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseJsonStringArray(value: string | null | undefined): string[] {
	if (!value || typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const out: string[] = [];
		for (const v of parsed) {
			if (typeof v === "string" && v.trim()) out.push(v.trim());
		}
		return out;
	} catch {
		return [];
	}
}

function normalizeMaxToOne(weighted: Map<string, number>): Record<string, number> {
	if (weighted.size === 0) return {};
	let max = 0;
	for (const v of weighted.values()) if (v > max) max = v;
	if (max <= 0) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of weighted.entries()) {
		out[k] = Math.round((v / max) * 1000) / 1000;
	}
	return out;
}

function daysBetween(today: Date, isoDate: string): number | null {
	if (!isoDate || typeof isoDate !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
	if (!m) return null;
	const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	return (now - then) / (1000 * 60 * 60 * 24);
}

function dedupe(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of items) {
		const key = v.toLowerCase().trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(v);
	}
	return out;
}

function dedupeMostRecent(items: Array<{ title: string; date: string }>): string[] {
	const sorted = [...items].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
	return dedupe(sorted.map(s => s.title));
}
