/**
 * Recipe Graph Worker
 *
 * Routes:
 * - POST /ingest          — upload raw recipe data (JSON)
 * - GET  /status           — pipeline status
 * - GET  /ingredients      — list canonical ingredients
 * - GET  /ingredients/:id  — ingredient detail + edges
 * - GET  /recipes          — list/search recipes
 * - GET  /recipes/:id      — recipe detail
 * - POST /process/parse    — trigger parse step on pending records
 * - POST /process/normalize — trigger normalize step
 * - POST /process/classify  — trigger classify step
 */

import { BUILDER_HTML } from "./builder-html";
import {
	handlePipelineRequest,
	handlePipelineQueue,
	handlePipelineCron,
} from "./pipeline";
import { handleMiseGraphRequest } from "./mise-graph";
import { handlePlanWorldMcpRequest } from "./mise-graph/plan-world-mcp";

// Re-export pipeline components for wrangler
export { RecipePipelineWorkflow } from "./pipeline/recipe-workflow";
export { PipelineOrchestrator } from "./pipeline/orchestrator";

export interface Env {
	DB: D1Database;
	INGEST_BUCKET: R2Bucket;
	AI: Ai;
	NORMALIZE_QUEUE: Queue;
	PIPELINE_QUEUE: Queue;
	PIPELINE_ORCHESTRATOR: DurableObjectNamespace;
	RECIPE_PIPELINE: Workflow;
	ANTHROPIC_API_KEY?: string;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// --- Pipeline routes ---
			if (path.startsWith("/pipeline/")) {
				const pipelineResponse = await handlePipelineRequest(path, request, env);
				if (pipelineResponse) return pipelineResponse;
			}

			// --- Mise Graph ---
			if (path === "/mcp/plan-world") {
				const mcpResponse = await handlePlanWorldMcpRequest(path, request, env);
				if (mcpResponse) return mcpResponse;
			}

			if (path === "/mise-graph" || path.startsWith("/mise-graph/")) {
				const miseGraphResponse = await handleMiseGraphRequest(path, request, env);
				if (miseGraphResponse) return miseGraphResponse;
			}

			// --- Ingest ---
			if (path === "/ingest" && request.method === "POST") {
				return handleIngest(request, env);
			}

			// --- Status ---
			if (path === "/status") {
				return handleStatus(env);
			}

			// --- Ingredients ---
			if (path === "/ingredients" && request.method === "GET") {
				return handleListIngredients(url, env);
			}

			if (path.startsWith("/ingredients/") && request.method === "GET") {
				const id = path.split("/")[2];
				return handleGetIngredient(id, env);
			}

			// --- Recipes ---
			if (path === "/recipes" && request.method === "GET") {
				return handleListRecipes(url, env);
			}

			if (path.startsWith("/recipes/") && request.method === "GET") {
				const id = path.split("/")[2];
				return handleGetRecipe(id, env);
			}

			// --- Bulk upload parsed ingredients ---
			if (path === "/bulk/parsed-ingredients" && request.method === "POST") {
				return handleBulkParsedIngredients(request, env);
			}

			// --- Bulk uploads ---
			if (path === "/bulk/normalization-map" && request.method === "POST") {
				return handleBulkNormalizationMap(request, env);
			}

			if (path === "/bulk/ingredient-edges" && request.method === "POST") {
				return handleBulkIngredientEdges(request, env);
			}

			// Generic bulk-insert endpoint for technique graph tables
			if (path === "/bulk/technique-graph" && request.method === "POST") {
				return handleBulkTechniqueGraph(request, env);
			}

			// Generic bulk insert for knowledge tables
			if (path === "/bulk/knowledge" && request.method === "POST") {
				return handleBulkKnowledge(request, env);
			}

			// Technique graph queries
			if (path.startsWith("/techniques/") && request.method === "GET") {
				const verb = decodeURIComponent(path.split("/")[2]);
				return handleGetTechnique(verb, env);
			}
			if (path === "/techniques" && request.method === "GET") {
				return handleListTechniques(env);
			}

			// Canonical dishes
			if (path === "/bulk/canonical-dishes" && request.method === "POST") {
				return handleBulkCanonicalDishes(request, env);
			}
			if (path === "/bulk/canonical-variations" && request.method === "POST") {
				return handleBulkCanonicalVariations(request, env);
			}
			if (path === "/dishes" && request.method === "GET") {
				return handleListDishes(url, env);
			}
			if (path.startsWith("/dishes/") && path.endsWith("/stream") && request.method === "GET") {
				const id = path.split("/")[2];
				return handleGetDishStream(id, env);
			}
			if (path.startsWith("/dishes/") && request.method === "GET") {
				const id = path.split("/")[2];
				return handleGetDish(id, env);
			}
			if (path === "/stream/blank" && request.method === "GET") {
				return handleBlankStream();
			}

			// Canonical recipes v2 (structured objects)
			if (path === "/canonical/validate" && request.method === "POST") {
				return handleValidateCanonical(request);
			}
			if (path === "/canonical" && request.method === "POST") {
				return handleUpsertCanonical(request, env);
			}
			if (path.startsWith("/canonical/") && request.method === "GET") {
				const id = path.split("/")[2];
				return handleGetCanonical(id, env);
			}

			// Composition templates
			if (path === "/bulk/composition-templates" && request.method === "POST") {
				return handleBulkCompositionTemplates(request, env);
			}
			if (path.startsWith("/compositions/") && path.endsWith("/template") && request.method === "GET") {
				const name = path.split("/")[2];
				return handleGetCompositionTemplate(name, env);
			}

			// --- Processing triggers ---
			if (path === "/process/parse" && request.method === "POST") {
				return handleProcessParse(env, ctx);
			}

			if (path === "/process/normalize" && request.method === "POST") {
				return handleProcessNormalize(env, ctx);
			}

			// --- Queue-based normalization ---
			if (path === "/process/normalize/enqueue" && request.method === "POST") {
				return handleEnqueueNormalize(env);
			}

			if (path === "/process/normalize/status" && request.method === "GET") {
				return handleNormalizeStatus(env);
			}

			// --- Translation ---
			if (path === "/process/translate" && request.method === "POST") {
				return handleTranslateBatch(request, env);
			}

			if (path === "/process/translate/status" && request.method === "GET") {
				return handleTranslateStatus(env);
			}

			// --- Geo-seasonal queries ---
			if (path === "/seasonal" && request.method === "GET") {
				return handleSeasonalQuery(url, env);
			}

			if (path === "/process/normalize/compare" && request.method === "POST") {
				return handleNormalizeCompare(env);
			}

			if (path === "/process/normalize/backfill" && request.method === "POST") {
				return handleNormalizeBackfill(env);
			}

			// --- App UI ---
			if (path === "/" || path === "/app") {
				return new Response(BUILDER_HTML, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			// --- Predictive Recipe Builder ---
			if (path === "/builder/search" && request.method === "GET") {
				return handleBuilderSearch(url, env);
			}

			if (path === "/builder/suggest" && request.method === "POST") {
				return handleBuilderSuggest(request, env);
			}

			if (path === "/builder/recipes" && request.method === "POST") {
				return handleBuilderRecipes(request, env);
			}

			if (path === "/builder/components" && request.method === "POST") {
				return handleBuilderComponents(request, env);
			}

			if (path === "/builder/dishes" && request.method === "POST") {
				return handleBuilderDishes(request, env);
			}

			// --- Default ---
			return json({
				service: "recipe-graph",
				endpoints: [
					"POST /ingest",
					"GET  /status",
					"GET  /ingredients",
					"GET  /ingredients/:id",
					"GET  /recipes",
					"GET  /recipes/:id",
					"POST /process/parse",
					"POST /process/normalize",
					"POST /process/normalize/enqueue",
					"GET  /process/normalize/status",
					"GET  /pipeline/status",
					"POST /pipeline/run",
					"POST /pipeline/toggle-auto",
					"POST /pipeline/reprocess",
					"GET  /mise-graph/status",
					"GET  /mise-graph/expand?ingredients=chickpea,tahini",
				],
			});
		} catch (e: any) {
			return json({ error: e.message }, 500);
		}
	},

