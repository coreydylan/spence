import type { MiseGraphEnv } from "./types";
import { loadMiseFormulas, type MiseFormula } from "./ledger";
import { composeMenuWithLlm, type ComposedMeal, type ComposerSnackBox, type ComposerRawIngredient, type ComposerLineageRef } from "./menu-composer";
import { loadComposerContext } from "./composer-context";
import type { MeshClaudeEnv } from "./llm-bridge";
import { hoistRepeatedRawIngredients, type HoistResult } from "./ingredient-hoist";
import { clusterTasksWithinSessions } from "./task-clustering";
import { runExtendedValidators } from "./validators-extended";
import { applyComposerPostPass, fillComponents, type PostPassReport } from "./composer-postpass";
import { buildShoppingListV2, type ShoppingRun } from "./shopping-list";
import { generatePrepInstructions } from "./prep-instructions";
import { splitBatchesByShelfLifeAndReassign, assignDesiredPrepDates, type RebatchReport } from "./shelf-life-rebatch";
import type { MealComponent } from "./meal-component";

export type MiseMealSlot = "breakfast" | "lunch" | "dinner" | "snack";

export interface MisePlannerContext {
	household_id?: string | null;
	start_date: string;
	end_date?: string | null;
	length_days?: number | null;
	timezone?: string | null;
	people?: number | null;
	title?: string | null;
	prompt?: string | null;
	cuisine_direction?: string[];
	constraints?: Record<string, unknown>;
	selected_ingredients?: string[];
	source_recipe_ids?: string[];
	pantry?: string[];
	equipment?: string[];
	preferences?: {
		breakfasts?: boolean;
		lunches?: boolean;
		dinners?: boolean;
		snack_boxes?: boolean;
		max_component_batches?: number;
		max_active_prep_min_per_session?: number;
	};
	default_meals?: {
		breakfast?: boolean;
		lunch?: boolean;
		dinner?: boolean;
		snack?: boolean;
	};
	meal_slots?: Array<MiseMealSlotSpec>;
	meal_overrides?: Array<MiseMealSlotSpec>;
	use_up?: Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }>;
	schedule?: Array<{
		date: string;
		available_min?: number | null;
		meal_slots?: MiseMealSlot[];
		notes?: string | null;
	}>;
	resolved_graph?: MiseResolvedGraphInput;
}

export interface MiseMealSlotSpec {
	date: string;
	slot: MiseMealSlot;
	people?: number | null;
	cuisine?: string[];
	format?: string | null;
	title?: string | null;
	locked?: boolean;
	notes?: string[] | string | null;
	source?: string | null;
}

export interface MiseResolvedGraphInput {
	mise_graph?: {
		states?: UnknownRecord[];
		edges?: UnknownRecord[];
		inferred_templates?: UnknownRecord[];
	};
	spence_graph?: {
		affinities?: UnknownRecord[];
		dish_candidates?: UnknownRecord[];
		component_candidates?: UnknownRecord[];
		produce_matches?: UnknownRecord[];
		technique_matches?: UnknownRecord[];
	};
	graph?: {
		nodes?: UnknownRecord[];
		edges?: UnknownRecord[];
	};
	states?: UnknownRecord[];
	edges?: UnknownRecord[];
	dishes?: UnknownRecord[];
	components?: UnknownRecord[];
	produce?: UnknownRecord[];
	techniques?: UnknownRecord[];
	affinities?: UnknownRecord[];
}

export interface MiseWeeklyPlanDraft {
	id: string;
	household_id: string | null;
	title: string;
	start_date: string;
	end_date: string;
	timezone: string | null;
	people: number;
	status: "draft";
	constraints: Record<string, unknown>;
	selected_ingredients: string[];
	source_recipe_ids: string[];
	meals_by_day: MisePlanDay[];
	component_batches: MisePlanComponentBatch[];
	prep_tasks: MisePlanTask[];
	breakfasts: MisePlanMeal[];
	snack_boxes: MiseSnackBox[];
	shopping_list: MiseShoppingListSection[];
	shop_runs?: ShoppingRun[];
	storage_labels: MiseStorageLabel[];
	meta: {
		generated_by: "mise_graph_planner";
		deterministic: boolean;
		repaired_by?: string;
		repair_count?: number;
		repair_notes?: string[];
		[key: string]: unknown;
	};
}

export interface MisePlanDay {
	date: string;
	day_index: number;
	meals: MisePlanMeal[];
}

export interface MisePlanMeal {
	id: string;
	date: string;
	slot: MiseMealSlot;
	title: string;
	format: string;
	component_ids: string[];
	ingredient_names: string[];
	source: string;
	notes: string[];
	people: number;
	cuisine: string[];
	locked: boolean;
	raw_ingredients?: ComposerRawIngredient[];
	method_summary?: string | null;
	lineage?: ComposerLineageRef[];
	active_time_min?: number;
	leftovers_to?: string[];
	components?: MealComponent[];
	meta?: Record<string, unknown>;
}

export interface MisePlanComponentBatch {
	id: string;
	state_id: string | null;
	label: string;
	quantity: number | null;
	unit: string | null;
	storage: string | null;
	container: string | null;
	quality_window_hours: number | null;
	planned_uses: Array<{ date: string; slot: MiseMealSlot; meal_id: string; title: string }>;
	station_tags: string[];
	equipment: string[];
	active_time_min: number;
	idle_time_min: number;
	input_names: string[];
	meta: Record<string, unknown>;
}

export interface MisePlanTask {
	id: string;
	scheduled_date: string;
	session_order: number;
	task_type: string;
	title: string;
	station_tags: string[];
	equipment: string[];
	depends_on: string[];
	state_inputs: string[];
	state_outputs: string[];
	active_time_min: number;
	idle_time_min: number;
	instructions: string[];
	status: "planned";
	meta: Record<string, unknown>;
}

export interface MiseSnackBox {
	id: string;
	date: string;
	title: string;
	items: string[];
	component_ids: string[];
	people: number;
	locked: boolean;
	raw_ingredients?: ComposerRawIngredient[];
	meta?: Record<string, unknown>;
}

export interface MiseShoppingListSection {
	category: string;
	items: MiseShoppingListItem[];
}

export interface MiseShoppingListItem {
	name: string;
	quantity: number | null;
	unit: string | null;
	source: string[];
	grams_total?: number;
}

export interface MiseStorageLabel {
	id: string;
	component_id: string;
	label: string;
	storage: string;
	use_by_date: string | null;
	notes: string[];
}

export interface SaveMiseWeeklyPlanResult {
	plan_id: string;
	components_saved: number;
	tasks_saved: number;
}

interface UnknownRecord {
	[key: string]: unknown;
}

interface PlannerCandidates {
	states: UnknownRecord[];
	edges: UnknownRecord[];
	dishes: UnknownRecord[];
	components: UnknownRecord[];
	produce: UnknownRecord[];
	techniques: UnknownRecord[];
	affinities: UnknownRecord[];
}

const DEFAULT_DINNER_FORMATS = ["bowl", "salad", "flatbread", "skillet", "soup", "tacos", "grain bowl"];
const DEFAULT_BREAKFASTS = ["chia pudding", "overnight oats", "yogurt bowl"];
const DEFAULT_SNACK_ITEMS = ["crunchy vegetables", "dip", "fruit", "nuts"];

export type MiseComposeMode = "auto" | "llm" | "deterministic";

export interface PlanEnv extends MiseGraphEnv, Partial<MeshClaudeEnv> {}

