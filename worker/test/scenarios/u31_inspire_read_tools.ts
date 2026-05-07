// U31 — Inspire read tools: shape contracts.
//
// Verifies all 13 inspire_read_* tools register on the MCP server and route
// through the dispatcher with the expected shape. Uses a hand-rolled FakeD1
// that recognizes the schema queries each underlying loader issues. We don't
// try to seed every corpus table — most reads return empty on absent tables,
// which matches the production fail-soft contract — but we DO seed
// personal_recipes and mise_meal_feedback so the household-scoped reads
// return populated arrays.

import type { Scenario } from "../lib/types";
import { handlePlanWorldJsonRpc, callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";

const u31: Scenario = {
	id: "u31",
	name: "Inspire read tools register on the MCP server and return shaped results",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fake = new FakeD1();
		const env = { DB: fake as unknown as D1Database } as any;

		// 1. tools/list now exposes the 13 new inspire_read_* tools.
		const list = await rpc(env, { id: 1, method: "tools/list", params: {} });
		const toolNames: string[] = (list.result?.tools || []).map((t: any) => t.name);
		const inspireExpected = [
			"inspire_read_seasonality",
			"inspire_read_anchor_pressure",
			"inspire_read_recent_menu",
			"inspire_read_taste_feedback",
			"inspire_read_recipe_library",
			"inspire_read_canonical_dishes",
			"inspire_read_canonical_components",
			"inspire_read_flavor_compounds",
			"inspire_read_affinity_pairs",
			"inspire_read_cuisine_fusions",
			"inspire_read_flavor_vibes",
			"inspire_read_format_library",
			"inspire_read_household_context",
		];
		for (const expected of inspireExpected) {
			ctx.assert.contains(toolNames, expected, `tools/list includes ${expected}`);
		}
		ctx.assert.gte(toolNames.length, 50, "tool catalog has at least 50 tools after wave 6");

		// Seed a household with personal recipes + meal feedback.
		fake.seedPersonalRecipe({
			id: "pr_chickpea_bowl_1",
			household_id: "u31_household",
			normalized_title: "Chickpea Tahini Bowl",
			cuisine_json: JSON.stringify(["mediterranean"]),
			format: "bowl",
			canonical_ingredients_json: JSON.stringify([
				{ name: "chickpea", qty: 1, unit: "cup" },
				{ name: "tahini", qty: 0.25, unit: "cup" },
				{ name: "lemon", qty: 1, unit: "ea" },
			]),
			flavor_tags_json: JSON.stringify(["herby", "creamy"]),
			household_loved: 1,
			cooked_count: 4,
			last_cooked_at: "2026-04-15",
		});
		fake.seedPersonalRecipe({
			id: "pr_tofu_noodles_1",
			household_id: "u31_household",
			normalized_title: "Tofu Sesame Noodles",
			cuisine_json: JSON.stringify(["japanese"]),
			format: "noodles",
			canonical_ingredients_json: JSON.stringify([
				{ name: "tofu", qty: 1, unit: "block" },
				{ name: "soba", qty: 200, unit: "g" },
			]),
			flavor_tags_json: JSON.stringify(["umami"]),
			household_loved: 0,
			cooked_count: 2,
			last_cooked_at: "2026-04-22",
		});
		fake.seedFeedback({
			id: "mf_plan1__meal_a",
			household_id: "u31_household",
			meal_title: "Chickpea Tahini Bowl",
			meal_cuisine_json: JSON.stringify(["mediterranean"]),
			meal_format: "bowl",
			rating: 5,
			would_repeat: 1,
			finished: 1,
			recorded_at: "2026-04-15T18:00:00Z",
			meta_json: JSON.stringify({ anchors: ["chickpea", "tahini"] }),
		});
		fake.seedFeedback({
			id: "mf_plan1__meal_b",
			household_id: "u31_household",
			meal_title: "Bland Tofu Stir Fry",
			meal_cuisine_json: JSON.stringify(["japanese"]),
			meal_format: "stir_fry",
			rating: 2,
			would_repeat: 0,
			finished: 0,
			recorded_at: "2026-04-20T18:00:00Z",
			meta_json: JSON.stringify({ anchors: ["tofu"] }),
		});

		// 2. inspire_read_seasonality — shape only (corpus tables not seeded so
		//    arrays are empty, but the wrapper must still return the buckets).
		const season = await callPlanWorldTool("inspire_read_seasonality", {
			region: "us-southwest",
			dates: ["2026-05-06", "2026-05-07", "2026-05-08"],
		}, env);
		ctx.assert.eq(season.region, "us-southwest", "seasonality echoes region");
		ctx.assert.eq((season.dates as string[]).length, 3, "seasonality echoes dates");
		ctx.assert.ok(Array.isArray(season.peak), "seasonality peak is array");
		ctx.assert.ok(Array.isArray(season.coming), "seasonality coming is array");
		ctx.assert.ok(Array.isArray(season.departing), "seasonality departing is array");

		// 3. inspire_read_anchor_pressure — runs against empty mise_week_plans;
		//    must return zero plans_seen + empty buckets.
		const pressure = await callPlanWorldTool("inspire_read_anchor_pressure", {
			household_id: "u31_household",
			lookback_days: 28,
		}, env);
		ctx.assert.eq(pressure.household_id, "u31_household", "anchor_pressure echoes household_id");
		ctx.assert.eq(pressure.plans_seen, 0, "anchor_pressure starts at zero plans");
		ctx.assert.ok(Array.isArray(pressure.saturated), "saturated is array");
		ctx.assert.ok(Array.isArray(pressure.trending), "trending is array");
		ctx.assert.ok(Array.isArray(pressure.cooled), "cooled is array");

		// 4. inspire_read_recent_menu — same as above.
		const menu = await callPlanWorldTool("inspire_read_recent_menu", {
			household_id: "u31_household",
		}, env);
		ctx.assert.eq(menu.household_id, "u31_household", "recent_menu echoes household_id");
		ctx.assert.ok(Array.isArray(menu.recent_dinner_titles), "recent_dinner_titles is array");

		// 5. inspire_read_taste_feedback — feedback rows should round-trip.
		const taste = await callPlanWorldTool("inspire_read_taste_feedback", {
			household_id: "u31_household",
			lookback_days: 60,
		}, env);
		ctx.assert.eq(taste.count_total, 2, "taste_feedback sees 2 records");
		ctx.assert.eq(taste.count_loved, 1, "taste_feedback counts 1 loved");
		ctx.assert.eq(taste.count_rejected, 1, "taste_feedback counts 1 rejected");
		ctx.assert.contains(taste.loved_titles as string[], "Chickpea Tahini Bowl", "loved_titles surfaces 5-rated meal");
		ctx.assert.contains(taste.rejected_titles as string[], "Bland Tofu Stir Fry", "rejected_titles surfaces 2-rated meal");

		// 6. inspire_read_recipe_library — should return both seeded recipes.
		const libAll = await callPlanWorldTool("inspire_read_recipe_library", {
			household_id: "u31_household",
		}, env);
		ctx.assert.eq(libAll.count, 2, "recipe_library returns both seeded recipes");
		const libLoved = await callPlanWorldTool("inspire_read_recipe_library", {
			household_id: "u31_household",
			loved_only: true,
		}, env);
		ctx.assert.eq(libLoved.count, 1, "recipe_library loved_only filter narrows to 1");
		const libCuisine = await callPlanWorldTool("inspire_read_recipe_library", {
			household_id: "u31_household",
			cuisine_filter: ["mediterranean"],
		}, env);
		ctx.assert.eq(libCuisine.count, 1, "recipe_library cuisine_filter narrows to 1");
		const libAnchor = await callPlanWorldTool("inspire_read_recipe_library", {
			household_id: "u31_household",
			anchor_filter: ["tofu"],
		}, env);
		ctx.assert.eq(libAnchor.count, 1, "recipe_library anchor_filter matches tofu");

		// 7. inspire_read_canonical_dishes — empty corpus → empty dishes.
		const dishes = await callPlanWorldTool("inspire_read_canonical_dishes", {
			anchors: ["chickpea", "tahini"],
			limit: 5,
		}, env);
		ctx.assert.ok(Array.isArray(dishes.dishes), "canonical_dishes returns dishes array");
		ctx.assert.eq((dishes.anchors as string[]).length, 2, "canonical_dishes echoes anchors");

		// 8. inspire_read_canonical_components — same.
		const components = await callPlanWorldTool("inspire_read_canonical_components", {
			anchors: ["chickpea"],
		}, env);
		ctx.assert.ok(Array.isArray(components.components), "canonical_components returns array");

		// 9. inspire_read_flavor_compounds — empty corpus → empty pairings.
		const compounds = await callPlanWorldTool("inspire_read_flavor_compounds", {
			anchor: "tomato",
		}, env);
		ctx.assert.eq(compounds.anchor, "tomato", "flavor_compounds echoes anchor");
		ctx.assert.ok(Array.isArray(compounds.pairings), "flavor_compounds returns pairings array");

		// 10. inspire_read_affinity_pairs.
		const aff = await callPlanWorldTool("inspire_read_affinity_pairs", {
			anchors: ["chickpea"],
		}, env);
		ctx.assert.ok(Array.isArray(aff.pairs), "affinity_pairs returns pairs array");

		// 11. inspire_read_cuisine_fusions.
		const fusions = await callPlanWorldTool("inspire_read_cuisine_fusions", {
			min_affinity: 0.5,
		}, env);
		ctx.assert.ok(Array.isArray(fusions.fusions), "cuisine_fusions returns fusions array");
		ctx.assert.ok(Array.isArray(fusions.prompt_lines), "cuisine_fusions returns prompt_lines");

		// 12. inspire_read_flavor_vibes.
		const vibes = await callPlanWorldTool("inspire_read_flavor_vibes", { max: 6 }, env);
		ctx.assert.ok(Array.isArray(vibes.vibes), "flavor_vibes returns vibes array");
		ctx.assert.ok(Array.isArray(vibes.prompt_lines), "flavor_vibes returns prompt_lines");

		// 13. inspire_read_format_library.
		const formats = await callPlanWorldTool("inspire_read_format_library", {}, env);
		ctx.assert.ok(Array.isArray(formats.formats), "format_library returns formats array");

		// 14. inspire_read_household_context — master read; all 12 sub-sections present.
		const ctxResult = await callPlanWorldTool("inspire_read_household_context", {
			household_id: "u31_household",
			location_region: "us-southwest",
			lookback_days: 28,
			dates: ["2026-05-06", "2026-05-07"],
		}, env);
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
			ctx.assert.ok(key in (ctxResult as Record<string, unknown>), `household_context contains ${key}`);
		}
		const recipeLib = (ctxResult.recipe_library as { count: number; recipes: unknown[] });
		ctx.assert.eq(recipeLib.count, 2, "household_context.recipe_library populated");
		const tasteCtx = (ctxResult.taste_feedback as { count_total: number });
		ctx.assert.eq(tasteCtx.count_total, 2, "household_context.taste_feedback populated");

		// 15. JSON-RPC round-trip: confirm one tool returns text content via tools/call.
		const rpcCall = await rpc(env, {
			id: 99,
			method: "tools/call",
			params: { name: "inspire_read_recipe_library", arguments: { household_id: "u31_household" } },
		});
		const content = rpcCall.result?.content as Array<{ type: string; text: string }> | undefined;
		ctx.assert.ok(Array.isArray(content) && content.length > 0, "tools/call returns content array");
		ctx.assert.eq(content?.[0].type, "text", "content entry is text");
		const parsed = JSON.parse(content?.[0].text || "{}");
		ctx.assert.eq(parsed.count, 2, "JSON content parses back to 2 recipes");

		ctx.notes.push(`tool count: ${toolNames.length}`);
		ctx.notes.push(`taste loved=${taste.count_loved} rejected=${taste.count_rejected}`);
		ctx.notes.push(`recipe library count: ${libAll.count}`);
	},
};

