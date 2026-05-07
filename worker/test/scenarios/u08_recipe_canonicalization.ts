// U8 — Pure unit tests for the recipe canonicalization helpers in
// recipe-importer.ts.
//
// These tests do not touch the network. They exercise:
//   - extractSchemaOrgRecipe handles HTML with and without JSON-LD.
//   - canonicalizeParsedRecipe with no LLM produces a useful ImportedRecipe
//     when handed clean schema.org input.
//   - inferFormat keyword matching: "Spicy Caramelized Shallot Pasta" →
//     "pasta", and a generic title returns null.

import type { Scenario } from "../lib/types";
import {
	canonicalizeParsedRecipe,
	extractSchemaOrgRecipe,
	inferFormat,
} from "../../src/mise-graph/recipe-importer";

const u08: Scenario = {
	id: "u08",
	name: "recipe-importer canonicalization helpers parse JSON-LD, infer format, and score confidence",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// --- extractSchemaOrgRecipe: HTML without JSON-LD --------------------
		const noLdHtml = "<html><head><title>Just a page</title></head><body><h1>Hello</h1></body></html>";
		const noLdResult = extractSchemaOrgRecipe(noLdHtml);
		ctx.assert.eq(noLdResult, null, "extractSchemaOrgRecipe returns null when no JSON-LD is present");

		// --- extractSchemaOrgRecipe: HTML with embedded Recipe JSON-LD -------
		const sampleRecipe = {
			"@context": "https://schema.org",
			"@type": "Recipe",
			name: "Spicy Caramelized Shallot Pasta",
			author: { "@type": "Person", name: "Alison Roman" },
			recipeYield: 4,
			prepTime: "PT15M",
			cookTime: "PT25M",
			totalTime: "PT40M",
			image: "https://example.com/img.jpg",
			recipeIngredient: [
				"6 anchovy fillets, packed in oil",
				"1/4 cup olive oil",
				"6 garlic cloves, thinly sliced",
				"4 large shallots, thinly sliced",
				"1 lb spaghetti",
				"1 tsp red pepper flakes",
				"Kosher salt",
			],
			recipeInstructions: [
				"Heat oil in a Dutch oven over medium-high.",
				"Add anchovies, garlic, shallots; stir until shallots are caramelized.",
				"Cook pasta until al dente; toss with sauce and reserved pasta water.",
			],
			recipeCuisine: ["Italian"],
		};
		const html = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify(sampleRecipe)}</script>
</head><body></body></html>`;
		const extracted = extractSchemaOrgRecipe(html);
		ctx.assert.ok(!!extracted, "extractSchemaOrgRecipe pulls the embedded Recipe object");
		ctx.assert.eq(
			(extracted as { name?: string }).name,
			"Spicy Caramelized Shallot Pasta",
			"extracted Recipe.name matches sample fixture",
		);

		// --- extractSchemaOrgRecipe: Recipe nested inside @graph -------------
		const graphHtml = `<html><head>
<script type="application/ld+json">${JSON.stringify({
	"@context": "https://schema.org",
	"@graph": [
		{ "@type": "WebPage", name: "Recipe page" },
		sampleRecipe,
	],
})}</script>
</head></html>`;
		const fromGraph = extractSchemaOrgRecipe(graphHtml);
		ctx.assert.ok(!!fromGraph, "extractSchemaOrgRecipe finds Recipe inside @graph");
		ctx.assert.eq(
			(fromGraph as { "@type"?: string })["@type"],
			"Recipe",
			"@graph extraction yields a Recipe node",
		);

		// --- canonicalizeParsedRecipe (no LLM) -------------------------------
		const recipe = await canonicalizeParsedRecipe(extracted);
		ctx.notes.push(`canonicalizeParsedRecipe id=${recipe.id} confidence=${recipe.confidence}`);
		ctx.notes.push(`ingredients=${recipe.ingredients_canonicalized.length} format=${recipe.canonical_format}`);

		ctx.assert.eq(recipe.title, "Spicy Caramelized Shallot Pasta", "title carried through");
		ctx.assert.eq(recipe.creator, "Alison Roman", "creator captured from author.name");
		ctx.assert.eq(recipe.servings, 4, "servings parsed from recipeYield");
		ctx.assert.gte(recipe.active_time_min, 25, "active_time_min reflects the longest source duration");
		ctx.assert.eq(recipe.canonical_format, "pasta", "canonicalizeParsedRecipe infers pasta format");
		ctx.assert.gte(recipe.confidence, 0.5, "confidence ≥ 0.5 for clean schema.org input");
		ctx.assert.eq(recipe.provenance.parser, "schema_org", "provenance.parser detected as schema_org");
		ctx.assert.ok(!!recipe.provenance.scraped_at, "provenance.scraped_at is populated");
		ctx.assert.gte(recipe.ingredients_canonicalized.length, 5, "all sample ingredients canonicalized");

		const garlic = recipe.ingredients_canonicalized.find(i => i.canonical === "garlic");
		ctx.assert.ok(!!garlic, "'garlic cloves' canonicalized to 'garlic'");
		ctx.assert.eq(garlic!.qty, 6, "garlic qty parsed");

		const oil = recipe.ingredients_canonicalized.find(i => i.canonical === "olive oil");
		ctx.assert.ok(!!oil, "olive oil ingredient present");
		ctx.assert.eq(oil!.unit, "cup", "olive oil unit parsed as cup");

		// --- inferFormat ------------------------------------------------------
		const pastaFormat = inferFormat("Spicy Caramelized Shallot Pasta", ["spaghetti", "shallot"]);
		ctx.assert.eq(pastaFormat, "pasta", "inferFormat tags pasta from title + ingredient keyword");

		const ambiguous = inferFormat("Mom's Famous Cake", ["flour", "sugar"]);
		ctx.assert.eq(ambiguous, null, "inferFormat returns null when no format keyword appears");

		const tagineFormat = inferFormat("Lamb Tagine", ["lamb", "preserved lemon"]);
		ctx.assert.eq(tagineFormat, "tagine", "inferFormat tags tagine from title keyword");
	},
};

export default u08;
