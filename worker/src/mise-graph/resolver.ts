import type { MiseGraphEnv, MiseIngredientState, MiseStateTemplate } from "./types";

type JsonObject = Record<string, unknown>;

export interface MiseResolveInput {
	household_id?: string | null;
	date?: string | null;
	location?: {
		lat?: number | null;
		lon?: number | null;
		state?: string | null;
		region?: string | null;
		timezone?: string | null;
	} | null;
	constraints?: {
		dietary?: string[];
		excluded_ingredients?: string[];
		avoid_ingredients?: string[];
		avoid_equipment?: string[];
		max_active_time_min?: number | null;
		max_lead_time_hours?: number | null;
		prefer_make_ahead?: boolean | null;
	} & JsonObject;
	inventory?: Array<string | InventoryItem>;
	desired?: Array<string | DesiredItem> | DesiredRequest | JsonObject;
	equipment?: string[];
	schedule?: {
		days?: string[];
		sessions?: Array<{ date?: string; available_minutes?: number; station_tags?: string[] }>;
		available_minutes_by_date?: Record<string, number>;
	} & JsonObject;
	ingredients?: Array<string | IngredientInput>;
	limit?: number;
	include_templates?: boolean;
}

interface IngredientInput {
	name?: string;
	canonical_name?: string;
	id?: number;
	quantity?: number;
	unit?: string;
	state?: string;
}

interface InventoryItem {
	name?: string;
	canonical_name?: string;
	ingredient?: string;
	state?: string;
	quantity?: number;
	unit?: string;
	expires_at?: string;
}

interface DesiredItem {
	name?: string;
	title?: string;
	type?: string;
	ingredients?: string[];
}

interface DesiredRequest {
	formats?: string[];
	breakfasts?: string[];
	cuisines?: string[];
	flavors?: string[];
	ingredients?: string[];
	avoid?: string[];
}

interface CanonicalIngredient {
	id: number;
	name: string;
	total_count: number | null;
	category: string | null;
	subcategory: string | null;
	flavor_profile: unknown[];
}

interface MiseStateRow extends MiseIngredientState {
	meta: JsonObject;
}

interface MiseEdgeRow {
	id: string;
	from_state_id: string;
	to_state_id: string;
	edge_type: string;
	action_label: string | null;
	technique: string | null;
	equipment_json: string | null;
	station_tags_json: string | null;
	cuisine_grammars_json: string | null;
	format_tags_json: string | null;
	active_time_min: number | null;
	idle_time_min: number | null;
	lead_time_hours: number | null;
	yield_ratio: number | null;
	storage_effect: string | null;
	quality_window_hours: number | null;
	difficulty: string | null;
	confidence: number | null;
	source: string | null;
	rationale: string | null;
	meta_json: string | null;
	from_canonical_name: string;
	from_state_name: string;
	from_display_name: string;
	to_canonical_name: string;
	to_state_name: string;
	to_display_name: string;
	equipment: string[];
	station_tags: string[];
	cuisine_grammars: string[];
	format_tags: string[];
	meta: JsonObject;
}

interface CandidateEdge {
	id: string;
	source: "persisted" | "inferred";
	from_state_id: string;
	to_state_id: string;
	from_label: string;
	to_label: string;
	canonical_name: string;
	edge_type: string;
	action_label: string;
	technique: string | null;
	equipment: string[];
	station_tags: string[];
	active_time_min: number | null;
	idle_time_min: number | null;
	lead_time_hours: number | null;
	quality_window_hours: number | null;
	confidence: number;
	rationale: string | null;
	score: number;
	score_breakdown: ScoreBreakdown;
}

interface CandidateDish {
	id: string;
	canonical_title: string;
	composition: string | null;
	meals: unknown[];
	methods: unknown[];
	equipment: string[];
	recipe_count: number;
	source_count: number;
	consensus_total_time: number | null;
	core_ingredients: string[];
	expected_ingredients: string[];
	optional_ingredients: string[];
	matched_ingredients: string[];
	missing_core_ingredients: string[];
	score: number;
	score_breakdown: ScoreBreakdown;
}

interface CandidateComponent {
	id: string;
	canonical_name: string;
	family: string | null;
	component_type: string | null;
	recipe_count: number;
	core_ingredients: string[];
	common_ingredients: string[];
	optional_ingredients: string[];
	matched_ingredients: string[];
	missing_core_ingredients: string[];
	score: number;
	score_breakdown: ScoreBreakdown;
}

interface SeasonalCandidate {
	id: string;
	name: string;
	normalized_name: string | null;
	base_ingredient: string | null;
	category: string | null;
	peak_months: number[];
	available_months: number[];
	source: "produce_profiles" | "regional_seasons";
	season: string | null;
	region_name: string | null;
	score: number;
	score_breakdown: ScoreBreakdown;
}

interface AffinityCandidate {
	ingredient_id: number;
	name: string;
	category: string | null;
	subcategory: string | null;
	score: number;
	co_count: number;
	edge_types: string | null;
	contexts: string | null;
	score_breakdown: ScoreBreakdown;
}

interface StationRule {
	id: string;
	station_tag: string;
	station_name: string;
	trigger_kind: string;
	equipment: string[];
	cheap_branches: unknown[];
	default_questions: unknown[];
}

interface TechniqueHint {
	technique: string;
	ingredient_score: number;
	equipment: string[];
	equipment_score: number;
	score: number;
	score_breakdown: ScoreBreakdown;
}

interface PlanContext {
	id: string;
	title: string | null;
	start_date: string;
	end_date: string;
	status: string | null;
	selected_ingredients: string[];
}

interface ScoreBreakdown {
	base: number;
	ingredient_match: number;
	desired_match: number;
	inventory_match: number;
	equipment_fit: number;
	seasonality: number;
	schedule_fit: number;
	constraint_fit: number;
	confidence: number;
	recency_or_popularity: number;
	total: number;
	reasons: string[];
}

export interface MiseResolveResult {
	input: MiseResolveInput;
	context: {
		household_id: string | null;
		date: string;
		month: number;
		season: string;
		location: MiseResolveInput["location"];
		ingredient_names: string[];
		desired_terms: string[];
		inventory_terms: string[];
		equipment: string[];
		constraints: MiseResolveInput["constraints"];
		plan_context: PlanContext[];
		persisted_state_count: number;
		persisted_edge_count: number;
		inferred_template_count: number;
		technique_hint_count: number;
	};
	technique_hints: TechniqueHint[];
	canonical_ingredients: CanonicalIngredient[];
	activated_edges: CandidateEdge[];
	rejected_edges: Array<CandidateEdge & { rejected_reason: string }>;
	candidate_graph: {
		nodes: Array<{ id: string; type: string; label: string; score?: number; data?: unknown }>;
		edges: Array<{ id: string; from: string; to: string; type: string; label?: string; score?: number; data?: unknown }>;
	};
	candidate_components: CandidateComponent[];
	candidate_dishes: CandidateDish[];
	seasonal_candidates: SeasonalCandidate[];
	affinity_candidates: AffinityCandidate[];
	score_breakdown: {
		activated_edges: ScoreBreakdown[];
		rejected_edges: ScoreBreakdown[];
		candidate_components: ScoreBreakdown[];
		candidate_dishes: ScoreBreakdown[];
		seasonal_candidates: ScoreBreakdown[];
		affinity_candidates: ScoreBreakdown[];
		technique_hints: ScoreBreakdown[];
	};
}

