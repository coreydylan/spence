// Onboarding Phase D — hook predicate evaluator + chattiness filter.
//
// Tier 2/3/4 questions don't sit on the linear advance-or-skip path; instead,
// each one declares a `trigger_kind` (one of the TriggerKind enum). The
// scheduler computes runtime HookDeps from D1 once per brief, then asks
// `evaluateHook(question, deps)` for each candidate to find out:
//
//   * whether the trigger fires (gates whether the question is even surfaceable),
//   * the score bonus (1.5 if fires, 1.0 otherwise — multiplies into the
//     scheduler's existing tier_weight × novelty_decay × kind_priority math),
//   * the rendered question_text (templated against the deps so we can say
//     "Tofu's shown up 4 times" with the actual count).
//
// computeHookDeps() reads what's available from D1. For data sources Phase A/B
// don't expose yet (notably cancelled meals + meal taste scores), we degrade
// gracefully — undefined-or-empty is the default state, and the trigger
// predicate just doesn't fire. Phase C's observation pipeline is expected to
// land more of these signals; this module is forward-compatible.
//
// The chattiness filter is a sibling helper: when engagement_signal is low,
// tier 3/4 questions get gated out entirely. The scheduler chains
// applyChattinessFilter() onto its candidate list before scoring.

import type { MiseGraphEnv } from "./types";
import type {
	HookedQuestion,
	Question,
	TriggerKind,
} from "./onboarding-questions";

// ─── HookDeps — runtime signals the scheduler computes once per brief ───────

export interface HookDeps {
	/** Now, in ms-since-epoch. Drives season/holiday/recency math. */
	now_ms: number;

	/** Meals cancelled within last 7 days for this household. */
	recent_cancellations: number;

	/** Recent cancellations whose reason text contains "takeout". */
	recent_takeout_cancellations: number;

	/** If 3+ meals same cuisine in last 14 days, this is the streak length. */
	dominant_cuisine_streak: number;
	dominant_cuisine: string | null;

	/** Most-repeated ingredient in last 14 days (≥4 occurrences). */
	repeat_ingredient: string | null;
	repeat_ingredient_count: number;

	/** Equipment registered to the household but never claimed/used. */
	idle_equipment: string[];

	/** Weeks since onboarding tier 0 completed (clamped ≥ 0). */
	weeks_active: number;

	/** Day-of-week / time-of-day cues. */
	is_weekend: boolean;
	is_sunday_morning: boolean;

	/** 1..12 in local time (we treat the worker's UTC clock as authoritative). */
	current_month: number;

	/** Most-recent meal_id with high taste score (eaten + loved). */
	recent_high_taste_meal_id: string | null;
	recent_high_taste_meal_label: string | null;

	/** Days until next major holiday (null if >30d out). */
	days_until_next_holiday: number | null;
	next_holiday_label: string | null;

	/** Recent free-text responses where user mentioned "tired". */
	tired_mentions_recent: number;

	/** Has a new household_member been added in the last 14 days? */
	new_member_recent: boolean;

	/** Avg meal.people across last 4 weeks; null if fewer than 4 datapoints. */
	avg_meal_people: number | null;
	avg_meal_people_prior: number | null;

	/** Engagement signal at the moment we evaluate (drives chattiness gate). */
	engagement_signal: number;
}

const HOLIDAYS_BY_MONTH_DAY: Array<{ month: number; day: number; label: string }> = [
	{ month: 1, day: 1, label: "New Year's Day" },
	{ month: 2, day: 14, label: "Valentine's Day" },
	{ month: 3, day: 17, label: "St. Patrick's Day" },
	{ month: 7, day: 4, label: "the Fourth of July" },
	{ month: 10, day: 31, label: "Halloween" },
	{ month: 11, day: 28, label: "Thanksgiving" },          // approx — last Thu
	{ month: 12, day: 25, label: "Christmas" },
];

/**
 * Compute the runtime hook dependencies for a household. Pure-ish — reads
 * from D1 but never writes. Best-effort: when a table doesn't exist or a
 * query fails, the field falls back to its zero/empty default rather than
 * throwing. The scheduler treats that as "no signal" → trigger doesn't fire.
 */
