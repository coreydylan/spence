// T11 — End-to-end recipe import + slot assignment.
//
// Mocks `fetch_impl` to return an HTML page carrying schema.org/Recipe
// JSON-LD for a vegetarian-violating dish (anchovy paste shallot pasta).
// Imports the recipe through `importRecipe`, asserts the canonicalized
// shape (title, creator, servings, format, components, dietary alerts,
// provenance), then assigns the recipe to Wed dinner with a hard lock and
// asserts the post-state plan reflects the swap and lock.

import type { Scenario } from "../lib/types";
import {
	assignRecipeToSlot,
	importRecipe,
} from "../../src/mise-graph/recipe-importer";
import { isMealLocked } from "../../src/mise-graph/locks";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const SAMPLE_RECIPE = {
	"@context": "https://schema.org",
	"@type": "Recipe",
	name: "Spicy Caramelized Shallot Pasta",
	author: { "@type": "Person", name: "Alison Roman" },
	recipeYield: "4 servings",
	prepTime: "PT15M",
	cookTime: "PT25M",
	totalTime: "PT40M",
	image: "https://example.com/shallot-pasta.jpg",
	recipeCuisine: ["Italian"],
	recipeIngredient: [
		"1 tablespoon anchovy paste",
		"1/4 cup olive oil",
		"6 garlic cloves, thinly sliced",
		"4 large shallots, thinly sliced",
		"1 lb spaghetti",
		"1 tsp red pepper flakes",
		"Kosher salt",
	],
	recipeInstructions: [
		{ "@type": "HowToStep", text: "Heat olive oil in a large Dutch oven over medium-high." },
		{ "@type": "HowToStep", text: "Add anchovy paste, garlic, and shallots; stir until shallots are caramelized." },
		{ "@type": "HowToStep", text: "Toss with cooked spaghetti and a splash of pasta water." },
	],
};

const SAMPLE_HTML = `<!doctype html>
<html>
	<head>
		<title>Spicy Caramelized Shallot Pasta — Example Blog</title>
		<meta property="og:title" content="Spicy Caramelized Shallot Pasta" />
		<script type="application/ld+json">${JSON.stringify(SAMPLE_RECIPE)}</script>
	</head>
	<body><h1>Pasta</h1></body>
</html>`;

