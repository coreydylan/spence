// Task graph decomposition + scheduling — Wave 7B Track C.
//
// A recipe is a list of human-written steps. A task graph is the
// mechanized form of that recipe: each step is decomposed into one or
// more atomic TaskNodes with skill, equipment, duration, and dependency
// metadata so the brigade scheduler can:
//   1. assign tasks to crew members based on skill confidence,
//   2. claim equipment atomically (via equipment.ts),
//   3. lay tasks on a timeline that respects the critical path while
//      packing parallelizable work into idle time.
//
// Decomposition is heuristic, not LLM-driven. We use a small lexicon of
// verbs to classify each step:
//
//   "preheat oven"    → cook, oven, low active / 15min passive, parallelizable
//   "dice/chop/slice" → prep, chefs_knife, parallelizable
//   "sauté/sear/brown" → cook, stove_burner, NOT parallelizable
//   "bake/roast"      → passive, oven, lots of passive_min from time hint
//   "knead/shape"     → prep, dough_handling, counter
//   "ferment/proof"   → passive, supervision_only, parallelizable
//   "blend/puree"     → prep, blender (or stove_emulsion if hot)
//   "fry/deep fry"    → cook, fryer
//   default           → prep, knife_basic, 5/0
//
// Dependencies are inferred two ways:
//   1. Produces/consumes — task A.produces "diced_onion", task B has
//      "diced_onion" in ingredients_in → B depends on A.
//   2. Oven gating — a "preheat oven" task gates every later oven user.
//   3. Soft prep gate — every prep task must finish before the FIRST cook
//      task in the chain (relaxed if a step explicitly tags otherwise).
//
// Storage: schemas/schema-task-graphs.sql (mise_task_graphs).

import type { MiseGraphEnv } from "./types";
import { beginTrace, completeTrace } from "./agent-trace";
import {
	type CrewMember,
	type RecipeForDecomposition,
	type ScheduleResult,
	type SkillKind,
	type TaskAssignment,
	type TaskGraph,
	type TaskKind,
	type TaskNode,
} from "./task-graph-types";

// ─── Schema migration ──────────────────────────────────────────────────────

const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
	`CREATE TABLE IF NOT EXISTS mise_task_graphs (
		id TEXT PRIMARY KEY,
		recipe_id TEXT NOT NULL,
		meal_id TEXT,
		tasks_json TEXT NOT NULL,
		critical_path_min INTEGER NOT NULL,
		total_active_min INTEGER NOT NULL,
		total_passive_min INTEGER NOT NULL,
		parallelism_max INTEGER NOT NULL,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS ux_task_graphs_meal
		ON mise_task_graphs(meal_id) WHERE meal_id IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS ix_task_graphs_recipe
		ON mise_task_graphs(recipe_id)`,
];

export async function migrateTaskGraphSchema(env: MiseGraphEnv): Promise<void> {
	for (const sql of SCHEMA_STATEMENTS) {
		await env.DB.prepare(sql).run();
	}
}

// ─── Public API: build ─────────────────────────────────────────────────────

export interface BuildTaskGraphArgs {
	recipe_id: string;
	meal_id: string;
	people: number;
	/** Inline override — when supplied, skip the personal_recipes lookup. */
	recipe?: RecipeForDecomposition;
}

/**
 * Decompose a recipe into a task graph. If `recipe` is supplied inline it's
 * used verbatim; otherwise the recipe is loaded from personal_recipes by id.
 *
 * Durations scale sub-linearly with `people` (sqrt curve, capped at 1.6×):
 * doubling the headcount doesn't double prep time, but it does add some.
 * Passive durations (oven, simmer) don't scale with people.
 *
 * Persists the graph via mise_task_graphs and returns it.
 */