export async function computeHookDeps(
	env: MiseGraphEnv,
	household_id: string,
	now_ms: number,
): Promise<HookDeps> {
	const id = (household_id || "").trim();
	const deps: HookDeps = {
		now_ms,
		recent_cancellations: 0,
		recent_takeout_cancellations: 0,
		dominant_cuisine_streak: 0,
		dominant_cuisine: null,
		repeat_ingredient: null,
		repeat_ingredient_count: 0,
		idle_equipment: [],
		weeks_active: 0,
		is_weekend: false,
		is_sunday_morning: false,
		current_month: 1,
		recent_high_taste_meal_id: null,
		recent_high_taste_meal_label: null,
		days_until_next_holiday: null,
		next_holiday_label: null,
		tired_mentions_recent: 0,
		new_member_recent: false,
		avg_meal_people: null,
		avg_meal_people_prior: null,
		engagement_signal: 1.0,
	};
	if (!id) return deps;

	// ---- Calendar-derived signals (always-available, no DB) ----------------
	const date = new Date(now_ms);
	const dow = date.getUTCDay();           // 0=Sun..6=Sat
	const hour = date.getUTCHours();
	deps.is_weekend = dow === 0 || dow === 6;
	deps.is_sunday_morning = dow === 0 && hour >= 6 && hour < 12;
	deps.current_month = date.getUTCMonth() + 1;
	const holiday = nextHoliday(date);
	if (holiday) {
		deps.days_until_next_holiday = holiday.days;
		deps.next_holiday_label = holiday.label;
	}

	// ---- Onboarding state-derived signals ----------------------------------
	try {
		const stateRow = await env.DB.prepare(
			`SELECT tier_0_completed_at, engagement_signal
			 FROM mise_onboarding_state
			 WHERE household_id = ?`,
		).bind(id).first<{ tier_0_completed_at: string | null; engagement_signal: number }>();
		if (stateRow) {
			if (typeof stateRow.engagement_signal === "number") {
				deps.engagement_signal = stateRow.engagement_signal;
			}
			if (stateRow.tier_0_completed_at) {
				const t = Date.parse(stateRow.tier_0_completed_at);
				if (Number.isFinite(t)) {
					const diffMs = Math.max(0, now_ms - t);
					deps.weeks_active = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
				}
			}
		}
	} catch {
		// State table missing — pre-migration. Defaults stand.
	}

	// ---- Recent free-text responses for "tired" mentions ------------------
	try {
		const result = await env.DB.prepare(
			`SELECT response_text, asked_at_ms
			 FROM mise_onboarding_responses
			 WHERE household_id = ?
			 ORDER BY asked_at_ms DESC`,
		).bind(id).all<{ response_text: string | null; asked_at_ms: number }>();
		const sevenDaysAgo = now_ms - 7 * 24 * 60 * 60 * 1000;
		let tired = 0;
		for (const r of result.results || []) {
			if (typeof r.asked_at_ms === "number" && r.asked_at_ms < sevenDaysAgo) continue;
			const text = (r.response_text || "").toLowerCase();
			if (!text) continue;
			if (text.includes("tired") || text.includes("exhausted") || text.includes("wiped")) {
				tired++;
			}
		}
		deps.tired_mentions_recent = tired;
	} catch {
		// Responses table missing.
	}

	// ---- Recent meal cancellations -----------------------------------------
	// We probe the active-plans archival shape if it exists. The query is
	// best-effort; if the table layout doesn't match we just stay at 0.
	try {
		const result = await env.DB.prepare(
			`SELECT cancelled_at_ms, cancel_reason
			 FROM mise_meal_cancellations
			 WHERE household_id = ?
			 ORDER BY cancelled_at_ms DESC`,
		).bind(id).all<{ cancelled_at_ms: number; cancel_reason: string | null }>();
		const sevenDaysAgo = now_ms - 7 * 24 * 60 * 60 * 1000;
		for (const r of result.results || []) {
			if (typeof r.cancelled_at_ms !== "number") continue;
			if (r.cancelled_at_ms < sevenDaysAgo) continue;
			deps.recent_cancellations++;
			const reason = (r.cancel_reason || "").toLowerCase();
			if (reason.includes("takeout") || reason.includes("delivery") || reason.includes("ordered out")) {
				deps.recent_takeout_cancellations++;
			}
		}
	} catch {
		// Cancellations table missing — Phase C's observation pipeline lands
		// this in a future deploy. Default 0 means the trigger doesn't fire.
	}

	// ---- Cuisine streak + repeat-ingredient signals -----------------------
	// Phase C is expected to publish a `mise_meal_signals` view. Until then
	// we keep these at their zero defaults and let the scheduler skip the
	// associated questions.
	try {
		const cuisine = await env.DB.prepare(
			`SELECT cuisine, streak_length, computed_at_ms
			 FROM mise_meal_signals
			 WHERE household_id = ? AND signal_kind = ?
			 ORDER BY computed_at_ms DESC`,
		).bind(id, "cuisine_streak").first<{ cuisine: string; streak_length: number; computed_at_ms: number }>();
		if (cuisine && typeof cuisine.streak_length === "number") {
			deps.dominant_cuisine_streak = cuisine.streak_length;
			deps.dominant_cuisine = cuisine.cuisine || null;
		}
	} catch {
		// Signals table missing.
	}

	try {
		const anchor = await env.DB.prepare(
			`SELECT ingredient, occurrence_count, computed_at_ms
			 FROM mise_meal_signals
			 WHERE household_id = ? AND signal_kind = ?
			 ORDER BY computed_at_ms DESC`,
		).bind(id, "repeat_ingredient").first<{ ingredient: string; occurrence_count: number; computed_at_ms: number }>();
		if (anchor && typeof anchor.occurrence_count === "number") {
			deps.repeat_ingredient = anchor.ingredient || null;
			deps.repeat_ingredient_count = anchor.occurrence_count;
		}
	} catch {
		// Signals table missing.
	}

	// ---- Idle equipment (registered but no claims) -------------------------
	// Read from mise_household_profiles.equipment_json if available. The
	// "no claims" half is a Phase C observation; for now we surface
	// everything in the equipment list as "potentially idle" only if the
	// scheduler explicitly asks (we keep the list itself short).
	try {
		const profile = await env.DB.prepare(
			`SELECT equipment_json
			 FROM mise_household_profiles
			 WHERE household_id = ?`,
		).bind(id).first<{ equipment_json: string }>();
		if (profile && typeof profile.equipment_json === "string") {
			const parsed = safeJson(profile.equipment_json);
			if (Array.isArray(parsed)) {
				const labels: string[] = [];
				for (const item of parsed) {
					if (typeof item === "string" && item.trim()) labels.push(item.trim());
					else if (item && typeof item === "object") {
						const rec = item as Record<string, unknown>;
						const label = typeof rec.label === "string" ? rec.label
							: typeof rec.name === "string" ? rec.name
							: typeof rec.equipment === "string" ? rec.equipment
							: null;
						if (label) labels.push(label);
					}
				}
				// Cross-reference with equipment claims when the table exists.
				let claimed = new Set<string>();
				try {
					const claims = await env.DB.prepare(
						`SELECT equipment FROM mise_equipment_claims
						 WHERE household_id = ?`,
					).bind(id).all<{ equipment: string }>();
					claimed = new Set((claims.results || []).map(r => (r.equipment || "").toLowerCase()).filter(Boolean));
				} catch {
					// Claims table missing — treat the whole equipment list as
					// "possibly idle." We still return it; the trigger fires on
					// list.length > 0 which is fine for week-1 calibration.
				}
				deps.idle_equipment = labels.filter(l => !claimed.has(l.toLowerCase()));
			}
		}
	} catch {
		// Profile table missing.
	}

	// ---- New-member signal --------------------------------------------------
	try {
		const fourteenDaysAgo = new Date(now_ms - 14 * 24 * 60 * 60 * 1000).toISOString();
		const newest = await env.DB.prepare(
			`SELECT created_at FROM mise_household_members
			 WHERE household_id = ?
			 ORDER BY created_at DESC`,
		).bind(id).first<{ created_at: string }>();
		if (newest && typeof newest.created_at === "string") {
			deps.new_member_recent = newest.created_at >= fourteenDaysAgo;
		}
	} catch {
		// Members table missing.
	}

	return deps;
}

