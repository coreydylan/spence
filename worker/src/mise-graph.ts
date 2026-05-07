import type { MiseExpansionInput, MiseGraphEnv, MiseStateTemplate } from "./mise-graph/types";
import { handleResolve, resolveMiseGraph, type MiseResolveInput, type MiseResolveResult } from "./mise-graph/resolver";
import {
	planMiseWeek,
	renderMiseWeeklyPlan,
	saveMiseWeeklyPlan,
	type MisePlannerContext,
	type MiseResolvedGraphInput,
	type MiseWeeklyPlanDraft,
} from "./mise-graph/planner";
import { seedMiseGraph } from "./mise-graph/seed";
import {
	compileMisePlanLedger,
	loadMiseFormulas,
	readMiseLedger,
	readMiseTimeline,
	saveMiseLedgerCompile,
	validateCompiledLedger,
	type MiseFormulaIndex,
	type MiseLedgerCompileResult,
} from "./mise-graph/ledger";
import {
	repairMisePlan,
	saveMiseRepairResult,
	type MiseRepairResult,
} from "./mise-graph/repair";
import { seedMiseFormulas } from "./mise-graph/formulas-seed";
import { buildShoppingListV2 } from "./mise-graph/shopping-list";
import type { ComposerRawIngredient } from "./mise-graph/menu-composer";
import { runRevisionLoop } from "./mise-graph/revision-loop";
import { runHardCritics, runWarningCritics } from "./mise-graph/critics";
import { seedFormatLibrary } from "./mise-graph/format-library-seed";
import { seedCuisineFusions } from "./mise-graph/cuisine-fusions";
import { enrichCanonicalComponents } from "./mise-graph/enrich-components";
import { renderMiseLedgerMarkdown } from "./mise-graph/markdown";
import {
	loadMiseObservations,
	normalizeObservation,
	persistMiseObservations,
	type MiseObservation,
	type MiseObservationInput,
} from "./mise-graph/observations";
import { callMeshClaude, type MeshClaudeEnv } from "./mise-graph/llm-bridge";
import { importPersonalRecipe, listPersonalRecipes } from "./mise-graph/personal-recipes";
import { applyProposal, setEventLock, type ProposalIntent, type EventLockState } from "./mise-graph/ripple";
import { addPantryLot, removePantryLot, listPantryLots, loadPantryPressure } from "./mise-graph/pantry-pressure";
import { recordMealFeedback, loadRecentFeedback } from "./mise-graph/recipe-feedback";
import { loadRecentMenuContext } from "./mise-graph/window-memory";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const EXISTING_GRAPH_TABLES = [
	"canonical_ingredients",
	"ingredient_edges",
	"canonical_dishes",
	"canonical_components",
	"produce_profiles",
	"produce_spots",
	"regional_seasons",
	"ingredient_compounds",
	"tg_technique_ingredient",
	"tg_technique_equipment",
	"tg_technique_sequence",
];

const MISE_TABLES = [
	"mise_ingredient_states",
	"mise_edges",
	"mise_station_rules",
	"mise_week_plans",
	"mise_plan_components",
	"mise_plan_tasks",
	"household_profiles",
	"household_taste_priors",
	"household_inventory_snapshots",
	"mise_context_runs",
	"mise_edge_scores",
	"mise_resource_lots",
	"mise_plan_events",
	"mise_event_inputs",
	"mise_event_outputs",
	"mise_resource_reservations",
	"mise_validation_runs",
	"mise_validation_issues",
	"mise_repair_runs",
	"mise_unit_conversions",
	"mise_formulas",
	"mise_audit_sessions",
	"mise_resource_observations",
	"mise_plan_revisions",
];

const USEFUL_TECHNIQUES = [
	"bake",
	"blanch",
	"blend",
	"boil",
	"broil",
	"caramelize",
	"chop",
	"cold ferment",
	"deglaze",
	"dice",
	"drain",
	"ferment",
	"fold",
	"grate",
	"grill",
	"knead",
	"marinate",
	"pickle",
	"pressure cook",
	"puree",
	"roast",
	"saute",
	"simmer",
	"slice",
	"soak",
	"steam",
	"stir",
	"toast",
	"whisk",
	"zest",
];

export async function handleMiseGraphRequest(
	path: string,
	request: Request,
	env: MiseGraphEnv,
): Promise<Response | null> {
	if (path !== "/mise-graph" && !path.startsWith("/mise-graph/")) {
		return null;
	}

	const url = new URL(request.url);
	const parts = path.split("/").filter(Boolean);
	const resource = parts[1] || "";

	if ((path === "/mise-graph" || resource === "") && request.method === "GET") {
		return json({
			service: "mise-graph",
			description: "Stateful household prep graph layered on Spence culinary intelligence.",
			routes: [
				"GET  /mise-graph/status",
				"GET  /mise-graph/expand?ingredients=chickpea,tahini",
				"POST /mise-graph/expand",
				"POST /mise-graph/resolve",
				"POST /mise-graph/plan",
				"POST /mise-graph/compile",
				"POST /mise-graph/validate",
				"POST /mise-graph/repair",
				"GET  /mise-graph/plans?household_id=corey",
				"GET  /mise-graph/plans/:id",
				"GET  /mise-graph/plans/:id/timeline",
				"GET  /mise-graph/plans/:id/ledger",
				"GET  /mise-graph/states?q=chickpea",
				"POST /mise-graph/states",
				"GET  /mise-graph/edges?canonical_name=chickpea",
				"POST /mise-graph/edges",
				"GET  /mise-graph/station-rules",
				"POST /mise-graph/station-rules",
				"POST /mise-graph/seed",
				"POST /mise-graph/seed-formulas",
				"POST /mise-graph/seed-format-library",
				"POST /mise-graph/seed-cuisine-fusions",
				"POST /mise-graph/enrich-components",
				"GET  /mise-graph/formulas?q=hummus",
				"GET  /mise-graph/unit-conversions?canonical_name=chickpea",
				"POST /mise-graph/observations",
				"GET  /mise-graph/plans/:id/observations",
				"GET  /mise-graph/plans/:id/revisions",
				"GET  /mise-graph/revisions/:id",
				"POST /mise-graph/llm-test  (mesh-claude bridge smoke test)",
				"POST /mise-graph/personal-recipes/import  (paprika/url/manual/instagram/screenshot)",
				"GET  /mise-graph/personal-recipes?household_id=corey&loved_only=true",
				"POST /mise-graph/plans/:id/proposals  (add_meal | replace_meal | remove_meal | move_event | shorten_cook)",
				"POST /mise-graph/plans/:id/events/:event_id/lock  (mutable | in_flight | locked | released)",
				"GET  /mise-graph/pantry?household_id=corey",
				"POST /mise-graph/pantry  (add lot)",
				"DELETE /mise-graph/pantry/:id",
				"GET  /mise-graph/pantry/pressure?household_id=corey&plan_dates=2026-05-06,2026-05-19",
				"POST /mise-graph/feedback  (record meal rating)",
				"GET  /mise-graph/feedback?household_id=corey",
				"GET  /mise-graph/memory?household_id=corey&lookback_days=28",
			],
		});
	}

	if (resource === "status" && request.method === "GET") {
		return handleMiseStatus(env);
	}

	if (resource === "expand") {
		if (request.method === "GET") return handleMiseExpandGet(url, env);
		if (request.method === "POST") return handleMiseExpandPost(request, env);
	}

	if (resource === "resolve") {
		return handleResolve(request, env);
	}

	if (resource === "plan") {
		if (request.method === "POST") return handleMisePlanPost(request, env);
	}

	if (resource === "compile") {
		if (request.method === "POST") return handleCompilePost(request, env);
	}

	if (resource === "validate") {
		if (request.method === "POST") return handleValidatePost(request, env);
	}

	if (resource === "repair") {
		if (request.method === "POST") return handleRepairPost(request, env);
	}

	if (resource === "plans") {
		if (request.method === "GET" && parts[2] && parts[3] === "timeline") return handleGetMiseTimeline(parts[2], env);
		if (request.method === "GET" && parts[2] && parts[3] === "ledger") return handleGetMiseLedger(parts[2], env);
		if (request.method === "GET" && parts[2] && parts[3] === "markdown") return handleGetMiseMarkdown(parts[2], env);
		if (request.method === "GET" && parts[2] && parts[3] === "observations") return handleListPlanObservations(parts[2], env);
		if (request.method === "GET" && parts[2] && parts[3] === "revisions") return handleListPlanRevisions(parts[2], env);
		if (request.method === "POST" && parts[2] && parts[3] === "proposals") return handleCreateProposal(parts[2], request, env);
		if (request.method === "POST" && parts[2] && parts[3] === "events" && parts[4] && parts[5] === "lock") return handleSetEventLock(parts[2], parts[4], request, env);
		if (request.method === "GET" && parts[2]) {
			if ((url.searchParams.get("format") || "").toLowerCase() === "markdown") {
				return handleGetMiseMarkdown(parts[2], env);
			}
			return handleGetMisePlan(parts[2], env);
		}
		if (request.method === "GET") return handleListMisePlans(url, env);
	}

	if (resource === "observations") {
		if (request.method === "POST") return handlePostObservations(request, env);
	}

	if (resource === "llm-test") {
		if (request.method === "POST") return handleLlmTest(request, env);
		if (request.method === "GET") return handleLlmTest(new Request(request.url, { method: "POST", body: JSON.stringify({}) }), env);
	}

	if (resource === "personal-recipes") {
		if (request.method === "POST" && parts[2] === "import") return handlePersonalRecipeImport(request, env);
		if (request.method === "GET") return handlePersonalRecipeList(url, env);
	}

	if (resource === "pantry") {
		if (request.method === "GET" && parts[2] === "pressure") return handlePantryPressure(url, env);
		if (request.method === "DELETE" && parts[2]) return handlePantryRemove(parts[2], env);
		if (request.method === "POST") return handlePantryAdd(request, env);
		if (request.method === "GET") return handlePantryList(url, env);
	}

	if (resource === "feedback") {
		if (request.method === "POST") return handleMealFeedbackPost(request, env);
		if (request.method === "GET") return handleMealFeedbackList(url, env);
	}

	if (resource === "memory") {
		if (request.method === "GET") return handleMemoryGet(url, env);
	}

	if (resource === "revisions") {
		if (request.method === "GET" && parts[2]) return handleGetRevision(parts[2], env);
	}

	if (resource === "states") {
		if (request.method === "GET") return handleListMiseStates(url, env);
		if (request.method === "POST") return handleUpsertMiseStates(request, env);
	}

	if (resource === "edges") {
		if (request.method === "GET") return handleListMiseEdges(url, env);
		if (request.method === "POST") return handleUpsertMiseEdges(request, env);
	}

	if (resource === "station-rules") {
		if (request.method === "GET") return handleListStationRules(env);
		if (request.method === "POST") return handleUpsertStationRules(request, env);
	}

	if (resource === "seed") {
		if (request.method === "POST") return handleSeedMiseGraph(env);
	}

	if (resource === "seed-formulas") {
		if (request.method === "POST") return handleSeedFormulas(env);
	}

	if (resource === "seed-format-library") {
		if (request.method === "POST") return handleSeedFormatLibrary(env);
	}

	if (resource === "seed-cuisine-fusions") {
		if (request.method === "POST") return handleSeedCuisineFusions(env);
	}

	if (resource === "enrich-components") {
		if (request.method === "POST") return handleEnrichComponents(request, env);
	}

	if (resource === "formulas") {
		if (request.method === "GET") return handleListFormulas(url, env);
	}

	if (resource === "unit-conversions") {
		if (request.method === "GET") return handleListUnitConversions(url, env);
	}

	return json({ error: "Not found", service: "mise-graph" }, 404);
}