export async function buildTaskGraph(
	env: MiseGraphEnv,
	args: BuildTaskGraphArgs,
): Promise<TaskGraph> {
	if (!args.recipe_id) throw new Error("buildTaskGraph: recipe_id required");
	if (!args.meal_id) throw new Error("buildTaskGraph: meal_id required");
	if (!Number.isFinite(args.people) || args.people <= 0) {
		throw new Error("buildTaskGraph: people must be a positive number");
	}
	await migrateTaskGraphSchema(env);

	const ctx = beginTrace({
		tool_name: "task_graph.buildTaskGraph",
		tool_args: { recipe_id: args.recipe_id, meal_id: args.meal_id, people: args.people },
		caller_kind: "system",
	});

	try {
		const recipe = args.recipe || await loadRecipeForDecomposition(env, args.recipe_id);
		if (!recipe) {
			throw new Error(`buildTaskGraph: recipe ${args.recipe_id} not found`);
		}

		const tasks = decomposeRecipe(recipe, args.people);
		linkDependencies(tasks);
		computeEarliestStarts(tasks);

		const critical = criticalPath({
			recipe_id: recipe.id,
			meal_id: args.meal_id,
			tasks,
			critical_path_min: 0,
			total_active_min: 0,
			total_passive_min: 0,
			parallelism_max: 0,
		});

		const total_active_min = tasks.reduce((s, t) => s + t.active_min, 0);
		const total_passive_min = tasks.reduce((s, t) => s + t.passive_min, 0);
		const parallelism_max = computeParallelismMax(tasks);

		const graph: TaskGraph = {
			recipe_id: recipe.id,
			meal_id: args.meal_id,
			tasks,
			critical_path_min: critical.total_min,
			total_active_min,
			total_passive_min,
			parallelism_max,
		};

		await persistGraph(env, graph);

		await completeTrace(env, ctx, {
			ok: true,
			result_summary: `built task graph: ${tasks.length} tasks, critical_path=${graph.critical_path_min}min, parallelism=${parallelism_max}`,
			result: {
				task_count: tasks.length,
				critical_path_min: graph.critical_path_min,
				parallelism_max,
			},
			triggered_mutations: [{ kind: "task_graph", mutation_id: args.meal_id }],
		});

		return graph;
	} catch (err) {
		await completeTrace(env, ctx, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

// ─── Public API: critical path ─────────────────────────────────────────────

/**
 * Compute the critical path: the longest path through the DAG by total
 * (active + passive) duration. Returns the ordered list of nodes on that
 * path plus the total duration.
 */
export function criticalPath(graph: TaskGraph): { tasks: TaskNode[]; total_min: number } {
	const byId = new Map<string, TaskNode>();
	for (const t of graph.tasks) byId.set(t.id, t);

	// Topological order so we can DP forward.
	const order = topoSort(graph.tasks);
	const distance = new Map<string, number>();
	const predecessor = new Map<string, string | null>();

	for (const id of order) {
		const node = byId.get(id);
		if (!node) continue;
		const own = node.active_min + node.passive_min;
		let best = own;
		let bestPred: string | null = null;
		for (const dep of node.depends_on) {
			const prev = distance.get(dep);
			if (prev === undefined) continue;
			const candidate = prev + own;
			if (candidate > best) {
				best = candidate;
				bestPred = dep;
			}
		}
		distance.set(id, best);
		predecessor.set(id, bestPred);
	}

	let endId: string | null = null;
	let endDist = -1;
	for (const [id, dist] of distance) {
		if (dist > endDist) {
			endDist = dist;
			endId = id;
		}
	}
	if (!endId) return { tasks: [], total_min: 0 };

	const reverse: TaskNode[] = [];
	let cursor: string | null = endId;
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const t = byId.get(cursor);
		if (!t) break;
		reverse.push(t);
		cursor = predecessor.get(cursor) ?? null;
	}
	reverse.reverse();
	return { tasks: reverse, total_min: endDist };
}

// ─── Public API: schedule ──────────────────────────────────────────────────

/**
 * Schedule the task graph against a crew. Each task is assigned to the
 * earliest-available qualified member. A member is qualified iff their
 * skill confidence for `task.skill` is >= `task.skill_floor`. Passive
 * (parallelizable) tasks don't block their assignee from picking up the
 * next active task — the member's clock advances by `active_min` only.
 *
 * Returns a ScheduleResult. `ok=false` means at least one task had no
 * eligible member; the unassignable list explains which ones.
 */
export function scheduleTaskGraph(
	graph: TaskGraph,
	crew: CrewMember[],
): ScheduleResult {
	if (crew.length === 0) {
		return {
			ok: graph.tasks.length === 0,
			assignments: [],
			unassignable: [...graph.tasks],
			total_duration_min: 0,
		};
	}

	const byId = new Map<string, TaskNode>();
	for (const t of graph.tasks) byId.set(t.id, t);

	const order = topoSort(graph.tasks);
	const finished = new Map<string, number>();              // task_id → end_offset_min
	const memberClock = new Map<string, number>();           // member_id → next-available offset
	for (const m of crew) memberClock.set(m.member_id, m.available_from_offset_min);

	const assignments: TaskAssignment[] = [];
	const unassignable: TaskNode[] = [];

	for (const id of order) {
		const task = byId.get(id);
		if (!task) continue;

		// Earliest start = max(predecessor end, task.earliest_start_offset_min).
		let earliest = task.earliest_start_offset_min ?? 0;
		for (const dep of task.depends_on) {
			const depEnd = finished.get(dep);
			if (depEnd !== undefined && depEnd > earliest) earliest = depEnd;
		}

		// Pick the cheapest qualified member: the one whose
		// clock reaches `earliest` soonest (ties → highest confidence).
		let bestMember: CrewMember | null = null;
		let bestStart = Number.POSITIVE_INFINITY;
		let bestConfidence = -1;
		for (const m of crew) {
			const conf = m.skills[task.skill] ?? 0;
			// supervision_only is always assignable (no confidence floor).
			if (task.skill !== "supervision_only" && conf < task.skill_floor) continue;
			const ready = memberClock.get(m.member_id) ?? m.available_from_offset_min;
			const start = Math.max(ready, earliest);
			if (start < bestStart || (start === bestStart && conf > bestConfidence)) {
				bestStart = start;
				bestMember = m;
				bestConfidence = conf;
			}
		}
		if (!bestMember) {
			unassignable.push(task);
			// Critical: still advance finished[] to its earliest-possible end so
			// downstream tasks don't fail to schedule. We treat the task as if
			// it took its full duration starting at `earliest`.
			finished.set(id, earliest + task.active_min + task.passive_min);
			continue;
		}

		const end = bestStart + task.active_min + task.passive_min;
		assignments.push({
			task_id: id,
			member_id: bestMember.member_id,
			start_offset_min: bestStart,
			end_offset_min: end,
		});
		finished.set(id, end);

		// Member's clock advances only by active_min — they can leave the
		// oven baking and start the next task. For non-parallelizable cook
		// tasks the active_min IS the full block (passive_min is usually 0
		// for sear/sauté), so this DTRT.
		memberClock.set(bestMember.member_id, bestStart + task.active_min);
	}

	let total_duration_min = 0;
	for (const end of finished.values()) {
		if (end > total_duration_min) total_duration_min = end;
	}

	return {
		ok: unassignable.length === 0,
		assignments,
		unassignable,
		total_duration_min,
	};
}

// ─── Persistence ───────────────────────────────────────────────────────────

async function persistGraph(env: MiseGraphEnv, graph: TaskGraph): Promise<void> {
	const id = `tg_${graph.meal_id}`;
	const now = Date.now();
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_task_graphs
			(id, recipe_id, meal_id, tasks_json, critical_path_min,
			 total_active_min, total_passive_min, parallelism_max,
			 created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		id,
		graph.recipe_id,
		graph.meal_id,
		JSON.stringify(graph.tasks),
		graph.critical_path_min,
		graph.total_active_min,
		graph.total_passive_min,
		graph.parallelism_max,
		now,
		now,
	).run();
}

export async function getTaskGraph(
	env: MiseGraphEnv,
	meal_id: string,
): Promise<TaskGraph | null> {
	if (!meal_id) return null;
	await migrateTaskGraphSchema(env);
	const row = await env.DB.prepare(
		`SELECT recipe_id, meal_id, tasks_json, critical_path_min,
			total_active_min, total_passive_min, parallelism_max
		 FROM mise_task_graphs
		 WHERE meal_id = ?
		 LIMIT 1`,
	).bind(meal_id).first<{
		recipe_id: string;
		meal_id: string;
		tasks_json: string;
		critical_path_min: number;
		total_active_min: number;
		total_passive_min: number;
		parallelism_max: number;
	}>();
	if (!row) return null;
	let tasks: TaskNode[] = [];
	try {
		const parsed = JSON.parse(row.tasks_json);
		if (Array.isArray(parsed)) tasks = parsed as TaskNode[];
	} catch {
		tasks = [];
	}
	return {
		recipe_id: row.recipe_id,
		meal_id: row.meal_id,
		tasks,
		critical_path_min: row.critical_path_min,
		total_active_min: row.total_active_min,
		total_passive_min: row.total_passive_min,
		parallelism_max: row.parallelism_max,
	};
}

// ─── Recipe load (from personal_recipes) ───────────────────────────────────

async function loadRecipeForDecomposition(
	env: MiseGraphEnv,
	recipe_id: string,
): Promise<RecipeForDecomposition | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT id, normalized_title, original_title,
				canonical_ingredients_json, raw_ingredients_text,
				method_summary, servings, active_time_min, total_time_min
			 FROM personal_recipes
			 WHERE id = ?
			 LIMIT 1`,
		).bind(recipe_id).first<{
			id: string;
			normalized_title: string | null;
			original_title: string | null;
			canonical_ingredients_json: string | null;
			raw_ingredients_text: string | null;
			method_summary: string | null;
			servings: number | null;
			active_time_min: number | null;
			total_time_min: number | null;
		}>();
		if (!row) return null;
		const ingredients = parseIngredientNames(row.canonical_ingredients_json);
		const steps = splitMethodToSteps(row.method_summary);
		return {
			id: row.id,
			title: row.normalized_title ?? row.original_title ?? null,
			steps,
			ingredients,
			servings: row.servings ?? null,
			active_time_min: row.active_time_min ?? null,
			total_time_min: row.total_time_min ?? null,
		};
	} catch {
		return null;
	}
}

function parseIngredientNames(json: string | null): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(p => (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string"
				? (p as { name: string }).name.trim().toLowerCase()
				: ""))
			.filter(s => s.length > 0);
	} catch {
		return [];
	}
}

function splitMethodToSteps(method: string | null): string[] {
	if (!method) return [];
	// Split on numbered prefixes like "1." or "Step 2:" first; fall back to
	// sentences if the method is one paragraph.
	const numbered = method.split(/\s*(?:\n+\s*)?(?:\d+\.\s+|step\s*\d+:\s*)/i)
		.map(s => s.trim())
		.filter(s => s.length > 0);
	if (numbered.length > 1) return numbered;
	return method.split(/\.\s+|\n+/)
		.map(s => s.trim())
		.filter(s => s.length > 4);
}

// ─── Decomposition heuristics ──────────────────────────────────────────────

interface DurationHint {
	active_min: number;
	passive_min: number;
}

function decomposeRecipe(recipe: RecipeForDecomposition, people: number): TaskNode[] {
	const scale = peopleScale(people);
	const tasks: TaskNode[] = [];
	for (let i = 0; i < recipe.steps.length; i++) {
		const stepText = recipe.steps[i];
		const subtasks = decomposeStep(recipe, stepText, i, scale);
		tasks.push(...subtasks);
	}
	if (tasks.length === 0) {
		// No usable steps — emit a single catch-all assembly task so the
		// graph isn't empty (caller can still schedule "make this thing").
		tasks.push(makeTask(recipe, 0, "assembly", "assemble dish", {
			skill: "knife_basic",
			skill_floor: 0.3,
			equipment: ["counter_space"],
			ingredients_in: [...recipe.ingredients],
			produces: "final_dish",
			active_min: Math.max(10, Math.round(15 * scale)),
			passive_min: 0,
			parallelizable: false,
		}));
	}
	return tasks;
}

interface DecompositionTemplate {
	kind: TaskKind;
	skill: SkillKind;
	skill_floor: number;
	equipment: string[];
	active_min: number;
	passive_min: number;
	parallelizable: boolean;
	produces_label: (verb: string) => string;
}

function decomposeStep(
	recipe: RecipeForDecomposition,
	stepText: string,
	step_idx: number,
	scale: number,
): TaskNode[] {
	const lower = stepText.toLowerCase();
	const template = pickTemplate(lower);
	const verb = pickVerb(lower);
	const consumed = matchIngredients(lower, recipe.ingredients);
	const timeHint = extractTimeMinutes(lower);

	let active = template.active_min;
	let passive = template.passive_min;
	if (template.kind === "passive" && timeHint !== null) {
		passive = Math.max(passive, timeHint);
	} else if (template.kind === "cook" && timeHint !== null) {
		active = Math.max(active, Math.round(timeHint * 0.7));
		passive = Math.max(passive, Math.round(timeHint * 0.3));
	} else if (template.kind === "prep" && timeHint !== null) {
		active = Math.max(active, timeHint);
	}
	// Sub-linear scaling for prep — feeding 6 instead of 4 doesn't double
	// dice time, but it does add some.
	if (template.kind === "prep" || template.kind === "assembly") {
		active = Math.round(active * scale);
	}

	const produces = template.produces_label(verb);
	const label = stepText.length > 80
		? stepText.slice(0, 77) + "..."
		: stepText;

	return [makeTask(recipe, step_idx, template.kind, label, {
		skill: template.skill,
		skill_floor: template.skill_floor,
		equipment: [...template.equipment],
		ingredients_in: consumed,
		produces,
		active_min: active,
		passive_min: passive,
		parallelizable: template.parallelizable,
	})];
}

function pickTemplate(lower: string): DecompositionTemplate {
	// Order matters — earlier matches win.
	if (/(preheat|heat\s+(the\s+)?oven|set\s+oven\s+to)/.test(lower)) {
		return {
			kind: "cook",
			skill: "oven_basic",
			skill_floor: 0.2,
			equipment: ["oven"],
			active_min: 2,
			passive_min: 15,
			parallelizable: true,
			produces_label: () => "preheated_oven",
		};
	}
	if (/\b(bake|roast)\b/.test(lower)) {
		return {
			kind: "passive",
			skill: "oven_basic",
			skill_floor: 0.3,
			equipment: ["oven"],
			active_min: 2,
			passive_min: 30,
			parallelizable: true,
			produces_label: v => `baked_${v}`,
		};
	}
	if (/\b(deep\s*fry|fry\b|frying)\b/.test(lower)) {
		return {
			kind: "cook",
			skill: "fryer",
			skill_floor: 0.6,
			equipment: ["fryer", "stove_burner_2"],
			active_min: 10,
			passive_min: 0,
			parallelizable: false,
			produces_label: () => "fried_component",
		};
	}
	if (/\b(sear|brown)\b/.test(lower)) {
		return {
			kind: "cook",
			skill: "stove_searing",
			skill_floor: 0.5,
			equipment: ["skillet", "stove_burner_1"],
			active_min: 8,
			passive_min: 0,
			parallelizable: false,
			produces_label: v => `seared_${v}`,
		};
	}
	if (/\b(saut[eé]|sweat|caramelize)\b/.test(lower)) {
		return {
			kind: "cook",
			skill: "stove_basic",
			skill_floor: 0.3,
			equipment: ["skillet", "stove_burner_1"],
			active_min: 8,
			passive_min: 0,
			parallelizable: false,
			produces_label: v => `sauteed_${v}`,
		};
	}
	if (/\b(simmer|reduce|stew)\b/.test(lower)) {
		return {
			kind: "passive",
			skill: "stove_basic",
			skill_floor: 0.2,
			equipment: ["saucepan", "stove_burner_1"],
			active_min: 3,
			passive_min: 20,
			parallelizable: true,
			produces_label: v => `simmered_${v}`,
		};
	}
	if (/\b(boil|blanch)\b/.test(lower)) {
		return {
			kind: "cook",
			skill: "stove_basic",
			skill_floor: 0.2,
			equipment: ["saucepan", "stove_burner_2"],
			active_min: 5,
			passive_min: 8,
			parallelizable: false,
			produces_label: v => `boiled_${v}`,
		};
	}
	if (/\b(emulsif|whisk\s+(in\s+)?the\s+oil|temper)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "stove_emulsion",
			skill_floor: 0.5,
			equipment: ["blender"],
			active_min: 5,
			passive_min: 0,
			parallelizable: true,
			produces_label: () => "emulsified_sauce",
		};
	}
	if (/\b(blend|pur[eé]e|process)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "knife_basic",
			skill_floor: 0.3,
			equipment: ["blender"],
			active_min: 4,
			passive_min: 0,
			parallelizable: true,
			produces_label: v => `blended_${v}`,
		};
	}
	if (/\b(julienne|brunoise|fillet|chiffonade)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "knife_advanced",
			skill_floor: 0.6,
			equipment: ["chefs_knife", "cutting_board"],
			active_min: 8,
			passive_min: 0,
			parallelizable: true,
			produces_label: v => `${v}_cut`,
		};
	}
	if (/\b(dice|chop|slice|mince|cube)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "knife_basic",
			skill_floor: 0.3,
			equipment: ["chefs_knife", "cutting_board"],
			active_min: 5,
			passive_min: 0,
			parallelizable: true,
			produces_label: v => `${v}_cut`,
		};
	}
	if (/\b(knead|fold|shape|stretch)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "dough_handling",
			skill_floor: 0.4,
			equipment: ["counter_space", "bench_scraper"],
			active_min: 8,
			passive_min: 0,
			parallelizable: true,
			produces_label: () => "shaped_dough",
		};
	}
	if (/\b(ferment|proof|rest|rise)\b/.test(lower)) {
		return {
			kind: "passive",
			skill: "supervision_only",
			skill_floor: 0,
			equipment: [],
			active_min: 1,
			passive_min: 60,
			parallelizable: true,
			produces_label: () => "rested_component",
		};
	}
	if (/\b(combine|mix|stir\s+together|toss|whisk)\b/.test(lower)) {
		return {
			kind: "prep",
			skill: "knife_basic",
			skill_floor: 0.2,
			equipment: ["counter_space"],
			active_min: 3,
			passive_min: 0,
			parallelizable: true,
			produces_label: () => "mixed_component",
		};
	}
	if (/\b(plate|garnish|serve|assemble|drizzle)\b/.test(lower)) {
		return {
			kind: "assembly",
			skill: "knife_basic",
			skill_floor: 0.2,
			equipment: ["counter_space"],
			active_min: 4,
			passive_min: 0,
			parallelizable: false,
			produces_label: () => "plated_dish",
		};
	}
	// Default: small prep.
	return {
		kind: "prep",
		skill: "knife_basic",
		skill_floor: 0.2,
		equipment: ["counter_space"],
		active_min: 5,
		passive_min: 0,
		parallelizable: true,
		produces_label: () => "step_output",
	};
}

function pickVerb(lower: string): string {
	const m = lower.match(/\b(preheat|bake|roast|fry|sear|brown|saut[eé]|sweat|caramelize|simmer|reduce|stew|boil|blanch|emulsif|blend|pur[eé]e|process|julienne|brunoise|fillet|chiffonade|dice|chop|slice|mince|cube|knead|fold|shape|stretch|ferment|proof|rest|rise|combine|mix|toss|whisk|plate|garnish|serve|assemble|drizzle)\b/);
	if (m) return m[1].toLowerCase();
	const first = lower.split(/\s+/)[0];
	return first ? first.replace(/[^a-z]/g, "") : "step";
}

function matchIngredients(stepLower: string, ingredients: string[]): string[] {
	const matched: string[] = [];
	for (const ing of ingredients) {
		if (!ing) continue;
		const head = ing.split(/[ ,]/)[0]; // "olive oil" → "olive"
		if (stepLower.includes(ing)) {
			matched.push(ing);
		} else if (head.length >= 4 && stepLower.includes(head)) {
			matched.push(ing);
		}
	}
	return matched;
}

function extractTimeMinutes(lower: string): number | null {
	// "30 minutes", "1 hour", "1.5 hours", "45 min"
	const hourMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:hour|hr|h\b)/);
	const minMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:minute|min|m\b)/);
	let total = 0;
	if (hourMatch) total += Math.round(Number(hourMatch[1]) * 60);
	if (minMatch) total += Math.round(Number(minMatch[1]));
	return total > 0 ? total : null;
}

function peopleScale(people: number): number {
	if (people <= 1) return 1;
	const scale = Math.sqrt(people / 2);
	return Math.min(1.6, Math.max(1, scale));
}

function makeTask(
	recipe: RecipeForDecomposition,
	step_idx: number,
	kind: TaskKind,
	label: string,
	props: {
		skill: SkillKind;
		skill_floor: number;
		equipment: string[];
		ingredients_in: string[];
		produces: string;
		active_min: number;
		passive_min: number;
		parallelizable: boolean;
	},
): TaskNode {
	return {
		id: generateTaskId(recipe.id, step_idx, label),
		recipe_id: recipe.id,
		step_idx,
		kind,
		label,
		skill: props.skill,
		skill_floor: props.skill_floor,
		equipment: props.equipment,
		ingredients_in: props.ingredients_in,
		produces: props.produces,
		active_min: props.active_min,
		passive_min: props.passive_min,
		parallelizable: props.parallelizable,
		depends_on: [],
	};
}

function generateTaskId(recipe_id: string, step_idx: number, label: string): string {
	// Stable id: prefix + recipe + step + label hash. Re-running buildTaskGraph
	// for the same recipe/step yields the same id.
	const safeRecipe = recipe_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
	const labelHash = simpleHash(label);
	return `task_${safeRecipe}_${step_idx}_${labelHash.toString(36)}`;
}

function simpleHash(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33 + s.charCodeAt(i)) >>> 0;
	}
	return h;
}

// ─── Dependency inference ──────────────────────────────────────────────────

function linkDependencies(tasks: TaskNode[]): void {
	// Map produces → first task that produces it.
	const producerByLabel = new Map<string, TaskNode>();
	for (const t of tasks) {
		if (!producerByLabel.has(t.produces)) {
			producerByLabel.set(t.produces, t);
		}
	}

	// 1. Produces/consumes linkage.
	for (const consumer of tasks) {
		for (const ing of consumer.ingredients_in) {
			// Direct producer match (e.g. produces=onion_cut, consumer references diced/chopped onion).
			for (const producer of tasks) {
				if (producer.id === consumer.id) continue;
				if (producer.step_idx >= consumer.step_idx) continue;
				if (producer.ingredients_in.includes(ing) && producer.kind === "prep") {
					addDep(consumer, producer.id);
				}
			}
		}
		// Direct produces-name lookup (e.g. step "make sauce" produces=mixed_component, later step "stir in sauce" doesn't include the tag — handled via produces label match in step text).
	}

	// 2. Oven gating: any task using the oven downstream of a preheat must
	//    depend on it.
	const ovenPreheats = tasks.filter(t =>
		t.equipment.includes("oven") && t.produces === "preheated_oven",
	);
	for (const preheat of ovenPreheats) {
		for (const t of tasks) {
			if (t.id === preheat.id) continue;
			if (t.step_idx <= preheat.step_idx) continue;
			if (t.equipment.includes("oven")) {
				addDep(t, preheat.id);
			}
		}
	}

	// 3. Soft prep gate: the first non-preheat cook task gates on every prep
	//    step that precedes it in the recipe order. Preheat ("preheated_oven")
	//    is excluded because it's parallelizable and doesn't consume mise.
	const firstRealCook = tasks.find(t =>
		t.kind === "cook" && t.produces !== "preheated_oven",
	);
	if (firstRealCook) {
		for (const t of tasks) {
			if (t.id === firstRealCook.id) continue;
			if (t.kind === "prep" && t.step_idx < firstRealCook.step_idx) {
				addDep(firstRealCook, t.id);
			}
		}
	}
}

function addDep(node: TaskNode, depId: string): void {
	if (node.id === depId) return;
	if (!node.depends_on.includes(depId)) node.depends_on.push(depId);
}

// ─── Topological sort + earliest start ─────────────────────────────────────

function topoSort(tasks: TaskNode[]): string[] {
	const indeg = new Map<string, number>();
	const byId = new Map<string, TaskNode>();
	for (const t of tasks) {
		byId.set(t.id, t);
		indeg.set(t.id, 0);
	}
	for (const t of tasks) {
		for (const dep of t.depends_on) {
			if (!byId.has(dep)) continue;
			indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
		}
	}
	const queue: string[] = [];
	for (const [id, deg] of indeg) if (deg === 0) queue.push(id);
	queue.sort((a, b) => {
		const ai = byId.get(a)?.step_idx ?? 0;
		const bi = byId.get(b)?.step_idx ?? 0;
		return ai - bi;
	});

	const order: string[] = [];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const next = queue.shift()!;
		if (visited.has(next)) continue;
		visited.add(next);
		order.push(next);
		for (const t of tasks) {
			if (t.depends_on.includes(next)) {
				indeg.set(t.id, (indeg.get(t.id) ?? 1) - 1);
				if ((indeg.get(t.id) ?? 0) === 0 && !visited.has(t.id)) {
					queue.push(t.id);
				}
			}
		}
		queue.sort((a, b) => {
			const ai = byId.get(a)?.step_idx ?? 0;
			const bi = byId.get(b)?.step_idx ?? 0;
			return ai - bi;
		});
	}
	// Append any leftover (cycle-bound) nodes so they aren't dropped.
	for (const t of tasks) if (!visited.has(t.id)) order.push(t.id);
	return order;
}

function computeEarliestStarts(tasks: TaskNode[]): void {
	const byId = new Map<string, TaskNode>();
	for (const t of tasks) byId.set(t.id, t);
	const order = topoSort(tasks);
	const startBy = new Map<string, number>();
	for (const id of order) {
		const t = byId.get(id);
		if (!t) continue;
		let earliest = 0;
		for (const dep of t.depends_on) {
			const depTask = byId.get(dep);
			const depStart = startBy.get(dep) ?? 0;
			const depEnd = depTask
				? depStart + depTask.active_min + depTask.passive_min
				: depStart;
			if (depEnd > earliest) earliest = depEnd;
		}
		startBy.set(id, earliest);
		t.earliest_start_offset_min = earliest;
	}
}

// ─── Parallelism estimate ──────────────────────────────────────────────────

function computeParallelismMax(tasks: TaskNode[]): number {
	// Walk the timeline at 1-min ticks across the [0, total] range and
	// count concurrently active tasks. Use earliest_start_offset_min as the
	// lower bound and (start + active + passive) as the upper bound.
	if (tasks.length === 0) return 0;
	let horizon = 0;
	for (const t of tasks) {
		const end = (t.earliest_start_offset_min ?? 0) + t.active_min + t.passive_min;
		if (end > horizon) horizon = end;
	}
	if (horizon === 0) return 1;
	let max = 1;
	// Sample at every event boundary rather than every minute (cheaper, exact).
	const events = new Set<number>();
	for (const t of tasks) {
		const start = t.earliest_start_offset_min ?? 0;
		const end = start + t.active_min + t.passive_min;
		events.add(start);
		events.add(end);
	}
	for (const tick of events) {
		let count = 0;
		for (const t of tasks) {
			const start = t.earliest_start_offset_min ?? 0;
			const end = start + t.active_min + t.passive_min;
			if (start <= tick && tick < end) count++;
		}
		if (count > max) max = count;
	}
	return max;
}