const t11: Scenario = {
	id: "t11",
	name: "Recipe import populates ImportedRecipe, surfaces dietary alerts, and pins to Wed dinner",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		const fetched: string[] = [];
		const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			fetched.push(url);
			return new Response(SAMPLE_HTML, {
				status: 200,
				headers: { "content-type": "text/html" },
			}) as unknown as Response;
		}) as typeof fetch;

		const recipe = await importRecipe({
			kind: "url",
			payload: "https://example.com/r1",
			options: {
				household_dietary: ["vegetarian"],
				fetch_impl: mockFetch,
				use_llm_canonicalize: false,
			},
		});

		ctx.notes.push(`fetched URLs: ${fetched.join(", ")}`);
		ctx.notes.push(`recipe id=${recipe.id} title="${recipe.title}" servings=${recipe.servings}`);
		ctx.notes.push(`format=${recipe.canonical_format} components=${recipe.components_inferred.length}`);
		ctx.notes.push(`warnings=${recipe.warnings.length} confidence=${recipe.confidence}`);

		ctx.assert.eq(fetched.length, 1, "mockFetch was called exactly once");
		ctx.assert.eq(recipe.title, "Spicy Caramelized Shallot Pasta", "title populated from JSON-LD");
		ctx.assert.eq(recipe.creator, "Alison Roman", "creator populated from author.name");
		ctx.assert.eq(recipe.servings, 4, "servings populated from recipeYield");
		ctx.assert.gte(recipe.active_time_min, 25, "active_time_min populated from cookTime/prepTime/totalTime");
		ctx.assert.eq(recipe.canonical_format, "pasta", "canonical_format inferred as pasta");

		// Dietary alerts: anchovy paste must trigger a non-vegetarian warning.
		const veganOrVeg = recipe.warnings.filter(w => w.kind === "non-vegetarian" || w.kind === "non-vegan");
		ctx.assert.gte(veganOrVeg.length, 1, "warnings contain a non-vegetarian alert");
		const anchovyWarning = recipe.warnings.find(w => /anchovy/i.test(w.detail));
		ctx.assert.ok(!!anchovyWarning, "warning specifically calls out anchovy");

		const flaggedIngredient = recipe.ingredients_canonicalized.find(i => i.alert === "non-vegetarian");
		ctx.assert.ok(!!flaggedIngredient, "at least one ingredient carries alert=non-vegetarian");

		// Components.
		ctx.assert.gte(recipe.components_inferred.length, 1, "at least one MealComponent inferred");
		const mainComponent = recipe.components_inferred.find(c => c.role === "main");
		ctx.assert.ok(!!mainComponent, "components_inferred includes a main component");

		// Provenance.
		ctx.assert.eq(recipe.provenance.source_url, "https://example.com/r1", "provenance.source_url tracks the input URL");
		ctx.assert.eq(recipe.provenance.parser, "schema_org", "provenance.parser is schema_org");
		ctx.assert.ok(!!recipe.provenance.scraped_at, "provenance.scraped_at is populated");

		// --- Assign + lock ----------------------------------------------------
		const plan = makeBasePlan();
		const wedBefore = findMeal(plan, "2026-05-13", "dinner");
		ctx.assert.ok(!!wedBefore, "base plan has Wed dinner slot");
		ctx.assert.notEq(wedBefore!.title, recipe.title, "Wed dinner is not yet the imported recipe");

		const updated = assignRecipeToSlot(plan, recipe, { date: "2026-05-13", slot: "dinner" }, { lock: true });

		// Original plan unmutated.
		ctx.assert.eq(findMeal(plan, "2026-05-13", "dinner")!.title, "Wednesday dinner placeholder", "original plan untouched");

		const wedAfter = findMeal(updated, "2026-05-13", "dinner");
		ctx.assert.ok(!!wedAfter, "Wed dinner survives assignment");
		ctx.assert.eq(wedAfter!.title, recipe.title, "Wed dinner replaced with imported recipe title");
		ctx.assert.eq((wedAfter!.meta as { source_recipe_id?: string } | undefined)?.source_recipe_id, recipe.id, "meta.source_recipe_id references the recipe");
		ctx.assert.eq(wedAfter!.source, `personal_recipe:${recipe.id}`, "meal.source flagged as personal_recipe:<id>");
		ctx.assert.contains(updated.source_recipe_ids, recipe.id, "plan.source_recipe_ids tracks the new recipe");
		ctx.assert.ok(isMealLocked(wedAfter!), "Wed dinner is hard-locked after assignment");

		// Lineage was extended.
		ctx.assert.gte(wedAfter!.lineage?.length || 0, 1, "lineage entry recorded for the imported recipe");
		const lineageRef = (wedAfter!.lineage || []).find(l => l.source_id === recipe.id);
		ctx.assert.ok(!!lineageRef, "lineage entry references the recipe.id");
	},
};

function findMeal(plan: MiseWeeklyPlanDraft, date: string, slot: string) {
	for (const day of plan.meals_by_day) {
		if (day.date !== date) continue;
		for (const meal of day.meals) {
			if (meal.slot === slot) return meal;
		}
	}
	return null;
}

function makeBasePlan(): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:t11",
		household_id: "test",
		title: "T11 base plan",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{
			date: "2026-05-13",
			day_index: 2,
			meals: [{
				id: "meal:wed_dinner",
				date: "2026-05-13",
				slot: "dinner",
				title: "Wednesday dinner placeholder",
				format: "bowl",
				component_ids: [],
				ingredient_names: [],
				source: "deterministic",
				notes: [],
				people: 2,
				cuisine: [],
				locked: false,
			}],
		}],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default t11;
