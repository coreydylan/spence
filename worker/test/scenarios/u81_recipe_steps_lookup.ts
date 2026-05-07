// U81 — Real recipe-step lookup against canonical_recipes_v2.
//
// Verifies the new `inspire_read_recipe_steps` tool: registers in the MCP
// catalog, dispatches through callPlanWorldTool, and round-trips the
// shaped {recipe_id, title, ingredients[], steps[], ...} payload. Uses a
// hand-rolled FakeD1 that recognizes the lookup queries we issue and
// serves two seeded `canonical_recipes_v2` rows.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool, handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";

const u81: Scenario = {
	id: "u81",
	name: "inspire_read_recipe_steps returns real ingredients + method steps from canonical_recipes_v2",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fake = new FakeD1();
		const env = { DB: fake as unknown as D1Database } as any;

		// Two canonical recipes. Each has the realistic document_json shape we
		// observed on prod: `time`, `yield`, `ingredient_groups[].items`, and
		// `steps[].prose`. The lookup module should normalise both into the
		// same compact result.
		fake.seedRecipe({
			id: "banana_bread",
			title: "Banana Bread",
			description: "A classic banana bread.",
			document_json: JSON.stringify({
				id: "banana_bread",
				title: "Banana Bread",
				description: "A classic banana bread.",
				time: { prep_min: 15, cook_min: 55, active_min: 15, idle_min: 55, total_min: 70 },
				yield: { servings: 10, servings_unit: "slices" },
				ingredient_groups: [
					{
						label: "Main",
						items: [
							{ canonical_name: "banana", consensus_qty: 3, unit: "whole", prep: "mashed", importance: "core" },
							{ canonical_name: "all-purpose flour", consensus_qty: 1.5, unit: "cup", importance: "core" },
							{ canonical_name: "baking soda", consensus_qty: 1, unit: "tsp", importance: "core" },
						],
					},
				],
				steps: [
					{
						index: 1,
						phase: "mise_en_place",
						primary_action: { verb: "preheat" },
						equipment_refs: ["oven", "9x5 loaf pan"],
						idle_time_min: 10,
						prose: "Preheat the oven to 350°F. Grease a 9x5 loaf pan.",
					},
					{
						index: 2,
						phase: "prep",
						primary_action: { verb: "mash" },
						ingredient_refs: ["banana"],
						completion_signal: "mostly smooth, a few small lumps are fine",
						prose: "In a large mixing bowl, mash 3 ripe bananas with a fork until mostly smooth.",
					},
				],
				_internal: { source_url: "https://example.com/banana-bread" },
			}),
		});
		fake.seedRecipe({
			id: "chocolate_chip_cookies",
			title: "Chocolate Chip Cookies",
			description: null,
			document_json: JSON.stringify({
				time: { total_min: 35 },
				yield: { servings: 24 },
				ingredient_groups: [
					{
						label: "Dough",
						items: [
							{ canonical_name: "butter", consensus_qty: 1, unit: "cup", importance: "core" },
							{ canonical_name: "chocolate chips", consensus_qty: 2, unit: "cup", importance: "core" },
						],
					},
				],
				steps: [
					{ index: 1, primary_action: { verb: "cream" }, prose: "Cream butter and sugar until light." },
				],
			}),
		});
		// Also seed a canonical_dishes row so the canonical_dish_id path works.
		fake.seedDish({ id: 45, canonical_title: "banana bread" });

		// 1. tools/list now exposes the new recipe-steps tool.
		const list = await rpc(env, { id: 1, method: "tools/list", params: {} });
		const toolNames: string[] = (list.result?.tools || []).map((t: any) => t.name);
		ctx.assert.contains(toolNames, "inspire_read_recipe_steps", "tools/list includes inspire_read_recipe_steps");

		// 2. Lookup by exact recipe_id.
		const byId = await callPlanWorldTool("inspire_read_recipe_steps", { recipe_id: "banana_bread" }, env);
		ctx.assert.eq(byId.ok, true, "by recipe_id returns ok=true");
		ctx.assert.eq(byId.recipe_id, "banana_bread", "recipe_id round-trips");
		ctx.assert.eq(byId.title, "Banana Bread", "title round-trips");
		ctx.assert.eq(byId.matched_by, "recipe_id", "matched_by reflects the lookup path");
		ctx.assert.eq(byId.total_time_min, 70, "total_time_min comes from document_json.time");
		ctx.assert.eq(byId.servings, 10, "servings comes from document_json.yield");
		ctx.assert.eq(byId.source_url, "https://example.com/banana-bread", "source_url surfaces from _internal");
		const ingredients = byId.ingredients as Array<{ name: string; qty: number | null; unit: string | null }>;
		ctx.assert.eq(ingredients.length, 3, "all ingredient_groups items are flattened");
		ctx.assert.eq(ingredients[0].name, "banana", "first ingredient is banana");
		ctx.assert.eq(ingredients[0].qty, 3, "consensus_qty maps to qty");
		ctx.assert.eq(ingredients[0].unit, "whole", "unit round-trips");
		const steps = byId.steps as Array<{ prose: string; verb: string | null; index: number }>;
		ctx.assert.eq(steps.length, 2, "two steps with prose are extracted");
		ctx.assert.eq(steps[0].verb, "preheat", "primary_action.verb extracted");
		ctx.assert.contains(steps[0].prose, "Preheat the oven", "step prose round-trips");

		// 3. Lookup by canonical_dish_title (LIKE match, case-insensitive).
		const byTitle = await callPlanWorldTool("inspire_read_recipe_steps", {
			canonical_dish_title: "Banana Bread",
		}, env);
		ctx.assert.eq(byTitle.ok, true, "by canonical_dish_title returns ok=true");
		ctx.assert.eq(byTitle.recipe_id, "banana_bread", "title LIKE match resolves to banana_bread");
		ctx.assert.eq(byTitle.matched_by, "canonical_dish_title", "matched_by reflects title path");

		// 4. Partial title — fuzzy LIKE should still hit.
		const byPartial = await callPlanWorldTool("inspire_read_recipe_steps", {
			canonical_dish_title: "chocolate chip",
		}, env);
		ctx.assert.eq(byPartial.ok, true, "fuzzy LIKE match works on chocolate chip");
		ctx.assert.eq(byPartial.recipe_id, "chocolate_chip_cookies", "fuzzy match resolves correctly");
		ctx.assert.eq(byPartial.servings, 24, "second recipe servings parses");

		// 5. Lookup by canonical_dish_id — joins through canonical_dishes.
		const byDishId = await callPlanWorldTool("inspire_read_recipe_steps", {
			canonical_dish_id: 45,
		}, env);
		ctx.assert.eq(byDishId.ok, true, "by canonical_dish_id returns ok=true");
		ctx.assert.eq(byDishId.recipe_id, "banana_bread", "dish_id resolves to banana_bread via title join");
		ctx.assert.eq(byDishId.matched_by, "canonical_dish_id", "matched_by reflects dish_id path");

		// 6. No identifier → ok:false with message.
		const noId = await callPlanWorldTool("inspire_read_recipe_steps", {}, env);
		ctx.assert.eq(noId.ok, false, "missing identifier yields ok:false");
		ctx.assert.ok(typeof noId.message === "string" && (noId.message as string).length > 0, "ok:false includes a message");

		// 7. Unknown recipe → ok:false with message.
		const missing = await callPlanWorldTool("inspire_read_recipe_steps", {
			recipe_id: "definitely_not_a_recipe",
		}, env);
		ctx.assert.eq(missing.ok, false, "unknown recipe_id yields ok:false");

		// 8. JSON-RPC round-trip via tools/call.
		const rpcCall = await rpc(env, {
			id: 99,
			method: "tools/call",
			params: { name: "inspire_read_recipe_steps", arguments: { recipe_id: "banana_bread" } },
		});
		const content = rpcCall.result?.content as Array<{ type: string; text: string }> | undefined;
		ctx.assert.ok(Array.isArray(content) && content.length > 0, "tools/call returns content array");
		const parsed = JSON.parse(content?.[0].text || "{}");
		ctx.assert.eq(parsed.ok, true, "JSON content surfaces ok=true");
		ctx.assert.eq(parsed.recipe_id, "banana_bread", "JSON content surfaces recipe_id");

		ctx.notes.push(`tool count: ${toolNames.length}`);
		ctx.notes.push(`ingredients flattened: ${ingredients.length}`);
		ctx.notes.push(`steps extracted: ${steps.length}`);
	},
};