export async function planMiseWeek(input: MisePlannerContext, env?: PlanEnv | null, composeMode: MiseComposeMode = "auto"): Promise<MiseWeeklyPlanDraft> {
	const startDate = requireIsoDate(input.start_date, "start_date");
	const days = computeDays(startDate, input.end_date, input.length_days);
	const endDate = days[days.length - 1] || startDate;
	const people = positiveInt(input.people, 2);
	const candidates = collectCandidates(input.resolved_graph);
	const selectedIngredients = normalizeList(input.selected_ingredients);
	const pantry = new Set(normalizeList(input.pantry));
	const equipment = new Set(normalizeList(input.equipment));
	const maxBatches = clamp(positiveInt(input.preferences?.max_component_batches, 7 + Math.max(0, days.length - 7)), 2, 24);
	const planId = slugId("mise_plan", input.household_id || "household", startDate, `${days.length}d`, selectedIngredients.join("_") || "draft");
	const cuisineDirection = parseCuisineDirection(input);
	const promptText = stringValue(input.prompt) || stringValue((input.constraints as Record<string, unknown> | undefined)?.prompt);

	const slotSpecs = resolveSlotSpecs(days, input, people, cuisineDirection);
	const useUp = Array.isArray(input.use_up) ? input.use_up : [];
	const dietary = normalizeList((input.constraints as Record<string, unknown> | undefined)?.dietary as unknown as string[]);

	const llmEligible = composeMode !== "deterministic"
		&& !!env
		&& isMeshConfigured(env);
	const llmAttemptOnly = composeMode === "llm";

	let composerOutput: Awaited<ReturnType<typeof composeMenuWithLlm>> | null = null;
	let formulaCatalog: MiseFormula[] = [];

	if (llmEligible && env) {
		try {
			const formulas = await loadMiseFormulas(env);
			formulaCatalog = Array.from(formulas.by_label.values());
			if (formulaCatalog.length > 0 && slotSpecs.length > 0) {
				const planDates = days;
				const locationRegion = stringValue(((input.constraints as Record<string, unknown> | undefined)?.location as Record<string, unknown> | undefined)?.region) || null;
				const context = await loadComposerContext(env, {
					anchors: selectedIngredients,
					plan_dates: planDates,
					household_id: input.household_id || null,
					location_region: locationRegion,
					cuisine_direction: cuisineDirection,
					per_section_limit: 5,
				});
				composerOutput = await composeMenuWithLlm(env as MeshClaudeEnv, {
					start_date: startDate,
					end_date: endDate,
					people_default: people,
					prompt: promptText || null,
					cuisine_direction: cuisineDirection,
					anchor_ingredients: selectedIngredients,
					pantry: Array.from(pantry),
					equipment: Array.from(equipment),
					household_id: input.household_id || null,
					dietary,
					slots: slotSpecs.map(spec => ({
						date: spec.date,
						slot: spec.slot,
						people: spec.people,
						cuisine: spec.cuisine,
						format: spec.format ?? null,
						title_hint: spec.title ?? null,
						locked: spec.locked,
						notes: spec.notes,
					})),
					formulas: formulaCatalog,
					max_active_time_min: positiveInt((input.constraints as Record<string, unknown> | undefined)?.max_active_time_min, 0) || null,
					context,
				});
			}
		} catch (error) {
			composerOutput = null;
		}
	}

	const usingLlm = !!composerOutput && composerOutput.ok;
	if (llmAttemptOnly && !usingLlm) {
		const detail = composerOutput?.debug?.raw_text
			? ` raw=${composerOutput.debug.raw_text.slice(0, 400).replace(/\n/g, "\\n")}`
			: "";
		throw new Error(`compose=llm requested but composer failed: ${composerOutput?.error || "unknown"}${detail}`);
	}

	let componentBatches: MisePlanComponentBatch[];
	let mealsByDay: MisePlanDay[];
	let breakfasts: MisePlanMeal[];
	let snackBoxes: MiseSnackBox[];
	let llmRawIngredients: ComposerRawIngredient[] = [];
	let composerRationale = "";

	let postPassReport: PostPassReport | null = null;
	if (usingLlm && composerOutput) {
		// Composer post-pass — auto-link formulas, scrub dietary violations,
		// strip filler notes, infer leftovers, fill lineage, set active_time_min.
		postPassReport = applyComposerPostPass(composerOutput.meals, composerOutput.snack_boxes, {
			formulas: formulaCatalog,
			dietary,
			cuisine_direction: cuisineDirection,
			people_default: people,
		});
		componentBatches = buildComponentBatchesFromFormulas(
			formulaCatalog,
			composerOutput.meals,
			composerOutput.snack_boxes,
			people,
			useUp,
			equipment,
		);
		// Now that batches exist, fill structural components on each meal.
		// (applyComposerPostPass ran before batches were built; this second
		// pass attaches use_batch sources where batches now exist.)
		let componentsFilled = 0;
		for (const meal of composerOutput.meals) {
			componentsFilled += fillComponents(meal, componentBatches);
		}
		if (postPassReport) postPassReport.components_filled += componentsFilled;
		const built = buildMealsFromComposer(composerOutput.meals, slotSpecs, componentBatches, people, cuisineDirection);
		mealsByDay = built.mealsByDay;
		breakfasts = built.breakfasts;
		snackBoxes = buildSnackBoxesFromComposer(composerOutput.snack_boxes, slotSpecs, componentBatches, people);
		llmRawIngredients = collectComposerRawIngredients(composerOutput.meals, composerOutput.snack_boxes);
		composerRationale = composerOutput.rationale || "";
	} else {
		componentBatches = buildComponentBatches(candidates, selectedIngredients, people, maxBatches, equipment, useUp);
		mealsByDay = buildMealsFromSlots(days, slotSpecs, candidates, componentBatches, selectedIngredients, people, cuisineDirection);
		breakfasts = buildBreakfastsFromSlots(slotSpecs, candidates, componentBatches, selectedIngredients, people);
		snackBoxes = buildSnackBoxesFromSlots(slotSpecs, candidates, componentBatches, selectedIngredients, people);
		// Even on the deterministic path, attach formula metadata when batch
		// labels match a real formula — so prep instructions get generated
		// from the formula library instead of falling back to stubs.
		if (env) {
			try {
				if (formulaCatalog.length === 0) {
					const idx = await loadMiseFormulas(env);
					formulaCatalog = Array.from(idx.by_label.values());
				}
				attachFormulaMetadataToBatches(componentBatches, formulaCatalog);
			} catch { /* non-fatal */ }
		}
	}

	const descriptorBackfill = backfillPlanMealCuisines(mealsByDay, breakfasts, cuisineDirection);
	attachPlannedUses(componentBatches, mealsByDay, breakfasts, snackBoxes);
	// Shelf-life-aware rebatching: split batches whose uses span more than
	// shelf_life_hours_fridge into multiple sub-batches, then stamp each batch
	// with a desired_prep_date so prep runs close to first use.
	let rebatchReport: RebatchReport | null = null;
	let prepDateReport: RebatchReport | null = null;
	{
		const split = splitBatchesByShelfLifeAndReassign(componentBatches, mealsByDay, breakfasts, snackBoxes);
		if (split.report.batches_split > 0) {
			componentBatches = split.batches;
			rebatchReport = split.report;
		}
		prepDateReport = assignDesiredPrepDates(componentBatches, startDate);
	}
	// GC orphan batches: after rebatch + meal id remap, any batch with no
	// planned_uses isn't claimed by any meal/breakfast/snack. Drop it so we
	// don't generate a phantom prep task (and a phantom shopping line).
	const orphanIds = new Set<string>();
	componentBatches = componentBatches.filter(batch => {
		const empty = !batch.planned_uses || batch.planned_uses.length === 0;
		if (empty) orphanIds.add(batch.id);
		return !empty;
	});
	if (orphanIds.size > 0) {
		// Cleanse meal.component_ids of any stale references to dropped batches
		const scrub = (ids?: string[]) => (ids || []).filter(id => !orphanIds.has(id));
		for (const day of mealsByDay) for (const meal of day.meals) meal.component_ids = scrub(meal.component_ids);
		for (const meal of breakfasts) meal.component_ids = scrub(meal.component_ids);
		for (const snack of snackBoxes) snack.component_ids = scrub(snack.component_ids);
	}
	const prepTasks = buildPrepTasks(startDate, componentBatches, candidates, input.schedule, input.preferences?.max_active_prep_min_per_session);
	// Smart shopping list: canonicalizes names, drops batch outputs, drops
	// formula-owned inputs, scrubs snack-box description strings, and emits
	// a shop-run schedule (full shop on day 0 + produce refresh on day 7+).
	const shoppingResult = buildShoppingListV2({
		startDate,
		endDate,
		pantry,
		componentBatches,
		formulaCatalog,
		mealsByDay,
		breakfasts,
		snackBoxes,
		llmRawIngredients,
	});
	const shoppingList = shoppingResult.sections;
	const shopRuns = shoppingResult.runs;
	const shoppingDebug = shoppingResult.debug;
	const storageLabels = buildStorageLabels(startDate, componentBatches);

	// POST-PASS: cross-meal ingredient hoisting (suggest batched chops, juices,
	// and proposed formulas for repeated raw ingredients).
	let hoistResult: HoistResult | null = null;
	try {
		hoistResult = hoistRepeatedRawIngredients({
			id: planId,
			start_date: startDate,
			end_date: endDate,
			meals_by_day: mealsByDay,
			breakfasts,
			snack_boxes: snackBoxes,
		});
	} catch {
		hoistResult = null;
	}

	// POST-PASS: cluster prep tasks within each cook session (food processor
	// reuse, oven clustering, late cold prep). Returns a session view that
	// downstream renderers can show.
	let clusteringResult: ReturnType<typeof clusterTasksWithinSessions> | null = null;
	try {
		const clusterTasks = prepTasks.map(task => ({
			id: task.id,
			scheduled_date: task.scheduled_date,
			active_time_min: task.active_time_min,
			idle_time_min: task.idle_time_min,
			equipment: task.equipment,
			station_tags: task.station_tags,
			title: task.title,
		}));
		clusteringResult = clusterTasksWithinSessions(clusterTasks);
	} catch {
		clusteringResult = null;
	}

	// POST-PASS: extended validation (flavor structure + cuisine grammar).
	let extendedValidationIssues: any[] = [];
	if (formulaCatalog.length > 0) {
		try {
			const formulaIndex = {
				by_state_id: new Map<string, MiseFormula>(formulaCatalog.filter(f => !!f.output_state_id).map(f => [f.output_state_id as string, f])),
				by_label: new Map<string, MiseFormula>(formulaCatalog.map(f => [f.output_label.toLowerCase(), f])),
				by_canonical: new Map<string, MiseFormula>(formulaCatalog.filter(f => !!f.output_canonical_name).map(f => [(f.output_canonical_name as string).toLowerCase(), f])),
				unit_conversions: new Map(),
			};
			const result = runExtendedValidators({
				id: planId,
				meals_by_day: mealsByDay,
				breakfasts,
				snack_boxes: snackBoxes,
				component_batches: componentBatches,
			} as any, formulaIndex);
			extendedValidationIssues = [...(result.flavor_issues || []), ...(result.cuisine_issues || [])];
		} catch {
			extendedValidationIssues = [];
		}
	}

	const constraints = {
		...(input.constraints || {}),
		...(promptText ? { prompt: promptText } : {}),
		...(cuisineDirection.length ? { cuisine_direction: cuisineDirection } : {}),
		...(input.use_up && input.use_up.length ? { use_up: input.use_up } : {}),
		...(usingLlm ? { menu_rationale: composerRationale } : {}),
		...(hoistResult && (hoistResult.proposed_formulas.length || hoistResult.ingredient_clusters.length)
			? { ingredient_hoist: hoistResult }
			: {}),
		...(clusteringResult && clusteringResult.sessions.length
			? { cook_sessions: clusteringResult.sessions }
			: {}),
		...(extendedValidationIssues.length
			? { extended_validation_issues: extendedValidationIssues }
			: {}),
	};

	return {
		id: planId,
		household_id: input.household_id || null,
		title: input.title || (days.length === 7 ? `Mise plan ${startDate}` : `${days.length}-day mise plan ${startDate}`),
		start_date: startDate,
		end_date: endDate,
		timezone: input.timezone || null,
		people,
		status: "draft",
		constraints,
		selected_ingredients: selectedIngredients,
		source_recipe_ids: normalizeList(input.source_recipe_ids),
		meals_by_day: mealsByDay,
		component_batches: componentBatches,
		prep_tasks: prepTasks,
		breakfasts,
		snack_boxes: snackBoxes,
		shopping_list: shoppingList,
		shop_runs: shopRuns,
		storage_labels: storageLabels,
		meta: {
			generated_by: "mise_graph_planner",
			deterministic: !usingLlm,
			length_days: days.length,
			cuisine_direction: cuisineDirection,
			explicit_slots: !!(input.meal_slots && input.meal_slots.length),
			meal_overrides_count: input.meal_overrides?.length || 0,
			prompt: promptText || null,
			compose_mode: usingLlm ? "llm" : "deterministic",
			llm_meals: usingLlm && composerOutput ? composerOutput.meals.length : 0,
			llm_debug: usingLlm && composerOutput?.debug ? {
				elapsed_ms: composerOutput.debug.elapsed_ms,
				input_tokens: composerOutput.debug.input_tokens,
				output_tokens: composerOutput.debug.output_tokens,
				cache_read: composerOutput.debug.cache_read,
				cost_usd: composerOutput.debug.cost_usd,
			} : null,
			llm_error: !usingLlm && composerOutput?.error ? composerOutput.error : null,
			post_pass: postPassReport,
			descriptor_backfill: descriptorBackfill,
			rebatch: rebatchReport,
			prep_dates: prepDateReport,
			shopping_debug: shoppingDebug,
		},
	};
}

