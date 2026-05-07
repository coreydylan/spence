// U46 — HouseholdAgent lifecycle: morning brief pure helpers + persistence.
//
// The Agents SDK can't boot in node (it imports `cloudflare:workers`), so we
// exercise the *extracted* pure / D1-only helpers from agents/household-cycles.ts
// directly. This locks the contract that the DO is wrapping with state +
// alarm scheduling. Wave 7B Phase 2 (or a future miniflare scenario) will
// drive the DO HTTP routes end-to-end.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateDailyBriefsSchema } from "../../src/mise-graph/schemas/migrations";
import {
	buildPlanHealthSnapshot,
	buildSuggestions,
	computeMorningBrief,
	isoDate,
	loadLatestBrief,
	nextLocal7am,
	nextNDates,
	persistMorningBrief,
} from "../../src/mise-graph/agents/household-cycles";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u46: Scenario = {
	id: "u46",
	name: "HouseholdAgent: morning brief pure helpers + persistence + load round-trip",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. nextLocal7am rolls forward when target has passed ─────────────
		const before7 = new Date("2026-05-13T13:30:00Z");
		const target1 = nextLocal7am(before7);
		ctx.assert.eq(
			target1.toISOString(),
			"2026-05-13T14:00:00.000Z",
			"nextLocal7am: same-day target when before 14:00Z",
		);
		const after7 = new Date("2026-05-13T14:30:00Z");
		const target2 = nextLocal7am(after7);
		ctx.assert.eq(
			target2.toISOString(),
			"2026-05-14T14:00:00.000Z",
			"nextLocal7am: rolls to next day when past 14:00Z",
		);

		// ── 2. nextNDates is inclusive of today ──────────────────────────────
		const dates = nextNDates(new Date("2026-05-13T12:00:00Z"), 3);
		ctx.assert.eq(dates.length, 3, "nextNDates returns N dates");
		ctx.assert.eq(dates[0], "2026-05-13", "first date is today");
		ctx.assert.eq(dates[2], "2026-05-15", "last date is today + (N-1)");

		ctx.assert.eq(isoDate(new Date("2026-05-13T23:59:59Z")), "2026-05-13", "isoDate slices YYYY-MM-DD");

		// ── 3. buildPlanHealthSnapshot returns shape with grievance counts ─
		const plan: MiseWeeklyPlanDraft = makeMinimalPlan("p1", "hh_a", "2026-05-13");
		const snapshot = buildPlanHealthSnapshot(plan, "2026-05-13");
		ctx.assert.eq(snapshot.plan_id, "p1", "snapshot carries plan_id");
		ctx.assert.gte(snapshot.hard_grievance_count, 0, "hard count is a non-negative integer");
		ctx.assert.gte(snapshot.warning_grievance_count, 0, "warning count is a non-negative integer");
		ctx.assert.eq(Array.isArray(snapshot.missed_prep_today), true, "missed_prep_today is an array");

		// Add a missed prep task (scheduled_date < today).
		plan.prep_tasks = [
			{
				id: "task1",
				scheduled_date: "2026-05-12",
				session_order: 0,
				task_type: "knife",
				title: "dice onion",
				station_tags: [],
				equipment: [],
				depends_on: [],
				state_inputs: [],
				state_outputs: [],
				active_time_min: 5,
				idle_time_min: 0,
				instructions: [],
				status: "planned",
				meta: {},
			},
		];
		const snapshot2 = buildPlanHealthSnapshot(plan, "2026-05-13");
		ctx.assert.eq(snapshot2.missed_prep_today.length, 1, "missed prep detected");
		ctx.assert.eq(snapshot2.missed_prep_today[0], "dice onion", "missed prep title captured");

		// ── 4. buildSuggestions surfaces missed prep + tight cook windows ──
		const suggestions = buildSuggestions(
			[snapshot2],
			[
				{
					date: "2026-05-13",
					busy_blocks: [],
					cook_window: { start: "2026-05-13T17:30", end: "2026-05-13T18:00", duration_min: 30 },
				},
			],
			"2026-05-13",
		);
		ctx.assert.gte(suggestions.length, 1, "suggestions produced");
		const missedPrepKinds = suggestions.map(s => s.kind);
		ctx.assert.contains(missedPrepKinds, "missed_prep", "missed_prep suggestion present");
		ctx.assert.contains(missedPrepKinds, "tight_window", "tight_window suggestion present (30min < 45)");

		// ── 5. computeMorningBrief end-to-end against mock D1 (no plans loaded) ─
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateDailyBriefsSchema(env);

		const brief = await computeMorningBrief(env, "hh_a", {
			now: new Date("2026-05-13T15:00:00Z"),
			skip_weather: true,
		});
		ctx.assert.eq(brief.household_id, "hh_a", "brief carries household_id");
		ctx.assert.eq(brief.for_date, "2026-05-13", "brief.for_date is today");
		ctx.assert.eq(brief.weather, null, "weather null when skip_weather=true");
		ctx.assert.eq(brief.calendar.length, 3, "calendar covers 3 days");
		ctx.assert.eq(brief.plan_health.length, 0, "plan_health empty when no plans loaded");

		// ── 6. persistMorningBrief + loadLatestBrief round-trip ─────────────
		const persisted = await persistMorningBrief(env, brief);
		ctx.assert.eq(persisted.household_id, "hh_a", "persist returns household_id");
		ctx.assert.matches(persisted.id, /^brief_/, "persisted id is namespaced");

		const loaded = await loadLatestBrief(env, "hh_a");
		ctx.assert.ok(!!loaded, "loadLatestBrief returns the persisted row");
		ctx.assert.eq(loaded!.household_id, "hh_a", "loaded household_id round-trips");
		ctx.assert.eq(loaded!.for_date, "2026-05-13", "loaded for_date round-trips");

		// Re-persist the same date — production D1 honours ON CONFLICT to
		// overwrite by (household_id, for_date). The mock D1 doesn't enforce
		// UNIQUE indexes, so we just verify loadLatestBrief picks up the
		// newest row by created_at_ms.
		const brief2 = await computeMorningBrief(env, "hh_a", {
			now: new Date("2026-05-13T16:00:00Z"),
			skip_weather: true,
		});
		await persistMorningBrief(env, brief2);
		const loaded2 = await loadLatestBrief(env, "hh_a");
		ctx.assert.eq(loaded2!.id, brief2.id, "loadLatestBrief returns newest row");

		ctx.notes.push(`brief id sample: ${persisted.id}`);
		ctx.notes.push(`overwrite id: ${loaded2!.id}`);
	},
};

function makeMinimalPlan(plan_id: string, household_id: string, date: string): MiseWeeklyPlanDraft {
	return {
		id: plan_id,
		household_id,
		title: `plan ${plan_id}`,
		start_date: date,
		end_date: date,
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{ date, day_index: 0, meals: [] }],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	} as MiseWeeklyPlanDraft;
}

export default u46;