interface ResolveContext {
	input: MiseResolveInput;
	date: string;
	month: number;
	season: string;
	ingredientNames: string[];
	desiredTerms: string[];
	inventoryTerms: string[];
	excludedTerms: string[];
	avoidEquipment: string[];
	equipment: string[];
	limit: number;
	includeTemplates: boolean;
	maxActiveTime: number | null;
	maxLeadTime: number | null;
	preferMakeAhead: boolean;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

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

export async function handleResolve(request: Request, env: MiseGraphEnv): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
	if (request.method !== "POST") return json({ error: "Method not allowed. Use POST." }, 405);

	const body = await request.json().catch(() => null) as Partial<MiseResolveInput> | null;
	if (!body || typeof body !== "object") return json({ error: "Expected JSON body." }, 400);

	const result = await resolveMiseGraph(body, env);
	if (!result.context.ingredient_names.length) {
		return json({ error: "Required: ingredients, inventory, or desired ingredients.", result }, 400);
	}

	return json(result);
}

export async function resolveMiseGraph(input: MiseResolveInput, env: MiseGraphEnv): Promise<MiseResolveResult> {
	const context = buildResolveContext(input);
	const canonical = await resolveCanonicalIngredients(context.ingredientNames, env);
	const canonicalIds = canonical.map(row => row.id);
	const canonicalNames = unique([...canonical.map(row => row.name), ...context.ingredientNames].map(normalizeName).filter(Boolean));

	const [
		states,
		persistedEdges,
		stationRules,
		planContext,
		affinities,
		dishes,
		components,
		seasonal,
		techniqueHints,
	] = await Promise.all([
		getMiseStates(canonicalIds, canonicalNames, env),
		getMiseEdges(canonicalIds, canonicalNames, env),
		getStationRules(env),
		getPlanContext(input, env),
		getAffinityCandidates(canonicalIds, context, env),
		getDishCandidates(canonicalNames, context, env),
		getComponentCandidates(canonicalNames, context, env),
		getSeasonalCandidates(canonicalIds, canonicalNames, context, env),
		getTechniqueHints(canonicalNames, context, env),
	]);

	const templates = context.includeTemplates && states.length === 0
		? inferStateTemplates(canonicalNames)
		: [];
	const candidateEdges = [
		...persistedEdges.map(edge => scorePersistedEdge(edge, context, stationRules, techniqueHints)),
		...templates.flatMap(template => scoreTemplateEdges(template, context, stationRules, techniqueHints)),
	].sort(compareScored);

	const activatedEdges: CandidateEdge[] = [];
	const rejectedEdges: Array<CandidateEdge & { rejected_reason: string }> = [];
	for (const edge of candidateEdges) {
		const rejectedReason = edgeRejectionReason(edge, context);
		if (rejectedReason) rejectedEdges.push({ ...edge, rejected_reason: rejectedReason });
		else if (activatedEdges.length < context.limit) activatedEdges.push(edge);
		else rejectedEdges.push({ ...edge, rejected_reason: "below_limit" });
	}

	const candidateGraph = buildCandidateGraph(
		canonical,
		states,
		templates,
		activatedEdges,
		rejectedEdges,
		dishes,
		components,
		seasonal,
		affinities,
		techniqueHints,
		context.limit,
	);

	return {
		input,
		context: {
			household_id: input.household_id ?? null,
			date: context.date,
			month: context.month,
			season: context.season,
			location: input.location ?? null,
			ingredient_names: canonicalNames,
			desired_terms: context.desiredTerms,
			inventory_terms: context.inventoryTerms,
			equipment: context.equipment,
			constraints: input.constraints,
			plan_context: planContext,
			persisted_state_count: states.length,
			persisted_edge_count: persistedEdges.length,
			inferred_template_count: templates.length,
			technique_hint_count: techniqueHints.length,
		},
		technique_hints: techniqueHints,
		canonical_ingredients: canonical,
		activated_edges: activatedEdges,
		rejected_edges: rejectedEdges.slice(0, context.limit),
		candidate_graph: candidateGraph,
		candidate_components: components,
		candidate_dishes: dishes,
		seasonal_candidates: seasonal,
		affinity_candidates: affinities,
		score_breakdown: {
			activated_edges: activatedEdges.map(edge => edge.score_breakdown),
			rejected_edges: rejectedEdges.slice(0, context.limit).map(edge => edge.score_breakdown),
			candidate_components: components.map(component => component.score_breakdown),
			candidate_dishes: dishes.map(dish => dish.score_breakdown),
			seasonal_candidates: seasonal.map(item => item.score_breakdown),
			affinity_candidates: affinities.map(item => item.score_breakdown),
			technique_hints: techniqueHints.map(item => item.score_breakdown),
		},
	};
}

function buildResolveContext(input: MiseResolveInput): ResolveContext {
	const date = parseDate(input.date);
	const month = Number(date.slice(5, 7));
	const constraints = input.constraints ?? {};
	const inventoryTerms = unique((input.inventory ?? []).map(itemName).map(normalizeName).filter(Boolean));
	const desiredTerms = unique(desiredInputNames(input.desired).map(normalizeName).filter(Boolean));
	const ingredientNames = unique([
		...(input.ingredients ?? []).map(itemName),
		...inventoryTerms,
		...desiredTerms,
	].map(normalizeName).filter(Boolean));
	const excludedTerms = unique([
		...(constraints.excluded_ingredients ?? []),
		...(constraints.avoid_ingredients ?? []),
	].map(normalizeName).filter(Boolean));
	const equipment = unique((input.equipment ?? []).map(normalizeName).filter(Boolean));
	const avoidEquipment = unique((constraints.avoid_equipment ?? []).map(normalizeName).filter(Boolean));
	const limit = clampInt(input.limit, 20, 1, 60);

	return {
		input,
		date,
		month,
		season: seasonForMonth(month),
		ingredientNames,
		desiredTerms,
		inventoryTerms,
		excludedTerms,
		avoidEquipment,
		equipment,
		limit,
		includeTemplates: input.include_templates !== false,
		maxActiveTime: finiteNumber(constraints.max_active_time_min),
		maxLeadTime: finiteNumber(constraints.max_lead_time_hours),
		preferMakeAhead: constraints.prefer_make_ahead === true,
	};
}

async function resolveCanonicalIngredients(names: string[], env: MiseGraphEnv): Promise<CanonicalIngredient[]> {
	const seen = new Set<number>();
	const results: CanonicalIngredient[] = [];

	for (const raw of names.slice(0, 24)) {
		const q = normalizeName(raw);
		if (!q) continue;
		const row = await optionalQuery(env, async () => {
			const exact = await env.DB.prepare(`
				SELECT id, name, total_count, category, subcategory, flavor_profile
				FROM canonical_ingredients
				WHERE lower(name) = ?
				ORDER BY total_count DESC
				LIMIT 1
			`).bind(q).first<CanonicalIngredientRow>();
			if (exact) return exact;
			return env.DB.prepare(`
				SELECT id, name, total_count, category, subcategory, flavor_profile
				FROM canonical_ingredients
				WHERE lower(name) LIKE ?
				ORDER BY total_count DESC
				LIMIT 1
			`).bind(`%${q}%`).first<CanonicalIngredientRow>();
		}, null);

		if (row && !seen.has(row.id)) {
			seen.add(row.id);
			results.push({
				id: row.id,
				name: row.name,
				total_count: row.total_count,
				category: row.category,
				subcategory: row.subcategory,
				flavor_profile: parseJsonArray(row.flavor_profile),
			});
		}
	}

	return results.sort((a, b) => a.name.localeCompare(b.name));
}