function isMeshConfigured(env: Partial<MeshClaudeEnv> | undefined): boolean {
	if (!env) return false;
	return !!env.MESH && !!env.BRIDGE_HOST && !!env.BRIDGE_PORT && !!env.BRIDGE_SECRET;
}

function computeDays(startDate: string, endDate: string | null | undefined, lengthDays: number | null | undefined): string[] {
	if (endDate) {
		const end = requireIsoDate(endDate, "end_date");
		const days: string[] = [];
		let cursor = startDate;
		while (cursor <= end && days.length < 90) {
			days.push(cursor);
			cursor = addDays(cursor, 1);
		}
		return days.length ? days : [startDate];
	}
	const length = clamp(positiveInt(lengthDays, 7), 1, 60);
	return Array.from({ length }, (_, index) => addDays(startDate, index));
}

function parseCuisineDirection(input: MisePlannerContext): string[] {
	const explicit = preserveCaseList(input.cuisine_direction);
	if (explicit.length) return explicit;
	const constraintsRecord = (input.constraints as Record<string, unknown> | undefined) || {};
	const fromConstraints = preserveCaseList(constraintsRecord.cuisine_direction as unknown as string[]);
	if (fromConstraints.length) return fromConstraints;
	const promptText = stringValue(input.prompt) || stringValue(constraintsRecord.prompt);
	if (!promptText) return [];
	const cuisines = ["japanese", "mexican", "italian", "french", "thai", "vietnamese", "korean", "chinese", "indian", "mediterranean", "greek", "spanish", "moroccan", "lebanese", "ethiopian", "peruvian", "american"];
	const lower = promptText.toLowerCase();
	const found = cuisines.filter(c => lower.includes(c));
	return found.map(c => c.charAt(0).toUpperCase() + c.slice(1));
}

function preserveCaseList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return unique(value
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(Boolean));
	}
	if (typeof value === "string") {
		return unique(value.split(",").map(s => s.trim()).filter(Boolean));
	}
	return [];
}

interface ResolvedSlotSpec extends MiseMealSlotSpec {
	people: number;
	cuisine: string[];
	locked: boolean;
	notes: string[];
}

function resolveSlotSpecs(
	days: string[],
	input: MisePlannerContext,
	defaultPeople: number,
	defaultCuisine: string[],
): ResolvedSlotSpec[] {
	const explicit = (input.meal_slots || []).filter(s => s && s.date && s.slot);
	const overrides = new Map<string, MiseMealSlotSpec>();
	for (const override of input.meal_overrides || []) {
		if (!override?.date || !override?.slot) continue;
		overrides.set(slotKey(override.date, override.slot), override);
	}

	const resolved: ResolvedSlotSpec[] = [];
	const seen = new Set<string>();

	if (explicit.length) {
		for (const spec of explicit) {
			const key = slotKey(spec.date, spec.slot);
			if (seen.has(key)) continue;
			seen.add(key);
			const merged = applyOverride(spec, overrides.get(key));
			resolved.push(buildResolvedSlot(merged, defaultPeople, defaultCuisine));
		}
		return resolved;
	}

	const defaults = {
		breakfast: input.default_meals?.breakfast ?? input.preferences?.breakfasts ?? true,
		lunch: input.default_meals?.lunch ?? input.preferences?.lunches ?? true,
		dinner: input.default_meals?.dinner ?? input.preferences?.dinners ?? true,
		snack: input.default_meals?.snack ?? input.preferences?.snack_boxes ?? true,
	};

	days.forEach((date, dayIndex) => {
		if (defaults.breakfast && dayIndex < days.length) addAuto(resolved, seen, overrides, date, "breakfast", defaultPeople, defaultCuisine);
		if (defaults.lunch) addAuto(resolved, seen, overrides, date, "lunch", defaultPeople, defaultCuisine);
		if (defaults.dinner) addAuto(resolved, seen, overrides, date, "dinner", defaultPeople, defaultCuisine);
		if (defaults.snack && dayIndex % 2 === 0) addAuto(resolved, seen, overrides, date, "snack", defaultPeople, defaultCuisine);
	});

	for (const [, override] of overrides) {
		const key = slotKey(override.date, override.slot);
		if (seen.has(key)) continue;
		if (!days.includes(override.date)) continue;
		seen.add(key);
		resolved.push(buildResolvedSlot(override, defaultPeople, defaultCuisine));
	}

	return resolved;
}

function addAuto(
	resolved: ResolvedSlotSpec[],
	seen: Set<string>,
	overrides: Map<string, MiseMealSlotSpec>,
	date: string,
	slot: MiseMealSlot,
	defaultPeople: number,
	defaultCuisine: string[],
): void {
	const key = slotKey(date, slot);
	if (seen.has(key)) return;
	seen.add(key);
	const baseSpec: MiseMealSlotSpec = { date, slot, source: "auto" };
	const override = overrides.get(key);
	const merged = applyOverride(baseSpec, override);
	resolved.push(buildResolvedSlot(merged, defaultPeople, defaultCuisine));
}

function applyOverride(spec: MiseMealSlotSpec, override?: MiseMealSlotSpec): MiseMealSlotSpec {
	if (!override) return spec;
	return {
		...spec,
		...override,
		date: spec.date,
		slot: spec.slot,
		notes: override.notes ?? spec.notes,
	};
}

function buildResolvedSlot(spec: MiseMealSlotSpec, defaultPeople: number, _defaultCuisine: string[]): ResolvedSlotSpec {
	const people = positiveInt(spec.people, defaultPeople);
	// Per-slot cuisine is ONLY what was explicitly set on this slot (via meal_overrides
	// or explicit meal_slots). Window-level cuisine_direction is a hint the LLM
	// composer applies sparingly across the window — not a label stamped on every slot.
	const cuisine = preserveCaseList(spec.cuisine);
	const notes = Array.isArray(spec.notes) ? spec.notes : (typeof spec.notes === "string" && spec.notes ? [spec.notes] : []);
	return {
		...spec,
		people,
		cuisine,
		locked: !!spec.locked,
		notes,
	};
}

function slotKey(date: string, slot: MiseMealSlot): string {
	return `${date}::${slot}`;
}

export function renderMiseWeeklyPlan(plan: MiseWeeklyPlanDraft): string {
	const lines: string[] = [
		`# ${plan.title}`,
		`${plan.start_date} to ${plan.end_date} for ${plan.people}`,
		"",
		"## Meals",
	];
	for (const day of plan.meals_by_day) {
		lines.push(`- ${day.date}: ${day.meals.map(meal => `${meal.slot}: ${meal.title}`).join("; ")}`);
	}
	lines.push("", "## Component Batches");
	for (const batch of plan.component_batches) {
		lines.push(`- ${batch.label}: ${batch.active_time_min} min active, ${batch.storage || "store safely"}`);
	}
	lines.push("", "## Prep Tasks");
	for (const task of plan.prep_tasks) {
		lines.push(`- ${task.scheduled_date} #${task.session_order}: ${task.title}`);
	}
	lines.push("", "## Shopping Draft");
	for (const section of plan.shopping_list) {
		lines.push(`- ${section.category}: ${section.items.map(item => item.name).join(", ")}`);
	}
	return lines.join("\n");
}