async function rpc(env: { DB: D1Database }, request: { id: number; method: string; params: unknown }): Promise<any> {
	return await handlePlanWorldJsonRpc({ jsonrpc: "2.0", ...request }, env as any) as any;
}

// ─── FakeD1 ────────────────────────────────────────────────────────────────
//
// Recognises the schema-shaped queries the inspire loaders issue. Tables we
// don't seed return { results: [] } so the caller's try/catch wrappers degrade
// gracefully into empty results. The MCP plumbing requires the legacy active /
// week-plans paths to no-op cleanly too.

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

	seedPersonalRecipe(row: PersonalRecipeSeed): void {
		this.personal.push(row);
	}

	seedFeedback(row: FeedbackSeed): void {
		this.feedback.push(row);
	}

	seedPlan(row: PlanRowSeed): void {
		this.plans.push(row);
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
		return null;
	}

	async run(): Promise<unknown> {
		// Plan-world write paths land here from MCP; no-op them.
		return { success: true };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		const sql = this.sql;

		// personal_recipes — both selectors used by the inspire path.
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

		// mise_meal_feedback.
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

		// mise_week_plans (window-memory).
		if (/FROM\s+mise_week_plans/i.test(sql)) {
			const householdId = String(this.bindings[0]);
			const rows = this.db.plans.filter(p => p.household_id === householdId);
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

		// mise_cuisine_fusions / mise_flavor_vibes / composition_templates /
		// canonical_dishes / canonical_components / canonical_ingredients /
		// ingredient_edges / ingredient_compounds / produce_profiles /
		// regional_seasons / tg_technique_* — all return empty. The loaders
		// wrap their queries in try/catch; an empty result is the correct
		// fail-soft answer when those corpus tables aren't seeded.
		return { results: [] as T[] };
	}
}

export default u31;