	// Queue consumer — each message contains an array of ~20 ingredient names
	async queue(batch: MessageBatch<string[]>, env: Env): Promise<void> {
		const names: string[] = batch.messages.flatMap(msg => msg.body);

		if (names.length === 0) {
			batch.ackAll();
			return;
		}

		const prompt = `You are an ingredient normalizer. For each numbered ingredient, return ONLY a JSON array. No markdown.

Rules:
- Strip quantities/measurements: "olive oil 30 ml" → "olive oil"
- Strip prep separately: "onion finely diced" → c:"onion", p:"finely diced"
- Strip alternatives: "maple syrup or honey" → "maple syrup"
- Strip: "about","plus more","to taste","as needed","for serving","optional","divided", brand names
- KEEP qualifiers: "smoked paprika","unsalted butter","whole wheat flour"
- KEEP form: "ground cinnamon","fresh basil","dried oregano"
- Singularize: "eggs"→"egg","carrots"→"carrot","garlic cloves"→"garlic"
- "juice of 1 lemon"→"lemon juice","zest of lime"→"lime zest"
- "salt and pepper"→"salt"
- Not an ingredient → c:"SKIP"

Output format: [{"i":1,"c":"canonical name","p":"prep or null"}]

${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;

		const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8" as any, {
			messages: [{ role: "user", content: prompt }],
			max_tokens: 1024,
		}) as any;

		const responseText = aiResponse.response || "";
		const jsonMatch = responseText.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			// Retry — don't ack
			batch.retryAll();
			return;
		}

		const results = JSON.parse(jsonMatch[0]) as Array<{ i: number; c: string; p: string | null }>;
		const stmts: D1PreparedStatement[] = [];

		for (const r of results) {
			const idx = (r.i || 0) - 1;
			if (idx < 0 || idx >= names.length) continue;

			const original = names[idx];
			const canonical = (r.c || "").toLowerCase().trim();
			const prep = r.p ? r.p.toLowerCase().trim() : null;

			if (!canonical || canonical === "skip" || canonical === "not_ingredient") continue;

			stmts.push(
				env.DB.prepare(
					"INSERT OR REPLACE INTO normalization_map (raw_name, canonical_name, prep_extracted, normalized_by) VALUES (?, ?, ?, 'workers_ai')"
				).bind(original, canonical, prep)
			);
		}

		if (stmts.length > 0) {
			await env.DB.batch(stmts);
		}

		batch.ackAll();
	},

	// Cron trigger — runs batch processing every 6 hours
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		await handlePipelineCron(env);
	},
};

// --- Handlers ---

async function handleIngest(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;

	if (!body.source || !body.recipes) {
		return json({ error: "Required: { source: string, recipes: [...] }" }, 400);
	}

	const sourceName = body.source;
	const sourceType = body.source_type || "json_generic";
	const recipes = body.recipes as any[];

	// Get or create source
	let source = await env.DB.prepare(
		"SELECT id FROM sources WHERE name = ?"
	).bind(sourceName).first<{ id: number }>();

	if (!source) {
		await env.DB.prepare(
			"INSERT INTO sources (name, type, scraper_type, first_ingested_at) VALUES (?, ?, ?, datetime('now'))"
		).bind(sourceName, sourceType, "api").run();
		source = await env.DB.prepare(
			"SELECT id FROM sources WHERE name = ?"
		).bind(sourceName).first<{ id: number }>();
	}

	const sourceId = source!.id;
	const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	let succeeded = 0;
	let failed = 0;
	let rejected = 0;

	for (const recipe of recipes) {
		try {
			// Validate: recipe must have real ingredients
			const rawIngs = recipe.ingredients || recipe.raw_ingredients || [];
			const realIngredients = rawIngs.filter((ing: string) => {
				if (typeof ing !== "string") return false;
				// Strip numbers, fractions, common units
				const stripped = ing.replace(/[\d\/\.]+/g, "").replace(/\b(cups?|tbsp|tsp|tablespoons?|teaspoons?|ounces?|oz|pounds?|lbs?|grams?|ml|liters?|inch|pinch|dash|to taste|medium|large|small)\b/gi, "").trim();
				return stripped.length > 3;
			});

			if (realIngredients.length < 2) {
				rejected++;
				continue;
			}

			const sourceRecipeId = recipe.id || recipe.post_id || recipe.shortcode || String(Date.now());

			await env.DB.prepare(`
				INSERT OR REPLACE INTO raw_recipes (
					source_id, source_recipe_id, title, slug, url, author, published_at,
					raw_ingredients, raw_instructions, ingredient_groups,
					servings, prep_time_min, cook_time_min, total_time_min,
					source_categories, source_tags,
					featured_image_url, image_urls,
					rating_value, rating_count, review_count, comment_count,
					raw_metadata, ingest_batch, checksum
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				sourceId,
				String(sourceRecipeId),
				recipe.title || recipe.recipe_name || "Untitled",
				recipe.slug || null,
				recipe.url || recipe.link || null,
				recipe.author || null,
				recipe.date || recipe.published_at || null,
				JSON.stringify(recipe.ingredients || recipe.raw_ingredients || []),
				JSON.stringify(recipe.instructions || recipe.raw_instructions || []),
				JSON.stringify(recipe.ingredient_groups || []),
				recipe.servings || null,
				recipe.prep_time_min || null,
				recipe.cook_time_min || null,
				recipe.total_time_min || null,
				JSON.stringify(recipe.categories || recipe.category_names || []),
				JSON.stringify(recipe.tags || recipe.tag_names || []),
				recipe.featured_image_url || recipe.recipe_image || null,
				JSON.stringify(recipe.image_urls || []),
				recipe.rating_value || null,
				recipe.rating_count || null,
				recipe.review_count || null,
				recipe.comment_count || null,
				JSON.stringify(recipe),
				batchId,
				simpleHash(JSON.stringify(recipe)),
			).run();

			// Enqueue for pipeline processing
			const inserted = await env.DB.prepare(
				"SELECT id FROM raw_recipes WHERE source_id = ? AND source_recipe_id = ?"
			).bind(sourceId, String(sourceRecipeId)).first<{ id: number }>();

			if (inserted && env.PIPELINE_QUEUE) {
				await env.PIPELINE_QUEUE.send({
					type: "process_recipe",
					recipe_id: inserted.id,
				});
			}

			succeeded++;
		} catch (e) {
			failed++;
		}
	}

	// Update source stats
	const total = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM raw_recipes WHERE source_id = ?"
	).bind(sourceId).first<{ cnt: number }>();

	await env.DB.prepare(
		"UPDATE sources SET recipe_count = ?, last_ingested_at = datetime('now') WHERE id = ?"
	).bind(total!.cnt, sourceId).run();

	return json({
		batch_id: batchId,
		source: sourceName,
		succeeded,
		failed,
		rejected,
		rejection_reason: rejected > 0 ? "recipes must have at least 2 real ingredient strings" : null,
		total_in_source: total!.cnt,
	});
}

async function handleStatus(env: Env): Promise<Response> {
	const sources = await env.DB.prepare(
		"SELECT name, type, recipe_count, last_ingested_at FROM sources ORDER BY recipe_count DESC"
	).all();

	const totalRaw = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM raw_recipes"
	).first<{ cnt: number }>();

	const parseStatus = await env.DB.prepare(
		"SELECT parse_status, COUNT(*) as cnt FROM raw_recipes GROUP BY parse_status"
	).all();

	const normalizeStatus = await env.DB.prepare(
		"SELECT normalize_status, COUNT(*) as cnt FROM raw_recipes GROUP BY normalize_status"
	).all();

	const classifyStatus = await env.DB.prepare(
		"SELECT classify_status, COUNT(*) as cnt FROM raw_recipes GROUP BY classify_status"
	).all();

	const canonicalCount = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM canonical_ingredients"
	).first<{ cnt: number }>().catch(() => ({ cnt: 0 }));

	const edgeCount = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM ingredient_edges"
	).first<{ cnt: number }>().catch(() => ({ cnt: 0 }));

	return json({
		sources: sources.results,
		total_raw_recipes: totalRaw?.cnt || 0,
		pipeline: {
			parse: Object.fromEntries((parseStatus.results || []).map((r: any) => [r.parse_status, r.cnt])),
			normalize: Object.fromEntries((normalizeStatus.results || []).map((r: any) => [r.normalize_status, r.cnt])),
			classify: Object.fromEntries((classifyStatus.results || []).map((r: any) => [r.classify_status, r.cnt])),
		},
		canonical: {
			ingredients: canonicalCount?.cnt || 0,
			edges: edgeCount?.cnt || 0,
		},
	});
}

async function handleListIngredients(url: URL, env: Env): Promise<Response> {
	const search = url.searchParams.get("q") || "";
	const limit = parseInt(url.searchParams.get("limit") || "50");
	const offset = parseInt(url.searchParams.get("offset") || "0");

	let results;
	if (search) {
		results = await env.DB.prepare(
			"SELECT * FROM canonical_ingredients WHERE name LIKE ? ORDER BY total_count DESC LIMIT ? OFFSET ?"
		).bind(`%${search}%`, limit, offset).all();
	} else {
		results = await env.DB.prepare(
			"SELECT * FROM canonical_ingredients ORDER BY total_count DESC LIMIT ? OFFSET ?"
		).bind(limit, offset).all();
	}

	return json(results.results);
}

async function handleGetIngredient(id: string, env: Env): Promise<Response> {
	const ingredient = await env.DB.prepare(
		"SELECT * FROM canonical_ingredients WHERE id = ?"
	).bind(id).first();

	if (!ingredient) {
		return json({ error: "Not found" }, 404);
	}

	// Get edges (affinities)
	const edges = await env.DB.prepare(`
		SELECT e.*, i.name as related_name
		FROM ingredient_edges e
		JOIN canonical_ingredients i ON (
			CASE WHEN e.from_ingredient_id = ? THEN e.to_ingredient_id ELSE e.from_ingredient_id END
		) = i.id
		WHERE e.from_ingredient_id = ? OR e.to_ingredient_id = ?
		ORDER BY e.weighted_pmi DESC
		LIMIT 30
	`).bind(id, id, id).all();

	return json({ ingredient, edges: edges.results });
}

async function handleListRecipes(url: URL, env: Env): Promise<Response> {
	const search = url.searchParams.get("q") || "";
	const source = url.searchParams.get("source") || "";
	const limit = parseInt(url.searchParams.get("limit") || "50");
	const offset = parseInt(url.searchParams.get("offset") || "0");

	let query = "SELECT id, title, slug, url, source_id, servings, total_time_min, source_categories FROM raw_recipes WHERE 1=1";
	const params: any[] = [];

	if (search) {
		query += " AND title LIKE ?";
		params.push(`%${search}%`);
	}

	if (source) {
		query += " AND source_id = (SELECT id FROM sources WHERE name = ?)";
		params.push(source);
	}

	query += " ORDER BY id DESC LIMIT ? OFFSET ?";
	params.push(limit, offset);

	const results = await env.DB.prepare(query).bind(...params).all();
	return json(results.results);
}