interface CanonicalIngredientRow {
	id: number;
	name: string;
	total_count: number | null;
	category: string | null;
	subcategory: string | null;
	flavor_profile: string | null;
}

async function getMiseStates(ids: number[], names: string[], env: MiseGraphEnv): Promise<MiseStateRow[]> {
	return optionalQuery(env, async () => {
		const clauses: string[] = [];
		const params: D1Type[] = [];
		if (ids.length) clauses.push(`canonical_ingredient_id IN (${numberList(ids)})`);
		for (const name of names.slice(0, 12)) {
			clauses.push("lower(canonical_name) LIKE ?");
			params.push(`%${name}%`);
		}
		if (!clauses.length) return [];
		const rows = await env.DB.prepare(`
			SELECT *
			FROM mise_ingredient_states
			WHERE ${clauses.join(" OR ")}
			ORDER BY canonical_name, state_kind, state_name
			LIMIT 240
		`).bind(...params).all<MiseIngredientState>();
		return (rows.results ?? []).map(row => ({ ...row, meta: parseJsonObject(row.meta_json) }));
	}, []);
}

async function getMiseEdges(ids: number[], names: string[], env: MiseGraphEnv): Promise<MiseEdgeRow[]> {
	return optionalQuery(env, async () => {
		const clauses: string[] = [];
		const params: D1Type[] = [];
		if (ids.length) clauses.push(`s1.canonical_ingredient_id IN (${numberList(ids)})`);
		for (const name of names.slice(0, 12)) {
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
			LIMIT 240
		`).bind(...params).all<Omit<MiseEdgeRow, "equipment" | "station_tags" | "cuisine_grammars" | "format_tags" | "meta">>();
		return (rows.results ?? []).map(row => ({
			...row,
			equipment: parseStringArray(row.equipment_json),
			station_tags: parseStringArray(row.station_tags_json),
			cuisine_grammars: parseStringArray(row.cuisine_grammars_json),
			format_tags: parseStringArray(row.format_tags_json),
			meta: parseJsonObject(row.meta_json),
		}));
	}, []);
}

async function getStationRules(env: MiseGraphEnv): Promise<StationRule[]> {
	return optionalQuery(env, async () => {
		const rows = await env.DB.prepare(`
			SELECT id, station_tag, station_name, trigger_kind, equipment_json, cheap_branches_json, default_questions_json
			FROM mise_station_rules
			ORDER BY station_tag
		`).all<{
			id: string;
			station_tag: string;
			station_name: string;
			trigger_kind: string;
			equipment_json: string | null;
			cheap_branches_json: string | null;
			default_questions_json: string | null;
		}>();
		return (rows.results ?? []).map(row => ({
			id: row.id,
			station_tag: row.station_tag,
			station_name: row.station_name,
			trigger_kind: row.trigger_kind,
			equipment: parseStringArray(row.equipment_json),
			cheap_branches: parseJsonArray(row.cheap_branches_json),
			default_questions: parseJsonArray(row.default_questions_json),
		}));
	}, []);
}

async function getPlanContext(input: MiseResolveInput, env: MiseGraphEnv): Promise<PlanContext[]> {
	if (!input.household_id) return [];
	const date = parseDate(input.date);
	return optionalQuery(env, async () => {
		const rows = await env.DB.prepare(`
			SELECT id, title, start_date, end_date, status, selected_ingredients_json
			FROM mise_week_plans
			WHERE household_id = ?
			AND start_date <= ?
			AND end_date >= ?
			ORDER BY updated_at DESC, created_at DESC
			LIMIT 5
		`).bind(input.household_id, date, date).all<{
			id: string;
			title: string | null;
			start_date: string;
			end_date: string;
			status: string | null;
			selected_ingredients_json: string | null;
		}>();
		return (rows.results ?? []).map(row => ({
			id: row.id,
			title: row.title,
			start_date: row.start_date,
			end_date: row.end_date,
			status: row.status,
			selected_ingredients: parseStringArray(row.selected_ingredients_json),
		}));
	}, []);
}

async function getAffinityCandidates(ids: number[], context: ResolveContext, env: MiseGraphEnv): Promise<AffinityCandidate[]> {
	if (!ids.length) return [];
	const rows = await optionalQuery(env, async () => {
		const idList = numberList(ids);
		const result = await env.DB.prepare(`
			SELECT
				CASE WHEN e.from_ingredient_id IN (${idList}) THEN e.to_ingredient_id ELSE e.from_ingredient_id END AS ingredient_id,
				ci.name,
				ci.category,
				ci.subcategory,
				SUM(e.weighted_pmi) AS raw_score,
				SUM(e.co_count) AS co_count,
				GROUP_CONCAT(DISTINCT e.type) AS edge_types,
				GROUP_CONCAT(DISTINCT e.context) AS contexts
			FROM ingredient_edges e
			JOIN canonical_ingredients ci ON ci.id = CASE
				WHEN e.from_ingredient_id IN (${idList}) THEN e.to_ingredient_id
				ELSE e.from_ingredient_id
			END
			WHERE (e.from_ingredient_id IN (${idList}) OR e.to_ingredient_id IN (${idList}))
			AND CASE WHEN e.from_ingredient_id IN (${idList}) THEN e.to_ingredient_id ELSE e.from_ingredient_id END NOT IN (${idList})
			GROUP BY ingredient_id, ci.name, ci.category, ci.subcategory
			ORDER BY raw_score DESC, ci.name
			LIMIT ?
		`).bind(context.limit * 2).all<{
			ingredient_id: number;
			name: string;
			category: string | null;
			subcategory: string | null;
			raw_score: number | null;
			co_count: number | null;
			edge_types: string | null;
			contexts: string | null;
		}>();
		return result.results ?? [];
	}, []);

	return rows.map(row => {
		const excluded = includesAny(row.name, context.excludedTerms);
		const breakdown = score("affinity", [
			["base", 4, "ingredient graph candidate"],
			["ingredient_match", Math.min(22, Math.max(0, Number(row.raw_score ?? 0)) * 4), "co-occurrence strength"],
			["inventory_match", context.inventoryTerms.length ? 5 : 0, "can extend inventory"],
			["constraint_fit", excluded ? -100 : 0, "excluded ingredient"],
			["recency_or_popularity", Math.min(10, Number(row.co_count ?? 0) / 10), "co-occurrence support"],
		]);
		return {
			ingredient_id: row.ingredient_id,
			name: row.name,
			category: row.category,
			subcategory: row.subcategory,
			score: breakdown.total,
			co_count: Number(row.co_count ?? 0),
			edge_types: row.edge_types,
			contexts: row.contexts,
			score_breakdown: breakdown,
		};
	}).sort(compareScored).slice(0, context.limit);
}

async function getDishCandidates(names: string[], context: ResolveContext, env: MiseGraphEnv): Promise<CandidateDish[]> {
	return optionalQuery(env, async () => {
		const { where, params } = likeJsonClauses(names, ["core_ingredients", "expected_ingredients", "optional_ingredients"]);
		if (!where) return [];
		const rows = await env.DB.prepare(`
			SELECT id, canonical_title, composition, sweet_savory, meals, methods, equipment,
				recipe_count, source_count, consensus_total_time, consensus_servings,
				core_ingredients, expected_ingredients, optional_ingredients
			FROM canonical_dishes
			WHERE ${where}
			ORDER BY recipe_count DESC, source_count DESC, canonical_title
			LIMIT ?
		`).bind(...params, context.limit * 4).all<DishRow>();

		return (rows.results ?? [])
			.map(row => scoreDish(row, context))
			.filter(row => row.score > -50)
			.sort(compareScored)
			.slice(0, context.limit);
	}, []);
}

interface DishRow {
	id: string;
	canonical_title: string;
	composition: string | null;
	sweet_savory: string | null;
	meals: string | null;
	methods: string | null;
	equipment: string | null;
	recipe_count: number | null;
	source_count: number | null;
	consensus_total_time: number | null;
	consensus_servings: number | null;
	core_ingredients: string | null;
	expected_ingredients: string | null;
	optional_ingredients: string | null;
}

async function getComponentCandidates(names: string[], context: ResolveContext, env: MiseGraphEnv): Promise<CandidateComponent[]> {
	return optionalQuery(env, async () => {
		const { where, params } = likeJsonClauses(names, ["core_ingredients", "common_ingredients", "optional_ingredients"]);
		if (!where) return [];
		const rows = await env.DB.prepare(`
			SELECT id, canonical_name, family, component_type, recipe_count,
				core_ingredients, common_ingredients, optional_ingredients
			FROM canonical_components
			WHERE ${where}
			ORDER BY recipe_count DESC, canonical_name
			LIMIT ?
		`).bind(...params, context.limit * 4).all<ComponentRow>();

		return (rows.results ?? [])
			.map(row => scoreComponent(row, context))
			.filter(row => row.score > -50)
			.sort(compareScored)
			.slice(0, context.limit);
	}, []);
}

interface ComponentRow {
	id: string;
	canonical_name: string;
	family: string | null;
	component_type: string | null;
	recipe_count: number | null;
	core_ingredients: string | null;
	common_ingredients: string | null;
	optional_ingredients: string | null;
}

async function getSeasonalCandidates(
	ids: number[],
	names: string[],
	context: ResolveContext,
	env: MiseGraphEnv,
): Promise<SeasonalCandidate[]> {
	const fromProfiles = await optionalQuery(env, async () => {
		const clauses: string[] = [];
		const params: D1Type[] = [];
		if (ids.length) clauses.push(`canonical_ingredient_id IN (${numberList(ids)})`);
		for (const name of names.slice(0, 10)) {
			clauses.push("lower(base_ingredient) LIKE ?");
			params.push(`%${name}%`);
			clauses.push("lower(normalized_name) LIKE ?");
			params.push(`%${name}%`);
		}
		if (!clauses.length) return [];
		const rows = await env.DB.prepare(`
			SELECT id, name, normalized_name, base_ingredient, category, peak_months, available_months, sightings
			FROM produce_profiles
			WHERE ${clauses.join(" OR ")}
			ORDER BY sightings DESC, name
			LIMIT ?
		`).bind(...params, context.limit * 2).all<{
			id: number;
			name: string;
			normalized_name: string | null;
			base_ingredient: string | null;
			category: string | null;
			peak_months: string | null;
			available_months: string | null;
			sightings: number | null;
		}>();
		return (rows.results ?? []).map(row => scoreSeasonalProfile(row, context));
	}, []);

	const fromRegional = await getRegionalSeasonalCandidates(context, env);
	return uniqueBy([...fromProfiles, ...fromRegional].sort(compareScored), row => `${row.source}:${row.name}`).slice(0, context.limit);
}

async function getTechniqueHints(names: string[], context: ResolveContext, env: MiseGraphEnv): Promise<TechniqueHint[]> {
	const terms = unique(names.flatMap(name => [
		name,
		name.endsWith("s") ? name.slice(0, -1) : `${name}s`,
	]).map(normalizeName).filter(Boolean));
	if (!terms.length) return [];

	return optionalQuery(env, async () => {
		const ingredientPlaceholders = terms.map(() => "?").join(",");
		const techniquePlaceholders = USEFUL_TECHNIQUES.map(() => "?").join(",");
		const rows = await env.DB.prepare(`
			SELECT technique, SUM(count) AS ingredient_score
			FROM tg_technique_ingredient
			WHERE lower(ingredient) IN (${ingredientPlaceholders})
			AND lower(technique) IN (${techniquePlaceholders})
			GROUP BY technique
			ORDER BY ingredient_score DESC, technique
			LIMIT ?
		`).bind(...terms, ...USEFUL_TECHNIQUES, context.limit * 2).all<{
			technique: string;
			ingredient_score: number | null;
		}>();

		const hints: TechniqueHint[] = [];
		for (const row of rows.results ?? []) {
			const equipmentRows = await env.DB.prepare(`
				SELECT equipment, count
				FROM tg_technique_equipment
				WHERE lower(technique) = ?
				ORDER BY count DESC, equipment
				LIMIT 8
			`).bind(normalizeName(row.technique)).all<{ equipment: string; count: number | null }>();
			const equipment = (equipmentRows.results ?? []).map(equipmentRow => normalizeName(equipmentRow.equipment)).filter(Boolean);
			const equipmentSupport = (equipmentRows.results ?? []).reduce((sum, equipmentRow) => sum + Number(equipmentRow.count ?? 0), 0);
			const breakdown = score("technique", [
				["base", 4, "technique graph hint"],
				["ingredient_match", Math.min(18, Math.log1p(row.ingredient_score ?? 0) * 4), "ingredient technique support"],
				["equipment_fit", equipmentScore(equipment, context), "equipment availability"],
				["recency_or_popularity", Math.min(8, Math.log1p(equipmentSupport)), "equipment support"],
			]);
			hints.push({
				technique: normalizeName(row.technique),
				ingredient_score: Number(row.ingredient_score ?? 0),
				equipment,
				equipment_score: equipmentSupport,
				score: breakdown.total,
				score_breakdown: breakdown,
			});
		}

		return hints.sort(compareScored).slice(0, context.limit);
	}, []);
}

async function getRegionalSeasonalCandidates(context: ResolveContext, env: MiseGraphEnv): Promise<SeasonalCandidate[]> {
	const state = normalizeName(context.input.location?.state ?? "").toUpperCase();
	if (!state) return [];
	return optionalQuery(env, async () => {
		const rows = await env.DB.prepare(`
			SELECT DISTINCT ingredient, region_name, season, months
			FROM regional_seasons
			WHERE state LIKE ? AND season = ?
			ORDER BY ingredient
			LIMIT ?
		`).bind(`%${state}%`, context.season, context.limit * 2).all<{
			ingredient: string;
			region_name: string | null;
			season: string | null;
			months: string | null;
		}>();
		return (rows.results ?? []).map((row, index) => {
			const matched = includesAny(row.ingredient, context.ingredientNames) || includesAny(row.ingredient, context.desiredTerms);
			const breakdown = score("regional season", [
				["base", 5, "regional seasonal candidate"],
				["ingredient_match", matched ? 16 : 0, "matches requested terms"],
				["seasonality", row.season === context.season ? 24 : 8, "in regional season"],
				["constraint_fit", includesAny(row.ingredient, context.excludedTerms) ? -100 : 0, "excluded ingredient"],
			]);
			return {
				id: `regional:${slugId(row.region_name ?? "region", row.ingredient, index)}`,
				name: row.ingredient,
				normalized_name: normalizeName(row.ingredient),
				base_ingredient: normalizeName(row.ingredient),
				category: null,
				peak_months: [],
				available_months: [],
				source: "regional_seasons",
				season: row.season,
				region_name: row.region_name,
				score: breakdown.total,
				score_breakdown: breakdown,
			};
		});
	}, []);
}

function scorePersistedEdge(edge: MiseEdgeRow, context: ResolveContext, stationRules: StationRule[], techniqueHints: TechniqueHint[]): CandidateEdge {
	const equipment = unique([...edge.equipment, ...equipmentForStations(edge.station_tags, stationRules)].map(normalizeName).filter(Boolean));
	const breakdown = scoreEdge({
		source: "persisted",
		canonicalName: edge.from_canonical_name,
		actionLabel: edge.action_label ?? edge.edge_type,
		technique: edge.technique,
		equipment,
		stationTags: edge.station_tags,
		activeTime: edge.active_time_min,
		leadTime: edge.lead_time_hours,
		qualityWindow: edge.quality_window_hours,
		confidence: edge.confidence ?? 0.5,
	}, context, techniqueHints);

	return {
		id: edge.id,
		source: "persisted",
		from_state_id: edge.from_state_id,
		to_state_id: edge.to_state_id,
		from_label: edge.from_display_name,
		to_label: edge.to_display_name,
		canonical_name: edge.from_canonical_name,
		edge_type: edge.edge_type,
		action_label: edge.action_label ?? edge.edge_type,
		technique: edge.technique,
		equipment,
		station_tags: edge.station_tags,
		active_time_min: edge.active_time_min,
		idle_time_min: edge.idle_time_min,
		lead_time_hours: edge.lead_time_hours,
		quality_window_hours: edge.quality_window_hours,
		confidence: edge.confidence ?? 0.5,
		rationale: edge.rationale,
		score: breakdown.total,
		score_breakdown: breakdown,
	};
}

function scoreTemplateEdges(template: MiseStateTemplate, context: ResolveContext, stationRules: StationRule[], techniqueHints: TechniqueHint[]): CandidateEdge[] {
	return template.edges.map(templateEdge => {
		const equipment = unique([...templateEdge.equipment, ...equipmentForStations(templateEdge.station_tags, stationRules)].map(normalizeName).filter(Boolean));
		const canonicalName = template.id.split(":")[1]?.replace(/_/g, " ") ?? template.display_name;
		const breakdown = scoreEdge({
			source: "inferred",
			canonicalName,
			actionLabel: templateEdge.action_label,
			technique: templateEdge.technique,
			equipment,
			stationTags: templateEdge.station_tags,
			activeTime: inferredActiveTime(templateEdge.technique, templateEdge.edge_type),
			leadTime: templateEdge.technique === "soak" || templateEdge.technique === "ferment" ? 12 : 0,
			qualityWindow: template.quality_window_hours,
			confidence: 0.62,
		}, context, techniqueHints);
		return {
			id: slugId("inferred_edge", template.id, templateEdge.to_state_name, templateEdge.edge_type, templateEdge.action_label),
			source: "inferred",
			from_state_id: template.id,
			to_state_id: slugId("inferred_state", canonicalName, templateEdge.to_state_name),
			from_label: template.display_name,
			to_label: `${canonicalName}: ${templateEdge.to_state_name.replace(/_/g, " ")}`,
			canonical_name: canonicalName,
			edge_type: templateEdge.edge_type,
			action_label: templateEdge.action_label,
			technique: templateEdge.technique,
			equipment,
			station_tags: templateEdge.station_tags,
			active_time_min: inferredActiveTime(templateEdge.technique, templateEdge.edge_type),
			idle_time_min: templateEdge.technique === "soak" || templateEdge.technique === "ferment" ? 720 : null,
			lead_time_hours: templateEdge.technique === "soak" || templateEdge.technique === "ferment" ? 12 : 0,
			quality_window_hours: template.quality_window_hours,
			confidence: 0.62,
			rationale: templateEdge.rationale,
			score: breakdown.total,
			score_breakdown: breakdown,
		};
	});
}

function scoreEdge(
	edge: {
		source: "persisted" | "inferred";
		canonicalName: string;
		actionLabel: string;
		technique: string | null;
		equipment: string[];
		stationTags: string[];
		activeTime: number | null;
		leadTime: number | null;
		qualityWindow: number | null;
		confidence: number;
	},
	context: ResolveContext,
	techniqueHints: TechniqueHint[],
): ScoreBreakdown {
	const name = normalizeName(edge.canonicalName);
	const action = normalizeName(`${edge.actionLabel} ${edge.technique ?? ""} ${edge.stationTags.join(" ")}`);
	const equipmentFit = equipmentScore(edge.equipment, context);
	const activeTime = edge.activeTime ?? 15;
	const scheduleFit = context.maxActiveTime !== null && activeTime > context.maxActiveTime
		? -20
		: Math.max(0, 12 - activeTime / 5);
	const leadTime = edge.leadTime ?? 0;
	const leadFit = context.maxLeadTime !== null && leadTime > context.maxLeadTime ? -18 : 0;
	const makeAhead = context.preferMakeAhead && (edge.qualityWindow ?? 0) >= 48 ? 8 : 0;
	const desiredMatch = includesAny(action, context.desiredTerms) || includesAny(name, context.desiredTerms) ? 14 : 0;
	const inventoryMatch = includesAny(name, context.inventoryTerms) ? 10 : 0;
	const ingredientMatch = includesAny(name, context.ingredientNames) ? 18 : 0;
	const excluded = includesAny(name, context.excludedTerms);
	const avoidedEquipment = edge.equipment.some(item => context.avoidEquipment.includes(normalizeName(item)));
	const techniqueHint = edge.technique
		? techniqueHints.find(hint => hint.technique === normalizeName(edge.technique))
		: null;

	return score("edge", [
		["base", edge.source === "persisted" ? 10 : 6, `${edge.source} edge`],
		["ingredient_match", ingredientMatch, "matches requested ingredient"],
		["desired_match", desiredMatch, "matches desired direction"],
		["inventory_match", inventoryMatch, "uses inventory"],
		["equipment_fit", equipmentFit, "equipment availability"],
		["schedule_fit", scheduleFit + leadFit + makeAhead, "fits prep window"],
		["constraint_fit", (excluded ? -100 : 0) + (avoidedEquipment ? -35 : 0), "constraint checks"],
		["confidence", Math.round(edge.confidence * 18) + (techniqueHint ? Math.min(8, techniqueHint.score / 4) : 0), "edge and technique confidence"],
	]);
}

function scoreDish(row: DishRow, context: ResolveContext): CandidateDish {
	const core = ingredientNamesFromJson(row.core_ingredients);
	const expected = ingredientNamesFromJson(row.expected_ingredients);
	const optional = ingredientNamesFromJson(row.optional_ingredients);
	const all = unique([...core, ...expected, ...optional]);
	const matched = all.filter(name => includesAny(name, context.ingredientNames));
	const missingCore = core.filter(name => !includesAny(name, context.ingredientNames) && !includesAny(name, context.inventoryTerms));
	const excluded = all.some(name => includesAny(name, context.excludedTerms));
	const equipment = parseStringArray(row.equipment);
	const desiredMatch = includesAny(row.canonical_title, context.desiredTerms) || includesAny(row.composition ?? "", context.desiredTerms);
	const totalTime = row.consensus_total_time ?? 45;
	const breakdown = score("dish", [
		["base", 8, "dish candidate"],
		["ingredient_match", matched.length * 9 - missingCore.length * 4, "ingredient coverage"],
		["desired_match", desiredMatch ? 16 : 0, "desired dish match"],
		["inventory_match", all.filter(name => includesAny(name, context.inventoryTerms)).length * 4, "inventory coverage"],
		["equipment_fit", equipmentScore(equipment, context), "equipment availability"],
		["schedule_fit", context.maxActiveTime !== null && totalTime > context.maxActiveTime ? -16 : Math.max(0, 10 - totalTime / 15), "time fit"],
		["constraint_fit", excluded ? -100 : 0, "excluded ingredient"],
		["recency_or_popularity", Math.min(14, Math.log1p(row.recipe_count ?? 0) + Math.log1p(row.source_count ?? 0)), "canonical support"],
	]);

	return {
		id: row.id,
		canonical_title: row.canonical_title,
		composition: row.composition,
		meals: parseJsonArray(row.meals),
		methods: parseJsonArray(row.methods),
		equipment,
		recipe_count: row.recipe_count ?? 0,
		source_count: row.source_count ?? 0,
		consensus_total_time: row.consensus_total_time,
		core_ingredients: core,
		expected_ingredients: expected,
		optional_ingredients: optional,
		matched_ingredients: matched,
		missing_core_ingredients: missingCore,
		score: breakdown.total,
		score_breakdown: breakdown,
	};
}

function scoreComponent(row: ComponentRow, context: ResolveContext): CandidateComponent {
	const core = ingredientNamesFromJson(row.core_ingredients);
	const common = ingredientNamesFromJson(row.common_ingredients);
	const optional = ingredientNamesFromJson(row.optional_ingredients);
	const all = unique([...core, ...common, ...optional]);
	const matched = all.filter(name => includesAny(name, context.ingredientNames));
	const missingCore = core.filter(name => !includesAny(name, context.ingredientNames) && !includesAny(name, context.inventoryTerms));
	const desiredMatch = includesAny(row.canonical_name, context.desiredTerms) || includesAny(row.component_type ?? "", context.desiredTerms);
	const excluded = all.some(name => includesAny(name, context.excludedTerms));
	const makeAheadType = /sauce|dip|pickle|dough|stock|bean|grain|component/.test(normalizeName(`${row.component_type ?? ""} ${row.family ?? ""}`));
	const breakdown = score("component", [
		["base", 9, "component candidate"],
		["ingredient_match", matched.length * 10 - missingCore.length * 5, "ingredient coverage"],
		["desired_match", desiredMatch ? 14 : 0, "desired component match"],
		["inventory_match", all.filter(name => includesAny(name, context.inventoryTerms)).length * 5, "inventory coverage"],
		["schedule_fit", context.preferMakeAhead && makeAheadType ? 10 : 3, "make-ahead fit"],
		["constraint_fit", excluded ? -100 : 0, "excluded ingredient"],
		["recency_or_popularity", Math.min(12, Math.log1p(row.recipe_count ?? 0)), "canonical support"],
	]);

	return {
		id: row.id,
		canonical_name: row.canonical_name,
		family: row.family,
		component_type: row.component_type,
		recipe_count: row.recipe_count ?? 0,
		core_ingredients: core,
		common_ingredients: common,
		optional_ingredients: optional,
		matched_ingredients: matched,
		missing_core_ingredients: missingCore,
		score: breakdown.total,
		score_breakdown: breakdown,
	};
}

function scoreSeasonalProfile(
	row: {
		id: number;
		name: string;
		normalized_name: string | null;
		base_ingredient: string | null;
		category: string | null;
		peak_months: string | null;
		available_months: string | null;
		sightings: number | null;
	},
	context: ResolveContext,
): SeasonalCandidate {
	const peakMonths = parseNumberArray(row.peak_months);
	const availableMonths = parseNumberArray(row.available_months);
	const inPeak = peakMonths.includes(context.month);
	const available = availableMonths.includes(context.month);
	const name = normalizeName(`${row.name} ${row.base_ingredient ?? ""} ${row.normalized_name ?? ""}`);
	const breakdown = score("seasonal", [
		["base", 5, "produce profile"],
		["ingredient_match", includesAny(name, context.ingredientNames) ? 14 : 0, "matches requested ingredient"],
		["desired_match", includesAny(name, context.desiredTerms) ? 8 : 0, "matches desired term"],
		["seasonality", inPeak ? 28 : available ? 15 : -6, "seasonal month fit"],
		["constraint_fit", includesAny(name, context.excludedTerms) ? -100 : 0, "excluded ingredient"],
		["recency_or_popularity", Math.min(10, Math.log1p(row.sightings ?? 0)), "market sightings"],
	]);
	return {
		id: `produce:${row.id}`,
		name: row.name,
		normalized_name: row.normalized_name,
		base_ingredient: row.base_ingredient,
		category: row.category,
		peak_months: peakMonths,
		available_months: availableMonths,
		source: "produce_profiles",
		season: null,
		region_name: null,
		score: breakdown.total,
		score_breakdown: breakdown,
	};
}

function edgeRejectionReason(edge: CandidateEdge, context: ResolveContext): string | null {
	if (includesAny(edge.canonical_name, context.excludedTerms)) return "excluded_ingredient";
	if (edge.equipment.some(item => context.avoidEquipment.includes(normalizeName(item)))) return "avoided_equipment";
	if (context.maxActiveTime !== null && (edge.active_time_min ?? 0) > context.maxActiveTime) return "active_time_exceeds_constraint";
	if (context.maxLeadTime !== null && (edge.lead_time_hours ?? 0) > context.maxLeadTime) return "lead_time_exceeds_constraint";
	if (edge.score < 12) return "low_score";
	return null;
}

function buildCandidateGraph(
	canonical: CanonicalIngredient[],
	states: MiseStateRow[],
	templates: MiseStateTemplate[],
	activatedEdges: CandidateEdge[],
	rejectedEdges: Array<CandidateEdge & { rejected_reason: string }>,
	dishes: CandidateDish[],
	components: CandidateComponent[],
	seasonal: SeasonalCandidate[],
	affinities: AffinityCandidate[],
	techniqueHints: TechniqueHint[],
	limit: number,
): MiseResolveResult["candidate_graph"] {
	const nodes = new Map<string, { id: string; type: string; label: string; score?: number; data?: unknown }>();
	const edges = new Map<string, { id: string; from: string; to: string; type: string; label?: string; score?: number; data?: unknown }>();

	for (const ingredient of canonical) {
		nodes.set(`ingredient:${ingredient.id}`, { id: `ingredient:${ingredient.id}`, type: "ingredient", label: ingredient.name, data: ingredient });
	}
	for (const state of states) {
		const id = `state:${state.id}`;
		nodes.set(id, { id, type: "mise_state", label: state.display_name, data: state });
		if (state.canonical_ingredient_id) {
			edges.set(`has_state:${state.canonical_ingredient_id}:${state.id}`, {
				id: `has_state:${state.canonical_ingredient_id}:${state.id}`,
				from: `ingredient:${state.canonical_ingredient_id}`,
				to: id,
				type: "has_state",
			});
		}
	}
	for (const template of templates) {
		nodes.set(template.id, { id: template.id, type: "inferred_mise_template", label: template.display_name, data: template });
	}
	for (const edge of [...activatedEdges, ...rejectedEdges.slice(0, limit)]) {
		nodes.set(edge.from_state_id, nodes.get(edge.from_state_id) ?? { id: edge.from_state_id, type: "mise_state", label: edge.from_label });
		nodes.set(edge.to_state_id, nodes.get(edge.to_state_id) ?? { id: edge.to_state_id, type: "mise_state", label: edge.to_label, score: edge.score });
		edges.set(edge.id, {
			id: edge.id,
			from: edge.from_state_id,
			to: edge.to_state_id,
			type: edge.edge_type,
			label: edge.action_label,
			score: edge.score,
			data: edge,
		});
	}
	for (const dish of dishes.slice(0, limit)) {
		nodes.set(`dish:${dish.id}`, { id: `dish:${dish.id}`, type: "canonical_dish", label: dish.canonical_title, score: dish.score, data: dish });
		for (const ingredient of canonical) {
			edges.set(`dish:${ingredient.id}:${dish.id}`, {
				id: `dish:${ingredient.id}:${dish.id}`,
				from: `ingredient:${ingredient.id}`,
				to: `dish:${dish.id}`,
				type: "supports_dish",
				score: dish.score,
			});
		}
	}
	for (const component of components.slice(0, limit)) {
		nodes.set(`component:${component.id}`, { id: `component:${component.id}`, type: "canonical_component", label: component.canonical_name, score: component.score, data: component });
	}
	for (const item of seasonal.slice(0, limit)) {
		nodes.set(item.id, { id: item.id, type: "seasonal_candidate", label: item.name, score: item.score, data: item });
	}
	for (const affinity of affinities.slice(0, limit)) {
		nodes.set(`ingredient:${affinity.ingredient_id}`, { id: `ingredient:${affinity.ingredient_id}`, type: "ingredient", label: affinity.name, score: affinity.score, data: affinity });
		for (const ingredient of canonical) {
			edges.set(`affinity:${ingredient.id}:${affinity.ingredient_id}`, {
				id: `affinity:${ingredient.id}:${affinity.ingredient_id}`,
				from: `ingredient:${ingredient.id}`,
				to: `ingredient:${affinity.ingredient_id}`,
				type: "co_occurs_with",
				score: affinity.score,
			});
		}
	}
	for (const hint of techniqueHints.slice(0, limit)) {
		nodes.set(`technique:${hint.technique}`, {
			id: `technique:${hint.technique}`,
			type: "technique",
			label: hint.technique,
			score: hint.score,
			data: hint,
		});
		for (const ingredient of canonical) {
			edges.set(`technique:${ingredient.id}:${hint.technique}`, {
				id: `technique:${ingredient.id}:${hint.technique}`,
				from: `ingredient:${ingredient.id}`,
				to: `technique:${hint.technique}`,
				type: "uses_technique",
				score: hint.score,
			});
		}
	}

	return {
		nodes: Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
		edges: Array.from(edges.values()).sort((a, b) => a.id.localeCompare(b.id)),
	};
}

function inferStateTemplates(names: string[]): MiseStateTemplate[] {
	const templates: MiseStateTemplate[] = [];
	for (const name of names) {
		if (/chickpea|garbanzo/.test(name)) {
			templates.push(template(name, "dry", "dried chickpeas", "raw", 8760, [
				edge("soaked", "state_transition", "soak overnight", "soak", ["legume_batch_active"], ["mixing bowl"], "Soaking opens cooked, falafel, and hummus branches."),
				edge("cooked_whole", "state_transition", "pressure cook", "pressure cook", ["instant_pot_active", "legume_batch_active"], ["instant pot"], "Cooked whole chickpeas become a neutral batch component."),
			]));
			templates.push(template(name, "cooked_whole", "cooked whole chickpeas", "cooked", 120, [
				edge("hummus", "component_output", "blend into hummus", "blend", ["food_processor_dirty"], ["food processor"], "A processor session can produce a dip for multiple meals."),
				edge("crispy", "component_output", "roast until crisp", "roast", ["oven_hot"], ["sheet pan", "oven"], "Roasting converts a cooked batch into a crunchy topping."),
			]));
		} else if (/parsley|cilantro|mint|dill|basil|herb/.test(name)) {
			templates.push(template(name, "washed_whole", `washed whole ${name}`, "washed", 120, [
				edge("chopped_mix", "state_transition", "chop herb mix", "chop", ["herb_board_active"], ["cutting board"], "Chop only near-term herbs; hold the rest whole."),
				edge("whole_leaf_reserve", "storage", "store whole-leaf reserve", null, ["herb_board_active"], ["deli container"], "Whole leaves keep better for late-week finishing."),
			]));
		} else if (/cucumber|radish|carrot|turnip/.test(name)) {
			templates.push(template(name, "raw_whole", `whole ${name}`, "raw", 120, [
				edge("raw_sticks", "state_transition", "cut snack sticks", "slice", ["crunchy_veg_board_active"], ["cutting board"], "Cut crunch vegetables while the board is active."),
				edge("quick_pickle", "component_output", "quick pickle", "pickle", ["crunchy_veg_board_active"], ["jar"], "Pickling extends a crunchy vegetable into later meals."),
			]));
		} else if (/flour|dough|pita|naan|pizza/.test(name)) {
			templates.push(template(name, "mixed_dough", "mixed dough", "dough", 96, [
				edge("fermented_dough", "state_transition", "cold ferment", "ferment", ["dough_fermentation_active"], ["covered container"], "Fermentation creates a multi-day carrier."),
				edge("dough_balls", "state_transition", "divide into balls", "divide", ["dough_fermentation_active"], ["deli containers"], "Portioned dough makes later cooking faster."),
			]));
		} else if (/lentil|bean/.test(name)) {
			templates.push(template(name, "dry", `dry ${name}`, "raw", 8760, [
				edge("cooked", "state_transition", "pressure cook", "pressure cook", ["instant_pot_active"], ["instant pot"], "Cooked legumes support bowls, salads, and dips."),
			]));
		} else if (/tahini|yogurt|miso|mayonnaise/.test(name)) {
			templates.push(template(name, "base", `${name} base`, "base", 168, [
				edge("thick_dip", "component_output", "season as dip", "whisk", ["sauce_base_active"], ["bowl"], "Keep one thick sauce for snacks and bowls."),
				edge("thin_dressing", "component_output", "thin as dressing", "whisk", ["sauce_base_active"], ["bowl"], "A thinner branch becomes salad or grain-bowl dressing."),
			]));
		} else {
			templates.push(template(name, "raw_whole", `whole ${name}`, "raw", null, [
				edge("washed", "state_transition", "wash and dry", "wash", ["prep_sink_active"], ["sink"], "Washing creates a ready state."),
				edge("roasted", "component_output", "roast", "roast", ["oven_hot"], ["sheet pan", "oven"], "Oven heat should create a future component."),
				edge("quick_pickle", "component_output", "quick pickle", "pickle", ["crunchy_veg_board_active"], ["jar"], "Pickling can extend useful life and add acidity."),
			]));
		}
	}
	return templates.sort((a, b) => a.id.localeCompare(b.id));
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
	return { to_state_name: toStateName, edge_type: edgeType, action_label: actionLabel, technique, station_tags: stationTags, equipment, rationale };
}

type D1Type = string | number | null;

async function optionalQuery<T>(env: MiseGraphEnv, run: () => Promise<T>, fallback: T): Promise<T> {
	void env;
	try {
		return await run();
	} catch {
		return fallback;
	}
}

function likeJsonClauses(names: string[], columns: string[]): { where: string; params: D1Type[] } {
	const clauses: string[] = [];
	const params: D1Type[] = [];
	for (const name of names.slice(0, 10)) {
		for (const col of columns) {
			clauses.push(`lower(${col}) LIKE ?`);
			params.push(`%${name}%`);
		}
	}
	return { where: clauses.join(" OR "), params };
}

function score(kind: string, parts: Array<[keyof Omit<ScoreBreakdown, "total" | "reasons">, number, string]>): ScoreBreakdown {
	const breakdown: ScoreBreakdown = {
		base: 0,
		ingredient_match: 0,
		desired_match: 0,
		inventory_match: 0,
		equipment_fit: 0,
		seasonality: 0,
		schedule_fit: 0,
		constraint_fit: 0,
		confidence: 0,
		recency_or_popularity: 0,
		total: 0,
		reasons: [kind],
	};
	for (const [key, value, reason] of parts) {
		const rounded = round(value);
		breakdown[key] += rounded;
		if (rounded !== 0) breakdown.reasons.push(`${reason}: ${rounded > 0 ? "+" : ""}${rounded}`);
	}
	breakdown.total = round(
		breakdown.base +
		breakdown.ingredient_match +
		breakdown.desired_match +
		breakdown.inventory_match +
		breakdown.equipment_fit +
		breakdown.seasonality +
		breakdown.schedule_fit +
		breakdown.constraint_fit +
		breakdown.confidence +
		breakdown.recency_or_popularity,
	);
	return breakdown;
}

function equipmentScore(required: string[], context: ResolveContext): number {
	if (!required.length) return 4;
	const normalized = required.map(normalizeName).filter(Boolean);
	if (normalized.some(item => context.avoidEquipment.includes(item))) return -35;
	if (!context.equipment.length) return -2;
	const matches = normalized.filter(item => context.equipment.includes(item)).length;
	return matches === normalized.length ? 12 : matches > 0 ? 5 : -6;
}

function equipmentForStations(tags: string[], rules: StationRule[]): string[] {
	const byTag = new Map(rules.map(rule => [normalizeName(rule.station_tag), rule.equipment]));
	return tags.flatMap(tag => byTag.get(normalizeName(tag)) ?? []);
}

function inferredActiveTime(technique: string | null, edgeType: string): number {
	const key = normalizeName(technique ?? edgeType);
	if (/wash|slice|chop|divide|whisk/.test(key)) return 10;
	if (/blend|pickle|soak/.test(key)) return 15;
	if (/pressure|roast|bake/.test(key)) return 25;
	if (/ferment/.test(key)) return 20;
	return 15;
}

function ingredientNamesFromJson(value: string | null): string[] {
	const parsed = parseJsonArray(value);
	return unique(parsed.map(entry => {
		if (typeof entry === "string") return normalizeName(entry);
		if (isRecord(entry)) return normalizeName(entry.name ?? entry.ingredient ?? entry.canonical_name);
		return "";
	}).filter(Boolean));
}

function desiredNames(item: string | DesiredItem): string[] {
	if (typeof item === "string") return [item];
	return [item.name, item.title, item.type, ...(item.ingredients ?? [])].filter((value): value is string => typeof value === "string");
}

function desiredInputNames(input: MiseResolveInput["desired"]): string[] {
	if (!input) return [];
	if (Array.isArray(input)) return input.flatMap(desiredNames);
	if (typeof input !== "object") return [];

	const names: string[] = [];
	for (const value of Object.values(input)) {
		if (typeof value === "string") {
			names.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") names.push(item);
				else if (item && typeof item === "object") names.push(...desiredNames(item as DesiredItem));
			}
		}
	}
	return names;
}

function itemName(item: string | InventoryItem | IngredientInput): string {
	if (typeof item === "string") return item;
	return String(item.name ?? item.canonical_name ?? ("ingredient" in item ? item.ingredient : "") ?? "");
}

function parseDate(value: string | null | undefined): string {
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
	return new Date().toISOString().slice(0, 10);
}

function seasonForMonth(month: number): string {
	if (month === 12 || month <= 2) return "winter";
	if (month <= 5) return "spring";
	if (month <= 8) return "summer";
	return "fall";
}

function parseJsonArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string" || value.length === 0) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseStringArray(value: unknown): string[] {
	return parseJsonArray(value).map(item => normalizeName(item)).filter(Boolean);
}

function parseNumberArray(value: unknown): number[] {
	return parseJsonArray(value)
		.map(item => Number(item))
		.filter(item => Number.isFinite(item))
		.map(item => Math.trunc(item));
}

function parseJsonObject(value: unknown): JsonObject {
	if (isRecord(value)) return value;
	if (typeof value !== "string" || value.length === 0) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown): string {
	return String(value ?? "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(part => String(part ?? "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

function includesAny(value: string, terms: string[]): boolean {
	const normalized = normalizeName(value);
	return terms.some(term => term.length > 0 && (normalized === term || normalized.includes(term) || term.includes(normalized)));
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const id = key(item);
		if (!seen.has(id)) {
			seen.add(id);
			result.push(item);
		}
	}
	return result;
}

function compareScored<T extends { score: number; id?: string; name?: string; canonical_name?: string; canonical_title?: string }>(a: T, b: T): number {
	if (b.score !== a.score) return b.score - a.score;
	const aKey = a.id ?? a.name ?? a.canonical_name ?? a.canonical_title ?? "";
	const bKey = b.id ?? b.name ?? b.canonical_name ?? b.canonical_title ?? "";
	return aKey.localeCompare(bKey);
}

function finiteNumber(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function numberList(values: number[]): string {
	return values.map(value => Math.trunc(value)).filter(value => Number.isFinite(value)).join(",");
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}
