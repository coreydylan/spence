// U102 — Wave 7F daily morning-brief cron sweep.
//
// The Agents SDK can't boot in node-side tests (it imports `cloudflare:workers`),
// so we exercise `runDailyMorningBriefSweep` against mock D1 with the DO
// invocation REPLACED by a stub that calls `computeMorningBrief` +
// `persistMorningBrief` directly. This locks the orchestration contract:
//   * Profiles + active-plans union → list of households
//   * Per-household errors are caught
//   * Briefs land in mise_household_agent_briefs with the right
//     household_id + for_date
//
// The real cron path (worker.scheduled() → DO /daily-brief) is tested by the
// HouseholdAgent route + the cron-runner sweep helpers running together.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	migrateDailyBriefsSchema,
	migrateHouseholdTimezoneColumn,
	migrateOnboardingSchema,
} from "../../src/mise-graph/schemas/migrations";
import {
	listSweepHouseholds,
	runDailyMorningBriefSweep,
	type HouseholdBriefInvoker,
} from "../../src/mise-graph/cron-runner";
import {
	computeMorningBrief,
	loadBriefForDate,
	persistMorningBrief,
} from "../../src/mise-graph/agents/household-cycles";
import { saveActivePlan } from "../../src/mise-graph/active-plans";
import type { Env } from "../../src/mise-graph-worker";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u102: Scenario = {
	id: "u102",
	name: "Wave 7F: cron sweep enumerates households + invokes per-household briefs + survives bad rows",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as unknown as Env;

		// ── 1. Apply schemas ─────────────────────────────────────────────────
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateHouseholdTimezoneColumn(env);
		await migrateDailyBriefsSchema(env);
		// Active plans table (no shared migrate fn; ad-hoc CREATE)
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mise_active_plans (
			plan_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`).run();

		// ── 2. Seed 3 household profiles + a couple of active plans ─────────
		const now = "2026-05-08T00:00:00Z";
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_profiles (
				household_id, display_name, people_count,
				dietary_json, equipment_json, current_anchors_json,
				cuisine_preferences_json, default_pantry_json,
				shop_preferences_json, notes,
				created_at, updated_at, timezone
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			"hh_a", "Household A", 2,
			"[]", "[]", "[]", "{}", "[]", null, null,
			now, now, "America/Los_Angeles",
		).run();

		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_profiles (
				household_id, display_name, people_count,
				dietary_json, equipment_json, current_anchors_json,
				cuisine_preferences_json, default_pantry_json,
				shop_preferences_json, notes,
				created_at, updated_at, timezone
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			"hh_b", "Household B", 4,
			"[]", "[]", "[]", "{}", "[]", null, null,
			now, now, "America/New_York",
		).run();

		// hh_c lives only in mise_active_plans (no profile row).
		const planC = {
			id: "plan_c",
			household_id: "hh_c",
			title: "plan c",
			start_date: "2026-05-08",
			end_date: "2026-05-08",
			timezone: null,
			people: 2,
			status: "draft",
			constraints: {},
			selected_ingredients: [],
			source_recipe_ids: [],
			meals_by_day: [],
			component_batches: [],
			prep_tasks: [],
			breakfasts: [],
			snack_boxes: [],
			shopping_list: [],
			shop_runs: [],
			storage_labels: [],
			meta: { generated_by: "test", deterministic: true },
		} as unknown as MiseWeeklyPlanDraft;
		await saveActivePlan(env, planC);

		// ── 3. listSweepHouseholds returns the union ─────────────────────────
		const sweepRows = await listSweepHouseholds(env);
		ctx.assert.eq(sweepRows.length, 3, "3 households scanned (2 profiles + 1 active-plan only)");
		const ids = sweepRows.map(r => r.household_id).sort();
		ctx.assert.eq(ids[0], "hh_a", "hh_a in sweep");
		ctx.assert.eq(ids[1], "hh_b", "hh_b in sweep");
		ctx.assert.eq(ids[2], "hh_c", "hh_c in sweep (active-plan-only household picked up)");

		const aRow = sweepRows.find(r => r.household_id === "hh_a")!;
		const bRow = sweepRows.find(r => r.household_id === "hh_b")!;
		const cRow = sweepRows.find(r => r.household_id === "hh_c")!;
		ctx.assert.eq(aRow.timezone, "America/Los_Angeles", "hh_a tz from profile");
		ctx.assert.eq(bRow.timezone, "America/New_York", "hh_b tz from profile");
		ctx.assert.eq(cRow.timezone, "America/Los_Angeles", "hh_c falls back to default tz when no profile");

		// ── 4. Run the sweep with a stub invoker that emulates the DO ───────
		const invokerCalls: Array<{ hh: string; tz: string; date: string }> = [];
		const invoker: HouseholdBriefInvoker = async (hh, tz, for_date) => {
			invokerCalls.push({ hh, tz, date: for_date });
			const brief = await computeMorningBrief(env, hh, {
				now: new Date(`${for_date}T14:00:00Z`),
				skip_weather: true,
			});
			await persistMorningBrief(env, brief);
			return true;
		};

		const result = await runDailyMorningBriefSweep(
			env,
			Date.parse("2026-05-08T14:00:00Z"),
			{ invoke: invoker },
		);

		ctx.assert.eq(result.for_date, "2026-05-08", "sweep computed for_date from scheduled time");
		ctx.assert.eq(result.households_scanned, 3, "all 3 households scanned");
		ctx.assert.eq(result.briefs_generated, 3, "3 briefs generated");
		ctx.assert.eq(result.errors.length, 0, "no errors");
		ctx.assert.eq(result.skipped.length, 0, "nothing skipped");
		ctx.assert.eq(invokerCalls.length, 3, "invoker fired once per household");

		// Verify each invoker call passed the right tz + date.
		const callA = invokerCalls.find(c => c.hh === "hh_a");
		const callB = invokerCalls.find(c => c.hh === "hh_b");
		const callC = invokerCalls.find(c => c.hh === "hh_c");
		ctx.assert.ok(!!callA && callA.tz === "America/Los_Angeles", "hh_a invoked with PT");
		ctx.assert.ok(!!callB && callB.tz === "America/New_York", "hh_b invoked with ET");
		ctx.assert.ok(!!callC && callC.tz === "America/Los_Angeles", "hh_c invoked with default tz");
		ctx.assert.eq(callA!.date, "2026-05-08", "for_date passed through");

		// ── 5. Verify briefs persisted with right shape ──────────────────────
		const briefA = await loadBriefForDate(env, "hh_a", "2026-05-08");
		const briefB = await loadBriefForDate(env, "hh_b", "2026-05-08");
		const briefC = await loadBriefForDate(env, "hh_c", "2026-05-08");
		ctx.assert.ok(!!briefA, "hh_a brief persisted");
		ctx.assert.ok(!!briefB, "hh_b brief persisted");
		ctx.assert.ok(!!briefC, "hh_c brief persisted");
		ctx.assert.eq(briefA!.household_id, "hh_a", "hh_a brief carries household_id");
		ctx.assert.eq(briefA!.for_date, "2026-05-08", "hh_a brief for the right date");
		ctx.assert.eq(briefB!.household_id, "hh_b", "hh_b brief carries household_id");
		ctx.assert.eq(briefC!.household_id, "hh_c", "hh_c brief carries household_id");

		// ── 6. Sweep tolerates an invoker error on one household ─────────────
		const failureInvoker: HouseholdBriefInvoker = async (hh, tz, for_date) => {
			if (hh === "hh_b") throw new Error("simulated DO failure");
			const brief = await computeMorningBrief(env, hh, {
				now: new Date(`${for_date}T15:00:00Z`),
				skip_weather: true,
			});
			await persistMorningBrief(env, brief);
			return true;
		};
		const failResult = await runDailyMorningBriefSweep(
			env,
			Date.parse("2026-05-09T14:00:00Z"),
			{ invoke: failureInvoker },
		);
		ctx.assert.eq(failResult.households_scanned, 3, "sweep still scans 3 households when 1 fails");
		ctx.assert.eq(failResult.briefs_generated, 2, "2 briefs generated despite hh_b failure");
		ctx.assert.eq(failResult.errors.length, 1, "1 error captured");
		ctx.assert.eq(failResult.errors[0].household_id, "hh_b", "error attributed to hh_b");
		ctx.assert.contains(failResult.errors[0].error, "simulated DO failure", "error message preserved");

		// ── 7. Sweep handles "agent returned no brief" as a skip, not an error ─
		const skipInvoker: HouseholdBriefInvoker = async () => false;
		const skipResult = await runDailyMorningBriefSweep(
			env,
			Date.parse("2026-05-10T14:00:00Z"),
			{ invoke: skipInvoker },
		);
		ctx.assert.eq(skipResult.briefs_generated, 0, "no briefs when invoker returns false");
		ctx.assert.eq(skipResult.skipped.length, 3, "all 3 marked skipped");
		ctx.assert.eq(skipResult.errors.length, 0, "no errors on skip");
		ctx.assert.eq(skipResult.skipped[0].reason, "agent_returned_no_brief", "skip reason captured");

		ctx.notes.push(`sweep at_iso: ${result.at}`);
		ctx.notes.push(`sweep generated: ${result.briefs_generated} briefs`);
		ctx.notes.push(`hh_b failure path: ${failResult.errors[0].error}`);
	},
};

export default u102;