async function handleMiseStatus(env: MiseGraphEnv): Promise<Response> {
	const existing: Record<string, number | null> = {};
	const mise: Record<string, number | null> = {};

	await Promise.all(EXISTING_GRAPH_TABLES.map(async table => {
		existing[table] = await tableCount(env, table);
	}));
	await Promise.all(MISE_TABLES.map(async table => {
		mise[table] = await tableCount(env, table);
	}));

	return json({
		service: "mise-graph",
		existing_graph: existing,
		mise_graph: mise,
		ready: Object.values(mise).some(v => v !== null),
	});
}

async function handleMiseExpandGet(url: URL, env: MiseGraphEnv): Promise<Response> {
	const ingredientParam = url.searchParams.get("ingredients") || url.searchParams.get("ingredient") || "";
	const ingredients = ingredientParam
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	const limit = parsePositiveInt(url.searchParams.get("limit"), 20);
	const includeTemplates = url.searchParams.get("include_templates") !== "false";
	return expandMiseGraph({ ingredients, limit, include_templates: includeTemplates }, env);
}

async function handleMiseExpandPost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json() as Partial<MiseExpansionInput>;
	const ingredients = (body.ingredients || []).map(s => String(s).trim()).filter(Boolean);
	const limit = Math.min(Math.max(Number(body.limit || 20), 1), 50);
	const includeTemplates = body.include_templates !== false;
	return expandMiseGraph({ ingredients, limit, include_templates: includeTemplates }, env);
}

async function expandMiseGraph(input: MiseExpansionInput, env: MiseGraphEnv): Promise<Response> {
	if (!input.ingredients.length) {
		return json({ error: "Required: ingredient or ingredients" }, 400);
	}

	const canonical = await resolveCanonicalIngredients(input.ingredients, env);
	const canonicalIds = canonical.map(i => i.id);
	const canonicalNames = unique([
		...canonical.map(i => i.name),
		...input.ingredients,
	].map(normalizeName).filter(Boolean));

	const [
		affinities,
		dishes,
		components,
		produce,
		techniques,
		miseStates,
		miseEdges,
	] = await Promise.all([
		getIngredientAffinities(canonicalIds, input.limit, env),
		getDishCandidates(canonicalNames, input.limit, env),
		getComponentCandidates(canonicalNames, input.limit, env),
		getProduceMatches(canonicalIds, canonicalNames, input.limit, env),
		getTechniqueMatches(canonicalNames, input.limit, env),
		getMiseStates(canonicalIds, canonicalNames, input.limit, env),
		getMiseEdges(canonicalIds, canonicalNames, input.limit, env),
	]);

	const templates = input.include_templates
		? inferStateTemplates(canonicalNames)
		: [];

	return json({
		input,
		canonical_ingredients: canonical,
		mise_graph: {
			states: miseStates,
			edges: miseEdges,
			inferred_templates: templates,
		},
		spence_graph: {
			affinities,
			dish_candidates: dishes,
			component_candidates: components,
			produce_matches: produce,
			technique_matches: techniques,
		},
		graph: buildUiGraph(canonical, affinities, dishes, components, produce, techniques, miseStates, miseEdges, templates),
	});
}

async function handleMisePlanPost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	const nestedResolve = recordValue(body.resolve_input);
	const startDate = isoDateValue(body.start_date) || isoDateValue(body.date) || isoDateValue(nestedResolve.date);
	if (!startDate) return json({ error: "Required: start_date as YYYY-MM-DD." }, 400);

	let resolved: MiseResolveResult | null = null;
	let resolvedGraph = isRecord(body.resolved_graph) ? body.resolved_graph as MiseResolvedGraphInput : null;
	if (!resolvedGraph) {
		const resolveInput = buildResolveInput(body, startDate);
		resolved = await resolveMiseGraph(resolveInput, env);
		if (!resolved.context.ingredient_names.length) {
			return json({
				error: "Required: ingredients, inventory, or desired ingredients for planning.",
				resolve_summary: summarizeResolve(resolved),
			}, 400);
		}
		resolvedGraph = plannerGraphFromResolveResult(resolved);
	}

	let plan;
	try {
		const composeMode = parseComposeMode(body.compose);
		plan = await planMiseWeek(buildPlannerInput(body, startDate, resolvedGraph, resolved), env, composeMode);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Failed to build mise plan." }, 400);
	}

	// Auto-repair: run validation+repair after compose so shelf-life violations,
	// expired-resource uses, and resource_not_ready issues converge before we
	// persist. Caller can opt out via body.repair=false.
	let repairSummary: Record<string, unknown> | null = null;
	if (body.repair !== false) {
		try {
			const formulasIndex = await loadMiseFormulas(env);
			const repaired = repairMisePlan(plan, { formulas: formulasIndex, max_iterations: 4 });
			plan = repaired.repaired_plan;
			// Repair's `ensureShoppingItems` reinjects raw ingredient names with
			// the legacy categorizer (returning "other" liberally). Rebuild the
			// shopping list with buildShoppingListV2 so the canonicalizer +
			// alias table take precedence.
			try {
				const formulaCatalog = Array.from(formulasIndex.by_label.values());
				const householdPantry = new Set<string>(); // best-effort; planner-level pantry isn't preserved through repair
				const llmRaw: ComposerRawIngredient[] = [
					...plan.meals_by_day.flatMap(day => day.meals.flatMap(m => m.raw_ingredients || [])),
					...plan.breakfasts.flatMap(b => b.raw_ingredients || []),
					...plan.snack_boxes.flatMap(s => s.raw_ingredients || []),
				];
				const result = buildShoppingListV2({
					startDate: plan.start_date,
					endDate: plan.end_date,
					pantry: householdPantry,
					componentBatches: plan.component_batches,
					formulaCatalog,
					mealsByDay: plan.meals_by_day,
					breakfasts: plan.breakfasts,
					snackBoxes: plan.snack_boxes,
					llmRawIngredients: llmRaw,
				});
				plan.shopping_list = result.sections;
				plan.shop_runs = result.runs;
			} catch { /* keep repaired list as-is on error */ }
			repairSummary = {
				converged: repaired.converged,
				iterations: repaired.summary.iterations,
				actions: repaired.summary.actions,
				initial_hard_errors: repaired.summary.initial_hard_errors,
				final_hard_errors: repaired.summary.final_hard_errors,
				initial_warnings: repaired.summary.initial_warnings,
				final_warnings: repaired.summary.final_warnings,
				remaining_issues: repaired.remaining_issues.slice(0, 8).map(i => ({
					type: i.issue_type,
					severity: i.severity,
					title: i.title,
					detail: i.detail,
				})),
			};
		} catch (error) {
			repairSummary = { error: error instanceof Error ? error.message : "repair failed" };
		}
	}

	// LLM-Modulo revision loop: after compose + post-pass + repair, run the
	// auditor + cascade-proposal driven loop to drive remaining hard grievances
	// (dietary, leftover-graph, etc.) to zero. Caller can opt out via
	// body.revise=false.
	let revisionSummary: Record<string, unknown> | null = null;
	if (body.revise !== false) {
		try {
			const before = runHardCritics(plan);
			const beforeWarn = runWarningCritics(plan);
			const revised = await runRevisionLoop(plan, {
				max_rounds: typeof body.max_revision_rounds === "number" ? body.max_revision_rounds : 5,
				max_grievances_per_round: 3,
				use_llm_for_alternatives: false,
				polish_passes: 2,
			});
			plan = revised.final_plan;
			revisionSummary = {
				converged: revised.converged,
				rounds: revised.rounds.length,
				attempts: revised.summary.total_attempts,
				committed: revised.summary.total_committed,
				polish_moves_applied: revised.summary.polish_moves_applied,
				initial_hard: before.length,
				initial_warning: beforeWarn.length,
				final_hard: revised.summary.final_hard,
				final_warning: revised.summary.final_soft,
				duration_ms: revised.total_duration_ms,
				audit_log: revised.rounds.map(r => ({
					round: r.round_number,
					attempts: r.attempts.length,
					committed: r.attempts.filter(a => a.committed).length,
					net_score_delta: r.net_score_delta,
					commits: r.attempts.filter(a => a.committed).map(a => ({
						grievance: a.grievance_id.slice(0, 80),
						proposal_kind: a.winner?.proposal.kind,
						description: a.winner?.proposal.description,
					})),
					attempts_detail: r.attempts.map(a => ({
						grievance: a.grievance_id.slice(0, 100),
						committed: a.committed,
						reason_skipped: a.reason_skipped,
						proposals_considered: a.proposals_considered.map(p => p.kind),
						previews: a.previews.map(p => ({
							kind: p.proposal.kind,
							score: p.score,
							net_delta: p.preview.scores?.net_delta,
							waste_delta: p.preview.scores?.waste_delta,
							warnings: p.preview.warnings?.slice(0, 2),
							new_hard: p.preview.new_grievances?.filter(g => g.severity === "hard").length || 0,
							resolved: p.preview.resolved_grievances?.length || 0,
						})),
					})),
				})),
			};
		} catch (error) {
			revisionSummary = { error: error instanceof Error ? error.message : "revision loop failed" };
		}
	}

	const shouldPersist = body.persist !== false && body.save !== false;
	const saved = shouldPersist ? await saveMiseWeeklyPlan(env, plan) : null;
	const response: Record<string, unknown> = {
		plan,
		persisted: saved !== null,
		saved,
		repair_summary: repairSummary,
		revision_summary: revisionSummary,
	};

	if (body.include_markdown === true || body.format === "markdown") {
		response.markdown = renderMiseWeeklyPlan(plan);
	}
	if (body.include_resolved === true) {
		response.resolved = resolved;
	} else if (resolved) {
		response.resolve_summary = summarizeResolve(resolved);
	}

	return json(response);
}

async function handleCompilePost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	const plan = await planFromCompileRequest(body, env);
	if (!plan) return json({ error: "Required: plan_id or plan." }, 400);

	const formulas = await loadMiseFormulas(env);
	const compiled = compileMisePlanLedger(plan, formulas);
	const shouldPersist = body.persist !== false && body.save !== false;
	const saved = shouldPersist ? await saveMiseLedgerCompile(env, compiled) : null;

	return json({
		compiled,
		persisted: saved !== null,
		saved,
		formula_count: formulas.by_label.size,
	});
}

