// T19 - end-to-end agentic compose loop driven by the MCP tool server.
//
// Builds a 7-day window via plan_create, then composes 7 dinners turn-by-turn
// using plan_compose_meal, calling plan_read_grievances + plan_read_ledger_at
// after each compose to confirm state. Verifies that at the end the plan has
// 0 hard grievances and all 7 dinner slots filled.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";

const t19: Scenario = {
	id: "t19",
	name: "MCP-driven 7-dinner compose loop reaches a hard-grievance-clean plan",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const env = { DB: new FakeD1() as unknown as D1Database } as any;

		const created = await callPlanWorldTool("plan_create", {
			household_id: "t19_household",
			start_date: "2026-07-06",
			end_date: "2026-07-12",
			people_default: 2,
			ingredients: ["onion", "tomato", "tofu", "rice", "spinach"],
		}, env);
		const planId = created.plan_id as string;
		ctx.assert.ok(planId.length > 0, "plan_create returns a plan id");

		const initialEmpty = await callPlanWorldTool("plan_read_empty_slots", { plan_id: planId }, env);
		const emptyCount = (initialEmpty.empty_slots as unknown[]).length;
		ctx.assert.gt(emptyCount, 0, "fresh plan has empty slots before compose");
		ctx.notes.push(`empty slots before compose: ${emptyCount}`);

		const dates = [
			"2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09",
			"2026-07-10", "2026-07-11", "2026-07-12",
		];
		// Ingredient names are chosen so the deterministic role-matcher in
		// composer-postpass.ts (`ROLE_KEYWORDS`) classifies each required slot.
		// Two relevant quirks of the post-pass: (a) the regex uses singular
		// "bean"/"lentil" with word boundaries, so plurals would not match, and
		// (b) formats whose required slots include both "main" and "starch"
		// (curry, stir fry) cause the PRIMARY_ROLE fallback for "main" to
		// consume every raw_ingredient before "starch" can claim one. The test
		// avoids those combos by using bowl/pasta/soup, where required slots
		// are either just "main" (pasta/soup) or {starch, protein} (bowl).
		const meals = [
			{ title: "Tofu rice bowl",     format: "bowl",  cuisine: ["asian"],         raw: ["tofu", "rice", "spinach"] },
			{ title: "Tomato pasta",       format: "pasta", cuisine: ["italian"],       raw: ["pasta", "tomato", "garlic"] },
			{ title: "Lentil stew",        format: "soup",  cuisine: ["mediterranean"], raw: ["lentil", "carrot", "onion"] },
			{ title: "Chickpea rice bowl", format: "bowl",  cuisine: ["mediterranean"], raw: ["chickpea", "rice", "tomato"] },
			{ title: "Rice and bean bowl", format: "bowl",  cuisine: ["latin"],         raw: ["bean", "rice", "lime"] },
			{ title: "Tempeh quinoa bowl", format: "bowl",  cuisine: ["fusion"],        raw: ["tempeh", "quinoa", "kale"] },
			{ title: "Egg noodle soup",    format: "soup",  cuisine: ["asian"],         raw: ["egg", "noodle", "scallion"] },
		];

		let lastHard = -1;
		for (let i = 0; i < dates.length; i++) {
			const date = dates[i];
			const meal = meals[i];
			const result = await callPlanWorldTool("plan_compose_meal", {
				plan_id: planId,
				slot: { date, slot: "dinner" },
				meal: {
					title: meal.title,
					format: meal.format,
					cuisine: meal.cuisine,
					raw_ingredients: meal.raw.map(name => ({ name, grams: 150 })),
				},
			}, env);
			ctx.assert.eq(result.ok, true, `plan_compose_meal succeeds for ${date}`);
			ctx.assert.ok(typeof result.meal_id === "string", `meal_id returned for ${date}`);

			const grievances = await callPlanWorldTool("plan_read_grievances", { plan_id: planId }, env);
			const counts = grievances.counts as Record<string, number>;
			lastHard = counts.hard || 0;
			ctx.notes.push(`day ${date}: meals composed=${i + 1} hard=${lastHard} total=${counts.total}`);

			const ledger = await callPlanWorldTool("plan_read_ledger_at", {
				plan_id: planId,
				date,
			}, env);
			ctx.assert.eq(ledger.date, date, `ledger date echoes back for ${date}`);
			ctx.assert.ok(Array.isArray(ledger.items), `ledger items returned for ${date}`);
		}

		const summary = await callPlanWorldTool("plan_get_summary", { plan_id: planId }, env);
		const finalCounts = (summary.summary as any).meals_by_slot as Record<string, number>;
		ctx.assert.eq(finalCounts.dinner, 7, "all 7 dinner slots are filled after compose loop");

		const finalGrievances = await callPlanWorldTool("plan_read_grievances", { plan_id: planId }, env);
		const finalCountsObj = finalGrievances.counts as Record<string, number>;
		ctx.assert.eq(finalCountsObj.hard, 0, "no hard grievances remain after compose loop");
		ctx.notes.push(`final: hard=${finalCountsObj.hard} warning=${finalCountsObj.warning} total=${finalCountsObj.total}`);

		const finalize = await callPlanWorldTool("plan_finalize", { plan_id: planId }, env);
		ctx.assert.eq(finalize.ok, true, "finalized plan is hard-grievance + coherence clean");
	},
};

class FakeD1 {
	active = new Map<string, { plan_json: string; status: string; household: string | null }>();
	plans = new Map<string, string>(); // legacy mise_week_plans
	proposals = new Map<string, { plan_id: string; status: string; meta_json: string }>();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const row = this.db.active.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_week_plans/i.test(this.sql)) {
			const plan_json = this.db.plans.get(String(this.bindings[0]));
			return (plan_json ? { plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (!row || row.plan_id !== String(this.bindings[1])) return null;
			return { meta_json: row.meta_json } as T;
		}
		return null;
	}

	async run(): Promise<unknown> {
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.set(String(this.bindings[0]), {
				household: this.bindings[1] as string | null,
				plan_json: String(this.bindings[2]),
				status: String(this.bindings[3] ?? "draft"),
			});
		} else if (/DELETE\s+FROM\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.delete(String(this.bindings[0]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_week_plans/i.test(this.sql)) {
			this.db.plans.set(String(this.bindings[0]), String(this.bindings[11]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_proposals/i.test(this.sql)) {
			this.db.proposals.set(String(this.bindings[0]), {
				plan_id: String(this.bindings[1]),
				status: String(this.bindings[5]),
				meta_json: String(this.bindings[10]),
			});
		} else if (/UPDATE\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (row && row.plan_id === String(this.bindings[1])) row.status = "applied";
		}
		// All other DELETE/INSERT statements (mise_plan_components, mise_plan_tasks,
		// mise_recipe_lineage) are no-ops in the mock.
		return { success: true };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const rows = Array.from(this.db.active.entries()).map(([plan_id, row]) => ({
				plan_id,
				household_id: row.household,
				status: row.status,
				updated_at: "now",
			}));
			return { results: rows as unknown as T[] };
		}
		return { results: [] };
	}
}

export default t19;
