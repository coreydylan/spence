// U29 — End-to-end replan-webhook flow against a mocked D1.
//
// Builds a synthetic plan with Wed dinner + Wed shop run, fires a skip_meal
// event via applyReplanEvent, and asserts:
//   - The post-state plan has Wed dinner removed.
//   - ripple_summary reflects the meal/shopping deltas.
//   - applyReplanEvent persists the new plan_json on a real (non-dry) call.
//   - When dry_run=true, the persisted plan stays untouched.
//
// Then locks the same slot and re-fires skip_meal to assert the lock
// produces a warning and the plan is not mutated again.

import type { Scenario } from "../lib/types";
import { applyReplanEvent } from "../../src/mise-graph/replan-events";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
} from "../../src/mise-graph/planner";

const u29: Scenario = {
	id: "u29",
	name: "Replan webhook applies skip_meal end-to-end and respects locks",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as { DB: D1Database };
		const plan = makeReplanFixture();
		db.savePlan(plan);

		// (1) dry_run skip_meal — plan must stay untouched in storage
		const dry = await applyReplanEvent(env, plan.id, {
			kind: "skip_meal",
			slot: { date: "2026-05-13", slot: "dinner" },
			reason: "going out",
		}, { dry_run: true });
		ctx.assert.eq(dry.applied, false, "dry_run does not apply changes");
		ctx.assert.gt(dry.ripple_summary.affected_meals, 0, "dry_run still surfaces affected meals");
		ctx.notes.push(`dry: ${dry.human_summary}`);
		const postDry = db.readPlan(plan.id);
		const wedAfterDry = postDry.meals_by_day.find(d => d.date === "2026-05-13");
		ctx.assert.ok(
			!!wedAfterDry?.meals.find(m => m.slot === "dinner"),
			"dry_run leaves Wed dinner intact in storage",
		);

		// (2) committed skip_meal — Wed dinner must vanish, plan saved
		const result = await applyReplanEvent(env, plan.id, {
			kind: "skip_meal",
			slot: { date: "2026-05-13", slot: "dinner" },
			reason: "kid sick",
		});
		ctx.assert.eq(result.applied, true, "non-dry skip_meal applies");
		ctx.assert.gt(result.ripple_summary.affected_meals, 0, "skip_meal touches at least one meal");
		ctx.assert.gt(
			result.ripple_summary.affected_shop_items,
			0,
			"skip_meal shrinks the shopping list",
		);
		ctx.notes.push(`commit: ${result.human_summary}`);

		const post = db.readPlan(plan.id);
		const wedAfter = post.meals_by_day.find(d => d.date === "2026-05-13");
		ctx.assert.ok(
			!wedAfter?.meals.some(m => m.slot === "dinner"),
			"Wed dinner is gone from persisted plan after skip_meal",
		);

		// (3) Replay: skip_meal on a now-empty slot is a no-op (warns).
		const replay = await applyReplanEvent(env, plan.id, {
			kind: "skip_meal",
			slot: { date: "2026-05-13", slot: "dinner" },
		});
		ctx.assert.eq(replay.applied, false, "replay against empty slot doesn't apply");
		ctx.assert.gt(replay.warnings.length, 0, "replay surfaces a warning");

		// (4) Lock a fresh slot, then skip_meal on it: lock check warns and skip
		// is refused (preview returns no preview_state, so applied stays false).
		const lockResult = await applyReplanEvent(env, plan.id, {
			kind: "lock_slot",
			slot: { date: "2026-05-14", slot: "lunch" },
			reason: "user pinned this",
		});
		ctx.assert.eq(lockResult.applied, true, "lock_slot applies");

		const skipLocked = await applyReplanEvent(env, plan.id, {
			kind: "skip_meal",
			slot: { date: "2026-05-14", slot: "lunch" },
		});
		ctx.assert.eq(skipLocked.applied, false, "skip_meal against locked slot does not apply");
		const lockMessage = skipLocked.warnings.find(w => w.toLowerCase().includes("locked"));
		ctx.assert.ok(!!lockMessage, "skip_meal on locked slot surfaces a 'locked' warning");

		const finalPlan = db.readPlan(plan.id);
		const thuLunch = finalPlan.meals_by_day
			.find(d => d.date === "2026-05-14")
			?.meals.find(m => m.slot === "lunch");
		ctx.assert.ok(!!thuLunch, "Thu lunch survives the locked-skip attempt");
	},
};

// ---------------------------------------------------------------------------
// Fixture: 2-day mini plan with Wed dinner + Thu lunch + a Wed shop run
// ---------------------------------------------------------------------------