async function handleValidatePost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	let compiled: MiseLedgerCompileResult | null = null;
	if (isRecord(body.compiled)) {
		compiled = body.compiled as unknown as MiseLedgerCompileResult;
	} else {
		const plan = await planFromCompileRequest(body, env);
		if (!plan) return json({ error: "Required: plan_id, plan, or compiled." }, 400);
		const formulas = await loadMiseFormulas(env);
		compiled = compileMisePlanLedger(plan, formulas);
	}

	const validationIssues = validateCompiledLedger({
		plan_id: compiled.plan_id,
		compiled_at: compiled.compiled_at,
		resources: compiled.resources,
		events: compiled.events,
		inputs: compiled.inputs,
		outputs: compiled.outputs,
		reservations: compiled.reservations,
	});
	const result: MiseLedgerCompileResult = {
		...compiled,
		validation_issues: validationIssues,
		summary: {
			resource_count: compiled.resources.length,
			event_count: compiled.events.length,
			reservation_count: compiled.reservations.length,
			hard_errors: validationIssues.filter(issue => issue.severity === "hard_error").length,
			warnings: validationIssues.filter(issue => issue.severity === "warning").length,
			infos: validationIssues.filter(issue => issue.severity === "info").length,
		},
	};

	const shouldPersist = body.persist === true || body.save === true;
	const saved = shouldPersist ? await saveMiseLedgerCompile(env, result) : null;

	return json({
		validation: {
			summary: result.summary,
			issues: validationIssues,
		},
		persisted: saved !== null,
		saved,
	});
}

async function handleRepairPost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	const plan = await planFromCompileRequest(body, env);
	if (!plan) return json({ error: "Required: plan_id or plan." }, 400);

	const formulas = await loadMiseFormulas(env);
	const result = repairMisePlan(plan, {
		max_iterations: positiveIntValue(body.max_iterations, 4),
		formulas,
	});
	const shouldPersist = body.persist !== false && body.save !== false;
	const saved = shouldPersist ? await saveMiseRepairResult(env, result) : null;
	const response: Record<string, unknown> = {
		repair: repairResponse(result, body.include_compiled !== false),
		persisted: saved !== null,
		saved,
	};
	if (body.include_plan !== false) {
		response.plan = result.repaired_plan;
	}
	if (body.include_markdown === true || body.format === "markdown") {
		response.markdown = renderMiseWeeklyPlan(result.repaired_plan);
	}
	return json(response);
}

function repairResponse(result: MiseRepairResult, includeCompiled: boolean): Record<string, unknown> {
	const response: Record<string, unknown> = {
		plan_id: result.plan_id,
		changed: result.changed,
		converged: result.converged,
		summary: result.summary,
		iterations: result.iterations.map(iteration => ({
			iteration: iteration.iteration,
			before_summary: iteration.before_summary,
			after_summary: iteration.after_summary,
			actions: iteration.actions,
		})),
		remaining_issues: result.remaining_issues,
	};
	if (includeCompiled) {
		response.initial_compiled = result.initial_compiled;
		response.final_compiled = result.final_compiled;
	}
	return response;
}

async function handleListMisePlans(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = normalizeName(url.searchParams.get("household_id") || "");
	const status = normalizeName(url.searchParams.get("status") || "");
	const limit = parsePositiveInt(url.searchParams.get("limit"), 25);
	const clauses: string[] = [];
	const params: any[] = [];

	if (householdId) {
		clauses.push("household_id = ?");
		params.push(householdId);
	}
	if (status) {
		clauses.push("status = ?");
		params.push(status);
	}

	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = await optionalQuery(env, async () => {
		const results = await env.DB.prepare(`
			SELECT id, household_id, title, start_date, end_date, timezone, people,
				status, selected_ingredients_json, created_at, updated_at
			FROM mise_week_plans
			${where}
			ORDER BY start_date DESC, updated_at DESC, created_at DESC
			LIMIT ?
		`).bind(...params, limit).all<any>();
		return results.results || [];
	}, []);

	return json({
		plans: rows.map(row => ({
			...row,
			selected_ingredients: parseJson(row.selected_ingredients_json, []),
		})),
	});
}

async function handleGetMisePlan(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const id = decodeURIComponent(rawId);
	const row = await optionalQuery(env, async () => {
		return env.DB.prepare(`
			SELECT *
			FROM mise_week_plans
			WHERE id = ?
			LIMIT 1
		`).bind(id).first<any>();
	}, null);

	if (!row) return json({ error: "Plan not found", id }, 404);

	const [components, tasks] = await Promise.all([
		optionalQuery(env, async () => {
			const results = await env.DB.prepare(`
				SELECT *
				FROM mise_plan_components
				WHERE plan_id = ?
				ORDER BY label
			`).bind(id).all<any>();
			return results.results || [];
		}, []),
		optionalQuery(env, async () => {
			const results = await env.DB.prepare(`
				SELECT *
				FROM mise_plan_tasks
				WHERE plan_id = ?
				ORDER BY scheduled_date, session_order, title
			`).bind(id).all<any>();
			return results.results || [];
		}, []),
	]);

	return json({
		plan: parseJson(row.plan_json, null),
		stored: {
			...row,
			plan_json: undefined,
			constraints: parseJson(row.constraints_json, {}),
			selected_ingredients: parseJson(row.selected_ingredients_json, []),
			source_recipe_ids: parseJson(row.source_recipe_ids_json, []),
		},
		components: components.map(component => ({
			...component,
			planned_uses: parseJson(component.planned_uses_json, []),
			meta: parseJson(component.meta_json, {}),
		})),
		tasks: tasks.map(task => ({
			...task,
			station_tags: parseJson(task.station_tags_json, []),
			equipment: parseJson(task.equipment_json, []),
			depends_on: parseJson(task.depends_on_json, []),
			state_inputs: parseJson(task.state_inputs_json, []),
			state_outputs: parseJson(task.state_outputs_json, []),
			instructions: parseJson(task.instructions_json, []),
			meta: parseJson(task.meta_json, {}),
		})),
	});
}

async function handleGetMiseTimeline(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawId);
	return json(await readMiseTimeline(env, planId));
}

async function handleGetMiseLedger(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawId);
	return json(await readMiseLedger(env, planId));
}

