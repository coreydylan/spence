// Daily brief module — context-builder + bridge agent caller + persistence.
// The morning cron walks every active plan that covers "today", builds a
// focused per-household context, asks the mesh bridge for a conversational
// brief, and writes it to `mise_daily_briefs`. Wave 5F surfaces the row.

import type { MiseWeeklyPlanDraft, MisePlanComponentBatch, MisePlanMeal, MiseSnackBox, MisePlanTask } from "./planner";
import { ledgerFromPlan, type ResourceItem } from "./resource-ledger";
import { runHardCritics, runWarningCritics, type Grievance } from "./critics";
import { callMeshClaude, type MeshClaudeEnv } from "./llm-bridge";
import type { MiseGraphEnv } from "./types";

export type CookWindow = "morning" | "afternoon" | "evening";

export interface DailyBriefMealEntry {
	slot: string; title: string; cuisine: string[]; format: string;
	leftover_source?: string;       // upstream meal id when this meal eats a leftover
	component_uses: string[];       // batch labels this meal consumes today
}
export interface DailyBriefCookEntry {
	title: string; active_min: number; idle_min: number; starts_at_window?: CookWindow;
}
export interface DailyBriefShopRun {
	item_count: number; label: string; items_preview: string[];
}
export interface DailyBriefExpiringItem {
	canonical_name: string; qty: number | null; unit: string | null;
	expires_at: string; days_until: number;
}
export interface DailyBriefGrievance {
	severity: string; message: string; suggested_repair: string | null;
}

export interface DailyBriefContext {
	household_id: string;
	plan_id: string | null;
	for_date: string;                   // YYYY-MM-DD
	todays_meals: DailyBriefMealEntry[];
	todays_cooks: DailyBriefCookEntry[];
	todays_shop_run?: DailyBriefShopRun;
	expiring_items: DailyBriefExpiringItem[];
	upcoming_grievances: DailyBriefGrievance[];
}

/**
 * Project a household + day situation from the active plan + ledger.
 * Pure function — no I/O. Caller decides "today" via `for_date`.
 */