async function handleGetRecipe(id: string, env: Env): Promise<Response> {
	const recipe = await env.DB.prepare(
		"SELECT * FROM raw_recipes WHERE id = ?"
	).bind(id).first();

	if (!recipe) {
		return json({ error: "Not found" }, 404);
	}

	// Get parsed ingredients if available
	const ingredients = await env.DB.prepare(
		"SELECT * FROM parsed_ingredients WHERE raw_recipe_id = ? ORDER BY sort_order"
	).bind(id).all();

	// Get classification if available
	const classification = await env.DB.prepare(
		"SELECT * FROM recipe_classifications WHERE raw_recipe_id = ? ORDER BY classified_at DESC LIMIT 1"
	).bind(id).first();

	return json({
		recipe,
		parsed_ingredients: ingredients.results,
		classification,
	});
}

async function handleBulkParsedIngredients(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const ingredients = body.ingredients as any[];

	if (!ingredients?.length) {
		return json({ error: "Required: { ingredients: [...] }" }, 400);
	}

	// Filter out garbage ingredients
	const JUNK_NAMES = new Set(["cup", "cups", "medium", "large", "small", "inch", "tablespoon", "teaspoon", "pinch", "to taste", "or", "and", "for", "the"]);
	const valid = ingredients.filter((ing: any) => {
		const name = (ing.name || "").trim();
		if (name.length < 2) return false;
		if (JUNK_NAMES.has(name.toLowerCase())) return false;
		if (/^\d+[\s\/\d.]*$/.test(name)) return false; // pure numbers
		return true;
	});

	let succeeded = 0;
	let failed = 0;
	const rejected = ingredients.length - valid.length;

	// D1 batch limit is 100 statements
	const batchSize = 50;
	for (let i = 0; i < valid.length; i += batchSize) {
		const batch = valid.slice(i, i + batchSize);
		const stmts = batch.map((ing: any) =>
			env.DB.prepare(`
				INSERT OR IGNORE INTO parsed_ingredients
				(raw_recipe_id, sort_order, raw_text, quantity, unit, name, prep, notes, canonical_name)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				ing.raw_recipe_id, ing.sort_order, ing.raw_text,
				ing.quantity, ing.unit, ing.name,
				ing.prep, ing.notes, ing.canonical_name
			)
		);

		try {
			await env.DB.batch(stmts);
			succeeded += batch.length;
		} catch (e) {
			failed += batch.length;
		}
	}

	return json({ succeeded, failed, rejected, total: ingredients.length });
}

async function handleProcessParse(env: Env, ctx: ExecutionContext): Promise<Response> {
	// Get pending recipes
	const pending = await env.DB.prepare(
		"SELECT id, raw_ingredients FROM raw_recipes WHERE parse_status = 'pending' AND raw_ingredients != '[]' LIMIT 100"
	).all();

	if (!pending.results?.length) {
		return json({ message: "No pending recipes to parse", processed: 0 });
	}

	// Process in the background
	ctx.waitUntil(processParseBatch(env, pending.results));

	return json({
		message: `Processing ${pending.results.length} recipes`,
		batch_size: pending.results.length,
	});
}

async function processParseBatch(env: Env, recipes: any[]) {
	for (const recipe of recipes) {
		try {
			const rawIngredients = JSON.parse(recipe.raw_ingredients || "[]");

			for (let i = 0; i < rawIngredients.length; i++) {
				const raw = rawIngredients[i];
				if (!raw || raw.length < 2) continue;

				// Basic parse (quantity + unit + name) — can be enhanced later
				const parsed = parseIngredientLine(raw);

				await env.DB.prepare(`
					INSERT INTO parsed_ingredients (raw_recipe_id, sort_order, raw_text, quantity, unit, name, prep, notes)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(
					recipe.id, i, raw,
					parsed.quantity, parsed.unit, parsed.name,
					parsed.prep ? JSON.stringify(parsed.prep) : null,
					parsed.notes
				).run();
			}

			await env.DB.prepare(
				"UPDATE raw_recipes SET parse_status = 'parsed' WHERE id = ?"
			).bind(recipe.id).run();
		} catch {
			await env.DB.prepare(
				"UPDATE raw_recipes SET parse_status = 'failed' WHERE id = ?"
			).bind(recipe.id).run();
		}
	}
}

// Generic bulk inserter for any technique graph table
async function handleBulkTechniqueGraph(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const table = body.table as string;
	const rows = body.rows as any[][];

	if (!table || !rows?.length) {
		return json({ error: "Required: { table: string, rows: [[...], ...] }" }, 400);
	}

	// Whitelist tables for security
	const ALLOWED = new Set([
		"tg_technique_ingredient", "tg_technique_equipment", "tg_technique_cue",
		"tg_technique_color", "tg_technique_consistency", "tg_technique_pitfall",
		"tg_technique_sequence", "tg_adverb_technique", "tg_composition_technique",
		"tg_technique_heat", "tg_technique_rest", "tg_technique_params",
		"tg_composition_params",
	]);
	if (!ALLOWED.has(table)) {
		return json({ error: `Unknown table: ${table}` }, 400);
	}

	const colCount = rows[0].length;
	const placeholders = "(" + Array(colCount).fill("?").join(",") + ")";
	const sql = `INSERT OR REPLACE INTO ${table} VALUES ${placeholders}`;

	let succeeded = 0;
	let failed = 0;
	const chunkSize = 50;

	for (let i = 0; i < rows.length; i += chunkSize) {
		const chunk = rows.slice(i, i + chunkSize);
		const stmts = chunk.map(r => env.DB.prepare(sql).bind(...r));
		try {
			await env.DB.batch(stmts);
			succeeded += chunk.length;
		} catch {
			failed += chunk.length;
		}
	}
	return json({ table, succeeded, failed, total: rows.length });
}

// Full technique graph traversal for a verb
async function handleGetTechnique(verb: string, env: Env): Promise<Response> {
	const params = await env.DB.prepare(
		"SELECT * FROM tg_technique_params WHERE technique = ?"
	).bind(verb).first();

	const ingredients = await env.DB.prepare(
		"SELECT ingredient, count FROM tg_technique_ingredient WHERE technique = ? ORDER BY count DESC LIMIT 15"
	).bind(verb).all();

	const equipment = await env.DB.prepare(
		"SELECT equipment, count FROM tg_technique_equipment WHERE technique = ? ORDER BY count DESC LIMIT 10"
	).bind(verb).all();

	const cues = await env.DB.prepare(
		"SELECT cue, count FROM tg_technique_cue WHERE technique = ? ORDER BY count DESC LIMIT 10"
	).bind(verb).all();

	const colors = await env.DB.prepare(
		"SELECT color, count FROM tg_technique_color WHERE technique = ? ORDER BY count DESC LIMIT 5"
	).bind(verb).all();

	const consistency = await env.DB.prepare(
		"SELECT consistency, count FROM tg_technique_consistency WHERE technique = ? ORDER BY count DESC LIMIT 5"
	).bind(verb).all();

	const pitfalls = await env.DB.prepare(
		"SELECT pitfall, count FROM tg_technique_pitfall WHERE technique = ? ORDER BY count DESC LIMIT 5"
	).bind(verb).all();

	const adverbs = await env.DB.prepare(
		"SELECT adverb, count FROM tg_adverb_technique WHERE technique = ? ORDER BY count DESC LIMIT 8"
	).bind(verb).all();

	const followedBy = await env.DB.prepare(
		"SELECT next_technique, count FROM tg_technique_sequence WHERE prev_technique = ? ORDER BY count DESC LIMIT 8"
	).bind(verb).all();

	const precededBy = await env.DB.prepare(
		"SELECT prev_technique, count FROM tg_technique_sequence WHERE next_technique = ? ORDER BY count DESC LIMIT 8"
	).bind(verb).all();

	const compositions = await env.DB.prepare(
		"SELECT composition, count FROM tg_composition_technique WHERE technique = ? ORDER BY count DESC LIMIT 10"
	).bind(verb).all();

	const heat = await env.DB.prepare(
		"SELECT heat_level, count FROM tg_technique_heat WHERE technique = ? ORDER BY count DESC"
	).bind(verb).all();

	return json({
		technique: verb,
		params,
		ingredients: ingredients.results,
		equipment: equipment.results,
		sensory_cues: cues.results,
		color_cues: colors.results,
		consistency: consistency.results,
		pitfalls: pitfalls.results,
		adverbs: adverbs.results,
		followed_by: followedBy.results,
		preceded_by: precededBy.results,
		compositions: compositions.results,
		heat_levels: heat.results,
	});
}

async function handleListTechniques(env: Env): Promise<Response> {
	const techs = await env.DB.prepare(`
		SELECT technique, temp_count + time_count as usage_count
		FROM tg_technique_params
		ORDER BY usage_count DESC
		LIMIT 100
	`).all();
	return json({ techniques: techs.results });
}