async function handlePostObservations(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	const planId = stringValue(body.plan_id);
	if (!planId) return json({ error: "Required: plan_id." }, 400);
	const householdId = stringValue(body.household_id) || null;
	const sessionId = stringValue(body.audit_session_id) || null;
	const observationsRaw = Array.isArray(body.observations) ? body.observations : (isRecord(body.observation) ? [body.observation] : []);
	if (!observationsRaw.length) return json({ error: "Required: observations[] or observation." }, 400);

	const planRow = await optionalQuery(env, async () => {
		return env.DB.prepare("SELECT plan_json FROM mise_week_plans WHERE id = ? LIMIT 1").bind(planId).first<{ plan_json: string }>();
	}, null);
	if (!planRow) return json({ error: "Plan not found", plan_id: planId }, 404);
	const plan = parseJson(planRow.plan_json, null) as MiseWeeklyPlanDraft | null;
	if (!plan) return json({ error: "Plan JSON not parseable" }, 500);

	const formulas = await loadMiseFormulas(env);
	const previousObservations = await loadMiseObservations(env, planId);
	const newObservations: MiseObservation[] = observationsRaw
		.map(raw => normalizeObservation(raw as MiseObservationInput, planId, householdId || plan.household_id || null, sessionId));

	const maxIterations = positiveIntValue(body.max_iterations, 6);
	// "Before" = plan as it stood (repaired against prior observations only).
	const beforeRepair = repairMisePlan(plan, {
		max_iterations: maxIterations,
		formulas,
		observations: previousObservations,
	});
	// "After" = plan repaired against prior + new observations.
	const afterRepair = repairMisePlan(plan, {
		max_iterations: maxIterations,
		formulas,
		observations: [...previousObservations, ...newObservations],
	});
	// Persist the repaired plan FIRST (this can cascade-delete prior observations via ON DELETE CASCADE
	// on mise_week_plans REPLACE), then re-persist all observations so they survive.
	const savedRepair = body.persist === false ? null : await saveMiseRepairResult(env, afterRepair);
	if (body.persist !== false) {
		await persistMiseObservations(env, [...previousObservations, ...newObservations]);
	}

	const diff = computeRevisionDiff(beforeRepair.final_compiled, afterRepair.final_compiled);
	const revisionId = slugId("rev", planId, Date.now());
	const trigger = {
		observations: newObservations,
		summary: summarizeObservations(newObservations),
	};
	if (body.persist !== false) {
		await env.DB.prepare(`
			INSERT INTO mise_plan_revisions
			(id, plan_id, parent_revision_id, kind, summary, trigger_json,
			 before_summary_json, after_summary_json, diff_json, applied, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			revisionId,
			planId,
			null,
			"audit_response",
			summarizeObservations(newObservations),
			JSON.stringify(trigger),
			JSON.stringify(beforeRepair.final_compiled.summary),
			JSON.stringify(afterRepair.final_compiled.summary),
			JSON.stringify(diff),
			1,
			JSON.stringify({ repair_iterations: afterRepair.iterations.length, repair_actions: afterRepair.summary.actions, max_iterations: positiveIntValue(body.max_iterations, 6) }),
		).run();
		for (const obs of newObservations) {
			await env.DB.prepare("UPDATE mise_resource_observations SET applied_at = datetime('now') WHERE id = ?").bind(obs.id).run();
		}
	}

	return json({
		revision_id: revisionId,
		persisted: body.persist !== false,
		observations_recorded: newObservations.length,
		before_summary: beforeRepair.final_compiled.summary,
		after_summary: afterRepair.final_compiled.summary,
		repair_summary: afterRepair.summary,
		diff,
		remaining_issues: afterRepair.final_compiled.validation_issues,
		saved_repair: savedRepair,
	});
}

function summarizeObservations(observations: MiseObservation[]): string {
	if (!observations.length) return "no observations";
	const parts = observations.slice(0, 4).map(obs => {
		const target = obs.target_canonical_name || obs.target_resource_lot_id || "resource";
		switch (obs.observation_kind) {
			case "consumed": return `${target} consumed`;
			case "missing": return `${target} missing`;
			case "remaining": return `${target} ${obs.quantity ?? "?"}${obs.unit ? ` ${obs.unit}` : ""} left`;
			case "gained": return `${target} gained${obs.quantity ? ` ${obs.quantity}${obs.unit || ""}` : ""}`;
			case "condition": return `${target} condition update`;
			default: return `${target} ${obs.observation_kind}`;
		}
	});
	const suffix = observations.length > 4 ? ` (+${observations.length - 4} more)` : "";
	return parts.join("; ") + suffix;
}

interface RevisionDiff {
	released_reservations: Array<{ event_id: string; event_title: string | null; component_id: string; label: string; quantity: number | null; unit: string | null }>;
	added_events: Array<{ id: string; type: string; title: string; date: string | null }>;
	removed_events: Array<{ id: string; type: string; title: string; date: string | null }>;
	added_components: Array<{ id: string; label: string }>;
	removed_components: Array<{ id: string; label: string }>;
	consumed_lots: Array<{ id: string; label: string }>;
	new_lots: Array<{ id: string; label: string; quantity: number | null; unit: string | null }>;
	hard_error_delta: number;
	warning_delta: number;
}

function computeRevisionDiff(before: MiseLedgerCompileResult, after: MiseLedgerCompileResult): RevisionDiff {
	const beforeEvents = new Map(before.events.map(event => [event.id, event]));
	const afterEvents = new Map(after.events.map(event => [event.id, event]));
	const beforeReservations = new Map(before.reservations.map(reservation => [`${reservation.event_id}::${reservation.component_id}`, reservation]));
	const afterReservations = new Map(after.reservations.map(reservation => [`${reservation.event_id}::${reservation.component_id}`, reservation]));
	const beforeLots = new Map(before.resources.map(lot => [lot.id, lot]));
	const afterLots = new Map(after.resources.map(lot => [lot.id, lot]));

	const releasedReservations: RevisionDiff["released_reservations"] = [];
	for (const [key, reservation] of beforeReservations) {
		if (afterReservations.has(key)) continue;
		const event = beforeEvents.get(reservation.event_id);
		releasedReservations.push({
			event_id: reservation.event_id,
			event_title: event?.title || null,
			component_id: reservation.component_id,
			label: typeof reservation.resource_lot_id === "string" ? (beforeLots.get(reservation.resource_lot_id)?.label || reservation.component_id) : reservation.component_id,
			quantity: reservation.quantity,
			unit: reservation.unit,
		});
	}

	const addedEvents: RevisionDiff["added_events"] = [];
	for (const [id, event] of afterEvents) {
		if (beforeEvents.has(id)) continue;
		addedEvents.push({ id, type: event.event_type, title: event.title, date: event.event_date });
	}
	const removedEvents: RevisionDiff["removed_events"] = [];
	for (const [id, event] of beforeEvents) {
		if (afterEvents.has(id)) continue;
		removedEvents.push({ id, type: event.event_type, title: event.title, date: event.event_date });
	}

	const beforeComponentIds = new Set<string>();
	const beforeComponentLabels = new Map<string, string>();
	for (const lot of before.resources) {
		if (lot.resource_kind !== "component") continue;
		if (lot.source_component_id) {
			beforeComponentIds.add(lot.source_component_id);
			beforeComponentLabels.set(lot.source_component_id, lot.label);
		}
	}
	const afterComponentIds = new Set<string>();
	const afterComponentLabels = new Map<string, string>();
	for (const lot of after.resources) {
		if (lot.resource_kind !== "component") continue;
		if (lot.source_component_id) {
			afterComponentIds.add(lot.source_component_id);
			afterComponentLabels.set(lot.source_component_id, lot.label);
		}
	}
	const addedComponents: RevisionDiff["added_components"] = [];
	for (const id of afterComponentIds) {
		if (beforeComponentIds.has(id)) continue;
		addedComponents.push({ id, label: afterComponentLabels.get(id) || id });
	}
	const removedComponents: RevisionDiff["removed_components"] = [];
	for (const id of beforeComponentIds) {
		if (afterComponentIds.has(id)) continue;
		removedComponents.push({ id, label: beforeComponentLabels.get(id) || id });
	}

	const consumedLots: RevisionDiff["consumed_lots"] = [];
	const newLots: RevisionDiff["new_lots"] = [];
	for (const [id, afterLot] of afterLots) {
		const beforeLot = beforeLots.get(id);
		if (!beforeLot) {
			newLots.push({ id, label: afterLot.label, quantity: afterLot.quantity, unit: afterLot.unit });
			continue;
		}
		if (beforeLot.status !== "consumed" && afterLot.status === "consumed") {
			consumedLots.push({ id, label: afterLot.label });
		}
	}

	return {
		released_reservations: releasedReservations,
		added_events: addedEvents,
		removed_events: removedEvents,
		added_components: addedComponents,
		removed_components: removedComponents,
		consumed_lots: consumedLots,
		new_lots: newLots,
		hard_error_delta: after.summary.hard_errors - before.summary.hard_errors,
		warning_delta: after.summary.warnings - before.summary.warnings,
	};
}

async function handleListPlanObservations(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawId);
	const observations = await loadMiseObservations(env, planId);
	return json({ plan_id: planId, observations, count: observations.length });
}

async function handleListPlanRevisions(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawId);
	const result = await env.DB.prepare(`
		SELECT id, plan_id, parent_revision_id, kind, summary, applied, created_at
		FROM mise_plan_revisions
		WHERE plan_id = ?
		ORDER BY created_at DESC
		LIMIT 50
	`).bind(planId).all<Record<string, unknown>>();
	return json({ plan_id: planId, revisions: result.results || [] });
}

async function handleGetRevision(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const id = decodeURIComponent(rawId);
	const row = await optionalQuery(env, async () => {
		return env.DB.prepare("SELECT * FROM mise_plan_revisions WHERE id = ? LIMIT 1").bind(id).first<Record<string, unknown>>();
	}, null);
	if (!row) return json({ error: "Revision not found", id }, 404);
	return json({
		...row,
		trigger: parseJson(row.trigger_json, {}),
		before_summary: parseJson(row.before_summary_json, {}),
		after_summary: parseJson(row.after_summary_json, {}),
		diff: parseJson(row.diff_json, {}),
		meta: parseJson(row.meta_json, {}),
	});
}

async function handleGetMiseMarkdown(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawId);
	const planRow = await optionalQuery(env, async () => {
		return env.DB.prepare("SELECT plan_json FROM mise_week_plans WHERE id = ? LIMIT 1").bind(planId).first<{ plan_json: string }>();
	}, null);
	if (!planRow) return new Response(`Plan not found: ${planId}`, { status: 404, headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
	const plan = parseJson(planRow.plan_json, null) as MiseWeeklyPlanDraft | null;
	if (!plan) return new Response("Plan JSON not parseable", { status: 500, headers: { "Content-Type": "text/plain", ...CORS_HEADERS } });
	const ledger = await readMiseLedger(env, planId);
	const markdown = renderMiseLedgerMarkdown(plan, {
		resources: (ledger.resources as any[]).map(normalizeRowMeta),
		events: (ledger.events as any[]).map(normalizeRowMeta),
		inputs: (ledger.inputs as any[]).map(normalizeRowMeta),
		outputs: (ledger.outputs as any[]).map(normalizeRowMeta),
		reservations: (ledger.reservations as any[]).map(normalizeRowMeta),
		validation_issues: ledger.validation_issues as any[],
	});
	return new Response(markdown, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			...CORS_HEADERS,
		},
	});
}

function normalizeRowMeta<T extends { meta_json?: unknown; meta?: unknown }>(row: T): T {
	const out: any = { ...row };
	if (typeof out.meta === "string") {
		out.meta = parseJson(out.meta, {});
	} else if (out.meta == null && typeof out.meta_json === "string") {
		out.meta = parseJson(out.meta_json, {});
	}
	return out;
}

async function planFromCompileRequest(body: Record<string, unknown>, env: MiseGraphEnv): Promise<MiseWeeklyPlanDraft | null> {
	if (isRecord(body.plan)) return body.plan as unknown as MiseWeeklyPlanDraft;
	const planId = stringValue(body.plan_id) || stringValue(body.id);
	if (!planId) return null;
	const row = await optionalQuery(env, async () => {
		return env.DB.prepare(`
			SELECT plan_json
			FROM mise_week_plans
			WHERE id = ?
			LIMIT 1
		`).bind(planId).first<{ plan_json: string }>();
	}, null);
	return row ? parseJson(row.plan_json, null) as MiseWeeklyPlanDraft | null : null;
}

async function handleSeedMiseGraph(env: MiseGraphEnv): Promise<Response> {
	const seeded = await seedMiseGraph(env.DB);
	return json({
		service: "mise-graph",
		seeded,
		note: "Seed is idempotent and uses INSERT OR IGNORE for starter states, edges, and station rules.",
	});
}

async function handlePantryList(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = url.searchParams.get("household_id") || "";
	if (!householdId) return json({ error: "household_id required" }, 400);
	const lots = await listPantryLots(env, householdId);
	return json({ household_id: householdId, count: lots.length, lots });
}

async function handlePantryAdd(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);
	const householdId = stringValue(body.household_id);
	const canonicalName = stringValue(body.canonical_name);
	if (!householdId || !canonicalName) return json({ error: "household_id + canonical_name required" }, 400);
	const lot = await addPantryLot(env, {
		household_id: householdId,
		canonical_name: canonicalName,
		storage_location: stringValue(body.storage_location) || null,
		quantity: typeof body.quantity === "number" ? body.quantity : null,
		unit: stringValue(body.unit) || null,
		grams: typeof body.grams === "number" ? body.grams : null,
		opened_at: stringValue(body.opened_at) || null,
		best_until: stringValue(body.best_until) || null,
		safe_until: stringValue(body.safe_until) || null,
		notes: stringValue(body.notes) || null,
	});
	return json({ lot });
}

async function handlePantryRemove(rawId: string, env: MiseGraphEnv): Promise<Response> {
	const id = decodeURIComponent(rawId);
	await removePantryLot(env, id);
	return json({ removed: id });
}

async function handlePantryPressure(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = url.searchParams.get("household_id") || "";
	if (!householdId) return json({ error: "household_id required" }, 400);
	const dates = (url.searchParams.get("plan_dates") || "").split(",").map(d => d.trim()).filter(Boolean);
	const pressure = await loadPantryPressure(env, householdId, dates);
	return json({ household_id: householdId, pressure });
}

async function handleMealFeedbackPost(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);
	const householdId = stringValue(body.household_id);
	const planId = stringValue(body.plan_id);
	const mealId = stringValue(body.meal_id);
	const rating = typeof body.rating === "number" ? body.rating : 0;
	if (!householdId || !planId || !mealId) return json({ error: "household_id + plan_id + meal_id required" }, 400);
	if (rating < 1 || rating > 5) return json({ error: "rating must be 1-5" }, 400);
	const record = await recordMealFeedback(env, {
		household_id: householdId,
		plan_id: planId,
		meal_id: mealId,
		rating: rating as 1 | 2 | 3 | 4 | 5,
		would_repeat: body.would_repeat === true,
		finished: body.finished !== false,
		notes: stringValue(body.notes) || undefined,
		meal_date: stringValue(body.meal_date) || undefined,
		meal_slot: stringValue(body.meal_slot) || undefined,
		meal_title: stringValue(body.meal_title) || undefined,
		meal_cuisine: Array.isArray(body.meal_cuisine) ? body.meal_cuisine.filter((c): c is string => typeof c === "string") : undefined,
		meal_format: stringValue(body.meal_format) || undefined,
		meal_anchors: Array.isArray(body.meal_anchors) ? body.meal_anchors.filter((c): c is string => typeof c === "string") : undefined,
	});
	return json({ record });
}

async function handleMealFeedbackList(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = url.searchParams.get("household_id") || "";
	if (!householdId) return json({ error: "household_id required" }, 400);
	const lookback = parseInt(url.searchParams.get("lookback_days") || "60", 10) || 60;
	const records = await loadRecentFeedback(env, householdId, lookback);
	return json({ household_id: householdId, count: records.length, records });
}

async function handleMemoryGet(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = url.searchParams.get("household_id") || "";
	if (!householdId) return json({ error: "household_id required" }, 400);
	const lookback = parseInt(url.searchParams.get("lookback_days") || "28", 10) || 28;
	const memory = await loadRecentMenuContext(env, { household_id: householdId, lookback_days: lookback });
	return json({ household_id: householdId, memory });
}

async function handlePersonalRecipeImport(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);
	const householdId = stringValue(body.household_id);
	if (!householdId) return json({ error: "household_id required" }, 400);
	const kind = stringValue(body.kind).toLowerCase();
	const validKinds = ["paprika", "url", "instagram", "manual", "screenshot"];
	if (!validKinds.includes(kind)) return json({ error: `kind must be one of ${validKinds.join(", ")}` }, 400);
	const result = await importPersonalRecipe(env, {
		household_id: householdId,
		kind: kind as "paprika" | "url" | "instagram" | "manual" | "screenshot",
		loved: body.loved === true,
		rating: typeof body.rating === "number" ? body.rating : undefined,
		url: stringValue(body.url) || undefined,
		paprika_payload: stringValue(body.paprika_payload) || undefined,
		manual: isRecord(body.manual) ? body.manual as any : undefined,
		text: stringValue(body.text) || undefined,
		screenshot_text: stringValue(body.screenshot_text) || undefined,
	});
	return json(result, result.ok ? 200 : 400);
}

async function handlePersonalRecipeList(url: URL, env: MiseGraphEnv): Promise<Response> {
	const householdId = url.searchParams.get("household_id") || "";
	if (!householdId) return json({ error: "household_id query param required" }, 400);
	const lovedOnly = (url.searchParams.get("loved_only") || "").toLowerCase() === "true";
	const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
	const recipes = await listPersonalRecipes(env, householdId, { loved_only: lovedOnly, limit });
	return json({ household_id: householdId, count: recipes.length, recipes });
}

async function handleCreateProposal(rawPlanId: string, request: Request, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawPlanId);
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body." }, 400);

	const planRow = await optionalQuery(env, async () => {
		return env.DB.prepare("SELECT plan_json FROM mise_week_plans WHERE id = ? LIMIT 1").bind(planId).first<{ plan_json: string }>();
	}, null);
	if (!planRow) return json({ error: "Plan not found", plan_id: planId }, 404);
	const plan = parseJson(planRow.plan_json, null) as MiseWeeklyPlanDraft | null;
	if (!plan) return json({ error: "Plan JSON not parseable" }, 500);

	const validKinds = ["add_meal", "replace_meal", "remove_meal", "shorten_cook", "move_event", "audit_response", "compose_window", "user_edit", "rollforward"];
	const kind = stringValue(body.kind);
	if (!validKinds.includes(kind)) return json({ error: `kind must be one of ${validKinds.join(", ")}` }, 400);

	const intent: ProposalIntent = {
		kind: kind as ProposalIntent["kind"],
		intent_text: stringValue(body.intent_text) || undefined,
		target_event_id: stringValue(body.target_event_id) || null,
		target_date: isoDateValue(body.target_date) || null,
		target_slot: ["breakfast", "lunch", "dinner", "snack"].includes(stringValue(body.target_slot)) ? (stringValue(body.target_slot) as ProposalIntent["target_slot"]) : null,
		new_meal_request: isRecord(body.new_meal_request) ? body.new_meal_request as any : undefined,
		move_to_date: isoDateValue(body.move_to_date) || null,
		move_to_time: stringValue(body.move_to_time) || null,
		cook_max_minutes: typeof body.cook_max_minutes === "number" ? body.cook_max_minutes : null,
		apply: body.apply !== false,
	};
	const result = await applyProposal(env, plan, intent);
	return json(result);
}

async function handleSetEventLock(rawPlanId: string, rawEventId: string, request: Request, env: MiseGraphEnv): Promise<Response> {
	const planId = decodeURIComponent(rawPlanId);
	const eventId = decodeURIComponent(rawEventId);
	const body = await request.json().catch(() => null) as unknown;
	if (!isRecord(body)) return json({ error: "Expected JSON body" }, 400);
	const lockState = stringValue(body.lock_state).toLowerCase();
	const valid: EventLockState[] = ["mutable", "in_flight", "locked", "released"];
	if (!(valid as string[]).includes(lockState)) {
		return json({ error: `lock_state must be one of ${valid.join(", ")}` }, 400);
	}
	await setEventLock(env, planId, eventId, lockState as EventLockState, stringValue(body.locked_by) || undefined);
	return json({ plan_id: planId, event_id: eventId, lock_state: lockState });
}

async function handleLlmTest(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json().catch(() => ({})) as Record<string, unknown>;
	const prompt = stringValue(body.prompt) || "Reply with the single word PONG. Nothing else.";
	const system = stringValue(body.system) || "You are a connectivity probe. Reply concisely.";
	const model = stringValue(body.model) || "claude-haiku-4-5-20251001";
	const startedAt = Date.now();
	const result = await callMeshClaude(env as unknown as MeshClaudeEnv, {
		prompt,
		system,
		model,
	});
	return json({
		bridge_url: env.BRIDGE_HOST && env.BRIDGE_PORT ? `http://${env.BRIDGE_HOST}:${env.BRIDGE_PORT}/v1/messages` : "(unset)",
		mesh_binding_present: !!env.MESH,
		secret_present: !!env.BRIDGE_SECRET,
		result,
		round_trip_ms: Date.now() - startedAt,
	});
}

