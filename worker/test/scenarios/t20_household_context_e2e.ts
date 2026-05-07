// T20 — Household context end-to-end (Wave 6 inspire reads).
//
// Builds a synthetic household with two weeks of cooked-meal history (encoded
// as `mise_week_plans` rows the window-memory loader walks), five personal
// recipes the household has loved, and a handful of meal-feedback ratings.
// Then calls `inspire_read_household_context` once and checks that every
// sub-section is populated with the expected signal:
//
//   - cuisine_balance reflects what was cooked (mediterranean dominates)
//   - recipe_library returns the seeded recipes (loved ones first)
//   - taste_feedback surfaces the loved + rejected titles correctly
//   - anchor_pressure detects the saturated anchor (chickpea)
//   - canonical_dishes / affinity_pairs are present (empty arrays without
//     a seeded corpus is acceptable — the test confirms shape, not depth)
//
// This is the integration analogue of u31. u31 wires every tool through the
// MCP layer; this test exercises the full master read end-to-end with a
// realistic household memory state, and asserts the bundle is small enough
// to keep the agent's first-turn read cheap.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";

const t20: Scenario = {
	id: "t20",
	name: "inspire_read_household_context returns a populated bundle for a real household",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		const fake = new FakeD1();
		const env = { DB: fake as unknown as D1Database } as any;
		const householdId = "t20_household";

		// Two weeks of cooked dinners: mediterranean-heavy, chickpea-heavy.
		const dinners: Array<{ date: string; title: string; cuisine: string[]; format: string; ingredients: string[] }> = [
			{ date: "2026-04-22", title: "Chickpea Tahini Bowl", cuisine: ["mediterranean"], format: "bowl", ingredients: ["chickpea", "tahini", "lemon"] },
			{ date: "2026-04-23", title: "Hummus Plate", cuisine: ["mediterranean"], format: "plate", ingredients: ["chickpea", "tahini", "olive_oil"] },
			{ date: "2026-04-24", title: "Falafel Wrap", cuisine: ["mediterranean"], format: "wrap", ingredients: ["chickpea", "parsley", "garlic"] },
			{ date: "2026-04-25", title: "Tofu Sesame Noodles", cuisine: ["japanese"], format: "noodles", ingredients: ["tofu", "soba", "sesame"] },
			{ date: "2026-04-26", title: "Spiced Chickpea Stew", cuisine: ["mediterranean"], format: "soup", ingredients: ["chickpea", "tomato", "spinach"] },
			{ date: "2026-04-27", title: "Pasta Pomodoro", cuisine: ["italian"], format: "pasta", ingredients: ["pasta", "tomato", "basil"] },
			{ date: "2026-04-29", title: "Chickpea Curry", cuisine: ["indian"], format: "curry", ingredients: ["chickpea", "tomato", "onion"] },
			{ date: "2026-04-30", title: "Mediterranean Bowl", cuisine: ["mediterranean"], format: "bowl", ingredients: ["chickpea", "feta", "olives"] },
			{ date: "2026-05-01", title: "Greek Salad", cuisine: ["mediterranean"], format: "salad", ingredients: ["cucumber", "feta", "olive_oil"] },
			{ date: "2026-05-02", title: "Tahini Caesar", cuisine: ["fusion"], format: "salad", ingredients: ["lettuce", "tahini", "lemon"] },
		];
		const today = new Date(); // The window-memory loader uses today() for recency.
		const baseEnd = new Date(today);
		baseEnd.setUTCDate(baseEnd.getUTCDate() - 1);
		// Anchor the dates to recent past so recency weights surface them.
		const anchoredDinners = dinners.map((d, idx) => {
			const date = new Date(today);
			date.setUTCDate(date.getUTCDate() - (dinners.length - idx + 1));
			return { ...d, date: date.toISOString().slice(0, 10) };
		});

		// Compose two weekly plan rows so window-memory has data to walk.
		const week1 = anchoredDinners.slice(0, 5);
		const week2 = anchoredDinners.slice(5);
		fake.seedPlan({
			id: "wk1",
			household_id: householdId,
			start_date: week1[0].date,
			end_date: week1[week1.length - 1].date,
			plan_json: JSON.stringify({
				meals_by_day: week1.map(d => ({
					date: d.date,
					meals: [{ slot: "dinner", title: d.title, cuisine: d.cuisine, format: d.format, ingredient_names: d.ingredients }],
				})),
				selected_ingredients: ["chickpea", "tahini"],
			}),
			created_at: new Date(today.getTime() - 7 * 86400_000).toISOString(),
		});
		fake.seedPlan({
			id: "wk2",
			household_id: householdId,
			start_date: week2[0].date,
			end_date: week2[week2.length - 1].date,
			plan_json: JSON.stringify({
				meals_by_day: week2.map(d => ({
					date: d.date,
					meals: [{ slot: "dinner", title: d.title, cuisine: d.cuisine, format: d.format, ingredient_names: d.ingredients }],
				})),
				selected_ingredients: ["chickpea", "tomato"],
			}),
			created_at: new Date(today.getTime() - 1 * 86400_000).toISOString(),
		});

		// Five personal recipes — three loved.
		const recipes = [
			{ id: "pr_a", title: "Chickpea Tahini Bowl", cuisine: ["mediterranean"], format: "bowl", ingredients: ["chickpea", "tahini", "lemon"], loved: 1, cooked_count: 6 },
			{ id: "pr_b", title: "Hummus Plate", cuisine: ["mediterranean"], format: "plate", ingredients: ["chickpea", "tahini"], loved: 1, cooked_count: 4 },
			{ id: "pr_c", title: "Falafel Wrap", cuisine: ["mediterranean"], format: "wrap", ingredients: ["chickpea", "parsley"], loved: 1, cooked_count: 3 },
			{ id: "pr_d", title: "Tofu Sesame Noodles", cuisine: ["japanese"], format: "noodles", ingredients: ["tofu", "soba"], loved: 0, cooked_count: 2 },
			{ id: "pr_e", title: "Pasta Pomodoro", cuisine: ["italian"], format: "pasta", ingredients: ["pasta", "tomato"], loved: 0, cooked_count: 1 },
		];
		for (const r of recipes) {
			fake.seedPersonalRecipe({
				id: r.id,
				household_id: householdId,
				normalized_title: r.title,
				cuisine_json: JSON.stringify(r.cuisine),
				format: r.format,
				canonical_ingredients_json: JSON.stringify(r.ingredients.map(name => ({ name }))),
				flavor_tags_json: JSON.stringify([]),
				household_loved: r.loved,
				cooked_count: r.cooked_count,
				last_cooked_at: anchoredDinners[0]?.date ?? null,
			});
		}

		// Three feedback rows.
		fake.seedFeedback({
			id: "mf_1",
			household_id: householdId,
			meal_title: "Chickpea Tahini Bowl",
			meal_cuisine_json: JSON.stringify(["mediterranean"]),
			meal_format: "bowl",
			rating: 5,
			would_repeat: 1,
			finished: 1,
			recorded_at: anchoredDinners[0].date + "T18:00:00Z",
			meta_json: JSON.stringify({ anchors: ["chickpea", "tahini"] }),
		});
		fake.seedFeedback({
			id: "mf_2",
			household_id: householdId,
			meal_title: "Hummus Plate",
			meal_cuisine_json: JSON.stringify(["mediterranean"]),
			meal_format: "plate",
			rating: 4,
			would_repeat: 1,
			finished: 1,
			recorded_at: anchoredDinners[1].date + "T18:00:00Z",
			meta_json: JSON.stringify({ anchors: ["chickpea", "tahini"] }),
		});
		fake.seedFeedback({
			id: "mf_3",
			household_id: householdId,
			meal_title: "Tofu Sesame Noodles",
			meal_cuisine_json: JSON.stringify(["japanese"]),
			meal_format: "noodles",
			rating: 2,
			would_repeat: 0,
			finished: 0,
			recorded_at: anchoredDinners[3].date + "T18:00:00Z",
			meta_json: JSON.stringify({ anchors: ["tofu"] }),
		});

		// ─── ACT ───────────────────────────────────────────────────────
		const result = await callPlanWorldTool("inspire_read_household_context", {
			household_id: householdId,
			location_region: "us-southwest",
			lookback_days: 28,
			dates: ["2026-05-06", "2026-05-07", "2026-05-08"],
		}, env);

		// ─── ASSERT: all 12 sub-sections present ───────────────────────
		const requiredKeys = [
			"seasonality",
			"anchor_pressure",
			"recent_menu",
			"taste_feedback",
			"recipe_library",
			"canonical_dishes",
			"canonical_components",
			"affinity_pairs",
			"flavor_compounds",
			"cuisine_fusions",
			"flavor_vibes",
			"format_library",
		];
		for (const key of requiredKeys) {
			ctx.assert.ok(key in (result as Record<string, unknown>), `bundle contains ${key}`);
		}

		// ─── ASSERT: recipe_library populated and ranked loved-first ───
		const recipeLib = result.recipe_library as { count: number; recipes: Array<{ title: string; loved: boolean }> };
		ctx.assert.eq(recipeLib.count, 5, "recipe_library returns all 5 seeded recipes");
		const lovedCount = recipeLib.recipes.filter(r => r.loved).length;
		ctx.assert.eq(lovedCount, 3, "recipe_library counts 3 loved recipes");

		// ─── ASSERT: taste_feedback surfaces loved + rejected ──────────
		const taste = result.taste_feedback as { count_loved: number; count_rejected: number; loved_titles: string[]; rejected_titles: string[]; loved_cuisines: Record<string, number>; loved_anchors: Record<string, number> };
		ctx.assert.eq(taste.count_loved, 2, "taste_feedback counts 2 loved (4 + 5)");
		ctx.assert.eq(taste.count_rejected, 1, "taste_feedback counts 1 rejected (rating 2)");
		ctx.assert.contains(taste.loved_titles, "Chickpea Tahini Bowl", "loved_titles surfaces 5-rated meal");
		ctx.assert.contains(taste.rejected_titles, "Tofu Sesame Noodles", "rejected_titles surfaces 2-rated meal");
		ctx.assert.ok(typeof taste.loved_cuisines["mediterranean"] === "number", "loved_cuisines includes mediterranean");
		ctx.assert.ok(typeof taste.loved_anchors["chickpea"] === "number", "loved_anchors includes chickpea");

		// ─── ASSERT: anchor_pressure detects saturated chickpea ────────
		const pressure = result.anchor_pressure as { plans_seen: number; saturated: Array<{ name: string; pressure: number }>; trending: Array<{ name: string; pressure: number }>; cooled: Array<{ name: string; pressure: number }> };
		ctx.assert.gte(pressure.plans_seen, 2, "anchor_pressure saw both seeded plan rows");
		const allBuckets = [...pressure.saturated, ...pressure.trending, ...pressure.cooled];
		const chickpea = allBuckets.find(b => b.name === "chickpea");
		ctx.assert.ok(!!chickpea, "chickpea detected somewhere in anchor pressure buckets");
		ctx.assert.eq(pressure.saturated.some(b => b.name === "chickpea"), true, "chickpea anchor saturates after two weeks of heavy use");

		// ─── ASSERT: recent_menu reflects cooked dinners ───────────────
		const menu = result.recent_menu as { recent_dinner_titles: string[]; recent_cuisines: Array<{ cuisine: string; count: number }>; recent_dinner_formats: Array<{ format: string; count: number }> };
		ctx.assert.contains(menu.recent_dinner_titles, "Chickpea Tahini Bowl", "recent_dinner_titles includes Chickpea Tahini Bowl");
		const cuisineCounts = Object.fromEntries(menu.recent_cuisines.map(c => [c.cuisine, c.count]));
		ctx.assert.gt(cuisineCounts["mediterranean"] || 0, cuisineCounts["italian"] || 0, "mediterranean dominates over italian");

		// ─── ASSERT: token-budget proxy: serialized JSON < ~32 KB ──────
		const serialized = JSON.stringify(result);
		ctx.assert.lte(serialized.length, 32 * 1024, "household_context bundle stays under 32 KB serialized");

		ctx.notes.push(`bundle bytes: ${serialized.length}`);
		ctx.notes.push(`recipe_library count: ${recipeLib.count}`);
		ctx.notes.push(`taste counts: loved=${taste.count_loved} rejected=${taste.count_rejected}`);
		ctx.notes.push(`saturated anchors: ${pressure.saturated.map(b => b.name).join(", ") || "(none)"}`);
		ctx.notes.push(`top cuisines: ${menu.recent_cuisines.slice(0, 3).map(c => `${c.cuisine}=${c.count}`).join(", ")}`);
	},
};