async function handleBulkKnowledge(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const table = body.table as string;
	const rows = body.rows as any[][];

	if (!table || !rows?.length) return json({ error: "Required: table, rows" }, 400);

	const ALLOWED = new Set([
		"recipe_features", "ingredient_hierarchy",
		"canonical_pitfalls", "canonical_causal_rules", "canonical_recovery_rules",
	]);
	if (!ALLOWED.has(table)) return json({ error: `Unknown table: ${table}` }, 400);

	const colCount = rows[0].length;
	const placeholders = "(" + Array(colCount).fill("?").join(",") + ")";
	const sql = `INSERT OR REPLACE INTO ${table} VALUES ${placeholders}`;

	let succeeded = 0, failed = 0;
	const chunkSize = 30;
	for (let i = 0; i < rows.length; i += chunkSize) {
		const chunk = rows.slice(i, i + chunkSize);
		const stmts = chunk.map(r => env.DB.prepare(sql).bind(...r));
		try {
			await env.DB.batch(stmts);
			succeeded += chunk.length;
		} catch {
			failed += chunk.length;
		}
	}
	return json({ table, succeeded, failed });
}

async function handleBulkCanonicalDishes(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const dishes = body.dishes as any[];
	if (!dishes?.length) return json({ error: "Required: dishes[]" }, 400);

	let succeeded = 0, failed = 0;
	const chunk = 30;
	for (let i = 0; i < dishes.length; i += chunk) {
		const batch = dishes.slice(i, i + chunk);
		const stmts = batch.map(d => env.DB.prepare(
			"INSERT OR REPLACE INTO canonical_dishes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
		).bind(
			d.id, d.canonical_title, d.composition, d.sweet_savory,
			d.meals, d.methods, d.equipment,
			d.recipe_count, d.source_count,
			d.core_ingredients, d.expected_ingredients, d.optional_ingredients,
			d.consensus_servings, d.consensus_total_time,
			d.consensus_cook_time, d.consensus_prep_time
		));
		try {
			await env.DB.batch(stmts);
			succeeded += batch.length;
		} catch {
			failed += batch.length;
		}
	}
	return json({ succeeded, failed });
}

async function handleBulkCanonicalVariations(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const variations = body.variations as any[];
	if (!variations?.length) return json({ error: "Required: variations[]" }, 400);

	let succeeded = 0, failed = 0;
	const chunk = 50;
	for (let i = 0; i < variations.length; i += chunk) {
		const batch = variations.slice(i, i + chunk);
		const stmts = batch.map(v => env.DB.prepare(
			"INSERT OR REPLACE INTO canonical_variations VALUES (?,?,?,?,?)"
		).bind(v.id, v.canonical_id, v.variation_label, v.variation_title, v.recipe_count));
		try {
			await env.DB.batch(stmts);
			succeeded += batch.length;
		} catch {
			failed += batch.length;
		}
	}
	return json({ succeeded, failed });
}

async function handleListDishes(url: URL, env: Env): Promise<Response> {
	const comp = url.searchParams.get("composition");
	const q = url.searchParams.get("q");
	const limit = parseInt(url.searchParams.get("limit") || "50");

	let sql = "SELECT id, canonical_title, composition, recipe_count, source_count, consensus_total_time, consensus_servings FROM canonical_dishes WHERE 1=1";
	const params: any[] = [];
	if (comp) { sql += " AND composition = ?"; params.push(comp); }
	if (q) { sql += " AND canonical_title LIKE ?"; params.push(`%${q}%`); }
	sql += " ORDER BY recipe_count DESC LIMIT ?";
	params.push(limit);

	const results = await env.DB.prepare(sql).bind(...params).all();
	return json({ dishes: results.results });
}

async function handleGetDish(id: string, env: Env): Promise<Response> {
	const dish = await env.DB.prepare("SELECT * FROM canonical_dishes WHERE id = ?").bind(id).first();
	if (!dish) return json({ error: "Not found" }, 404);

	const variations = await env.DB.prepare(
		"SELECT variation_label, variation_title, recipe_count FROM canonical_variations WHERE canonical_id = ? ORDER BY recipe_count DESC"
	).bind(id).all();

	return json({ dish, variations: variations.results });
}

async function handleGetDishStream(id: string, env: Env): Promise<Response> {
	const dish = await env.DB.prepare("SELECT * FROM canonical_dishes WHERE id = ?").bind(id).first<any>();
	if (!dish) return json({ error: "Not found" }, 404);

	const variations = await env.DB.prepare(
		"SELECT variation_label, recipe_count FROM canonical_variations WHERE canonical_id = ? ORDER BY recipe_count DESC"
	).bind(id).all<any>();

	const { buildStreamFromCanonical } = await import("./cards");
	const stream = buildStreamFromCanonical(dish, variations.results || []);

	return json({
		recipe_id: dish.id,
		canonical_title: dish.canonical_title,
		stream,
	});
}

async function handleBlankStream(): Promise<Response> {
	const { buildBlankStream } = await import("./cards");
	return json({ stream: buildBlankStream() });
}

// === Canonical Recipe v2 handlers ===

async function handleValidateCanonical(request: Request): Promise<Response> {
	const recipe = await request.json() as any;
	const { validateCanonicalRecipe } = await import("./validators/canonical");
	const result = validateCanonicalRecipe(recipe);
	return json(result);
}

async function handleUpsertCanonical(request: Request, env: Env): Promise<Response> {
	const recipe = await request.json() as any;
	const { validateCanonicalRecipe } = await import("./validators/canonical");
	const validation = validateCanonicalRecipe(recipe);

	if (!validation.valid) {
		return json({ error: "Validation failed", validation }, 400);
	}

	await env.DB.prepare(`
		INSERT OR REPLACE INTO canonical_recipes_v2
		(id, title, description, composition, category, is_component, component_role,
		 default_method, status, confidence_score, corpus_count, reviewed_at, reviewer,
		 document_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`).bind(
		recipe.id,
		recipe.title,
		recipe.description || null,
		recipe.composition,
		recipe.category || null,
		recipe.is_component ? 1 : 0,
		recipe.component_role || null,
		recipe.default_method || null,
		recipe._internal?.status || "draft",
		recipe._internal?.confidence_score || null,
		recipe._internal?.corpus_count || null,
		recipe._internal?.reviewed_at || null,
		recipe._internal?.reviewer || null,
		JSON.stringify(recipe),
	).run();

	// Update component usage graph
	await env.DB.prepare(
		"DELETE FROM canonical_component_usage WHERE composite_id = ?"
	).bind(recipe.id).run();

	if (recipe.ingredient_groups) {
		for (const group of recipe.ingredient_groups) {
			if (group.component_ref) {
				await env.DB.prepare(
					"INSERT OR REPLACE INTO canonical_component_usage (composite_id, component_id, slot) VALUES (?, ?, ?)"
				).bind(recipe.id, group.component_ref, group.slot || null).run();
			}
		}
	}

	return json({ success: true, id: recipe.id, validation });
}

async function handleGetCanonical(id: string, env: Env): Promise<Response> {
	const row = await env.DB.prepare(
		"SELECT document_json FROM canonical_recipes_v2 WHERE id = ?"
	).bind(id).first<{ document_json: string }>();

	if (!row) return json({ error: "Not found" }, 404);

	return json(JSON.parse(row.document_json));
}

async function handleBulkCompositionTemplates(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const templates = body.templates as Array<{ name: string; slots: any[]; variant_sets: any[] }>;
	if (!templates?.length) return json({ error: "Required: templates[]" }, 400);

	for (const t of templates) {
		await env.DB.prepare(
			"INSERT OR REPLACE INTO composition_templates (name, slots_json, variant_sets_json) VALUES (?, ?, ?)"
		).bind(t.name, JSON.stringify(t.slots), JSON.stringify(t.variant_sets)).run();
	}
	return json({ uploaded: templates.length });
}

async function handleGetCompositionTemplate(name: string, env: Env): Promise<Response> {
	const row = await env.DB.prepare(
		"SELECT slots_json, variant_sets_json FROM composition_templates WHERE name = ?"
	).bind(name).first<{ slots_json: string; variant_sets_json: string }>();
	if (!row) return json({ error: "Template not found" }, 404);

	const slots = JSON.parse(row.slots_json);
	const variant_sets = JSON.parse(row.variant_sets_json);

	const { buildCompositionTemplateStream } = await import("./templates");
	const stream = buildCompositionTemplateStream(name, { slots, variant_sets });

	return json({
		composition: name,
		slots,
		variant_sets,
		stream,
	});
}

async function handleBulkIngredientEdges(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const edges = body.edges as Array<{
		from_id: number; to_id: number; cooccurrence: number;
		pmi: number; npmi: number;
	}>;

	if (!edges?.length) {
		return json({ error: "Required: { edges: [{from_id, to_id, cooccurrence, pmi, npmi}] }" }, 400);
	}

	let succeeded = 0;
	let failed = 0;
	const chunkSize = 50;

	for (let i = 0; i < edges.length; i += chunkSize) {
		const chunk = edges.slice(i, i + chunkSize);
		const stmts = chunk.map(e =>
			env.DB.prepare(
				"INSERT OR REPLACE INTO ingredient_edges (from_ingredient_id, to_ingredient_id, type, co_count, pmi, weighted_pmi, source) VALUES (?, ?, 'cooccurrence', ?, ?, ?, 'computed')"
			).bind(e.from_id, e.to_id, e.cooccurrence, e.pmi, e.npmi)
		);

		try {
			await env.DB.batch(stmts);
			succeeded += chunk.length;
		} catch {
			failed += chunk.length;
		}
	}

	return json({ succeeded, failed, total: edges.length });
}