async function handleSeedFormulas(env: MiseGraphEnv): Promise<Response> {
	const seeded = await seedMiseFormulas(env.DB);
	return json({
		service: "mise-graph",
		seeded,
		note: "Idempotent INSERT OR REPLACE for USDA SR28 unit conversions and prototype formulas.",
	});
}

async function handleSeedFormatLibrary(env: MiseGraphEnv): Promise<Response> {
	const seeded = await seedFormatLibrary(env.DB);
	return json({
		service: "mise-graph",
		seeded,
		note: "Format library: 18 formats × cuisine variants (burger, pizza, dumpling, mezze, etc.).",
	});
}

async function handleSeedCuisineFusions(env: MiseGraphEnv): Promise<Response> {
	const seeded = await seedCuisineFusions(env.DB);
	return json({
		service: "mise-graph",
		seeded,
		note: "Chef-validated cross-cuisine fusion patterns + flavor vibes (gochujang-aioli, miso-butter, etc.).",
	});
}

async function handleEnrichComponents(request: Request, env: MiseGraphEnv): Promise<Response> {
	let body: Record<string, unknown> = {};
	try {
		body = await request.json() as Record<string, unknown>;
	} catch {
		body = {};
	}
	const batchSize = typeof body.batch_size === "number" ? body.batch_size : 8;
	const dryRun = body.dry_run === true;
	const onlyMissing = body.only_missing !== false; // default true
	const result = await enrichCanonicalComponents(env, {
		batch_size: batchSize,
		dry_run: dryRun,
		only_missing: onlyMissing,
	});
	return json({
		service: "mise-graph",
		result,
		note: "LLM-enriched canonical_components: cuisine_signature + variant_names backfilled.",
	});
}

async function handleListFormulas(url: URL, env: MiseGraphEnv): Promise<Response> {
	const q = (url.searchParams.get("q") || "").trim().toLowerCase();
	const stateId = url.searchParams.get("state_id");
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (q) {
		clauses.push("(LOWER(output_label) LIKE ? OR LOWER(output_canonical_name) LIKE ?)");
		params.push(`%${q}%`, `%${q}%`);
	}
	if (stateId) {
		clauses.push("output_state_id = ?");
		params.push(stateId);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const result = await env.DB.prepare(`
		SELECT id, output_state_id, output_label, output_canonical_name,
			batch_qty, batch_unit, batch_grams, serves, yield_ratio, inputs_json,
			shelf_life_hours_fridge, shelf_life_hours_pantry, shelf_life_hours_freezer,
			make_ahead_days_min, make_ahead_days_max, make_ahead_best_min, make_ahead_best_max,
			active_time_min, idle_time_min, equipment_json, source
		FROM mise_formulas
		${where}
		ORDER BY output_label
	`).bind(...params).all<Record<string, unknown>>();
	const rows = (result.results || []).map(row => ({
		...row,
		inputs: parseJsonOrNull(row.inputs_json) || [],
		equipment: parseJsonOrNull(row.equipment_json) || [],
	}));
	return json({ formulas: rows, count: rows.length });
}

async function handleListUnitConversions(url: URL, env: MiseGraphEnv): Promise<Response> {
	const canonical = url.searchParams.get("canonical_name");
	const result = canonical
		? await env.DB.prepare("SELECT canonical_name, unit, grams, source, ndb_no FROM mise_unit_conversions WHERE canonical_name = ? ORDER BY unit").bind(canonical).all<Record<string, unknown>>()
		: await env.DB.prepare("SELECT canonical_name, unit, grams, source, ndb_no FROM mise_unit_conversions ORDER BY canonical_name, unit").all<Record<string, unknown>>();
	return json({ conversions: result.results || [], count: (result.results || []).length });
}

function parseJsonOrNull(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function buildResolveInput(body: Record<string, unknown>, startDate: string): MiseResolveInput {
	const nested = recordValue(body.resolve_input);
	return {
		...body,
		...nested,
		household_id: stringValue(nested.household_id) || stringValue(body.household_id) || null,
		date: isoDateValue(nested.date) || isoDateValue(body.date) || startDate,
		location: firstRecord(nested.location, body.location),
		constraints: {
			...recordValue(nested.constraints),
			...recordValue(body.constraints),
		},
		inventory: arrayInput(nested.inventory ?? body.inventory) as MiseResolveInput["inventory"],
		desired: (nested.desired ?? body.desired) as MiseResolveInput["desired"],
		equipment: normalizeStringList(nested.equipment ?? body.equipment),
		schedule: firstRecord(nested.schedule, body.schedule) as MiseResolveInput["schedule"],
		ingredients: arrayInput(nested.ingredients ?? body.ingredients) as MiseResolveInput["ingredients"],
		limit: positiveIntValue(nested.limit ?? body.limit, 30),
		include_templates: nested.include_templates !== false && body.include_templates !== false,
	};
}

function buildPlannerInput(
	body: Record<string, unknown>,
	startDate: string,
	resolvedGraph: MiseResolvedGraphInput,
	resolved: MiseResolveResult | null,
): MisePlannerContext {
	const nested = recordValue(body.resolve_input);
	const constraints = {
		...recordValue(nested.constraints),
		...recordValue(body.constraints),
	};
	const selectedIngredients = firstNonEmpty([
		normalizeStringList(body.selected_ingredients),
		itemNamesFromInput(body.ingredients),
		resolved?.context.ingredient_names || [],
	]);
	const pantry = unique([
		...normalizeStringList(body.pantry),
		...itemNamesFromInput(nested.inventory ?? body.inventory),
	]);
	const equipment = firstNonEmpty([
		normalizeStringList(body.equipment),
		normalizeStringList(nested.equipment),
		resolved?.context.equipment || [],
	]);
	const preferences = recordValue(body.preferences);

	const endDate = isoDateValue(body.end_date) || isoDateValue(nested.end_date) || null;
	const lengthDays = positiveIntValue(body.length_days, 0) || positiveIntValue(nested.length_days, 0) || null;
	const cuisineDirection = normalizeCuisineList(body.cuisine_direction)
		.concat(normalizeCuisineList(nested.cuisine_direction));
	const promptText = stringValue(body.prompt) || stringValue(nested.prompt) || null;
	const useUp = normalizeUseUpList(body.use_up ?? nested.use_up);
	const defaultMeals = recordValue(body.default_meals ?? nested.default_meals);
	const mealSlots = normalizeMealSlotList(body.meal_slots ?? nested.meal_slots);
	const mealOverrides = normalizeMealSlotList(body.meal_overrides ?? nested.meal_overrides);

	return {
		household_id: stringValue(body.household_id) || stringValue(nested.household_id) || resolved?.context.household_id || null,
		start_date: startDate,
		end_date: endDate,
		length_days: lengthDays,
		timezone: stringValue(body.timezone) || stringValue(recordValue(body.location).timezone) || stringValue(recordValue(nested.location).timezone) || null,
		people: positiveIntValue(body.people, 2),
		title: stringValue(body.title) || null,
		prompt: promptText,
		cuisine_direction: unique(cuisineDirection),
		constraints,
		selected_ingredients: selectedIngredients,
		source_recipe_ids: normalizeStringList(body.source_recipe_ids),
		pantry,
		equipment,
		preferences: {
			breakfasts: preferences.breakfasts === false ? false : true,
			lunches: preferences.lunches === false ? false : true,
			dinners: preferences.dinners === false ? false : true,
			snack_boxes: preferences.snack_boxes === false ? false : true,
			max_component_batches: positiveIntValue(preferences.max_component_batches, 8),
			max_active_prep_min_per_session: positiveIntValue(preferences.max_active_prep_min_per_session, 75),
		},
		default_meals: {
			breakfast: defaultMeals.breakfast === false ? false : (defaultMeals.breakfast === true ? true : undefined),
			lunch: defaultMeals.lunch === false ? false : (defaultMeals.lunch === true ? true : undefined),
			dinner: defaultMeals.dinner === false ? false : (defaultMeals.dinner === true ? true : undefined),
			snack: defaultMeals.snack === false ? false : (defaultMeals.snack === true ? true : undefined),
		},
		meal_slots: mealSlots,
		meal_overrides: mealOverrides,
		use_up: useUp,
		schedule: normalizePlannerSchedule(body.schedule ?? nested.schedule, startDate),
		resolved_graph: resolvedGraph,
	};
}

function parseComposeMode(value: unknown): "auto" | "llm" | "deterministic" {
	const v = typeof value === "string" ? value.toLowerCase().trim() : "";
	if (v === "llm" || v === "deterministic") return v;
	return "auto";
}

function normalizeCuisineList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string").map(s => s.trim()).filter(Boolean);
	}
	if (typeof value === "string") return value.split(",").map(s => s.trim()).filter(Boolean);
	return [];
}