// ─── FakeD1 ─── (same shape as u31; copy locally so each test stays self-contained) ─

interface PersonalRecipeSeed {
	id: string;
	household_id: string;
	normalized_title?: string | null;
	original_title?: string | null;
	cuisine_json?: string;
	format?: string | null;
	canonical_ingredients_json?: string;
	flavor_tags_json?: string;
	household_loved?: number;
	household_rating?: number | null;
	cooked_count?: number;
	last_cooked_at?: string | null;
}

interface FeedbackSeed {
	id: string;
	household_id: string;
	plan_id?: string | null;
	meal_id?: string | null;
	meal_date?: string | null;
	meal_slot?: string | null;
	meal_title?: string | null;
	meal_cuisine_json?: string;
	meal_format?: string | null;
	rating?: number | null;
	would_repeat?: number | null;
	finished?: number | null;
	notes?: string | null;
	recorded_at?: string;
	meta_json?: string;
}

interface PlanRowSeed {
	id: string;
	household_id: string;
	start_date: string;
	end_date: string;
	plan_json: string;
	selected_ingredients_json?: string;
	source_recipe_ids_json?: string;
	created_at?: string | null;
}

class FakeD1 {
	personal: PersonalRecipeSeed[] = [];
	feedback: FeedbackSeed[] = [];
	plans: PlanRowSeed[] = [];
	active = new Map<string, { plan_json: string; status: string; household: string | null }>();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}

	seedPersonalRecipe(row: PersonalRecipeSeed): void { this.personal.push(row); }
	seedFeedback(row: FeedbackSeed): void { this.feedback.push(row); }
	seedPlan(row: PlanRowSeed): void { this.plans.push(row); }
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this { this.bindings = values; return this; }

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const row = this.db.active.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json } : null) as T | null;
		}
		return null;
	}

	async run(): Promise<unknown> { return { success: true }; }

	async all<T = unknown>(): Promise<{ results: T[] }> {
		const sql = this.sql;

		if (/FROM\s+personal_recipes/i.test(sql)) {
			const householdId = String(this.bindings[0]);
			const lovedOnly = /AND\s+household_loved\s*=\s*1/i.test(sql);
			let rows = this.db.personal.filter(r => r.household_id === householdId);
			if (lovedOnly) rows = rows.filter(r => r.household_loved === 1);
			return {
				results: rows.map(r => ({
					id: r.id,
					household_id: r.household_id,
					source_kind: "manual",
					source_url: null,
					source_app: null,
					author: null,
					original_title: r.original_title ?? r.normalized_title ?? null,
					normalized_title: r.normalized_title ?? null,
					cuisine_json: r.cuisine_json ?? "[]",
					format: r.format ?? null,
					meal_slots_json: "[]",
					canonical_ingredients_json: r.canonical_ingredients_json ?? "[]",
					raw_ingredients_text: null,
					method_summary: null,
					active_time_min: null,
					total_time_min: null,
					servings: null,
					flavor_tags_json: r.flavor_tags_json ?? "[]",
					household_rating: r.household_rating ?? null,
					household_loved: r.household_loved ?? 0,
					cooked_count: r.cooked_count ?? 0,
					last_cooked_at: r.last_cooked_at ?? null,
					parser_confidence: 0.7,
				})) as unknown as T[],
			};
		}

		if (/FROM\s+mise_meal_feedback/i.test(sql)) {
			const householdId = String(this.bindings[0]);
			const cutoff = String(this.bindings[1] ?? "");
			const rows = this.db.feedback.filter(r =>
				r.household_id === householdId
				&& (!cutoff || (r.recorded_at ?? "") >= cutoff)
			);
			return {
				results: rows.map(r => ({
					id: r.id,
					household_id: r.household_id,
					plan_id: r.plan_id ?? null,
					meal_id: r.meal_id ?? null,
					meal_date: r.meal_date ?? null,
					meal_slot: r.meal_slot ?? null,
					meal_title: r.meal_title ?? null,
					meal_cuisine_json: r.meal_cuisine_json ?? "[]",
					meal_format: r.meal_format ?? null,
					rating: r.rating ?? null,
					would_repeat: r.would_repeat ?? null,
					finished: r.finished ?? null,
					notes: r.notes ?? null,
					recorded_at: r.recorded_at ?? "2026-04-01T00:00:00Z",
					meta_json: r.meta_json ?? "{}",
				})) as unknown as T[],
			};
		}

		if (/FROM\s+mise_week_plans/i.test(sql)) {
			const householdId = String(this.bindings[0]);
			const cutoff = String(this.bindings[1] ?? "");
			const rows = this.db.plans.filter(p =>
				p.household_id === householdId
				&& (!cutoff || p.end_date >= cutoff)
			);
			return {
				results: rows.map(r => ({
					id: r.id,
					household_id: r.household_id,
					start_date: r.start_date,
					end_date: r.end_date,
					plan_json: r.plan_json,
					selected_ingredients_json: r.selected_ingredients_json ?? "[]",
					source_recipe_ids_json: r.source_recipe_ids_json ?? "[]",
					created_at: r.created_at ?? null,
				})) as unknown as T[],
			};
		}

		// All corpus tables (canonical_dishes, ingredient_edges, etc.) are
		// absent in this scenario — the loaders fail-soft into empty arrays,
		// which is the correct behaviour for households on a fresh install.
		return { results: [] as T[] };
	}
}

export default t20;