async function handleBulkNormalizationMap(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const mappings = body.mappings as Array<{ raw_name: string; canonical_name: string; prep: string | null }>;

	if (!mappings?.length) {
		return json({ error: "Required: { mappings: [{raw_name, canonical_name, prep}] }" }, 400);
	}

	// D1 batch limit is ~100 statements, so chunk
	let succeeded = 0;
	let failed = 0;
	const chunkSize = 50;

	for (let i = 0; i < mappings.length; i += chunkSize) {
		const chunk = mappings.slice(i, i + chunkSize);
		const stmts = chunk.map(m =>
			env.DB.prepare(
				"INSERT OR REPLACE INTO normalization_map (raw_name, canonical_name, prep_extracted, normalized_by) VALUES (?, ?, ?, 'gpt-5.4-nano')"
			).bind(m.raw_name, m.canonical_name, m.prep || null)
		);

		try {
			await env.DB.batch(stmts);
			succeeded += chunk.length;
		} catch {
			failed += chunk.length;
		}
	}

	return json({ succeeded, failed, total: mappings.length });
}

async function handleEnqueueNormalize(env: Env): Promise<Response> {
	// Get all unique unnormalized ingredient names, ordered by frequency
	const pending = await env.DB.prepare(`
		SELECT name, COUNT(*) as cnt
		FROM parsed_ingredients
		WHERE canonical_name IS NULL
		GROUP BY name
		ORDER BY cnt DESC
	`).all();

	if (!pending.results?.length) {
		return json({ message: "No ingredients to normalize", enqueued: 0 });
	}

	const names = pending.results.map((r: any) => r.name as string);
	const batchSize = 20; // matches queue consumer max_batch_size
	let enqueued = 0;

	// Send to queue in chunks of 20 names per message
	// Queue max_batch_size=20 messages, so consumer gets up to 20 messages = 20 batches
	// But we want each message to contain a chunk of names for one AI call
	const messageBatches: MessageSendRequest[] = [];
	for (let i = 0; i < names.length; i += batchSize) {
		const chunk = names.slice(i, i + batchSize);
		messageBatches.push({ body: chunk });

		// Queue sendBatch limit is 100 messages per call
		if (messageBatches.length >= 100) {
			await env.NORMALIZE_QUEUE.sendBatch(messageBatches);
			enqueued += messageBatches.length;
			messageBatches.length = 0;
		}
	}

	// Send remaining
	if (messageBatches.length > 0) {
		await env.NORMALIZE_QUEUE.sendBatch(messageBatches);
		enqueued += messageBatches.length;
	}

	return json({
		total_names: names.length,
		batches_enqueued: enqueued,
		names_per_batch: batchSize,
	});
}

async function handleNormalizeStatus(env: Env): Promise<Response> {
	const total = await env.DB.prepare(
		"SELECT COUNT(DISTINCT name) as cnt FROM parsed_ingredients"
	).first<{ cnt: number }>();

	const mapCount = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM normalization_map"
	).first<{ cnt: number }>();

	const canonicalCount = await env.DB.prepare(
		"SELECT COUNT(DISTINCT canonical_name) as cnt FROM normalization_map"
	).first<{ cnt: number }>();

	const totalNames = total?.cnt || 0;
	const mapped = mapCount?.cnt || 0;

	return json({
		total_unique_names: totalNames,
		mapped: mapped,
		remaining: totalNames - mapped,
		percent_done: totalNames ? Math.round((mapped / totalNames) * 100) : 0,
		canonical_ingredients: canonicalCount?.cnt || 0,
	});
}