function makeReplanFixture(): MiseWeeklyPlanDraft {
	const wed: MisePlanMeal = {
		id: "meal:wed_dinner",
		date: "2026-05-13",
		slot: "dinner",
		title: "Tomato pasta",
		format: "bowl",
		component_ids: [],
		ingredient_names: ["pasta", "canned tomato", "garlic"],
		source: "synthetic_test",
		notes: [],
		people: 2,
		cuisine: ["italian"],
		locked: false,
		raw_ingredients: [
			{ name: "pasta", qty: 200, unit: "g", grams: 200, category: null },
			{ name: "canned tomato", qty: 1, unit: "can", grams: 400, category: null },
			{ name: "garlic", qty: 3, unit: "clove", grams: 9, category: null },
		],
		leftovers_to: ["2026-05-14 lunch"],
	};
	const thuLunch: MisePlanMeal = {
		id: "meal:thu_lunch",
		date: "2026-05-14",
		slot: "lunch",
		title: "Pasta salad",
		format: "salad",
		component_ids: [],
		ingredient_names: ["greens", "feta"],
		source: "synthetic_test",
		notes: [],
		people: 2,
		cuisine: [],
		locked: false,
		raw_ingredients: [
			{ name: "greens", qty: 200, unit: "g", grams: 200, category: null },
			{ name: "feta", qty: 100, unit: "g", grams: 100, category: null },
		],
	};
	const batch: MisePlanComponentBatch = {
		id: "mise_component:tomato_sauce",
		state_id: null,
		label: "Quick Tomato Sauce",
		quantity: 400,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 72,
		planned_uses: [
			{ date: "2026-05-13", slot: "dinner", meal_id: wed.id, title: wed.title },
		],
		station_tags: [],
		equipment: [],
		active_time_min: 15,
		idle_time_min: 0,
		input_names: ["canned tomato", "garlic"],
		meta: { desired_prep_date: "2026-05-13" },
	};
	return {
		id: "mise_plan:u29",
		household_id: "test",
		title: "U29 Replan Fixture",
		start_date: "2026-05-13",
		end_date: "2026-05-14",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: ["pasta", "tomato"],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-13", day_index: 0, meals: [wed] },
			{ date: "2026-05-14", day_index: 1, meals: [thuLunch] },
		],
		component_batches: [batch],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [
			{
				category: "produce",
				items: [
					{ name: "garlic", quantity: 3, unit: "clove", source: ["meal:wed_dinner"] },
					{ name: "greens", quantity: 200, unit: "g", source: ["meal:thu_lunch"] },
				],
			},
			{
				category: "pantry",
				items: [
					{ name: "pasta", quantity: 200, unit: "g", source: ["meal:wed_dinner"] },
					{ name: "canned tomato", quantity: 1, unit: "can", source: ["meal:wed_dinner"] },
				],
			},
			{
				category: "dairy",
				items: [
					{ name: "feta", quantity: 100, unit: "g", source: ["meal:thu_lunch"] },
				],
			},
		],
		shop_runs: [
			{
				id: "run:wed_pre",
				date: "2026-05-13",
				label: "Wed shop",
				categories: ["produce", "pantry", "dairy"],
				item_count: 5,
			},
		],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

// ---------------------------------------------------------------------------
// Fake D1 — supports active-plans round-trip
// ---------------------------------------------------------------------------

class FakeD1 {
	private plans = new Map<string, string>();

	savePlan(plan: MiseWeeklyPlanDraft): void {
		this.plans.set(plan.id, JSON.stringify(plan));
	}
	readPlan(id: string): MiseWeeklyPlanDraft {
		const raw = this.plans.get(id);
		if (!raw) throw new Error(`missing plan ${id}`);
		return JSON.parse(raw) as MiseWeeklyPlanDraft;
	}
	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
	get _plans(): Map<string, string> {
		return this.plans;
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
		if (/SELECT\s+plan_json\s+FROM\s+mise_active_plans/i.test(this.sql)) {
			const id = String(this.bindings[0]);
			const plan_json = this.db._plans.get(id);
			return (plan_json ? { plan_json } : null) as T | null;
		}
		return null;
	}

	async run(): Promise<unknown> {
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(this.sql)) {
			const plan_id = String(this.bindings[0]);
			const plan_json = String(this.bindings[2]);
			this.db._plans.set(plan_id, plan_json);
		}
		// Audit-log inserts swallowed silently — table doesn't exist in this fake.
		return { success: true };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		return { results: [] };
	}
}

export default u29;