export async function saveMiseWeeklyPlan(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft): Promise<SaveMiseWeeklyPlanResult> {
	await env.DB.prepare(`
		INSERT OR REPLACE INTO mise_week_plans
		(id, household_id, title, start_date, end_date, timezone, people,
		 constraints_json, selected_ingredients_json, source_recipe_ids_json,
		 status, plan_json, created_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`).bind(
		plan.id,
		plan.household_id,
		plan.title,
		plan.start_date,
		plan.end_date,
		plan.timezone,
		plan.people,
		JSON.stringify(plan.constraints),
		JSON.stringify(plan.selected_ingredients),
		JSON.stringify(plan.source_recipe_ids),
		plan.status,
		JSON.stringify(plan),
		"mise_graph_planner",
	).run();

	await env.DB.prepare("DELETE FROM mise_plan_components WHERE plan_id = ?").bind(plan.id).run();
	await env.DB.prepare("DELETE FROM mise_plan_tasks WHERE plan_id = ?").bind(plan.id).run();

	for (const component of plan.component_batches) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_plan_components
			(id, plan_id, state_id, label, quantity, unit, storage, container,
			 quality_window_hours, planned_uses_json, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			scopedId(plan.id, component.id),
			plan.id,
			component.state_id,
			component.label,
			component.quantity,
			component.unit,
			component.storage,
			component.container,
			component.quality_window_hours,
			JSON.stringify(component.planned_uses),
			JSON.stringify({
				...component.meta,
				station_tags: component.station_tags,
				equipment: component.equipment,
				active_time_min: component.active_time_min,
				idle_time_min: component.idle_time_min,
				input_names: component.input_names,
			}),
		).run();
	}

	for (const task of plan.prep_tasks) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_plan_tasks
			(id, plan_id, scheduled_date, session_order, task_type, title,
			 station_tags_json, equipment_json, depends_on_json, state_inputs_json,
			 state_outputs_json, active_time_min, idle_time_min, instructions_json,
			 status, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			scopedId(plan.id, task.id),
			plan.id,
			task.scheduled_date,
			task.session_order,
			task.task_type,
			task.title,
			JSON.stringify(task.station_tags),
			JSON.stringify(task.equipment),
			JSON.stringify(task.depends_on),
			JSON.stringify(task.state_inputs),
			JSON.stringify(task.state_outputs),
			task.active_time_min,
			task.idle_time_min,
			JSON.stringify(task.instructions),
			task.status,
			JSON.stringify(task.meta),
		).run();
	}

	// Persist recipe lineage for each meal that has it (LLM composer output).
	await env.DB.prepare("DELETE FROM mise_recipe_lineage WHERE plan_id = ?").bind(plan.id).run();
	const allMeals = [...plan.meals_by_day.flatMap(day => day.meals), ...plan.breakfasts];
	for (const meal of allMeals) {
		const lineage = (meal as MisePlanMeal).lineage;
		if (!Array.isArray(lineage) || lineage.length === 0) continue;
		for (let i = 0; i < lineage.length; i++) {
			const ref = lineage[i];
			await env.DB.prepare(`
				INSERT OR REPLACE INTO mise_recipe_lineage
				(id, plan_id, meal_id, source_kind, source_id, source_title, influence, confidence, meta_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				`${plan.id}::${meal.id}::${i}`,
				plan.id,
				meal.id,
				ref.source_kind,
				ref.source_id || null,
				ref.source_title || null,
				ref.influence,
				ref.confidence ?? 0.7,
				"{}",
			).run();
		}
	}

	return {
		plan_id: plan.id,
		components_saved: plan.component_batches.length,
		tasks_saved: plan.prep_tasks.length,
	};
}

function collectCandidates(input: MiseResolvedGraphInput | undefined): PlannerCandidates {
	const nodes = input?.graph?.nodes || [];
	return {
		states: uniqueRecords([
			...(input?.states || []),
			...(input?.mise_graph?.states || []),
			...nodes.filter(node => stringValue(node.type) === "mise_state").map(node => recordValue(node.data)),
		]),
		edges: uniqueRecords([
			...(input?.edges || []),
			...(input?.mise_graph?.edges || []),
			...(input?.mise_graph?.inferred_templates || []).flatMap(template => {
				const edges = arrayValue(template.edges);
				return edges.map(edge => ({ ...recordValue(edge), from_template_id: stringValue(template.id), from_display_name: stringValue(template.display_name) }));
			}),
		]),
		dishes: uniqueRecords([
			...(input?.dishes || []),
			...(input?.spence_graph?.dish_candidates || []),
			...nodes.filter(node => stringValue(node.type) === "canonical_dish").map(node => recordValue(node.data)),
		]),
		components: uniqueRecords([
			...(input?.components || []),
			...(input?.spence_graph?.component_candidates || []),
			...nodes.filter(node => stringValue(node.type) === "canonical_component").map(node => recordValue(node.data)),
		]),
		produce: uniqueRecords([...(input?.produce || []), ...(input?.spence_graph?.produce_matches || [])]),
		techniques: uniqueRecords([...(input?.techniques || []), ...(input?.spence_graph?.technique_matches || [])]),
		affinities: uniqueRecords([...(input?.affinities || []), ...(input?.spence_graph?.affinities || [])]),
	};
}

function buildComponentBatches(
	candidates: PlannerCandidates,
	selectedIngredients: string[],
	people: number,
	maxBatches: number,
	equipment: Set<string>,
	useUp: Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }> = [],
): MisePlanComponentBatch[] {
	const scored: Array<{ score: number; batch: MisePlanComponentBatch }> = [];
	for (const component of candidates.components) {
		const label = titleCase(stringValue(component.canonical_name) || stringValue(component.label) || "weekly component");
		const inputs = normalizeList([
			...arrayValue(component.core_ingredients).map(String),
			...arrayValue(component.common_ingredients).map(String),
		]);
		scored.push({
			score: scoreIngredientOverlap(inputs, selectedIngredients) + numberValue(component.recipe_count) / 100 + useUpBonus(label, inputs, useUp),
			batch: makeBatch(label, null, people, inferStorage(label), inferContainer(label), 96, inputs, [], [], { source: "canonical_component", component, use_up_match: useUpMatchKey(label, inputs, useUp) }),
		});
	}
	for (const edge of candidates.edges) {
		const edgeType = stringValue(edge.edge_type);
		if (edgeType && !["component_output", "state_transition", "format_use"].includes(edgeType)) continue;
		const label = titleCase(
			stringValue(edge.to_label)
			|| stringValue(edge.to_display_name)
			|| stringValue(edge.to_state_name)
			|| stringValue(edge.action_label)
			|| "prep component",
		);
		const stationTags = normalizeList(arrayValue(edge.station_tags).map(String).concat(arrayValue(edge.station_tags_json).map(String)));
		const requiredEquipment = normalizeList(arrayValue(edge.equipment).map(String).concat(arrayValue(edge.equipment_json).map(String)));
		const equipmentScore = requiredEquipment.filter(item => equipment.has(normalizeName(item))).length;
		scored.push({
			score: 1 + equipmentScore + numberValue(edge.score) / 20 + (edgeType === "component_output" ? 1 : 0) + useUpBonus(label, [], useUp),
			batch: makeBatch(
				label,
				stringValue(edge.to_state_id) || null,
				people,
				stringValue(edge.storage_effect) || inferStorage(label),
				inferContainer(label),
				numberOrNull(edge.quality_window_hours) || 96,
				[],
				stationTags,
				requiredEquipment,
				{ source: "mise_edge", edge, use_up_match: useUpMatchKey(label, [], useUp) },
				numberOrNull(edge.active_time_min) || undefined,
				numberOrNull(edge.idle_time_min) || undefined,
			),
		});
	}
	for (const ingredient of selectedIngredients) {
		scored.push({
			score: 0.5 + useUpBonus(`${ingredient} ready prep`, [ingredient], useUp),
			batch: makeBatch(`${titleCase(ingredient)} ready prep`, null, people, inferStorage(ingredient), inferContainer(ingredient), 72, [ingredient], ["prep_sink_active"], ["cutting board"], { source: "fallback", use_up_match: useUpMatchKey(`${ingredient} ready prep`, [ingredient], useUp) }),
		});
	}
	return uniqueBy(scored.sort((a, b) => b.score - a.score || a.batch.label.localeCompare(b.batch.label)).map(item => item.batch), batch => normalizeName(batch.label)).slice(0, maxBatches);
}

function useUpBonus(label: string, inputs: string[], useUp: Array<{ resource: string; pressure?: string }>): number {
	if (!useUp.length) return 0;
	const labelN = normalizeName(label);
	const inputsN = inputs.map(normalizeName);
	let bonus = 0;
	for (const entry of useUp) {
		const target = normalizeName(entry.resource);
		if (!target) continue;
		const matches = labelN.includes(target) || labelN === target || inputsN.some(i => i.includes(target) || i === target);
		if (!matches) continue;
		const pressure = (entry.pressure || "soft").toLowerCase();
		if (pressure === "soft") bonus += 1.5;
		else if (pressure === "opportunistic") bonus += 0.5;
		else if (pressure === "avoid") bonus -= 2.0;
	}
	return bonus;
}

function useUpMatchKey(label: string, inputs: string[], useUp: Array<{ resource: string; pressure?: string }>): string[] {
	if (!useUp.length) return [];
	const labelN = normalizeName(label);
	const inputsN = inputs.map(normalizeName);
	const matched: string[] = [];
	for (const entry of useUp) {
		const target = normalizeName(entry.resource);
		if (!target) continue;
		if (labelN.includes(target) || inputsN.some(i => i.includes(target))) {
			matched.push(entry.resource);
		}
	}
	return matched;
}

function makeBatch(
	label: string,
	stateId: string | null,
	people: number,
	storage: string | null,
	container: string | null,
	qualityWindowHours: number | null,
	inputNames: string[],
	stationTags: string[],
	equipment: string[],
	meta: Record<string, unknown>,
	activeTimeMin = 15,
	idleTimeMin = 0,
): MisePlanComponentBatch {
	const normalizedLabel = titleCase(label);
	return {
		id: slugId("mise_component", normalizedLabel),
		state_id: stateId,
		label: normalizedLabel,
		quantity: Math.max(1, Math.ceil(people / 2)),
		unit: "batch",
		storage,
		container,
		quality_window_hours: qualityWindowHours,
		planned_uses: [],
		station_tags: stationTags.length ? stationTags : inferStationTags(normalizedLabel),
		equipment: equipment.length ? equipment : inferEquipment(normalizedLabel),
		active_time_min: activeTimeMin,
		idle_time_min: idleTimeMin,
		input_names: inputNames,
		meta,
	};
}

function buildMealsFromSlots(
	days: string[],
	slotSpecs: ResolvedSlotSpec[],
	candidates: PlannerCandidates,
	batches: MisePlanComponentBatch[],
	selectedIngredients: string[],
	defaultPeople: number,
	cuisineDirection: string[],
): MisePlanDay[] {
	const dishTitles = candidates.dishes.map(dish => titleCase(stringValue(dish.canonical_title) || stringValue(dish.title))).filter(Boolean);
	const formatPool = unique([...dishTitles, ...DEFAULT_DINNER_FORMATS]);
	const dayIndexMap = new Map(days.map((date, index) => [date, index]));
	const result = new Map<string, MisePlanDay>();
	days.forEach((date, dayIndex) => result.set(date, { date, day_index: dayIndex, meals: [] }));

	const dinnersBySpec = slotSpecs.filter(spec => spec.slot === "dinner" || spec.slot === "lunch")
		.sort((a, b) => a.date.localeCompare(b.date) || (a.slot === "dinner" ? -1 : 1));

	const dinnerTitleByDate = new Map<string, string>();
	for (const spec of dinnersBySpec) {
		const dayIndex = dayIndexMap.get(spec.date) ?? 0;
		const cuisine = spec.cuisine.length ? spec.cuisine : cuisineDirection;
		const explicitTitle = stringValue(spec.title);
		const explicitFormat = stringValue(spec.format);
		const dinnerBatch = batches[dayIndex % Math.max(1, batches.length)];
		const supportBatch = batches[(dayIndex + 2) % Math.max(1, batches.length)];
		const componentIds = unique([dinnerBatch?.id, supportBatch?.id].filter(isString));

		if (spec.slot === "dinner") {
			const baseFormat = explicitFormat || formatPool[dayIndex % Math.max(1, formatPool.length)] || "bowl";
			const title = explicitTitle
				|| (dishTitles.includes(baseFormat)
					? applyCuisineFlavor(baseFormat, cuisine)
					: applyCuisineFlavor(fallbackDinnerTitle(baseFormat, selectedIngredients, dayIndex), cuisine));
			dinnerTitleByDate.set(spec.date, title);
			pushMeal(result, spec.date, dayIndex, {
				id: slugId("meal", spec.date, "dinner", title, spec.people),
				date: spec.date,
				slot: "dinner",
				title,
				format: normalizeName(baseFormat),
				component_ids: componentIds,
				ingredient_names: selectedIngredients.slice(0, 5),
				source: spec.source || (dishTitles.includes(title) ? "canonical_dish" : "planner_fallback"),
				notes: composeNotes(spec.notes, ["Use prepared components before opening new branches."], cuisine, spec.people),
				people: spec.people,
				cuisine,
				locked: !!spec.locked,
			});
		} else if (spec.slot === "lunch") {
			const baseDinnerTitle = dinnerTitleByDate.get(spec.date) || (formatPool[dayIndex % Math.max(1, formatPool.length)] || "bowl");
			const titleHint = explicitTitle || (dayIndex === 0 ? "Reset lunch plate" : `Leftover ${titleCase(baseDinnerTitle)}`);
			const title = titleHint;
			pushMeal(result, spec.date, dayIndex, {
				id: slugId("meal", spec.date, "lunch", title, spec.people),
				date: spec.date,
				slot: "lunch",
				title,
				format: explicitFormat ? normalizeName(explicitFormat) : "leftover lunch",
				component_ids: componentIds,
				ingredient_names: selectedIngredients.slice(0, 4),
				source: spec.source || (dayIndex === 0 ? "reset_plate" : "leftover_lunch"),
				notes: composeNotes(spec.notes, [`Scale dinner for ${spec.people}${spec.people > defaultPeople ? ` (vs household default ${defaultPeople})` : ""} plus lunch.`], cuisine, spec.people),
				people: spec.people,
				cuisine,
				locked: !!spec.locked,
			});
		}
	}

	return Array.from(result.values()).filter(day => day.meals.length > 0);
}

function pushMeal(result: Map<string, MisePlanDay>, date: string, dayIndex: number, meal: MisePlanMeal): void {
	const day = result.get(date) || { date, day_index: dayIndex, meals: [] };
	day.meals.push(meal);
	result.set(date, day);
}

function applyCuisineFlavor(base: string, cuisine: string[]): string {
	if (!cuisine.length) return base;
	const normalized = base.toLowerCase();
	const tag = cuisine[0];
	if (normalized.includes(tag.toLowerCase())) return base;
	return `${tag}-style ${base}`.replace(/^\s+|\s+$/g, "");
}

function composeNotes(specNotes: string[] | undefined, defaultNotes: string[], _cuisine: string[], people: number): string[] {
	// Cuisine direction stamping was creating noise on every meal; cuisine
	// already shows in the meal.cuisine array. Servings only annotated when
	// non-default since 2-person households don't need it on every line.
	const out = [...(specNotes && specNotes.length ? specNotes : defaultNotes)];
	if (people && people !== 2) out.push(`Servings: ${people}.`);
	return unique(out);
}

function buildBreakfastsFromSlots(
	slotSpecs: ResolvedSlotSpec[],
	candidates: PlannerCandidates,
	batches: MisePlanComponentBatch[],
	selectedIngredients: string[],
	defaultPeople: number,
): MisePlanMeal[] {
	const produceNames = breakfastProduceNames(candidates, selectedIngredients);
	const breakfastSpecs = slotSpecs.filter(spec => spec.slot === "breakfast")
		.sort((a, b) => a.date.localeCompare(b.date));
	return breakfastSpecs.map((spec, index) => {
		const explicitTitle = stringValue(spec.title);
		const baseTitle = explicitTitle
			|| (produceNames[index % Math.max(1, produceNames.length)]
				? `${DEFAULT_BREAKFASTS[index % DEFAULT_BREAKFASTS.length]} with ${produceNames[index % produceNames.length]}`
				: DEFAULT_BREAKFASTS[index % DEFAULT_BREAKFASTS.length] || "simple breakfast");
		return {
			id: slugId("meal", spec.date, "breakfast", baseTitle),
			date: spec.date,
			slot: "breakfast",
			title: titleCase(baseTitle),
			format: stringValue(spec.format) ? normalizeName(spec.format!) : "breakfast",
			component_ids: batches.filter(batch => /yogurt|fruit|oat|egg|jam|sauce/i.test(batch.label)).slice(0, 2).map(batch => batch.id),
			ingredient_names: selectedIngredients.slice(0, 3),
			source: spec.source || "planner_fallback",
			notes: composeNotes(spec.notes, ["Keep low-prep and repeatable."], spec.cuisine, spec.people),
			people: spec.people,
			cuisine: spec.cuisine,
			locked: spec.locked,
		};
	});
}

function buildSnackBoxesFromSlots(
	slotSpecs: ResolvedSlotSpec[],
	candidates: PlannerCandidates,
	batches: MisePlanComponentBatch[],
	selectedIngredients: string[],
	defaultPeople: number,
): MiseSnackBox[] {
	const produceNames = snackProduceNames(candidates, selectedIngredients);
	const snackSpecs = slotSpecs.filter(spec => spec.slot === "snack")
		.sort((a, b) => a.date.localeCompare(b.date));
	return snackSpecs.map((spec, index) => {
		const items = unique([
			...DEFAULT_SNACK_ITEMS,
			...(produceNames[index] ? [produceNames[index]] : []),
			...selectedIngredients.filter(name => /cucumber|radish|carrot|celery|apple|berry|grape/.test(name)).slice(0, 2).map(titleCase),
		]).slice(0, 5);
		return {
			id: slugId("snack_box", spec.date, spec.people),
			date: spec.date,
			title: stringValue(spec.title) || `Snack box ${spec.date}`,
			items,
			component_ids: batches.filter(batch => /dip|pickle|stick|hummus|sauce|fruit/i.test(batch.label)).slice(0, 2).map(batch => batch.id),
			people: spec.people,
			locked: spec.locked,
		};
	});
}

function buildComponentBatchesFromFormulas(
	formulas: MiseFormula[],
	meals: ComposedMeal[],
	snackBoxes: ComposerSnackBox[],
	people: number,
	useUp: Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }>,
	equipment: Set<string>,
): MisePlanComponentBatch[] {
	const usedFormulaIds = new Set<string>();
	for (const meal of meals) for (const id of meal.formula_ids) usedFormulaIds.add(id);
	for (const snack of snackBoxes) for (const id of snack.formula_ids) usedFormulaIds.add(id);

	const formulasById = new Map(formulas.map(formula => [formula.id, formula]));
	const batches: MisePlanComponentBatch[] = [];
	for (const id of usedFormulaIds) {
		const formula = formulasById.get(id);
		if (!formula) continue;
		batches.push(componentBatchFromFormula(formula, people, useUp, equipment));
	}
	return batches;
}

function componentBatchFromFormula(formula: MiseFormula, people: number, useUp: Array<{ resource: string; pressure?: "soft" | "opportunistic" | "avoid" }>, equipment: Set<string>): MisePlanComponentBatch {
	const canonical = formula.output_canonical_name || formula.id.replace(/^mise_formula_/, "").replace(/_/g, " ");
	const componentId = `mise_component:${normalizeName(canonical).replace(/\s+/g, "_")}`;
	const inputNames = formula.inputs.map(input => input.canonical_name);
	const stationTags = inferStationTags(formula.output_label);
	const mergedEquipment = unique([...formula.equipment, ...inferEquipment(formula.output_label)])
		.filter(item => item)
		.sort((a, b) => (equipment.has(normalizeName(a)) ? -1 : 0) - (equipment.has(normalizeName(b)) ? -1 : 0));
	const useUpTag = useUpMatchKey(formula.output_label, inputNames, useUp);
	return {
		id: componentId,
		state_id: formula.output_state_id,
		label: formula.output_label,
		quantity: formula.batch_qty,
		unit: formula.batch_unit,
		storage: "refrigerator",
		container: null,
		quality_window_hours: formula.shelf_life_hours_fridge ?? formula.shelf_life_hours_pantry ?? 96,
		planned_uses: [],
		station_tags: stationTags,
		equipment: mergedEquipment,
		active_time_min: formula.active_time_min ?? 15,
		idle_time_min: formula.idle_time_min ?? 0,
		input_names: inputNames,
		meta: {
			source: "llm_composer",
			formula_id: formula.id,
			formula,
			use_up_match: useUpTag,
		},
	};
}

interface ComposerBuildResult {
	mealsByDay: MisePlanDay[];
	breakfasts: MisePlanMeal[];
}

function buildMealsFromComposer(
	composedMeals: ComposedMeal[],
	slotSpecs: ResolvedSlotSpec[],
	batches: MisePlanComponentBatch[],
	defaultPeople: number,
	defaultCuisine: string[],
): ComposerBuildResult {
	const dayMap = new Map<string, MisePlanDay>();
	const breakfasts: MisePlanMeal[] = [];
	const slotByKey = new Map(slotSpecs.map(spec => [`${spec.date}::${spec.slot}`, spec]));
	const formulaIdToComponentId = new Map<string, string>();
	for (const batch of batches) {
		const formulaId = ((batch.meta as Record<string, unknown> | undefined)?.formula_id) as string | undefined;
		if (formulaId) formulaIdToComponentId.set(formulaId, batch.id);
	}

	for (const composed of composedMeals) {
		if (!composed.date || !composed.slot) continue;
		if (composed.slot === "snack") continue;
		const slotSpec = slotByKey.get(`${composed.date}::${composed.slot}`);
		const componentIds = unique(composed.formula_ids
			.map(id => formulaIdToComponentId.get(id))
			.filter((id): id is string => !!id));
		const cuisine = composed.cuisine.length ? composed.cuisine : (slotSpec?.cuisine || defaultCuisine);
		const people = slotSpec?.people || composed.people || defaultPeople;
		const meal: MisePlanMeal = {
			id: slugId("meal", composed.date, composed.slot, composed.title || composed.format),
			date: composed.date,
			slot: composed.slot,
			title: titleCase(composed.title || `${composed.format || composed.slot} meal`),
			format: normalizeName(composed.format || composed.slot),
			component_ids: componentIds,
			ingredient_names: unique([
				...composed.formula_ids.map(id => id.replace(/^mise_formula_/, "")),
				...composed.raw_ingredients.map(ing => ing.name),
			]).slice(0, 8),
			source: "llm_composer",
			notes: composeNotes(slotSpec?.notes, composed.notes.length ? composed.notes : (composed.method_summary ? [composed.method_summary] : []), cuisine, people),
			people,
			cuisine,
			locked: !!slotSpec?.locked,
			raw_ingredients: composed.raw_ingredients,
			method_summary: composed.method_summary || null,
			lineage: composed.lineage,
			active_time_min: (composed as ComposedMeal & { active_time_min?: number }).active_time_min,
			leftovers_to: composed.leftovers_to,
			components: (composed as ComposedMeal & { components?: import("./meal-component").MealComponent[] }).components,
		};

		if (composed.slot === "breakfast") {
			breakfasts.push(meal);
		} else {
			let day = dayMap.get(composed.date);
			if (!day) {
				const dayIndex = dayMap.size;
				day = { date: composed.date, day_index: dayIndex, meals: [] };
				dayMap.set(composed.date, day);
			}
			day.meals.push(meal);
		}
	}

	const mealsByDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
	mealsByDay.forEach((day, index) => { day.day_index = index; });
	breakfasts.sort((a, b) => a.date.localeCompare(b.date));
	return { mealsByDay, breakfasts };
}

function backfillPlanMealCuisines(
	mealsByDay: MisePlanDay[],
	breakfasts: MisePlanMeal[],
	cuisineDirection: string[],
): { cuisine_filled: number } {
	const meals = [...mealsByDay.flatMap(day => day.meals), ...breakfasts];
	const sourceCuisineByTarget = new Map<string, string[]>();
	for (const source of meals) {
		const cuisines = cleanCuisineLabels(source.cuisine);
		if (cuisines.length === 0) continue;
		for (const claim of source.leftovers_to || []) {
			const parsed = parseLeftoverClaim(claim);
			if (parsed) sourceCuisineByTarget.set(slotKey(parsed.date, parsed.slot), cuisines);
		}
	}

	let cuisineFilled = 0;
	for (const meal of meals) {
		if (cleanCuisineLabels(meal.cuisine).length > 0) continue;
		const inherited = sourceCuisineByTarget.get(slotKey(meal.date, meal.slot));
		const inferred = inherited
			|| inferPlanCuisineFromMeal(meal)
			|| defaultPlanCuisineForMeal(meal, cuisineDirection);
		if (inferred.length === 0) continue;
		meal.cuisine = inferred;
		cuisineFilled++;
	}
	return { cuisine_filled: cuisineFilled };
}

function inferPlanCuisineFromMeal(meal: MisePlanMeal): string[] | null {
	const text = [
		meal.title,
		meal.format,
		meal.method_summary || "",
		...(meal.ingredient_names || []),
		...(meal.raw_ingredients || []).map(r => r.name || ""),
		...(meal.notes || []),
	].join(" ").toLowerCase();
	const rules: Array<[RegExp, string]> = [
		[/\b(kimchi|gochujang|bibimbap|bulgogi|japchae|doenjang)\b/, "Korean"],
		[/\b(miso|udon|ramen|soba|donburi|teriyaki|nori|ponzu|matcha|furikake)\b/, "Japanese"],
		[/\b(mapo|scallion pancake|lo mein|dan dan|sichuan|sesame noodle)\b/, "Chinese"],
		[/\b(thai|lemongrass|kaffir|green curry|red curry|panang|massaman)\b/, "Thai"],
		[/\b(curry|dal|dahl|chana|masala|tikka|paneer|raita|naan|korma|vindaloo)\b/, "Indian"],
		[/\b(taco|tacos|tortilla|quesadilla|enchilada|tostada|salsa|elote|esquites|pico de gallo)\b/, "Mexican"],
		[/\b(pasta|risotto|pizza|gnocchi|polenta|focaccia|ricotta|parmesan|cacio e pepe)\b/, "Italian"],
		[/\b(falafel|hummus|tahini|feta|sumac|za'?atar|labneh|pita|mezze|preserved lemon|dukkah)\b/, "Mediterranean"],
		[/\b(harissa|chermoula|tagine|couscous)\b/, "North African"],
		[/\b(galette|quiche|nicoise|ratatouille|baguette)\b/, "French"],
		[/\b(chia|oat|oats|granola|yogurt|avocado toast|scramble|toast|almond butter)\b/, "California"],
	];
	for (const [pattern, cuisine] of rules) if (pattern.test(text)) return [cuisine];
	return null;
}

function defaultPlanCuisineForMeal(meal: MisePlanMeal, cuisineDirection: string[]): string[] {
	const direction = cleanCuisineLabels(cuisineDirection);
	if (meal.slot === "breakfast") return ["California"];
	if (direction.length > 0 && meal.slot === "dinner") return [direction[0]];
	return ["American"];
}

function cleanCuisineLabels(cuisines: string[] | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const cuisine of cuisines || []) {
		const value = (cuisine || "").trim();
		const key = value.toLowerCase();
		if (!value || seen.has(key) || /^(unknown|tbd|none|n\/a|na)$/i.test(value)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function parseLeftoverClaim(claim: string): { date: string; slot: MiseMealSlot } | null {
	const match = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
	if (!match) return null;
	return { date: match[1], slot: match[2].toLowerCase() as MiseMealSlot };
}

function buildSnackBoxesFromComposer(
	composedSnacks: ComposerSnackBox[],
	slotSpecs: ResolvedSlotSpec[],
	batches: MisePlanComponentBatch[],
	defaultPeople: number,
): MiseSnackBox[] {
	const formulaIdToComponentId = new Map<string, string>();
	for (const batch of batches) {
		const formulaId = ((batch.meta as Record<string, unknown> | undefined)?.formula_id) as string | undefined;
		if (formulaId) formulaIdToComponentId.set(formulaId, batch.id);
	}
	const snackSlots = new Map(slotSpecs.filter(s => s.slot === "snack").map(s => [s.date, s]));
	return composedSnacks
		.filter(snack => snack.date)
		.map(snack => {
			const slotSpec = snackSlots.get(snack.date);
			const componentIds = unique(snack.formula_ids
				.map(id => formulaIdToComponentId.get(id))
				.filter((id): id is string => !!id));
			return {
				id: slugId("snack_box", snack.date, snack.people),
				date: snack.date,
				title: snack.title || `Snack box ${snack.date}`,
				items: snack.items,
				component_ids: componentIds,
				people: slotSpec?.people || snack.people || defaultPeople,
				locked: !!slotSpec?.locked,
				raw_ingredients: snack.raw_ingredients,
			};
		})
		.sort((a, b) => a.date.localeCompare(b.date));
}

function collectComposerRawIngredients(meals: ComposedMeal[], snacks: ComposerSnackBox[]): ComposerRawIngredient[] {
	const out: ComposerRawIngredient[] = [];
	for (const meal of meals) for (const ing of meal.raw_ingredients) out.push(ing);
	for (const snack of snacks) for (const ing of snack.raw_ingredients) out.push(ing);
	return out;
}

function attachPlannedUses(
	batches: MisePlanComponentBatch[],
	days: MisePlanDay[],
	breakfasts: MisePlanMeal[],
	snackBoxes: MiseSnackBox[],
): void {
	const meals = [...days.flatMap(day => day.meals), ...breakfasts];
	for (const meal of meals) {
		for (const componentId of meal.component_ids) {
			const batch = batches.find(candidate => candidate.id === componentId);
			if (batch) batch.planned_uses.push({ date: meal.date, slot: meal.slot, meal_id: meal.id, title: meal.title });
		}
	}
	for (const box of snackBoxes) {
		for (const componentId of box.component_ids) {
			const batch = batches.find(candidate => candidate.id === componentId);
			if (batch) batch.planned_uses.push({ date: box.date, slot: "snack", meal_id: box.id, title: box.title });
		}
	}
}

function buildPrepTasks(
	startDate: string,
	batches: MisePlanComponentBatch[],
	candidates: PlannerCandidates,
	schedule: MisePlannerContext["schedule"],
	maxActivePrepMin: number | null | undefined,
): MisePlanTask[] {
	const prepDates = choosePrepDates(startDate, schedule);
	const maxMin = clamp(positiveInt(maxActivePrepMin, 75), 20, 180);
	const tasks: MisePlanTask[] = [];
	// Two-tier scheduling. If a batch has `meta.desired_prep_date`, honor it.
	// Otherwise, fall back to the legacy session-clustering on prepDates.
	let currentDateIndex = 0;
	let sessionActive = 0;
	const sessionLoadByDate = new Map<string, number>();
	for (const batch of sortBatchesForPrep(batches)) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const desired = typeof meta?.desired_prep_date === "string" ? (meta!.desired_prep_date as string) : null;
		let prepDate: string;
		if (desired) {
			prepDate = desired < startDate ? startDate : desired;
			// Honor the max-session-min budget by spilling forward one day
			// if today's session is already full.
			const load = sessionLoadByDate.get(prepDate) || 0;
			if (load > 0 && load + batch.active_time_min > maxMin) {
				const nextDate = addDays(prepDate, 1);
				prepDate = nextDate;
			}
			sessionLoadByDate.set(prepDate, (sessionLoadByDate.get(prepDate) || 0) + batch.active_time_min);
		} else {
			if (sessionActive > 0 && sessionActive + batch.active_time_min > maxMin) {
				currentDateIndex = Math.min(currentDateIndex + 1, prepDates.length - 1);
				sessionActive = 0;
			}
			sessionActive += batch.active_time_min;
			prepDate = prepDates[currentDateIndex] || startDate;
			sessionLoadByDate.set(prepDate, (sessionLoadByDate.get(prepDate) || 0) + batch.active_time_min);
		}
		tasks.push({
			id: slugId("mise_task", prepDate, tasks.filter(task => task.scheduled_date === prepDate).length + 1, batch.id),
			scheduled_date: prepDate,
			session_order: tasks.filter(task => task.scheduled_date === prepDate).length + 1,
			task_type: "component_batch",
			title: `Make ${batch.label}`,
			station_tags: batch.station_tags,
			equipment: batch.equipment,
			depends_on: [],
			state_inputs: batch.input_names,
			state_outputs: [batch.id],
			active_time_min: batch.active_time_min,
			idle_time_min: batch.idle_time_min,
			instructions: realPrepInstructions(batch),
			status: "planned",
			meta: { component_id: batch.id },
		});
	}
	const techniqueNames = candidates.techniques.map(item => stringValue(item.technique)).filter(Boolean).slice(0, 4);
	if (techniqueNames.length) {
		const reviewDate = prepDates[Math.min(currentDateIndex, prepDates.length - 1)] || startDate;
		tasks.push({
			id: slugId("mise_task", reviewDate, "technique_review"),
			scheduled_date: reviewDate,
			session_order: tasks.filter(task => task.scheduled_date === reviewDate).length + 1,
			task_type: "check",
			title: "Check active technique branches",
			station_tags: [],
			equipment: [],
			depends_on: [],
			state_inputs: [],
			state_outputs: [],
			active_time_min: 5,
			idle_time_min: 0,
			instructions: [`Confirm the week is using: ${techniqueNames.join(", ")}.`],
			status: "planned",
			meta: { source: "technique_matches" },
		});
	}
	return tasks;
}

function buildShoppingList(
	candidates: PlannerCandidates,
	selectedIngredients: string[],
	pantry: Set<string>,
	batches: MisePlanComponentBatch[],
	days: MisePlanDay[],
	breakfasts: MisePlanMeal[],
	snackBoxes: MiseSnackBox[],
	llmRawIngredients: ComposerRawIngredient[] = [],
): MiseShoppingListSection[] {
	const sources = new Map<string, Set<string>>();
	const grams = new Map<string, number>();
	const counts = new Map<string, { qty: number | null; unit: string | null }>();
	const add = (name: string, source: string, gramsValue?: number | null, qtyValue?: number | null, unit?: string | null): void => {
		const normalized = normalizeName(name);
		if (!normalized || pantry.has(normalized)) return;
		if (!sources.has(normalized)) sources.set(normalized, new Set());
		sources.get(normalized)?.add(source);
		if (gramsValue && Number.isFinite(gramsValue)) {
			grams.set(normalized, (grams.get(normalized) || 0) + gramsValue);
		}
		if (qtyValue && Number.isFinite(qtyValue) && unit) {
			const existing = counts.get(normalized);
			if (!existing || existing.unit === unit) {
				counts.set(normalized, { qty: (existing?.qty || 0) + qtyValue, unit });
			}
		}
	};
	selectedIngredients.forEach(name => add(name, "selected"));
	candidates.affinities.slice(0, 8).forEach(item => add(stringValue(item.name), "affinity"));
	candidates.produce.slice(0, 8).forEach(item => add(stringValue(item.name) || stringValue(item.normalized_name), "produce"));
	for (const batch of batches) batch.input_names.forEach(name => add(name, batch.label));
	for (const meal of [...days.flatMap(day => day.meals), ...breakfasts]) meal.ingredient_names.forEach(name => add(name, meal.title));
	for (const box of snackBoxes) box.items.forEach(name => add(name, box.title));
	for (const ing of llmRawIngredients) add(ing.name, "llm_composer", ing.grams, ing.qty, ing.unit);

	const items = Array.from(sources.entries()).map(([name, source]) => {
		const totalGrams = grams.get(name);
		const totalQty = counts.get(name);
		return {
			name: titleCase(name),
			quantity: totalQty?.qty ?? null,
			unit: totalQty?.unit ?? null,
			source: Array.from(source).sort(),
			...(totalGrams ? { grams_total: Math.ceil(totalGrams * 1.1) } : {}),
		} as MiseShoppingListItem;
	});
	const sections = new Map<string, MiseShoppingListItem[]>();
	for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
		const category = shoppingCategory(item.name);
		if (!sections.has(category)) sections.set(category, []);
		sections.get(category)?.push(item);
	}
	return Array.from(sections.entries()).map(([category, sectionItems]) => ({ category, items: sectionItems }));
}

function buildStorageLabels(startDate: string, batches: MisePlanComponentBatch[]): MiseStorageLabel[] {
	return batches.map(batch => ({
		id: slugId("mise_label", batch.id),
		component_id: batch.id,
		label: batch.label,
		storage: batch.storage || "refrigerate or store by food-safety needs",
		use_by_date: batch.quality_window_hours ? addDays(startDate, Math.max(0, Math.floor(batch.quality_window_hours / 24))) : null,
		notes: [
			batch.container ? `Container: ${batch.container}` : "Use a sealed labeled container.",
			batch.planned_uses.length ? `Planned uses: ${batch.planned_uses.map(use => use.date).join(", ")}` : "No fixed use yet.",
		],
	}));
}

function fallbackDinnerTitle(format: string, selectedIngredients: string[], dayIndex: number): string {
	const ingredients = new Set(selectedIngredients.map(normalizeName));
	const has = (pattern: RegExp): boolean => selectedIngredients.some(item => pattern.test(normalizeName(item)));
	const chickpea = has(/chickpea|garbanzo/) ? "chickpea" : selectedIngredients[0] || "vegetable";
	const sauce = has(/tahini/) ? "tahini" : "herb";
	const spring = selectedIngredients.filter(item => /asparagus|radish|pea|fava|artichoke|strawberr|greens/.test(normalizeName(item)));
	const crunch = ingredients.has("radish") ? "pickled radish" : "crunchy vegetables";
	const bread = has(/flour|dough|pita|naan|flatbread|pizza/) ? "Ooni flatbread" : "warm flatbread";
	const formats: Record<string, string> = {
		bowl: `Herbed ${chickpea} bowl with ${sauce} sauce`,
		salad: `${titleCase(spring.slice(0, 2).join(" and ") || "spring vegetable")} salad with crispy ${chickpea}`,
		flatbread: `${bread} with hummus and ${crunch}`,
		skillet: `Spring vegetable skillet with ${chickpea}`,
		soup: `Lemony ${chickpea} soup with herbs`,
		tacos: `Crispy ${chickpea} tacos with ${crunch}`,
		"grain bowl": `${titleCase(sauce)} grain bowl with roasted vegetables`,
	};
	return formats[normalizeName(format)] || `${titleCase(format || "dinner")} with ${titleCase(chickpea)}`;
}

function breakfastProduceNames(candidates: PlannerCandidates, selectedIngredients: string[]): string[] {
	const names = unique([
		...selectedIngredients,
		...candidates.produce.map(item => stringValue(item.name) || stringValue(item.normalized_name)),
	].map(normalizeName).filter(name => /strawberr|berry|blueberry|raspberry|blackberry|apple|pear|peach|plum|apricot|banana|citrus|orange|grapefruit|kiwi|mango|fig|date/.test(name)));
	return names.length ? names.map(titleCase) : ["Seasonal Fruit"];
}

function snackProduceNames(candidates: PlannerCandidates, selectedIngredients: string[]): string[] {
	const names = unique([
		...selectedIngredients,
		...candidates.produce.map(item => stringValue(item.name) || stringValue(item.normalized_name)),
	].map(normalizeName).filter(name => /radish|cucumber|carrot|celery|snap pea|pea shoot|pepper|tomato|apple|strawberr|berry|grape/.test(name)));
	return names.length ? names.map(titleCase) : ["Crunchy Vegetables"];
}

function choosePrepDates(startDate: string, schedule: MisePlannerContext["schedule"]): string[] {
	const scheduled = (schedule || [])
		.filter(item => requireIsoDate(item.date, "schedule.date") >= startDate)
		.filter(item => positiveInt(item.available_min, 0) >= 30)
		.sort((a, b) => stringValue(a.date).localeCompare(stringValue(b.date)))
		.map(item => item.date);
	return scheduled.length ? unique(scheduled) : Array.from({ length: 7 }, (_, index) => addDays(startDate, index));
}

function sortBatchesForPrep(batches: MisePlanComponentBatch[]): MisePlanComponentBatch[] {
	return [...batches].sort((a, b) => prepPriority(a) - prepPriority(b) || a.label.localeCompare(b.label));
}

function prepPriority(batch: MisePlanComponentBatch): number {
	const label = normalizeName(batch.label);
	if (/soaked/.test(label)) return 10;
	if (/cooked whole|pressure|simmer/.test(label)) return 20;
	if (/falafel mix/.test(label)) return 30;
	if (/hummus|dip|puree/.test(label)) return 40;
	if (/crispy|roast/.test(label)) return 45;
	if (/sauce|dressing/.test(label)) return 50;
	if (/pickle|salted/.test(label)) return 55;
	if (/dough|ferment/.test(label)) return 60;
	return 70;
}

function inferStorage(label: string): string {
	const normalized = normalizeName(label);
	if (/dry|flour|grain|nut|seed/.test(normalized)) return "pantry";
	if (/frozen|freeze/.test(normalized)) return "freezer";
	return "refrigerated";
}

function inferContainer(label: string): string {
	const normalized = normalizeName(label);
	if (/pickle|jam|sauce|dressing|dip|hummus/.test(normalized)) return "jar";
	if (/dough|ball/.test(normalized)) return "covered deli container";
	if (/snack|stick|washed|greens|herb/.test(normalized)) return "vented deli container";
	return "sealed container";
}

function inferStationTags(label: string): string[] {
	const normalized = normalizeName(label);
	if (/roast|bake|sheet/.test(normalized)) return ["oven_hot"];
	if (/blend|hummus|dip|puree|sauce/.test(normalized)) return ["food_processor_dirty"];
	if (/pickle|stick|slice|chop|washed/.test(normalized)) return ["prep_board_active"];
	if (/dough|ferment/.test(normalized)) return ["dough_fermentation_active"];
	return ["prep_station_active"];
}

function inferEquipment(label: string): string[] {
	const normalized = normalizeName(label);
	if (/roast|bake|sheet/.test(normalized)) return ["sheet pan", "oven"];
	if (/blend|hummus|dip|puree|sauce/.test(normalized)) return ["food processor"];
	if (/pickle/.test(normalized)) return ["jar"];
	if (/dough|ferment/.test(normalized)) return ["mixing bowl", "covered container"];
	return ["cutting board"];
}

function attachFormulaMetadataToBatches(batches: MisePlanComponentBatch[], formulas: MiseFormula[]): void {
	const byLabel = new Map<string, MiseFormula>();
	const byCanonical = new Map<string, MiseFormula>();
	for (const f of formulas) {
		byLabel.set((f.output_label || "").toLowerCase(), f);
		if (f.output_canonical_name) byCanonical.set(f.output_canonical_name.toLowerCase(), f);
	}
	for (const batch of batches) {
		const meta = (batch.meta as Record<string, unknown>) || {};
		if (meta.formula) continue;
		const labelKey = batch.label.toLowerCase();
		const formula = byLabel.get(labelKey)
			|| byCanonical.get(labelKey)
			|| Array.from(byLabel.values()).find(f => labelKey.includes((f.output_label || "").toLowerCase().replace(/^make /, "")));
		if (formula) {
			batch.meta = { ...meta, formula, formula_id: formula.id };
		}
	}
}

function realPrepInstructions(batch: MisePlanComponentBatch): string[] {
	const meta = batch.meta as Record<string, unknown> | undefined;
	const formula = meta?.formula as MiseFormula | undefined;
	if (!formula) {
		return [
			`Set up ${batch.station_tags.join(", ") || "prep station"}.`,
			`Prepare ${batch.label}.`,
			`Pack in ${batch.container || "a labeled container"}; store in ${batch.storage || "fridge"}.`,
		];
	}
	return generatePrepInstructions(formula, {
		storage: batch.storage || "refrigerator",
		container: batch.container,
	});
}

function shoppingCategory(name: string): string {
	const normalized = normalizeName(name);
	if (/apple|berry|citrus|orange|lemon|lime|grape|fruit/.test(normalized)) return "fruit";
	if (/cucumber|radish|carrot|greens|herb|onion|garlic|pepper|tomato|vegetable/.test(normalized)) return "produce";
	if (/yogurt|milk|cheese|egg|butter|cream/.test(normalized)) return "dairy";
	if (/chickpea|lentil|bean|tofu|chicken|beef|fish|pork/.test(normalized)) return "protein";
	if (/rice|oat|flour|bread|pita|pasta|grain/.test(normalized)) return "grains";
	if (/tahini|oil|vinegar|spice|salt|nut|seed/.test(normalized)) return "pantry";
	return "other";
}

function scoreIngredientOverlap(left: string[], right: string[]): number {
	const rightSet = new Set(right.map(normalizeName));
	return left.reduce((score, item) => score + (rightSet.has(normalizeName(item)) ? 2 : 0), 0);
}

function uniqueRecords(records: UnknownRecord[]): UnknownRecord[] {
	return uniqueBy(records.filter(record => Object.keys(record).length > 0), record => stringValue(record.id) || stringValue(record.canonical_name) || JSON.stringify(record));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const results: T[] = [];
	for (const item of items) {
		const itemKey = key(item);
		if (seen.has(itemKey)) continue;
		seen.add(itemKey);
		results.push(item);
	}
	return results;
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return unique(value.map(item => normalizeName(item)).filter(Boolean));
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function recordValue(value: unknown): UnknownRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function arrayValue(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value: unknown, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function requireIsoDate(value: string, field: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`Invalid ${field}: expected YYYY-MM-DD`);
	}
	return value;
}

function addDays(date: string, days: number): string {
	const parsed = new Date(`${date}T00:00:00.000Z`);
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
}

function normalizeName(value: unknown): string {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function titleCase(value: string): string {
	return normalizeName(value).replace(/\b\w/g, char => char.toUpperCase());
}

function scopedId(planId: string, innerId: string): string {
	if (innerId.startsWith(`${planId}::`)) return innerId;
	return `${planId}::${innerId}`;
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

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