function normalizeMealSlotList(value: unknown): import("./mise-graph/planner").MiseMealSlotSpec[] {
	if (!Array.isArray(value)) return [];
	const result: import("./mise-graph/planner").MiseMealSlotSpec[] = [];
	for (const raw of value) {
		const record = recordValue(raw);
		const date = isoDateValue(record.date);
		const slotRaw = stringValue(record.slot).toLowerCase();
		if (!date || !["breakfast", "lunch", "dinner", "snack"].includes(slotRaw)) continue;
		result.push({
			date,
			slot: slotRaw as import("./mise-graph/planner").MiseMealSlot,
			people: positiveIntValue(record.people, 0) || null,
			cuisine: normalizeCuisineList(record.cuisine),
			format: stringValue(record.format) || null,
			title: stringValue(record.title) || null,
			locked: record.locked === true,
			notes: typeof record.notes === "string" ? record.notes : (Array.isArray(record.notes) ? record.notes.filter((n: unknown): n is string => typeof n === "string") : null),
			source: stringValue(record.source) || "user_input",
		});
	}
	return result;
}

function normalizeUseUpList(value: unknown): Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }> {
	if (!Array.isArray(value)) return [];
	const out: Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }> = [];
	for (const raw of value) {
		if (typeof raw === "string") {
			const resource = raw.trim();
			if (resource) out.push({ resource });
			continue;
		}
		const record = recordValue(raw);
		const resource = stringValue(record.resource) || stringValue(record.name);
		if (!resource) continue;
		const pressureValue = stringValue(record.pressure).toLowerCase();
		const pressure: "soft" | "opportunistic" | "avoid" | undefined = pressureValue === "soft" || pressureValue === "opportunistic" || pressureValue === "avoid" ? pressureValue : undefined;
		out.push({ resource, pressure });
	}
	return out;
}

function plannerGraphFromResolveResult(result: MiseResolveResult): MiseResolvedGraphInput {
	return {
		edges: asRecords(result.activated_edges),
		dishes: asRecords(result.candidate_dishes),
		components: asRecords(result.candidate_components),
		produce: asRecords(result.seasonal_candidates),
		techniques: asRecords(result.technique_hints),
		affinities: asRecords(result.affinity_candidates),
		graph: {
			nodes: asRecords(result.candidate_graph.nodes),
			edges: asRecords(result.candidate_graph.edges),
		},
	};
}

function asRecords<T>(items: T[]): Record<string, unknown>[] {
	return items as unknown as Record<string, unknown>[];
}

function summarizeResolve(result: MiseResolveResult): Record<string, unknown> {
	return {
		context: result.context,
		counts: {
			activated_edges: result.activated_edges.length,
			rejected_edges: result.rejected_edges.length,
			candidate_components: result.candidate_components.length,
			candidate_dishes: result.candidate_dishes.length,
			seasonal_candidates: result.seasonal_candidates.length,
			affinity_candidates: result.affinity_candidates.length,
			technique_hints: result.technique_hints.length,
		},
		top_edges: result.activated_edges.slice(0, 8).map(edge => ({
			id: edge.id,
			action_label: edge.action_label,
			score: edge.score,
			rationale: edge.rationale,
		})),
	};
}