export function buildDailyBriefContext(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefContext {
	const ctx: DailyBriefContext = {
		household_id: plan.household_id || "",
		plan_id: plan.id || null,
		for_date,
		todays_meals: collectTodaysMeals(plan, for_date),
		todays_cooks: collectTodaysCooks(plan, for_date),
		expiring_items: collectExpiringItems(plan, for_date),
		upcoming_grievances: collectUpcomingGrievances(plan, for_date),
	};
	const shopRun = collectTodaysShopRun(plan, for_date);
	if (shopRun) ctx.todays_shop_run = shopRun;
	return ctx;
}

function collectTodaysMeals(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefMealEntry[] {
	const allMeals: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) {
		if (day.date === for_date) for (const m of day.meals || []) allMeals.push(m);
	}
	for (const b of plan.breakfasts || []) if (b.date === for_date) allMeals.push(b);

	const batchLabelById = new Map<string, string>();
	for (const batch of plan.component_batches || []) batchLabelById.set(batch.id, batch.label);

	const mealById = new Map<string, MisePlanMeal>();
	for (const day of plan.meals_by_day || []) for (const m of day.meals || []) mealById.set(m.id, m);
	for (const b of plan.breakfasts || []) mealById.set(b.id, b);

	const out: DailyBriefMealEntry[] = [];
	for (const meal of allMeals) {
		const component_uses = (meal.component_ids || [])
			.map(cid => batchLabelById.get(cid))
			.filter((label): label is string => Boolean(label));
		// leftover_source: another meal whose leftovers_to claims this meal.
		let leftover_source: string | undefined;
		for (const other of mealById.values()) {
			if (other.id !== meal.id && (other.leftovers_to || []).includes(meal.id)) {
				leftover_source = other.id;
				break;
			}
		}
		const entry: DailyBriefMealEntry = {
			slot: meal.slot,
			title: meal.title,
			cuisine: Array.isArray(meal.cuisine) ? meal.cuisine.slice() : [],
			format: meal.format || "",
			component_uses,
		};
		if (leftover_source) entry.leftover_source = leftover_source;
		out.push(entry);
	}
	for (const box of plan.snack_boxes || []) {
		if (box.date !== for_date) continue;
		out.push({
			slot: "snack",
			title: box.title,
			cuisine: [],
			format: "snack box",
			component_uses: (box.component_ids || [])
				.map(cid => batchLabelById.get(cid))
				.filter((label): label is string => Boolean(label)),
		});
	}
	return out;
}

function collectTodaysCooks(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefCookEntry[] {
	const tasks = (plan.prep_tasks || []).filter(t => t.scheduled_date === for_date);
	if (tasks.length === 0) return [];

	// Group by session_order so multi-task sessions surface as one cook.
	const bySession = new Map<number, MisePlanTask[]>();
	for (const t of tasks) {
		const list = bySession.get(t.session_order) || [];
		list.push(t);
		bySession.set(t.session_order, list);
	}
	const out: DailyBriefCookEntry[] = [];
	for (const key of Array.from(bySession.keys()).sort((a, b) => a - b)) {
		const session = bySession.get(key)!;
		const titles = session.map(t => t.title).filter(Boolean);
		const title = titles.length === 1 ? titles[0] : titles.join(" + ");
		const entry: DailyBriefCookEntry = {
			title: title || "Prep session",
			active_min: session.reduce((acc, t) => acc + (t.active_time_min || 0), 0),
			idle_min: session.reduce((acc, t) => acc + (t.idle_time_min || 0), 0),
		};
		const window = inferCookWindow(session);
		if (window) entry.starts_at_window = window;
		out.push(entry);
	}
	return out;
}

function inferCookWindow(session: MisePlanTask[]): CookWindow | undefined {
	for (const t of session) {
		const meta = t.meta as Record<string, unknown> | undefined;
		const w = meta?.window || meta?.starts_at_window;
		if (w === "morning" || w === "afternoon" || w === "evening") return w;
		const tags = (t.station_tags || []).map(s => s.toLowerCase());
		if (tags.includes("morning")) return "morning";
		if (tags.includes("afternoon")) return "afternoon";
		if (tags.includes("evening")) return "evening";
	}
	const idle = session.reduce((acc, t) => acc + (t.idle_time_min || 0), 0);
	if (idle >= 240) return "evening";
	return undefined;
}

function collectTodaysShopRun(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefShopRun | undefined {
	const todays = (plan.shop_runs || []).find(r => r.date === for_date);
	if (!todays) return undefined;
	const wantedCats = new Set((todays.categories || []).map(c => c.toLowerCase()));
	const previews: string[] = [];
	for (const section of plan.shopping_list || []) {
		if (wantedCats.size > 0 && !wantedCats.has(section.category.toLowerCase())) continue;
		for (const item of section.items || []) {
			if (previews.length >= 5) break;
			previews.push(item.name);
		}
		if (previews.length >= 5) break;
	}
	return {
		item_count: todays.item_count || previews.length,
		label: todays.label || "Shop run",
		items_preview: previews,
	};
}

function collectExpiringItems(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefExpiringItem[] {
	const ledger = ledgerFromPlan(plan);
	const expiring: ResourceItem[] = ledger.expiring_by(for_date, 2);
	return expiring.map(item => ({
		canonical_name: item.canonical_name,
		qty: item.qty || null,
		unit: item.unit || null,
		expires_at: item.expires_at || for_date,
		days_until: daysBetween(for_date, item.expires_at || for_date),
	}));
}

function collectUpcomingGrievances(plan: MiseWeeklyPlanDraft, for_date: string): DailyBriefGrievance[] {
	const grievances: Grievance[] = [
		...runHardCritics(plan, {}),
		...runWarningCritics(plan, { now: for_date }),
	];
	const out: DailyBriefGrievance[] = [];
	for (const g of grievances) {
		// "Upcoming" = touches today or a date in the next 3 days.
		const slotDate = g.slot_ref?.date;
		if (slotDate) {
			const days = daysBetween(for_date, slotDate);
			if (days < 0 || days > 3) continue;
		}
		out.push({
			severity: g.severity,
			message: g.message,
			suggested_repair: g.suggested_repair || null,
		});
	}
	return out;
}

const SYSTEM_PROMPT = `You are Spence — a household chef-of-staff checking in with a family for the day.
Your tone is warm, concise, and action-oriented. You speak like a thoughtful prep cook
giving a 90-second standup: what's on the schedule today, what to use up before it
turns, and what concrete moves to make. No bullet salads, no headers, no markdown
fences. 1-3 short paragraphs MAX. Focus on what's different about today —
don't restate the entire week.`;

/** Compose a brief via mesh-bridge. Falls back deterministically on error. */
export async function generateBrief(
	env: MeshClaudeEnv,
	context: DailyBriefContext,
): Promise<{ text: string; meta: Record<string, unknown> }> {
	const prompt = buildBriefPrompt(context);
	const response = await callMeshClaude(env, { prompt, system: SYSTEM_PROMPT });
	const meta: Record<string, unknown> = {
		context_summary: summarizeContextForMeta(context),
		bridge_session_id: response.sessionId,
		bridge_elapsed_ms: response.elapsedMs,
	};
	if (response.ok && response.text && response.text.trim()) {
		return { text: response.text.trim(), meta };
	}
	const fallback = composeFallbackBrief(context);
	meta.fallback = true;
	if (response.error) meta.bridge_error = response.error;
	return { text: fallback, meta };
}

function buildBriefPrompt(ctx: DailyBriefContext): string {
	const json = JSON.stringify({
		for_date: ctx.for_date,
		todays_meals: ctx.todays_meals,
		todays_cooks: ctx.todays_cooks,
		todays_shop_run: ctx.todays_shop_run,
		expiring_items: ctx.expiring_items,
		upcoming_grievances: ctx.upcoming_grievances,
	}, null, 2);
	return [
		`You're checking in with the household for ${ctx.for_date}.`,
		`Here is the day's context as JSON. Use it to compose the brief — DO NOT echo the JSON back.`,
		"```json", json, "```",
		`Write a short, conversational, action-oriented brief — 1 to 3 paragraphs maximum.`,
		`Lead with what's on the menu tonight. Mention any item that's about to turn and how today's plan uses it.`,
		`If there's a cook session today, name the active time. If a shop run is scheduled, mention the headline items.`,
		`If a grievance is suggesting a real-time repair, surface it as a suggestion at the end.`,
	].join("\n\n");
}

function summarizeContextForMeta(ctx: DailyBriefContext): Record<string, unknown> {
	return {
		meals: ctx.todays_meals.length,
		cooks: ctx.todays_cooks.length,
		expiring: ctx.expiring_items.length,
		grievances: ctx.upcoming_grievances.length,
		has_shop_run: !!ctx.todays_shop_run,
	};
}

function composeFallbackBrief(ctx: DailyBriefContext): string {
	const parts: string[] = [];
	if (ctx.todays_meals.length > 0) {
		const dinner = ctx.todays_meals.find(m => m.slot === "dinner") || ctx.todays_meals[0];
		parts.push(`Today: ${dinner.title}.`);
	} else {
		parts.push(`Quiet day on the plan — nothing scheduled.`);
	}
	if (ctx.expiring_items.length > 0) {
		const first = ctx.expiring_items[0];
		parts.push(`Heads up: ${first.canonical_name} is turning in ${first.days_until} day(s) — use it soon.`);
	}
	if (ctx.todays_cooks.length > 0) {
		const cook = ctx.todays_cooks[0];
		parts.push(`Prep: ${cook.title} (${cook.active_min} min active).`);
	}
	if (ctx.todays_shop_run) {
		parts.push(`Shop run: ${ctx.todays_shop_run.label} (${ctx.todays_shop_run.item_count} items).`);
	}
	return parts.join(" ");
}

export interface SaveBriefInput {
	household_id: string; plan_id: string | null; for_date: string;
	brief_text: string; brief_meta: Record<string, unknown>;
}

/** Idempotent upsert on (household_id, for_date). Resets delivered on re-save. */
export async function saveDailyBrief(env: MiseGraphEnv, brief: SaveBriefInput): Promise<{ brief_id: string }> {
	const brief_id = makeBriefId(brief.household_id, brief.for_date);
	await env.DB.prepare(`
		INSERT INTO mise_daily_briefs
			(brief_id, household_id, plan_id, for_date, generated_at, brief_text, brief_meta_json, delivered, delivered_at, delivery_channel)
		VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, NULL, NULL)
		ON CONFLICT(brief_id) DO UPDATE SET
			plan_id         = excluded.plan_id,
			generated_at    = excluded.generated_at,
			brief_text      = excluded.brief_text,
			brief_meta_json = excluded.brief_meta_json,
			delivered       = FALSE,
			delivered_at    = NULL,
			delivery_channel = NULL
	`).bind(
		brief_id,
		brief.household_id,
		brief.plan_id,
		brief.for_date,
		nowIso(),
		brief.brief_text,
		JSON.stringify(brief.brief_meta || {}),
	).run();
	return { brief_id };
}

export interface UndeliveredBrief { brief_id: string; for_date: string; brief_text: string; }

export async function listUndeliveredBriefs(env: MiseGraphEnv, household_id: string): Promise<UndeliveredBrief[]> {
	const result = await env.DB.prepare(`
		SELECT brief_id, for_date, brief_text
		FROM mise_daily_briefs
		WHERE household_id = ? AND delivered = FALSE
		ORDER BY for_date DESC
		LIMIT 50
	`).bind(household_id).all<{ brief_id: string; for_date: string; brief_text: string }>();
	return (result.results || []).map(row => ({
		brief_id: row.brief_id,
		for_date: row.for_date,
		brief_text: row.brief_text,
	}));
}

export async function markBriefDelivered(env: MiseGraphEnv, brief_id: string, channel: string): Promise<void> {
	await env.DB.prepare(`
		UPDATE mise_daily_briefs
		SET delivered = TRUE, delivered_at = ?, delivery_channel = ?
		WHERE brief_id = ?
	`).bind(nowIso(), channel, brief_id).run();
}

export interface BriefForDate { brief_id: string; brief_text: string; brief_meta: Record<string, unknown>; }

export async function getBriefForDate(env: MiseGraphEnv, household_id: string, for_date: string): Promise<BriefForDate | null> {
	const row = await env.DB.prepare(`
		SELECT brief_id, brief_text, brief_meta_json
		FROM mise_daily_briefs
		WHERE household_id = ? AND for_date = ?
		LIMIT 1
	`).bind(household_id, for_date).first<{ brief_id: string; brief_text: string; brief_meta_json: string | null }>();
	if (!row) return null;
	let meta: Record<string, unknown> = {};
	if (row.brief_meta_json) {
		try { meta = JSON.parse(row.brief_meta_json) as Record<string, unknown>; }
		catch { meta = {}; }
	}
	return { brief_id: row.brief_id, brief_text: row.brief_text, brief_meta: meta };
}

/** True when the context has at least one signal worth briefing on. */
export function briefContextHasSignal(ctx: DailyBriefContext): boolean {
	return ctx.todays_meals.length > 0
		|| ctx.todays_cooks.length > 0
		|| !!ctx.todays_shop_run
		|| ctx.expiring_items.length > 0
		|| ctx.upcoming_grievances.length > 0;
}

function makeBriefId(household_id: string, for_date: string): string {
	const safeHh = (household_id || "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
	return `brief:${safeHh}:${for_date}`;
}

function nowIso(): string { return new Date().toISOString(); }

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000);
}

// Re-export so callers don't need a second import line.
export type { MisePlanComponentBatch, MiseSnackBox };
