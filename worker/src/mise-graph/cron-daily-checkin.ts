// Daily check-in cron entry point.
//
// Wired into the Cloudflare Worker `scheduled()` handler by Wave 5F. Fires
// each morning, walks every active plan that covers "today" within its
// start_date..end_date span, builds a per-household brief context, calls
// the mesh-claude bridge for natural-language phrasing, and writes the
// result to `mise_daily_briefs`.
//
// Designed to be safe to call from a manual admin endpoint as well — see
// `runDailyCheckinForToday` for the single-shot variant Wave 5F can expose
// for testing without waiting for cron.

import type { MiseGraphEnv } from "./types";
import type { MeshClaudeEnv } from "./llm-bridge";
import { listActivePlans, loadActivePlan } from "./active-plans";
import {
	buildDailyBriefContext,
	briefContextHasSignal,
	generateBrief,
	saveDailyBrief,
	type DailyBriefContext,
} from "./daily-brief";

// ─── Types ────────────────────────────────────────────────────────────────

export interface DailyCheckinSummary {
	households_processed: number;
	briefs_generated: number;
	errors: Array<{ household_id: string; error: string }>;
}

export interface DailyCheckinOpts {
	now?: string;            // ISO date "YYYY-MM-DD" override (defaults to UTC today)
	only_household?: string; // restrict to a single household for debugging / manual runs
}

// CronEnv is a MiseGraphEnv that ALSO has the mesh-bridge bindings populated.
// We treat the mesh as optional so the cron still runs (with deterministic
// fallback briefs) when the bridge isn't wired.
type CronEnv = MiseGraphEnv & Partial<MeshClaudeEnv>;

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Top-level handler invoked by the Cloudflare Worker scheduled trigger.
 *
 * Steps:
 *   1. Determine "today" (UTC; per-household tz support is a future improvement).
 *   2. List active plans (scoped to a single household when `only_household` is set).
 *   3. For each plan whose start_date <= today <= end_date:
 *        a. buildDailyBriefContext()
 *        b. Skip if context has nothing meaningful for today.
 *        c. generateBrief() via mesh-bridge (deterministic fallback if bridge errors).
 *        d. saveDailyBrief()
 *   4. Return per-run summary for logging.
 */
export async function handleDailyCheckin(
	env: CronEnv,
	opts: DailyCheckinOpts = {},
): Promise<DailyCheckinSummary> {
	const today = normalizeDate(opts.now) || todayUtc();
	const summary: DailyCheckinSummary = {
		households_processed: 0,
		briefs_generated: 0,
		errors: [],
	};

	let plans;
	try {
		plans = await listActivePlans(env, opts.only_household);
	} catch (err) {
		summary.errors.push({
			household_id: opts.only_household || "*",
			error: `listActivePlans failed: ${errMsg(err)}`,
		});
		return summary;
	}

	if (!plans || plans.length === 0) return summary;

	// De-duplicate by household — one plan per household per day. Keep the
	// most recently updated row.
	const planByHousehold = new Map<string, typeof plans[number]>();
	for (const p of plans) {
		if (!p.household_id) continue;
		const existing = planByHousehold.get(p.household_id);
		if (!existing || (p.updated_at || "") > (existing.updated_at || "")) {
			planByHousehold.set(p.household_id, p);
		}
	}

	for (const [household_id, summaryRow] of planByHousehold) {
		summary.households_processed += 1;
		try {
			const plan = await loadActivePlan(env, summaryRow.plan_id);
			if (!plan) continue;
			if (!planCoversDate(plan.start_date, plan.end_date, today)) continue;

			const ctx = buildDailyBriefContext(plan, today);
			if (!briefContextHasSignal(ctx)) continue;

			const brief = await generateBriefSafe(env, ctx);
			await saveDailyBrief(env, {
				household_id,
				plan_id: ctx.plan_id,
				for_date: today,
				brief_text: brief.text,
				brief_meta: brief.meta,
			});
			summary.briefs_generated += 1;
		} catch (err) {
			summary.errors.push({ household_id, error: errMsg(err) });
		}
	}

	return summary;
}

/**
 * Manual single-shot trigger so Wave 5F can expose an admin endpoint for
 * testing. When `household_id` is provided, restricts to that household;
 * otherwise behaves like the cron.
 */
export async function runDailyCheckinForToday(
	env: CronEnv,
	household_id?: string,
): Promise<{ briefs_generated: number }> {
	const summary = await handleDailyCheckin(env, household_id ? { only_household: household_id } : {});
	return { briefs_generated: summary.briefs_generated };
}

// ─── Internals ────────────────────────────────────────────────────────────

async function generateBriefSafe(
	env: CronEnv,
	ctx: DailyBriefContext,
): Promise<{ text: string; meta: Record<string, unknown> }> {
	if (!isMeshConfigured(env)) {
		return {
			text: composeFallbackText(ctx),
			meta: { fallback: true, reason: "mesh_not_configured" },
		};
	}
	return await generateBrief(env as MeshClaudeEnv, ctx);
}

function isMeshConfigured(env: CronEnv): env is CronEnv & MeshClaudeEnv {
	return !!env.MESH && typeof env.MESH.fetch === "function"
		&& !!env.BRIDGE_HOST && !!env.BRIDGE_PORT && !!env.BRIDGE_SECRET;
}

function composeFallbackText(ctx: DailyBriefContext): string {
	if (ctx.todays_meals.length === 0) return `Light day on the plan for ${ctx.for_date}.`;
	const dinner = ctx.todays_meals.find(m => m.slot === "dinner") || ctx.todays_meals[0];
	let text = `Today: ${dinner.title}.`;
	if (ctx.expiring_items.length > 0) {
		const e = ctx.expiring_items[0];
		text += ` Use the ${e.canonical_name} soon — turning in ${e.days_until} day(s).`;
	}
	return text;
}

function planCoversDate(start_date: string, end_date: string, today: string): boolean {
	if (!start_date || !end_date) return false;
	return start_date <= today && today <= end_date;
}

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

function normalizeDate(input?: string): string | null {
	if (!input) return null;
	if (/^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);
	return null;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