// ─── Hook evaluator + template renderer ─────────────────────────────────────

export interface EvaluateHookResult {
	fires: boolean;
	bonus: number;            // 1.5 if fires, 1.0 otherwise
	rendered_text: string;    // template filled with deps; falls back to template if no template
}

const FIRE_BONUS = 1.5;
const NO_FIRE_BONUS = 1.0;

/**
 * Evaluate whether a hooked question's trigger fires given the current deps.
 * Returns the bonus multiplier the scheduler should apply, plus the rendered
 * question_text (template-filled with deps).
 *
 * For a non-hooked Question (tier 0/1) this returns {fires:true, bonus:1.0}
 * since those don't have triggers — the scheduler always considers them.
 */
export function evaluateHook(
	question: Question | HookedQuestion,
	deps: HookDeps,
): EvaluateHookResult {
	if (!isHookedQuestion(question)) {
		return {
			fires: true,
			bonus: NO_FIRE_BONUS,
			rendered_text: question.question_text,
		};
	}
	const fires = evaluateTrigger(question.trigger_kind, deps);
	const rendered_text = renderTemplate(question.text_template, deps);
	return {
		fires,
		bonus: fires ? FIRE_BONUS : NO_FIRE_BONUS,
		rendered_text,
	};
}

/**
 * Pure trigger evaluator. Exported so the scheduler can pre-filter without
 * paying for the template render.
 */