async function handleNormalizeCompare(env: Env): Promise<Response> {
	// Grab 20 random unnormalized names with a mix of easy and hard
	const pending = await env.DB.prepare(`
		SELECT name, COUNT(*) as cnt
		FROM parsed_ingredients
		WHERE name NOT IN (SELECT raw_name FROM normalization_map)
		GROUP BY name
		ORDER BY RANDOM()
		LIMIT 20
	`).all();

	const names = pending.results?.map((r: any) => r.name as string) || [];

	const prompt = `You are an ingredient normalizer. For each numbered ingredient, return ONLY a JSON array. No markdown.

Rules:
- Strip quantities/measurements: "olive oil 30 ml" → "olive oil"
- Strip prep separately: "onion finely diced" → c:"onion", p:"finely diced"
- Strip alternatives: "maple syrup or honey" ��� "maple syrup"
- Strip: "about","plus more","to taste","as needed","for serving","optional","divided", brand names
- KEEP qualifiers: "smoked paprika","unsalted butter","whole wheat flour"
- KEEP form: "ground cinnamon","fresh basil","dried oregano"
- Singularize: "eggs"→"egg","carrots"→"carrot","garlic cloves"→"garlic"
- "juice of 1 lemon"→"lemon juice","zest of lime"→"lime zest"
- "salt and pepper"→"salt"
- Not an ingredient → c:"SKIP"

Output format: [{"i":1,"c":"canonical name","p":"prep or null"}]

${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;

	const models = [
		"@cf/meta/llama-3.1-8b-instruct-fp8",
		"@cf/mistral/mistral-7b-instruct-v0.2-lora",
		"@cf/microsoft/phi-2",
		"@cf/qwen/qwen1.5-1.8b-chat",
		"@cf/qwen/qwen1.5-0.5b-chat",
		"@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
	];

	const results: Record<string, any> = {};

	// Run all models in parallel
	const runs = models.map(async (model) => {
		const start = Date.now();
		try {
			const aiResponse = await env.AI.run(model as any, {
				messages: [{ role: "user", content: prompt }],
				max_tokens: 1024,
			}) as any;
			const elapsed = Date.now() - start;
			const responseText = aiResponse.response || "";
			const jsonMatch = responseText.match(/\[[\s\S]*\]/);

			let parsed: any[] = [];
			let parseError = null;
			if (jsonMatch) {
				try { parsed = JSON.parse(jsonMatch[0]); } catch (e: any) { parseError = e.message; }
			}

			results[model] = {
				elapsed_ms: elapsed,
				valid_json: !!jsonMatch && !parseError,
				items_returned: parsed.length,
				parse_error: parseError,
				raw_preview: responseText.slice(0, 300),
				normalized: parsed.slice(0, 20).map((r: any) => ({
					i: r.i,
					c: (r.c || "").toLowerCase().trim(),
					p: r.p || null,
				})),
			};
		} catch (e: any) {
			results[model] = { error: e.message, elapsed_ms: Date.now() - start };
		}
	});

	await Promise.all(runs);

	return json({ input_names: names, models: results });
}

async function handleNormalizeBackfill(env: Env): Promise<Response> {
	// Apply normalization_map to parsed_ingredients in batches
	// Get unmapped names that have a mapping available
	const pending = await env.DB.prepare(`
		SELECT DISTINCT pi.name, nm.canonical_name
		FROM parsed_ingredients pi
		JOIN normalization_map nm ON nm.raw_name = pi.name
		WHERE pi.canonical_name IS NULL
		LIMIT 5000
	`).all();

	if (!pending.results?.length) {
		return json({ message: "No ingredients to backfill", updated: 0 });
	}

	const stmts = pending.results.map((r: any) =>
		env.DB.prepare(
			"UPDATE parsed_ingredients SET canonical_name = ? WHERE name = ? AND canonical_name IS NULL"
		).bind(r.canonical_name, r.name)
	);

	// Execute in batches of 50
	let updated = 0;
	for (let i = 0; i < stmts.length; i += 50) {
		const batch = stmts.slice(i, i + 50);
		await env.DB.batch(batch);
		updated += batch.length;
	}

	const remaining = await env.DB.prepare(`
		SELECT COUNT(DISTINCT pi.name) as cnt
		FROM parsed_ingredients pi
		JOIN normalization_map nm ON nm.raw_name = pi.name
		WHERE pi.canonical_name IS NULL
	`).first<{ cnt: number }>();

	return json({
		updated_names: updated,
		remaining_to_backfill: remaining?.cnt || 0,
	});
}

async function handleProcessNormalize(env: Env, ctx: ExecutionContext): Promise<Response> {
	const batchSize = 20;

	// Get unique unnormalized ingredient names (most common first)
	const pending = await env.DB.prepare(`
		SELECT name, COUNT(*) as cnt
		FROM parsed_ingredients
		WHERE canonical_name IS NULL
		GROUP BY name
		ORDER BY cnt DESC
		LIMIT ?
	`).bind(batchSize).all();

	if (!pending.results?.length) {
		return json({ message: "No ingredients to normalize", processed: 0 });
	}

	const names = pending.results.map((r: any) => r.name as string);

	const prompt = `You are an ingredient normalizer. For each numbered ingredient, return ONLY a JSON array. No markdown.

Rules:
- Strip quantities/measurements: "olive oil 30 ml" → "olive oil"
- Strip prep separately: "onion finely diced" → c:"onion", p:"finely diced"
- Strip alternatives: "maple syrup or honey" → "maple syrup"
- Strip: "about","plus more","to taste","as needed","for serving","optional","divided", brand names
- KEEP qualifiers: "smoked paprika","unsalted butter","whole wheat flour"
- KEEP form: "ground cinnamon","fresh basil","dried oregano"
- Singularize: "eggs"→"egg","carrots"→"carrot","garlic cloves"→"garlic"
- "juice of 1 lemon"→"lemon juice","zest of lime"→"lime zest"
- "salt and pepper"→"salt"
- Not an ingredient → c:"SKIP"

Output format: [{"i":1,"c":"canonical name","p":"prep or null"}]

${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}`;

	try {
		const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8" as any, {
			messages: [{ role: "user", content: prompt }],
			max_tokens: 1024,
		}) as any;

		const responseText = aiResponse.response || "";
		const jsonMatch = responseText.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			return json({ error: "AI did not return valid JSON", raw: responseText.slice(0, 500) }, 500);
		}

		const results = JSON.parse(jsonMatch[0]) as Array<{ i: number; c: string; p: string | null }>;
		let mapped = 0;
		let skipped = 0;

		// Build batch of D1 statements
		const stmts: D1PreparedStatement[] = [];

		for (const r of results) {
			const idx = (r.i || 0) - 1;
			if (idx < 0 || idx >= names.length) continue;

			const original = names[idx];
			const canonical = (r.c || "").toLowerCase().trim();
			const prep = r.p ? r.p.toLowerCase().trim() : null;

			if (!canonical || canonical === "skip" || canonical === "not_ingredient") {
				skipped++;
				continue;
			}

			stmts.push(
				env.DB.prepare(
					"INSERT OR REPLACE INTO normalization_map (raw_name, canonical_name, prep_extracted, normalized_by) VALUES (?, ?, ?, 'workers_ai')"
				).bind(original, canonical, prep)
			);
			stmts.push(
				env.DB.prepare(
					"UPDATE parsed_ingredients SET canonical_name = ? WHERE name = ?"
				).bind(canonical, original)
			);
			mapped++;
		}

		// Execute all DB writes in a single batch
		if (stmts.length > 0) {
			await env.DB.batch(stmts);
		}

		// Count remaining in the background to avoid blocking response
		const remaining = await env.DB.prepare(
			"SELECT COUNT(DISTINCT name) as cnt FROM parsed_ingredients WHERE canonical_name IS NULL"
		).first<{ cnt: number }>().then(r => r?.cnt || 0);

		return json({ processed: names.length, mapped, skipped, remaining });

	} catch (e: any) {
		return json({ error: e.message }, 500);
	}
}

// --- Predictive Recipe Builder ---

async function handleBuilderSearch(url: URL, env: Env): Promise<Response> {
	// Autocomplete ingredient search
	const q = (url.searchParams.get("q") || "").toLowerCase().trim();
	const limit = parseInt(url.searchParams.get("limit") || "10");

	if (q.length < 1) {
		return json({ results: [] });
	}

	// Prefix match first, then contains
	const prefixResults = await env.DB.prepare(
		"SELECT id, name, total_count, category FROM canonical_ingredients WHERE name LIKE ? ORDER BY total_count DESC LIMIT ?"
	).bind(`${q}%`, limit).all();

	let results = prefixResults.results || [];

	// If we have room, add contains matches
	if (results.length < limit) {
		const remaining = limit - results.length;
		const containsResults = await env.DB.prepare(
			"SELECT id, name, total_count, category FROM canonical_ingredients WHERE name LIKE ? AND name NOT LIKE ? ORDER BY total_count DESC LIMIT ?"
		).bind(`%${q}%`, `${q}%`, remaining).all();
		results = results.concat(containsResults.results || []);
	}

	return json({ query: q, results });
}

async function handleBuilderSuggest(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const ingredientIds = (body.ingredient_ids || []) as number[];
	const limit = body.limit || 20;

	if (!ingredientIds.length) {
		return json({ error: "Required: { ingredient_ids: [id1, id2, ...] }" }, 400);
	}

	const idsList = ingredientIds.join(",");

	// === 1. Affinity-based suggestions via ingredient_edges ===
	const suggestions = await env.DB.prepare(`
		SELECT
			CASE WHEN from_ingredient_id IN (${idsList}) THEN to_ingredient_id ELSE from_ingredient_id END as partner_id,
			SUM(weighted_pmi) as total_score,
			COUNT(*) as co_count
		FROM ingredient_edges
		WHERE (from_ingredient_id IN (${idsList}) OR to_ingredient_id IN (${idsList}))
		AND CASE WHEN from_ingredient_id IN (${idsList}) THEN to_ingredient_id ELSE from_ingredient_id END NOT IN (${idsList})
		AND weighted_pmi > 0
		GROUP BY partner_id
		HAVING COUNT(*) >= ?
		ORDER BY total_score DESC
		LIMIT ?
	`).bind(Math.max(1, Math.floor(ingredientIds.length / 2)), limit).all();

	const partnerIds = (suggestions.results || []).map((s: any) => s.partner_id);
	let enrichedSuggestions: any[] = [];

	if (partnerIds.length > 0) {
		const partnerInfo = await env.DB.prepare(
			`SELECT id, name, category, subcategory, total_count, flavor_profile FROM canonical_ingredients WHERE id IN (${partnerIds.join(",")})`
		).all();

		const infoMap = new Map((partnerInfo.results || []).map((r: any) => [r.id, r]));

		enrichedSuggestions = (suggestions.results || []).map((s: any) => {
			const info = infoMap.get(s.partner_id) as any;
			return {
				id: s.partner_id,
				name: info?.name,
				category: info?.category,
				subcategory: info?.subcategory,
				score: Math.round((s.total_score as number) * 100) / 100,
				co_occurrence: s.co_count,
				flavor_profile: info?.flavor_profile ? JSON.parse(info.flavor_profile as string).slice(0, 5) : null,
			};
		});
	}

	// === 2. Composition prediction from source_categories/tags ===
	const compositionQuery = await env.DB.prepare(`
		SELECT source_categories, source_tags
		FROM raw_recipes
		WHERE id IN (
			SELECT raw_recipe_id FROM parsed_ingredients
			WHERE canonical_name IN (
				SELECT name FROM canonical_ingredients WHERE id IN (${idsList})
			)
			GROUP BY raw_recipe_id
			HAVING COUNT(DISTINCT canonical_name) >= ?
		)
		LIMIT 200
	`).bind(Math.max(1, Math.floor(ingredientIds.length * 0.6))).all();

	const categoryCounts = new Map<string, number>();
	const tagCounts = new Map<string, number>();

	for (const r of (compositionQuery.results || [])) {
		try {
			const cats = JSON.parse((r.source_categories as string) || "[]");
			for (const c of cats) {
				const key = String(c).toLowerCase();
				categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
			}
		} catch {}
		try {
			const tags = JSON.parse((r.source_tags as string) || "[]");
			for (const t of tags) {
				const key = String(t).toLowerCase();
				tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
			}
		} catch {}
	}

	const matchingRecipes = compositionQuery.results?.length || 0;

	const topCategories = Array.from(categoryCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([cat, count]) => ({
			category: cat,
			recipe_count: count,
			confidence: matchingRecipes > 0 ? Math.round((count / matchingRecipes) * 100) : 0,
		}));

	const topTags = Array.from(tagCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.map(([tag, count]) => ({
			tag,
			recipe_count: count,
			confidence: matchingRecipes > 0 ? Math.round((count / matchingRecipes) * 100) : 0,
		}));

	// === 3. Flavor compound overlap ===
	const flavorMatches = await env.DB.prepare(`
		SELECT
			ic2.canonical_ingredient_id as partner_id,
			ci.name as partner_name,
			COUNT(DISTINCT ic1.compound_id) as shared_compounds
		FROM ingredient_compounds ic1
		JOIN ingredient_compounds ic2 ON ic1.compound_id = ic2.compound_id
		JOIN canonical_ingredients ci ON ic2.canonical_ingredient_id = ci.id
		WHERE ic1.canonical_ingredient_id IN (${idsList})
		AND ic2.canonical_ingredient_id NOT IN (${idsList})
		GROUP BY partner_id, partner_name
		ORDER BY shared_compounds DESC
		LIMIT 10
	`).all();

	return json({
		selected_count: ingredientIds.length,
		matching_recipes: matchingRecipes,
		suggestions: enrichedSuggestions,
		composition: {
			categories: topCategories,
			tags: topTags,
		},
		flavor_pairings: flavorMatches.results || [],
	});
}

async function handleBuilderRecipes(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const ingredientIds = (body.ingredient_ids || []) as number[];
	const limit = body.limit || 12;

	if (!ingredientIds.length) {
		return json({ error: "Required: { ingredient_ids: [id1, id2, ...] }" }, 400);
	}

	const idsList = ingredientIds.join(",");

	// Find recipes that contain the most of these ingredients
	// Rank by: (matching count / total selected) desc, then by match count, then by rating
	const recipes = await env.DB.prepare(`
		WITH canonical_names AS (
			SELECT id, name FROM canonical_ingredients WHERE id IN (${idsList})
		),
		matches AS (
			SELECT
				pi.raw_recipe_id,
				COUNT(DISTINCT pi.canonical_name) as match_count,
				GROUP_CONCAT(DISTINCT pi.canonical_name) as matched
			FROM parsed_ingredients pi
			WHERE pi.canonical_name IN (SELECT name FROM canonical_names)
			GROUP BY pi.raw_recipe_id
			HAVING match_count >= ?
		)
		SELECT
			r.id,
			r.title,
			r.url,
			r.featured_image_url,
			r.rating_value,
			r.rating_count,
			r.total_time_min,
			r.servings,
			r.source_categories,
			m.match_count,
			m.matched,
			s.name as source_name
		FROM matches m
		JOIN raw_recipes r ON r.id = m.raw_recipe_id
		LEFT JOIN sources s ON s.id = r.source_id
		ORDER BY
			m.match_count DESC,
			COALESCE(r.rating_value, 0) DESC,
			COALESCE(r.rating_count, 0) DESC
		LIMIT ?
	`).bind(
		Math.max(2, Math.ceil(ingredientIds.length * 0.6)),
		limit
	).all();

	return json({
		selected_count: ingredientIds.length,
		results_count: recipes.results?.length || 0,
		recipes: recipes.results || [],
	});
}

// Cache for ingredient IDF weights
let ingIdfCache: Map<string, number> | null = null;

async function getIngredientIdf(env: Env): Promise<Map<string, number>> {
	if (ingIdfCache) return ingIdfCache;

	const rows = await env.DB.prepare(
		"SELECT name, total_count FROM canonical_ingredients WHERE total_count > 0"
	).all();

	let maxCount = 1;
	for (const r of (rows.results || [])) {
		const c = r.total_count as number;
		if (c > maxCount) maxCount = c;
	}

	const idf = new Map<string, number>();
	for (const r of (rows.results || [])) {
		const name = (r.name as string).toLowerCase();
		const count = r.total_count as number;
		// IDF = log((maxCount + 1) / (count + 1)). Rare → high, generic → low.
		idf.set(name, Math.log((maxCount + 1) / (count + 1)));
	}
	ingIdfCache = idf;
	return idf;
}


async function handleBuilderComponents(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const ingredientNames = (body.ingredient_names || []) as string[];

	if (!ingredientNames.length) {
		return json({ error: "Required: { ingredient_names: ['tahini', 'lemon'] }" }, 400);
	}

	const idf = await getIngredientIdf(env);
	const componentsRes = await env.DB.prepare(
		"SELECT id, canonical_name, family, component_type, recipe_count, core_ingredients, common_ingredients, cuisine_signature FROM canonical_components"
	).all();

	const userIngSet = new Set(ingredientNames.map(n => n.toLowerCase().trim()));
	const getWeight = (ing: string) => idf.get(ing) ?? 3.0;

	// Compute user's own weighted signature — we'll compare against component signatures
	const userWeights = new Map<string, number>();
	for (const ing of userIngSet) {
		userWeights.set(ing, getWeight(ing));
	}

	const matches: any[] = [];
	for (const comp of (componentsRes.results || [])) {
		const core = (JSON.parse((comp.core_ingredients as string) || "[]") as string[])
			.map(i => i.toLowerCase());
		const common = (JSON.parse((comp.common_ingredients as string) || "[]") as string[])
			.map(i => i.toLowerCase());

		if (core.length === 0) continue;

		// Signature weight = core (weight 1.0) + common (weight 0.5)
		let signatureWeight = 0;
		let userMatchWeight = 0;
		const have: string[] = [];
		const missing: string[] = [];
		const missingDefining: string[] = [];

		for (const ing of core) {
			const w = getWeight(ing);
			signatureWeight += w;
			if (userIngSet.has(ing)) {
				userMatchWeight += w;
				have.push(ing);
			} else {
				missing.push(ing);
				if (w >= 1.5) missingDefining.push(ing);
			}
		}
		for (const ing of common) {
			const w = getWeight(ing) * 0.5;
			signatureWeight += w;
			if (userIngSet.has(ing)) {
				userMatchWeight += w;
				have.push(ing);
			}
		}

		if (signatureWeight === 0) continue;

		const completionRatio = userMatchWeight / signatureWeight;
		// Require at least 25% weighted match
		if (completionRatio < 0.25) continue;

		// Find the highest-weight match (the distinguishing ingredient)
		let distinguishingMatch = "";
		let distinguishingWeight = 0;
		for (const ing of have) {
			const w = getWeight(ing);
			if (w > distinguishingWeight) {
				distinguishingWeight = w;
				distinguishingMatch = ing;
			}
		}

		matches.push({
			component_id: comp.id,
			name: comp.canonical_name,
			family: comp.family,
			component_type: comp.component_type,
			recipe_count: comp.recipe_count,
			core_ingredients: core,
			ingredients_have: have,
			core_missing: missing,
			missing_defining: missingDefining,
			distinguishing_match: distinguishingMatch,
			distinguishing_weight: Math.round(distinguishingWeight * 100) / 100,
			completion_pct: Math.round(completionRatio * 100),
			score: Math.round(userMatchWeight * 100) / 100,
			cuisine: JSON.parse((comp.cuisine_signature as string) || "[]"),
		});
	}

	// Sort by weighted match score (so rare-ingredient matches rank higher)
	matches.sort((a, b) => b.score - a.score || b.completion_pct - a.completion_pct);

	return json({
		input_ingredients: ingredientNames,
		matches_count: matches.length,
		detected_components: matches.slice(0, 10),
	});
}

async function handleBuilderDishes(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const ingredientNames = (body.ingredient_names || []) as string[];
	const compositionFilter = body.composition as string | undefined;

	if (!ingredientNames.length) {
		return json({ error: "Required: { ingredient_names: [...] }" }, 400);
	}

	const idf = await getIngredientIdf(env);
	const userIngSet = new Set(ingredientNames.map(n => n.toLowerCase().trim()));
	const getWeight = (ing: string) => idf.get(ing) ?? 3.0;

	let query = "SELECT id, canonical_title, composition, sweet_savory, meals, recipe_count, " +
		"consensus_total_time, consensus_servings, core_ingredients, expected_ingredients, " +
		"optional_ingredients, variations FROM canonical_dishes";
	const params: any[] = [];
	if (compositionFilter) {
		query += " WHERE composition = ?";
		params.push(compositionFilter);
	}

	const stmt = params.length > 0
		? env.DB.prepare(query).bind(...params)
		: env.DB.prepare(query);
	const dishesRes = await stmt.all();

	const matches: any[] = [];
	for (const dish of (dishesRes.results || [])) {
		const expected = JSON.parse((dish.expected_ingredients as string) || "[]") as Array<{name: string; frequency?: number; role?: string}>;
		const optional = JSON.parse((dish.optional_ingredients as string) || "[]") as Array<{name: string; frequency?: number}>;

		if (expected.length === 0) continue;

		let signatureWeight = 0;
		let matchWeight = 0;
		const have: string[] = [];
		const missing: Array<{name: string; frequency: number}> = [];

		for (const ing of expected) {
			const name = ing.name.toLowerCase();
			// Weight = IDF × dish-specific frequency
			const w = getWeight(name) * (ing.frequency ?? 0.5);
			signatureWeight += w;
			if (userIngSet.has(name)) {
				matchWeight += w;
				have.push(name);
			} else {
				missing.push({name, frequency: ing.frequency ?? 0});
			}
		}

		// Optional ingredients worth half
		for (const ing of optional) {
			const name = ing.name.toLowerCase();
			const w = getWeight(name) * (ing.frequency ?? 0.3) * 0.5;
			signatureWeight += w;
			if (userIngSet.has(name)) {
				matchWeight += w;
				have.push(name);
			}
		}

		if (signatureWeight === 0) continue;
		const completion = matchWeight / signatureWeight;
		if (completion < 0.3) continue;

		matches.push({
			dish_id: dish.id,
			title: dish.canonical_title,
			composition: dish.composition,
			sweet_savory: dish.sweet_savory,
			recipe_count: dish.recipe_count,
			total_time_min: dish.consensus_total_time,
			servings: dish.consensus_servings,
			ingredients_have: have,
			missing_top: missing.slice(0, 6).map(m => m.name),
			completion_pct: Math.round(completion * 100),
			score: Math.round(matchWeight * 100) / 100,
			variations: dish.variations ? JSON.parse(dish.variations as string) : null,
		});
	}

	matches.sort((a, b) => b.score - a.score || b.completion_pct - a.completion_pct);

	return json({
		input_ingredients: ingredientNames,
		composition_filter: compositionFilter || null,
		matches_count: matches.length,
		dishes: matches.slice(0, 15),
	});
}

// --- Geo-seasonal queries ---

async function handleSeasonalQuery(url: URL, env: Env): Promise<Response> {
	const lat = parseFloat(url.searchParams.get("lat") || "0");
	const lon = parseFloat(url.searchParams.get("lon") || "0");
	const radiusKm = parseFloat(url.searchParams.get("radius") || "100");
	const month = parseInt(url.searchParams.get("month") || String(new Date().getMonth() + 1));
	const limit = parseInt(url.searchParams.get("limit") || "50");

	if (!lat && !lon) {
		return json({ error: "Required: ?lat=&lon= (optional: &radius=100&month=4&limit=50)" }, 400);
	}

	// Rough bounding box filter (1 degree ≈ 111km)
	const latDelta = radiusKm / 111;
	const lonDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));

	const minLat = lat - latDelta;
	const maxLat = lat + latDelta;
	const minLon = lon - lonDelta;
	const maxLon = lon + lonDelta;

	// Find spots within bounding box for this month, then group by product
	const spots = await env.DB.prepare(`
		SELECT
			product_id,
			product_name,
			produce_profile_id,
			COUNT(*) as sighting_count,
			MIN(spotted_at) as first_seen,
			MAX(spotted_at) as last_seen,
			AVG(lat) as avg_lat,
			AVG(lon) as avg_lon,
			GROUP_CONCAT(DISTINCT location_name) as locations,
			GROUP_CONCAT(DISTINCT city) as cities
		FROM produce_spots
		WHERE lat BETWEEN ? AND ?
		AND lon BETWEEN ? AND ?
		AND month = ?
		GROUP BY product_id
		ORDER BY sighting_count DESC
		LIMIT ?
	`).bind(minLat, maxLat, minLon, maxLon, month, limit).all();

	// Enrich with produce profile data
	const results = [];
	for (const spot of (spots.results || [])) {
		const profileId = spot.produce_profile_id;
		let profile = null;
		if (profileId) {
			profile = await env.DB.prepare(
				"SELECT name, season_profile, peak_months, available_months, description_taste, category FROM produce_profiles WHERE id = ?"
			).bind(profileId).first();
		}

		// Haversine distance from query point to average spot location
		const dLat = ((spot.avg_lat as number) - lat) * Math.PI / 180;
		const dLon = ((spot.avg_lon as number) - lon) * Math.PI / 180;
		const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
			Math.cos(lat * Math.PI / 180) * Math.cos((spot.avg_lat as number) * Math.PI / 180) *
			Math.sin(dLon/2) * Math.sin(dLon/2);
		const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

		results.push({
			product_name: spot.product_name,
			sightings: spot.sighting_count,
			distance_km: Math.round(distKm),
			locations: (spot.locations as string || "").split(",").filter(Boolean).slice(0, 5),
			cities: (spot.cities as string || "").split(",").filter(Boolean).slice(0, 3),
			first_seen: spot.first_seen,
			last_seen: spot.last_seen,
			profile: profile ? {
				season_profile: profile.season_profile,
				peak_months: profile.peak_months,
				description: (profile.description_taste as string || "").slice(0, 200),
				category: profile.category,
			} : null,
		});
	}

	// If GPS sightings found, return them
	if (results.length > 0) {
		return json({
			query: { lat, lon, radius_km: radiusKm, month },
			month_name: ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month],
			source: "gps_sightings",
			results_count: results.length,
			results,
		});
	}

	// Fallback: use regional seasonal data based on nearest US state
	// Determine season from month
	const seasonMap: Record<number, string> = {
		1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
		6: "summer", 7: "summer", 8: "summer", 9: "fall", 10: "fall",
		11: "fall", 12: "winter",
	};
	const season = seasonMap[month] || "spring";

	// Try to get state from query param, or use a simple lat/lon → state hint
	const stateParam = url.searchParams.get("state") || "";

	let regionalResults;
	if (stateParam) {
		regionalResults = await env.DB.prepare(`
			SELECT DISTINCT ingredient, region_name, season, months
			FROM regional_seasons
			WHERE state LIKE ? AND season = ?
			ORDER BY ingredient
		`).bind(`%${stateParam.toUpperCase()}%`, season).all();
	} else {
		// Rough US region detection from lat/lon
		let guessedStates = "";
		// Hawaii
		if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) guessedStates = "HI";
		// Alaska
		else if (lat >= 54 && lon <= -130) guessedStates = "AK";
		// Continental US
		else if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) {
			if (lon < -105 && lat <= 37) guessedStates = "CA,NV,AZ,UT"; // Southwest
			else if (lon < -105 && lat > 37) guessedStates = "WA,OR,ID"; // Northwest
			else if (lon >= -105 && lon < -90 && lat <= 37) guessedStates = "TX,OK,NM,AR,LA"; // South Central
			else if (lon >= -105 && lon < -85 && lat > 37) guessedStates = "MT,WY,CO,ND,SD,NE,KS,MN,IA,MO"; // North Central
			else if (lon >= -90 && lat <= 37) guessedStates = "WV,VA,NC,SC,TN,GA,FL,AL,MS"; // Southeast
			else if (lon >= -85 && lat > 37 && lat <= 43) guessedStates = "WI,MI,IL,IN,OH,KY"; // Great Lakes
			else guessedStates = "ME,VT,NH,MA,CT,RI,NY,NJ,PA,MD,DE"; // Northeast
		}

		if (guessedStates) {
			const firstState = guessedStates.split(",")[0];
			regionalResults = await env.DB.prepare(`
				SELECT DISTINCT ingredient, region_name, season, months
				FROM regional_seasons
				WHERE state LIKE ? AND season = ?
				ORDER BY ingredient
			`).bind(`%${firstState}%`, season).all();
		}
	}

	if (regionalResults?.results?.length) {
		const regionName = (regionalResults.results[0] as any).region_name;
		return json({
			query: { lat, lon, radius_km: radiusKm, month },
			month_name: ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month],
			source: "regional_calendar",
			region: regionName,
			season,
			note: "No GPS sightings found nearby. Showing regional seasonal produce calendar.",
			results_count: regionalResults.results.length,
			results: regionalResults.results.map((r: any) => ({
				ingredient: r.ingredient,
				season: r.season,
			})),
		});
	}

	return json({
		query: { lat, lon, radius_km: radiusKm, month },
		month_name: ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month],
		source: "none",
		results_count: 0,
		results: [],
		note: "No sightings or regional data found for this location.",
	});
}

// --- Translation ---

async function handleTranslateBatch(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as any;
	const lang = body.lang as string;
	const langName = body.lang_name as string || lang;
	const items = body.items as Array<{ text: string; freq: number }>;

	if (!lang || !items?.length) {
		return json({ error: "Required: { lang, lang_name, items: [{text, freq}] }" }, 400);
	}

	const prompt = `You are a food ingredient translator. Translate each ${langName} ingredient to English. Return ONLY a JSON array. No markdown.

Rules:
- Translate the ingredient name to English
- Strip quantities/measurements: "2 cups flour" → just "flour"
- Strip prep instructions: "onion, finely diced" → just "onion"
- Keep qualifiers that identify the ingredient: "smoked paprika", "whole wheat flour", "dark chocolate"
- Singularize: "eggs" → "egg", "tomatoes" → "tomato"
- If it's not a food ingredient, return "SKIP"
- If you're unsure of the translation, give your best guess

Output format: [{"i":1,"en":"english ingredient name"}]

${items.map((item, i) => `${i + 1}. ${item.text}`).join("\n")}`;

	try {
		const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8" as any, {
			messages: [{ role: "user", content: prompt }],
			max_tokens: 1024,
		}) as any;

		const responseText = aiResponse.response || "";
		const jsonMatch = responseText.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			return json({ error: "AI did not return valid JSON", raw: responseText.slice(0, 500) }, 500);
		}

		const results = JSON.parse(jsonMatch[0]) as Array<{ i: number; en: string }>;
		let translated = 0;
		let skipped = 0;
		const stmts: D1PreparedStatement[] = [];

		for (const r of results) {
			const idx = (r.i || 0) - 1;
			if (idx < 0 || idx >= items.length) continue;

			const original = items[idx].text;
			const english = (r.en || "").toLowerCase().trim();

			if (!english || english === "skip") {
				skipped++;
				continue;
			}

			stmts.push(
				env.DB.prepare(
					"INSERT OR IGNORE INTO translation_map (original_text, lang, english_text, translated_by) VALUES (?, ?, ?, 'workers_ai')"
				).bind(original, lang, english)
			);
			translated++;
		}

		if (stmts.length > 0) {
			await env.DB.batch(stmts);
		}

		return json({ lang, processed: items.length, translated, skipped });

	} catch (e: any) {
		return json({ error: e.message }, 500);
	}
}

async function handleTranslateStatus(env: Env): Promise<Response> {
	const total = await env.DB.prepare(
		"SELECT COUNT(*) as cnt FROM translation_map"
	).first<{ cnt: number }>();

	const byLang = await env.DB.prepare(
		"SELECT lang, COUNT(*) as cnt FROM translation_map GROUP BY lang ORDER BY cnt DESC"
	).all();

	return json({
		total: total?.cnt || 0,
		by_language: byLang.results,
	});
}

// --- Utilities ---

function json(data: any, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36);
}

function parseIngredientLine(raw: string): {
	quantity: number | null;
	unit: string | null;
	name: string;
	prep: string[] | null;
	notes: string | null;
} {
	// Simplified parser — the full Python parser is more robust
	// This handles the basics for real-time ingest
	let s = raw.replace(/&frac12;|½/g, "1/2")
		.replace(/&frac14;|¼/g, "1/4")
		.replace(/&frac34;|¾/g, "3/4")
		.replace(/&frac13;|⅓/g, "1/3")
		.replace(/&frac23;|⅔/g, "2/3")
		.replace(/&#8217;/g, "'")
		.replace(/&#038;/g, "&")
		.trim();

	// Extract quantity
	let quantity: number | null = null;
	const qMatch = s.match(/^(\d+)\s+(\d+)\/(\d+)\s+/);
	const fMatch = s.match(/^(\d+)\/(\d+)\s+/);
	const dMatch = s.match(/^(\d+\.?\d*)\s+/);

	if (qMatch) {
		quantity = parseInt(qMatch[1]) + parseInt(qMatch[2]) / parseInt(qMatch[3]);
		s = s.slice(qMatch[0].length);
	} else if (fMatch) {
		quantity = parseInt(fMatch[1]) / parseInt(fMatch[2]);
		s = s.slice(fMatch[0].length);
	} else if (dMatch) {
		quantity = parseFloat(dMatch[1]);
		s = s.slice(dMatch[0].length);
	}

	// Extract unit
	let unit: string | null = null;
	const units: Record<string, string> = {
		cup: "cup", cups: "cup",
		tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp",
		teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp",
		ounce: "oz", ounces: "oz", oz: "oz",
		pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
		gram: "g", grams: "g", g: "g",
		clove: "clove", cloves: "clove",
		can: "can", cans: "can",
	};

	for (const [word, normalized] of Object.entries(units)) {
		const pattern = new RegExp(`^${word}s?\\.?\\s+`, "i");
		if (pattern.test(s)) {
			unit = normalized;
			s = s.replace(pattern, "").trim();
			break;
		}
	}

	// Extract notes (parenthetical)
	let notes: string | null = null;
	const noteMatch = s.match(/\(([^)]+)\)/);
	if (noteMatch) {
		notes = noteMatch[1];
		s = s.replace(/\([^)]*\)/g, "").trim();
	}

	// The rest is the name
	const name = s.replace(/,\s*$/, "").trim().toLowerCase();

	return { quantity, unit, name, prep: null, notes };
}