async function rpc(env: { DB: D1Database }, request: { id: number; method: string; params: unknown }): Promise<any> {
	return await handlePlanWorldJsonRpc({ jsonrpc: "2.0", ...request }, env as any) as any;
}

// ─── FakeD1 ────────────────────────────────────────────────────────────────
//
// Recognises the lookup queries `recipe-lookup.ts` issues, plus the legacy
// active/week-plans paths the MCP plumbing might touch. Tables we don't seed
// return { results: [] } so the caller's try/catch wrappers degrade
// gracefully — matching production fail-soft behavior.

interface RecipeSeed {
	id: string;
	title: string;
	description: string | null;
	document_json: string;
}

interface DishSeed {
	id: number | string;
	canonical_title: string;
}

class FakeD1 {
	recipes: RecipeSeed[] = [];
	dishes: DishSeed[] = [];

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}

	seedRecipe(row: RecipeSeed): void {
		this.recipes.push(row);
	}

	seedDish(row: DishSeed): void {
		this.dishes.push(row);
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
		const sql = this.sql;

		// canonical_recipes_v2 by id.
		if (/FROM\s+canonical_recipes_v2/i.test(sql) && /WHERE\s+id\s*=\s*\?/i.test(sql)) {
			const id = String(this.bindings[0]);
			const row = this.db.recipes.find(r => r.id === id);
			return (row ? { ...row } : null) as T | null;
		}

		// canonical_recipes_v2 by exact lowered title.
		if (/FROM\s+canonical_recipes_v2/i.test(sql) && /LOWER\(title\)\s*=\s*\?/i.test(sql)) {
			const lower = String(this.bindings[0]);
			const row = this.db.recipes.find(r => r.title.toLowerCase() === lower);
			return (row ? { ...row } : null) as T | null;
		}

		// canonical_recipes_v2 by title LIKE.
		if (/FROM\s+canonical_recipes_v2/i.test(sql) && /LOWER\(title\)\s*LIKE\s*\?/i.test(sql)) {
			const pattern = String(this.bindings[0]);
			const needle = pattern.replace(/^%|%$/g, "");
			const matches = this.db.recipes
				.filter(r => r.title.toLowerCase().includes(needle))
				.sort((a, b) => a.title.length - b.title.length);
			const row = matches[0] ?? null;
			return (row ? { ...row } : null) as T | null;
		}

		// canonical_dishes by id.
		if (/FROM\s+canonical_dishes/i.test(sql) && /WHERE\s+id\s*=\s*\?/i.test(sql)) {
			const id = this.bindings[0];
			const row = this.db.dishes.find(d => String(d.id) === String(id));
			return (row ? { canonical_title: row.canonical_title } : null) as T | null;
		}

		return null;
	}

	async run(): Promise<unknown> {
		return { success: true };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		return { results: [] as T[] };
	}
}

export default u81;