export function evaluateTrigger(kind: TriggerKind, deps: HookDeps): boolean {
	switch (kind) {
		// Tier 2 ------------------------------------------------------------
		case "skipped_meal":
			return deps.recent_cancellations > 0;
		case "cuisine_streak":
			return deps.dominant_cuisine_streak >= 3;
		case "anchor_repeat":
			return deps.repeat_ingredient !== null && deps.repeat_ingredient_count >= 4;
		case "equipment_unused":
			return deps.idle_equipment.length > 0;
		case "weekend_food":
			return deps.weeks_active === 1 && deps.is_weekend;
		case "takeout_night":
			return deps.recent_takeout_cancellations > 0;

		// Tier 3 ------------------------------------------------------------
		case "tired_night_default":
			return deps.tired_mentions_recent >= 1;
		case "sunday_morning":
			return deps.is_sunday_morning;
		case "loved_meal_followup":
			return deps.recent_high_taste_meal_id !== null;
		case "holiday_approach":
			return typeof deps.days_until_next_holiday === "number"
				&& deps.days_until_next_holiday >= 0
				&& deps.days_until_next_holiday <= 7;
		case "cancel_alternative":
			return deps.recent_cancellations > 0;
		case "perfect_on_paper":
			// Heuristic — requires Phase C taste-prior signal that doesn't
			// exist yet. Default to NOT firing.
			return false;
		case "growing_up_meal":
			return deps.is_sunday_morning || deps.weeks_active >= 4;
		case "cook_alone_or_together":
			// Opportunistic — fires after 4+ weeks active, no other signal.
			return deps.weeks_active >= 4;
		case "leftover_philosophy":
			return deps.weeks_active >= 4;
		case "tired_response_pattern":
			return deps.tired_mentions_recent >= 3;

		// Tier 4 ------------------------------------------------------------
		case "season_summer":
			return deps.current_month === 6;
		case "season_fall":
			return deps.current_month === 9;
		case "season_winter":
			return deps.current_month === 12;
		case "season_spring":
			return deps.current_month === 3;
		case "new_member":
			return deps.new_member_recent;
		case "hosting_uptick":
			return typeof deps.avg_meal_people === "number"
				&& typeof deps.avg_meal_people_prior === "number"
				&& deps.avg_meal_people > deps.avg_meal_people_prior + 0.5;

		default:
			return false;
	}
}