function normalizePlannerSchedule(input: unknown, startDate: string): MisePlannerContext["schedule"] {
	const sessions: NonNullable<MisePlannerContext["schedule"]> = [];
	if (Array.isArray(input)) {
		for (const item of input) {
			const record = recordValue(item);
			const date = isoDateValue(record.date);
			if (!date) continue;
			sessions.push({
				date,
				available_min: positiveIntValue(record.available_min ?? record.available_minutes, 75),
				meal_slots: ["dinner"],
				notes: stringValue(record.notes) || null,
			});
		}
	}

	const record = recordValue(input);
	for (const item of arrayInput(record.sessions)) {
		const session = recordValue(item);
		const date = isoDateValue(session.date);
		if (!date) continue;
		sessions.push({
			date,
			available_min: positiveIntValue(session.available_min ?? session.available_minutes, 75),
			meal_slots: ["dinner"],
			notes: stringValue(session.notes) || null,
		});
	}

	const minutesByDate = recordValue(record.available_minutes_by_date);
	for (const [dateKey, minutes] of Object.entries(minutesByDate)) {
		const date = isoDateValue(dateKey);
		if (!date) continue;
		sessions.push({
			date,
			available_min: positiveIntValue(minutes, 75),
			meal_slots: ["dinner"],
		});
	}

	if (sessions.length) {
		return uniqueByDate(sessions).sort((a, b) => a.date.localeCompare(b.date));
	}

	return Array.from({ length: 7 }, (_, index) => ({
		date: addDays(startDate, index),
		available_min: 75,
		meal_slots: ["dinner"] as ["dinner"],
		notes: "Default afternoon/evening cooking session.",
	}));
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
	for (const value of values) {
		if (isRecord(value)) return value;
	}
	return {};
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayInput(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
	return [];
}

function itemNamesFromInput(value: unknown): string[] {
	return unique(arrayInput(value).map(item => {
		if (typeof item === "string") return normalizeName(item);
		const record = recordValue(item);
		return normalizeName(record.name ?? record.canonical_name ?? record.ingredient ?? record.title);
	}).filter(Boolean));
}

function normalizeStringList(value: unknown): string[] {
	return unique(arrayInput(value).map(item => normalizeName(item)).filter(Boolean));
}

function firstNonEmpty(lists: string[][]): string[] {
	return lists.find(list => list.length > 0) || [];
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function positiveIntValue(value: unknown, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

function isoDateValue(value: unknown): string | null {
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
	return null;
}

function addDays(date: string, days: number): string {
	const parsed = new Date(`${date}T00:00:00.000Z`);
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
}

function uniqueByDate(sessions: NonNullable<MisePlannerContext["schedule"]>): NonNullable<MisePlannerContext["schedule"]> {
	const seen = new Set<string>();
	const output: NonNullable<MisePlannerContext["schedule"]> = [];
	for (const session of sessions) {
		if (seen.has(session.date)) continue;
		seen.add(session.date);
		output.push(session);
	}
	return output;
}

async function resolveCanonicalIngredients(names: string[], env: MiseGraphEnv): Promise<any[]> {
	const seen = new Set<number>();
	const results: any[] = [];

	for (const raw of names) {
		const q = normalizeName(raw);
		if (!q) continue;

		let row = await env.DB.prepare(`
			SELECT id, name, total_count, category, subcategory, flavor_profile
			FROM canonical_ingredients
			WHERE lower(name) = ?
			ORDER BY total_count DESC
			LIMIT 1
		`).bind(q).first<any>();

		if (!row) {
			row = await env.DB.prepare(`
				SELECT id, name, total_count, category, subcategory, flavor_profile
				FROM canonical_ingredients
				WHERE lower(name) LIKE ?
				ORDER BY total_count DESC
				LIMIT 1
			`).bind(`%${q}%`).first<any>();
		}

		if (row && !seen.has(row.id)) {
			seen.add(row.id);
			results.push({
				...row,
				flavor_profile: parseJson(row.flavor_profile, []),
			});
		}
	}

	return results;
}

async function getIngredientAffinities(ids: number[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	if (!ids.length) return [];
	const idsList = ids.join(",");

	const rows = await env.DB.prepare(`
		SELECT
			CASE
				WHEN e.from_ingredient_id IN (${idsList}) THEN e.to_ingredient_id
				ELSE e.from_ingredient_id
			END AS ingredient_id,
			ci.name,
			ci.category,
			ci.subcategory,
			SUM(e.weighted_pmi) AS score,
			SUM(e.co_count) AS co_count,
			GROUP_CONCAT(DISTINCT e.type) AS edge_types,
			GROUP_CONCAT(DISTINCT e.context) AS contexts
		FROM ingredient_edges e
		JOIN canonical_ingredients ci ON ci.id = CASE
			WHEN e.from_ingredient_id IN (${idsList}) THEN e.to_ingredient_id
			ELSE e.from_ingredient_id
		END
		WHERE (e.from_ingredient_id IN (${idsList}) OR e.to_ingredient_id IN (${idsList}))
		AND CASE
			WHEN e.from_ingredient_id IN (${idsList}) THEN e.to_ingredient_id
			ELSE e.from_ingredient_id
		END NOT IN (${idsList})
		GROUP BY ingredient_id, ci.name, ci.category, ci.subcategory
		ORDER BY score DESC
		LIMIT ?
	`).bind(limit).all<any>();

	return rows.results || [];
}

async function getDishCandidates(names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	if (!names.length) return [];
	const { where, params } = likeJsonClauses(names, ["core_ingredients", "expected_ingredients", "optional_ingredients"]);
	const rows = await env.DB.prepare(`
		SELECT id, canonical_title, composition, sweet_savory, meals, methods, equipment,
			recipe_count, source_count, consensus_total_time, consensus_servings,
			core_ingredients, expected_ingredients, optional_ingredients, variations
		FROM canonical_dishes
		WHERE ${where}
		ORDER BY recipe_count DESC, source_count DESC
		LIMIT ?
	`).bind(...params, limit).all<any>();

	return (rows.results || []).map(row => ({
		...row,
		meals: parseJson(row.meals, []),
		methods: parseJson(row.methods, []),
		equipment: parseJson(row.equipment, []),
		core_ingredients: parseJson(row.core_ingredients, []),
		expected_ingredients: parseJson(row.expected_ingredients, []),
		optional_ingredients: parseJson(row.optional_ingredients, []),
		variations: parseJson(row.variations, {}),
	}));
}

async function getComponentCandidates(names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	if (!names.length) return [];
	const { where, params } = likeJsonClauses(names, ["core_ingredients", "common_ingredients", "optional_ingredients"]);
	const rows = await env.DB.prepare(`
		SELECT id, canonical_name, family, component_type, variant_names, recipe_count,
			core_ingredients, common_ingredients, optional_ingredients,
			typical_ratios, cuisine_signature
		FROM canonical_components
		WHERE ${where}
		ORDER BY recipe_count DESC
		LIMIT ?
	`).bind(...params, limit).all<any>();

	return (rows.results || []).map(row => ({
		...row,
		variant_names: parseJson(row.variant_names, []),
		core_ingredients: parseJson(row.core_ingredients, []),
		common_ingredients: parseJson(row.common_ingredients, []),
		optional_ingredients: parseJson(row.optional_ingredients, []),
		typical_ratios: parseJson(row.typical_ratios, {}),
		cuisine_signature: parseJson(row.cuisine_signature, []),
	}));
}

async function getProduceMatches(ids: number[], names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	const clauses: string[] = [];
	const params: any[] = [];

	if (ids.length) clauses.push(`canonical_ingredient_id IN (${ids.join(",")})`);
	for (const name of names.slice(0, 8)) {
		clauses.push("lower(base_ingredient) LIKE ?");
		params.push(`%${name}%`);
		clauses.push("lower(normalized_name) LIKE ?");
		params.push(`%${name}%`);
	}

	if (!clauses.length) return [];

	const rows = await env.DB.prepare(`
		SELECT id, name, normalized_name, base_ingredient, variety, category, subcategory,
			description_taste, season_profile, peak_months, available_months, sightings,
			first_seen, last_seen, canonical_ingredient_id
		FROM produce_profiles
		WHERE ${clauses.join(" OR ")}
		ORDER BY sightings DESC, name
		LIMIT ?
	`).bind(...params, limit).all<any>();

	return (rows.results || []).map(row => ({
		...row,
		peak_months: parseJson(row.peak_months, []),
		available_months: parseJson(row.available_months, []),
	}));
}

async function getTechniqueMatches(names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	const terms = unique(names.flatMap(name => [
		name,
		name.endsWith("s") ? name.slice(0, -1) : `${name}s`,
	]));
	if (!terms.length) return [];

	const placeholders = terms.map(() => "?").join(",");
	const techniquePlaceholders = USEFUL_TECHNIQUES.map(() => "?").join(",");
	const rows = await env.DB.prepare(`
		SELECT technique, SUM(count) AS score
		FROM tg_technique_ingredient
		WHERE lower(ingredient) IN (${placeholders})
		AND lower(technique) IN (${techniquePlaceholders})
		GROUP BY technique
		ORDER BY score DESC
		LIMIT ?
	`).bind(...terms, ...USEFUL_TECHNIQUES, limit).all<any>();

	return rows.results || [];
}

async function getMiseStates(ids: number[], names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	return optionalQuery(env, async () => {
		const clauses: string[] = [];
		const params: any[] = [];
		if (ids.length) clauses.push(`canonical_ingredient_id IN (${ids.join(",")})`);
		for (const name of names.slice(0, 8)) {
			clauses.push("lower(canonical_name) LIKE ?");
			params.push(`%${name}%`);
		}
		if (!clauses.length) return [];
		const rows = await env.DB.prepare(`
			SELECT *
			FROM mise_ingredient_states
			WHERE ${clauses.join(" OR ")}
			ORDER BY canonical_name, state_kind, state_name
			LIMIT ?
		`).bind(...params, limit).all<any>();
		return rows.results || [];
	}, []);
}

async function getMiseEdges(ids: number[], names: string[], limit: number, env: MiseGraphEnv): Promise<any[]> {
	return optionalQuery(env, async () => {
		const clauses: string[] = [];
		const params: any[] = [];
		if (ids.length) clauses.push(`s1.canonical_ingredient_id IN (${ids.join(",")})`);
		for (const name of names.slice(0, 8)) {
			clauses.push("lower(s1.canonical_name) LIKE ?");
			params.push(`%${name}%`);
		}
		if (!clauses.length) return [];
		const rows = await env.DB.prepare(`
			SELECT e.*,
				s1.canonical_name AS from_canonical_name,
				s1.state_name AS from_state_name,
				s1.display_name AS from_display_name,
				s2.canonical_name AS to_canonical_name,
				s2.state_name AS to_state_name,
				s2.display_name AS to_display_name
			FROM mise_edges e
			JOIN mise_ingredient_states s1 ON s1.id = e.from_state_id
			JOIN mise_ingredient_states s2 ON s2.id = e.to_state_id
			WHERE ${clauses.join(" OR ")}
			ORDER BY e.confidence DESC, e.edge_type, e.action_label
			LIMIT ?
		`).bind(...params, limit).all<any>();
		return (rows.results || []).map(row => ({
			...row,
			equipment: parseJson(row.equipment_json, []),
			station_tags: parseJson(row.station_tags_json, []),
			cuisine_grammars: parseJson(row.cuisine_grammars_json, []),
			format_tags: parseJson(row.format_tags_json, []),
			meta: parseJson(row.meta_json, {}),
		}));
	}, []);
}

async function handleListMiseStates(url: URL, env: MiseGraphEnv): Promise<Response> {
	const q = normalizeName(url.searchParams.get("q") || url.searchParams.get("ingredient") || "");
	const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
	const rows = await optionalQuery(env, async () => {
		const results = q
			? await env.DB.prepare(`
				SELECT * FROM mise_ingredient_states
				WHERE lower(canonical_name) LIKE ? OR lower(display_name) LIKE ?
				ORDER BY canonical_name, state_kind, state_name
				LIMIT ?
			`).bind(`%${q}%`, `%${q}%`, limit).all<any>()
			: await env.DB.prepare(`
				SELECT * FROM mise_ingredient_states
				ORDER BY canonical_name, state_kind, state_name
				LIMIT ?
			`).bind(limit).all<any>();
		return results.results || [];
	}, []);
	return json({ states: rows });
}

async function handleListMiseEdges(url: URL, env: MiseGraphEnv): Promise<Response> {
	const canonicalName = normalizeName(url.searchParams.get("canonical_name") || url.searchParams.get("ingredient") || "");
	const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
	const rows = await optionalQuery(env, async () => {
		const results = canonicalName
			? await env.DB.prepare(`
				SELECT e.*, s1.display_name AS from_display_name, s2.display_name AS to_display_name
				FROM mise_edges e
				JOIN mise_ingredient_states s1 ON s1.id = e.from_state_id
				JOIN mise_ingredient_states s2 ON s2.id = e.to_state_id
				WHERE lower(s1.canonical_name) LIKE ? OR lower(s2.canonical_name) LIKE ?
				ORDER BY e.confidence DESC, e.edge_type, e.action_label
				LIMIT ?
			`).bind(`%${canonicalName}%`, `%${canonicalName}%`, limit).all<any>()
			: await env.DB.prepare(`
				SELECT e.*, s1.display_name AS from_display_name, s2.display_name AS to_display_name
				FROM mise_edges e
				JOIN mise_ingredient_states s1 ON s1.id = e.from_state_id
				JOIN mise_ingredient_states s2 ON s2.id = e.to_state_id
				ORDER BY e.confidence DESC, e.edge_type, e.action_label
				LIMIT ?
			`).bind(limit).all<any>();
		return results.results || [];
	}, []);
	return json({ edges: rows });
}

async function handleListStationRules(env: MiseGraphEnv): Promise<Response> {
	const rows = await optionalQuery(env, async () => {
		const results = await env.DB.prepare(`
			SELECT *
			FROM mise_station_rules
			ORDER BY station_tag
		`).all<any>();
		return (results.results || []).map(row => ({
			...row,
			equipment: parseJson(row.equipment_json, []),
			cheap_branches: parseJson(row.cheap_branches_json, []),
			default_questions: parseJson(row.default_questions_json, []),
			meta: parseJson(row.meta_json, {}),
		}));
	}, []);
	return json({ station_rules: rows });
}

async function handleUpsertMiseStates(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json() as any;
	const states = Array.isArray(body.states) ? body.states : [];
	if (!states.length) return json({ error: "Required: { states: [...] }" }, 400);

	let succeeded = 0;
	for (const state of states) {
		const canonicalName = normalizeName(state.canonical_name);
		const stateName = normalizeName(state.state_name || state.state_kind || "raw");
		const id = state.id || slugId("mise_state", canonicalName, stateName);
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_ingredient_states
			(id, canonical_ingredient_id, produce_profile_id, canonical_name, state_name,
			 display_name, state_kind, component_type, default_storage, default_container,
			 quality_window_hours, active_window_hours, prep_level, source, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			id,
			state.canonical_ingredient_id || null,
			state.produce_profile_id || null,
			canonicalName,
			stateName,
			state.display_name || `${canonicalName}: ${stateName}`,
			state.state_kind || stateName,
			state.component_type || null,
			state.default_storage || null,
			state.default_container || null,
			state.quality_window_hours || null,
			state.active_window_hours || null,
			state.prep_level || "household",
			state.source || "mise_graph",
			JSON.stringify(state.meta || {}),
		).run();
		succeeded++;
	}

	return json({ succeeded, total: states.length });
}

async function handleUpsertMiseEdges(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json() as any;
	const edges = Array.isArray(body.edges) ? body.edges : [];
	if (!edges.length) return json({ error: "Required: { edges: [...] }" }, 400);

	let succeeded = 0;
	for (const edge of edges) {
		const id = edge.id || slugId("mise_edge", edge.from_state_id, edge.to_state_id, edge.edge_type, edge.action_label || "edge");
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_edges
			(id, from_state_id, to_state_id, edge_type, action_label, technique,
			 equipment_json, station_tags_json, cuisine_grammars_json, format_tags_json,
			 active_time_min, idle_time_min, lead_time_hours, yield_ratio,
			 storage_effect, quality_window_hours, difficulty, confidence,
			 source, rationale, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			id,
			edge.from_state_id,
			edge.to_state_id,
			edge.edge_type,
			edge.action_label || null,
			edge.technique || null,
			JSON.stringify(edge.equipment || []),
			JSON.stringify(edge.station_tags || []),
			JSON.stringify(edge.cuisine_grammars || []),
			JSON.stringify(edge.format_tags || []),
			edge.active_time_min || null,
			edge.idle_time_min || null,
			edge.lead_time_hours || null,
			edge.yield_ratio || null,
			edge.storage_effect || null,
			edge.quality_window_hours || null,
			edge.difficulty || null,
			edge.confidence ?? 0.5,
			edge.source || "mise_graph",
			edge.rationale || null,
			JSON.stringify(edge.meta || {}),
		).run();
		succeeded++;
	}

	return json({ succeeded, total: edges.length });
}

async function handleUpsertStationRules(request: Request, env: MiseGraphEnv): Promise<Response> {
	const body = await request.json() as any;
	const rules = Array.isArray(body.station_rules) ? body.station_rules : [];
	if (!rules.length) return json({ error: "Required: { station_rules: [...] }" }, 400);

	let succeeded = 0;
	for (const rule of rules) {
		const stationTag = normalizeName(rule.station_tag).replace(/\s+/g, "_");
		const id = rule.id || slugId("mise_station", stationTag);
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_station_rules
			(id, station_tag, station_name, trigger_kind, equipment_json,
			 cheap_branches_json, default_questions_json, source, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			id,
			stationTag,
			rule.station_name || stationTag.replace(/_/g, " "),
			rule.trigger_kind || "active_station",
			JSON.stringify(rule.equipment || []),
			JSON.stringify(rule.cheap_branches || []),
			JSON.stringify(rule.default_questions || []),
			rule.source || "mise_graph",
			JSON.stringify(rule.meta || {}),
		).run();
		succeeded++;
	}

	return json({ succeeded, total: rules.length });
}

function inferStateTemplates(names: string[]): MiseStateTemplate[] {
	const templates: MiseStateTemplate[] = [];
	for (const name of names) {
		if (/chickpea|garbanzo/.test(name)) {
			templates.push(template(name, "dry", "dried chickpeas", "raw", 365 * 24, [
				edge("soaked", "state_transition", "soak overnight", "soak", ["legume_batch_active"], ["mixing_bowl"], "Soaking opens the falafel branch while preserving a cooked-bean branch if split."),
				edge("cooked_whole", "state_transition", "pressure cook", "pressure_cook", ["instant_pot_active", "legume_batch_active"], ["instant pot"], "Cooking from dry creates neutral whole chickpeas for multiple future formats."),
			]));
			templates.push(template(name, "cooked_whole", "cooked whole chickpeas", "cooked", 5 * 24, [
				edge("hummus", "component_output", "blend into hummus", "blend", ["food_processor_dirty"], ["food processor"], "A processor session should create a dip while the cooked chickpea batch is available."),
				edge("crispy", "component_output", "roast until crisp", "roast", ["oven_hot", "ooni_hot"], ["sheet pan", "oven"], "Drying and roasting converts the same batch into a crunchy topping."),
				edge("chickpea_salad", "format_use", "dress as salad protein", "dress", ["mixing_bowl_active"], ["mixing bowl"], "Whole chickpeas can move into lunch boxes without repeating hummus."),
			]));
		} else if (/parsley|cilantro|mint|dill|basil|herb/.test(name)) {
			templates.push(template(name, "washed_whole", `washed whole ${name}`, "washed", 5 * 24, [
				edge("chopped_mix", "state_transition", "chop herb mix", "chop", ["herb_board_active"], ["cutting board"], "Chop only the early-week portion; hold later herbs whole for quality."),
				edge("stems", "branch_opportunity", "reserve tender stems", "trim", ["herb_board_active"], ["cutting board"], "Stems can route into blended sauces instead of waste."),
				edge("whole_leaf_reserve", "storage", "store as whole-leaf reserve", null, ["herb_board_active"], ["deli container"], "Whole leaves keep better for late-week finishing."),
			]));
		} else if (/cucumber|radish/.test(name)) {
			templates.push(template(name, "raw_whole", `whole ${name}`, "raw", 5 * 24, [
				edge("raw_sticks", "state_transition", "cut snack sticks", "slice", ["crunchy_veg_board_active"], ["cutting board"], "Snack-box vegetables should be cut while the board is already active."),
				edge("quick_pickle", "component_output", "quick pickle", "pickle", ["crunchy_veg_board_active"], ["jar"], "Pickled crunch lasts longer and changes the meal texture."),
				edge("salted_salad", "format_use", "salted salad crunch", "salt", ["crunchy_veg_board_active"], ["mixing bowl"], "Salted cucumber is short-window, so it should be scheduled close to serving."),
			]));
		} else if (/flour|dough|pita|naan|pizza/.test(name)) {
			templates.push(template(name, "mixed_dough", "mixed dough", "dough", 4 * 24, [
				edge("fermented_dough", "state_transition", "cold ferment", "ferment", ["dough_fermentation_active"], ["covered container"], "Fermentation creates a multi-day carrier for flatbreads and pizza."),
				edge("dough_balls", "state_transition", "divide into balls", "divide", ["dough_fermentation_active"], ["deli containers"], "Portioned dough lets the week schedule use only what is needed."),
			]));
		} else if (/lentil/.test(name)) {
			templates.push(template(name, "dry", "dry lentils", "raw", 365 * 24, [
				edge("cooked", "state_transition", "pressure cook", "pressure_cook", ["instant_pot_active"], ["instant pot"], "Lentils can be cooked late-week for salad and rescue bowls."),
			]));
		} else if (/tahini|yogurt/.test(name)) {
			templates.push(template(name, "base", `${name} base`, "base", 7 * 24, [
				edge("thick_dip", "component_output", "season as dip", "whisk", ["sauce_base_active"], ["bowl"], "Keep one thick sauce for snack boxes."),
				edge("thin_dressing", "component_output", "thin as dressing", "whisk", ["sauce_base_active"], ["bowl"], "Thin the same base into salad or bowl dressing."),
			]));
		} else {
			templates.push(template(name, "raw_whole", `whole ${name}`, "raw", null, [
				edge("washed", "state_transition", "wash and dry", "wash", ["prep_sink_active"], ["sink"], "Washing creates a ready state but may shorten quality for some produce."),
				edge("roasted", "component_output", "roast", "roast", ["oven_hot"], ["sheet pan"], "Oven heat should create at least one future component."),
				edge("quick_pickle", "component_output", "quick pickle", "pickle", ["crunchy_veg_board_active"], ["jar"], "Pickling extends a crunchy vegetable into later meals."),
			]));
		}
	}
	return templates;
}

function buildUiGraph(
	canonical: any[],
	affinities: any[],
	dishes: any[],
	components: any[],
	produce: any[],
	techniques: any[],
	miseStates: any[],
	miseEdges: any[],
	templates: MiseStateTemplate[],
) {
	const nodes: any[] = [];
	const edges: any[] = [];

	for (const ing of canonical) {
		nodes.push({ id: `ingredient:${ing.id}`, type: "ingredient", label: ing.name, data: ing });
	}
	for (const affinity of affinities.slice(0, 12)) {
		nodes.push({ id: `ingredient:${affinity.ingredient_id}`, type: "ingredient", label: affinity.name, data: affinity });
		for (const ing of canonical) {
			edges.push({ from: `ingredient:${ing.id}`, to: `ingredient:${affinity.ingredient_id}`, type: "co_occurs_with", score: affinity.score });
		}
	}
	for (const state of miseStates) {
		nodes.push({ id: `mise_state:${state.id}`, type: "mise_state", label: state.display_name, data: state });
		if (state.canonical_ingredient_id) {
			edges.push({ from: `ingredient:${state.canonical_ingredient_id}`, to: `mise_state:${state.id}`, type: "has_state" });
		}
	}
	for (const edgeRow of miseEdges) {
		edges.push({ from: `mise_state:${edgeRow.from_state_id}`, to: `mise_state:${edgeRow.to_state_id}`, type: edgeRow.edge_type, label: edgeRow.action_label });
	}
	for (const dish of dishes.slice(0, 10)) {
		nodes.push({ id: `dish:${dish.id}`, type: "canonical_dish", label: dish.canonical_title, data: dish });
		for (const ing of canonical) edges.push({ from: `ingredient:${ing.id}`, to: `dish:${dish.id}`, type: "supports_dish" });
	}
	for (const component of components.slice(0, 8)) {
		nodes.push({ id: `component:${component.id}`, type: "canonical_component", label: component.canonical_name, data: component });
		for (const ing of canonical) edges.push({ from: `ingredient:${ing.id}`, to: `component:${component.id}`, type: "supports_component" });
	}
	for (const item of produce.slice(0, 8)) {
		nodes.push({ id: `produce:${item.id}`, type: "produce_profile", label: item.name, data: item });
		if (item.canonical_ingredient_id) edges.push({ from: `ingredient:${item.canonical_ingredient_id}`, to: `produce:${item.id}`, type: "has_produce_profile" });
	}
	for (const tech of techniques.slice(0, 8)) {
		nodes.push({ id: `technique:${tech.technique}`, type: "technique", label: tech.technique, data: tech });
		for (const ing of canonical) edges.push({ from: `ingredient:${ing.id}`, to: `technique:${tech.technique}`, type: "uses_technique" });
	}
	for (const t of templates) {
		nodes.push({ id: t.id, type: "inferred_mise_template", label: t.display_name, data: t });
	}

	return { nodes, edges };
}

function template(
	canonicalName: string,
	stateName: string,
	displayName: string,
	stateKind: string,
	qualityWindowHours: number | null,
	edges: MiseStateTemplate["edges"],
): MiseStateTemplate {
	return {
		id: slugId("template", canonicalName, stateName),
		state_name: stateName,
		display_name: displayName,
		state_kind: stateKind,
		quality_window_hours: qualityWindowHours,
		edges,
	};
}

function edge(
	toStateName: string,
	edgeType: string,
	actionLabel: string,
	technique: string | null,
	stationTags: string[],
	equipment: string[],
	rationale: string,
): MiseStateTemplate["edges"][number] {
	return {
		to_state_name: toStateName,
		edge_type: edgeType,
		action_label: actionLabel,
		technique,
		station_tags: stationTags,
		equipment,
		rationale,
	};
}

async function tableCount(env: MiseGraphEnv, table: string): Promise<number | null> {
	return optionalQuery(env, async () => {
		const row = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).first<{ cnt: number }>();
		return row?.cnt ?? 0;
	}, null);
}

async function optionalQuery<T>(env: MiseGraphEnv, run: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await run();
	} catch {
		return fallback;
	}
}

function likeJsonClauses(names: string[], columns: string[]): { where: string; params: string[] } {
	const clauses: string[] = [];
	const params: string[] = [];
	for (const name of names.slice(0, 8)) {
		for (const col of columns) {
			clauses.push(`lower(${col}) LIKE ?`);
			params.push(`%${name}%`);
		}
	}
	return { where: clauses.join(" OR "), params };
}

function parseJson(value: unknown, fallback: any): any {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function parsePositiveInt(value: string | null, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(Math.floor(parsed), 100);
}

function normalizeName(value: unknown): string {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(part => String(part || "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function json(data: any, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}