/**
 * Render a `${var}` template against HookDeps. Missing keys become '' rather
 * than throwing — the scheduler should never crash on a stale template.
 * Numeric values render as plain decimal; null/undefined render as ''.
 */
export function renderTemplate(template: string, deps: HookDeps): string {
	if (!template || typeof template !== "string") return "";
	const valueMap: Record<string, unknown> = {
		now_ms: deps.now_ms,
		recent_cancellations: deps.recent_cancellations,
		recent_takeout_cancellations: deps.recent_takeout_cancellations,
		dominant_cuisine_streak: deps.dominant_cuisine_streak,
		dominant_cuisine: deps.dominant_cuisine,
		repeat_ingredient: deps.repeat_ingredient,
		repeat_ingredient_count: deps.repeat_ingredient_count,
		idle_equipment: deps.idle_equipment.join(", "),
		idle_equipment_label: deps.idle_equipment[0] ?? "",
		weeks_active: deps.weeks_active,
		is_weekend: deps.is_weekend,
		is_sunday_morning: deps.is_sunday_morning,
		current_month: deps.current_month,
		recent_high_taste_meal_id: deps.recent_high_taste_meal_id,
		recent_high_taste_meal_label: deps.recent_high_taste_meal_label,
		days_until_next_holiday: deps.days_until_next_holiday,
		next_holiday_label: deps.next_holiday_label,
		tired_mentions_recent: deps.tired_mentions_recent,
		new_member_recent: deps.new_member_recent,
		avg_meal_people: deps.avg_meal_people,
		avg_meal_people_prior: deps.avg_meal_people_prior,
		engagement_signal: deps.engagement_signal,
	};
	return template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
		const v = valueMap[key];
		if (v === null || v === undefined) return "";
		if (typeof v === "number") return String(v);
		if (typeof v === "boolean") return v ? "yes" : "no";
		return String(v);
	});
}

// ─── Chattiness filter ──────────────────────────────────────────────────────

/**
 * Phase D budget-aware question pre-filter. Engagement < 0.7 (terse user)
 * gates out tier 3/4 entirely — they're deeper, opportunistic prompts that
 * a low-chatter user shouldn't see. Engagement >= 1.4 (chatty user) allows
 * up to TWO questions per brief; the scheduler caller decides whether to
 * actually pick a second one based on what's available.
 */
export interface ChattinessFilterResult<Q> {
	allowed: Q[];
	max_questions: 1 | 2;
	gated: Q[];
}

export function applyChattinessFilter<Q extends { tier: number }>(
	questions: ReadonlyArray<Q>,
	engagement_signal: number,
): ChattinessFilterResult<Q> {
	const sig = Number.isFinite(engagement_signal) ? engagement_signal : 1.0;
	const allowed: Q[] = [];
	const gated: Q[] = [];
	if (sig < 0.7) {
		// Terse — only tier 0/1/2.
		for (const q of questions) {
			if (q.tier <= 2) allowed.push(q);
			else gated.push(q);
		}
	} else {
		for (const q of questions) allowed.push(q);
	}
	const max_questions: 1 | 2 = sig >= 1.4 ? 2 : 1;
	return { allowed, max_questions, gated };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isHookedQuestion(q: Question | HookedQuestion): q is HookedQuestion {
	return typeof (q as HookedQuestion).trigger_kind === "string"
		&& typeof (q as HookedQuestion).text_template === "string";
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

interface NextHoliday { days: number; label: string }

function nextHoliday(now: Date): NextHoliday | null {
	const ms = now.getTime();
	const year = now.getUTCFullYear();
	let best: NextHoliday | null = null;
	for (const h of HOLIDAYS_BY_MONTH_DAY) {
		// Try this year and next year.
		for (const y of [year, year + 1]) {
			const candidate = Date.UTC(y, h.month - 1, h.day);
			if (candidate < ms) continue;
			const days = Math.round((candidate - ms) / (24 * 60 * 60 * 1000));
			if (days > 30) continue;
			if (!best || days < best.days) {
				best = { days, label: h.label };
			}
		}
	}
	return best;
}
