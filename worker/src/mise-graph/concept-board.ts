// Concept board — Wave 6 of the mise-graph planner.
//
// Phase 1 of the chef-of-staff agent loop is "inspiration": canvass candidate
// dish concepts before committing to slots. This module is the sticky-notes-
// on-the-wall workspace that persists those candidates between MCP tool
// calls. Phase 2 ("tetris fit") then scores each candidate against the
// calendar and shortlists the best fit per slot.
//
// Storage
// -------
//   mise_plan_movements  — one articulated theme per plan
//   mise_concept_board   — candidate cards, indexed by plan_id + status
//
// Lifecycle of a card:
//   bookmark → candidate → (auto-tetris scored) → shortlisted → committed
//                                              ↘ discarded
//
// Tetris scoring is intentionally deterministic — no LLM. Each scoring
// dimension returns a -10..+10 reading; the total is the unweighted sum
// (clamped to 0..100 so the agent has a stable "out of 100" reading). For
// the first version we only implement the dimensions that have enough
// signal in the existing plan model:
//   cuisine_fit, format_diversity, leftover_continuity, prep_budget,
//   shop_efficiency, cross_meal_reuse, calendar_fit, weather_fit
// the rest report 0 with a note in the breakdown so callers see the
// scaffolding is wired.

import type { MiseGraphEnv } from "./types";
import type {
	MiseMealSlot,
	MisePlanMeal,
	MiseSnackBox,
	MiseWeeklyPlanDraft,
} from "./planner";
import { loadActivePlan, saveActivePlan } from "./active-plans";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlanMovement {
	movement_id: string;
	plan_id: string;
	household_id: string | null;
	theme_text: string;
	rationale: string | null;
	created_at: string;
}

export interface ConceptCardRawIngredient {
	name: string;
	qty?: number;
	unit?: string;
	grams?: number;
}

export type ConceptSourceKind =
	| "corpus"
	| "personal_recipe"
	| "user_prompt"
	| "subagent_ideation"
	| "manual";

export type ConceptStatus =
	| "candidate"
	| "shortlisted"
	| "committed"
	| "discarded";

export interface ConceptCard {
	concept_id: string;
	plan_id: string;
	movement_id: string | null;
	title: string;
	format: string | null;
	cuisine: string[];
	source_kind: ConceptSourceKind;
	source_ref: string | null;
	raw_ingredients: ConceptCardRawIngredient[];
	formula_ids: string[];
	est_active_min: number | null;
	est_idle_min: number | null;
	rationale: string | null;
	vibe_tags: string[];
	status: ConceptStatus;
	committed_to_slot: string | null;
	tetris_score: number | null;
	tetris_score_breakdown: Record<string, number> | null;
	created_at: string;
	updated_at: string;
}

export interface SetMovementParams {
	plan_id: string;
	household_id?: string;
	theme_text: string;
	rationale?: string;
}

export interface BookmarkConceptParams {
	plan_id: string;
	movement_id?: string | null;
	title: string;
	format?: string | null;
	cuisine: string[];
	source_kind: ConceptSourceKind;
	source_ref?: string | null;
	raw_ingredients?: ConceptCardRawIngredient[];
	formula_ids?: string[];
	est_active_min?: number | null;
	est_idle_min?: number | null;
	rationale?: string | null;
	vibe_tags?: string[];
}

export interface ListConceptsOptions {
	status?: ConceptStatus;
	limit?: number;
}

export interface TetrisScoreInput {
	plan_id: string;
	concept_id: string;
	candidate_slot: { date: string; slot: MiseMealSlot };
}

export interface TetrisScoreBreakdown {
	cuisine_fit: number;
	format_diversity: number;
	leftover_continuity: number;
	prep_budget: number;
	shop_efficiency: number;
	cross_meal_reuse: number;
	seasonality: number;
	weather_fit: number;
	calendar_fit: number;
	anchor_pressure: number;
	taste_feedback: number;
}

export interface TetrisScoreResult {
	concept_id: string;
	candidate_slot: { date: string; slot: MiseMealSlot };
	total_score: number;
	breakdown: TetrisScoreBreakdown;
	warnings: string[];
}

export interface AutoTetrisFitResult {
	scored: number;
	best_assignments: Array<{
		concept_id: string;
		suggested_slot: { date: string; slot: MiseMealSlot };
		score: number;
	}>;
}

// ─── Schema migration ───────────────────────────────────────────────────────

const SCHEMA_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS mise_plan_movements (
		movement_id TEXT PRIMARY KEY,
		plan_id TEXT NOT NULL,
		household_id TEXT,
		theme_text TEXT NOT NULL,
		rationale TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_movements_plan ON mise_plan_movements(plan_id)`,
	`CREATE TABLE IF NOT EXISTS mise_concept_board (
		concept_id TEXT PRIMARY KEY,
		plan_id TEXT NOT NULL,
		movement_id TEXT,
		title TEXT NOT NULL,
		format TEXT,
		cuisine_json TEXT NOT NULL DEFAULT '[]',
		source_kind TEXT NOT NULL,
		source_ref TEXT,
		raw_ingredients_json TEXT NOT NULL DEFAULT '[]',
		formula_ids_json TEXT NOT NULL DEFAULT '[]',
		est_active_min INTEGER,
		est_idle_min INTEGER,
		rationale TEXT,
		vibe_tags_json TEXT DEFAULT '[]',
		status TEXT NOT NULL DEFAULT 'candidate',
		committed_to_slot TEXT,
		tetris_score REAL,
		tetris_score_breakdown_json TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_concepts_plan ON mise_concept_board(plan_id, status)`,
];

export async function migrateConceptBoardSchema(env: MiseGraphEnv): Promise<void> {
	for (const sql of SCHEMA_STATEMENTS) {
		await env.DB.prepare(sql).run();
	}
}

// ─── Movements ──────────────────────────────────────────────────────────────

export async function setMovement(env: MiseGraphEnv, params: SetMovementParams): Promise<PlanMovement> {
	await migrateConceptBoardSchema(env);
	const planId = trim(params.plan_id);
	if (!planId) throw new Error("setMovement: plan_id required");
	const themeText = trim(params.theme_text);
	if (!themeText) throw new Error("setMovement: theme_text required");

	const householdId = params.household_id ? trim(params.household_id) || null : null;
	const rationale = params.rationale ? trim(params.rationale) || null : null;
	const now = new Date().toISOString();
	const movement_id = generateMovementId(planId, now);

	const movement: PlanMovement = {
		movement_id,
		plan_id: planId,
		household_id: householdId,
		theme_text: themeText,
		rationale,
		created_at: now,
	};

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_plan_movements
			(movement_id, plan_id, household_id, theme_text, rationale, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			movement.movement_id,
			movement.plan_id,
			movement.household_id,
			movement.theme_text,
			movement.rationale,
			movement.created_at,
		)
		.run();

	return movement;
}

export async function getMovement(env: MiseGraphEnv, plan_id: string): Promise<PlanMovement | null> {
	const id = trim(plan_id);
	if (!id) return null;
	let row: MovementRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT movement_id, plan_id, household_id, theme_text, rationale, created_at
			 FROM mise_plan_movements
			 WHERE plan_id = ?
			 ORDER BY created_at DESC
			 LIMIT 1`,
		).bind(id).first<MovementRow>();
	} catch {
		return null;
	}
	return row ? rowToMovement(row) : null;
}

interface MovementRow {
	movement_id: string;
	plan_id: string;
	household_id: string | null;
	theme_text: string;
	rationale: string | null;
	created_at: string;
}

function rowToMovement(row: MovementRow): PlanMovement {
	return {
		movement_id: row.movement_id,
		plan_id: row.plan_id,
		household_id: row.household_id || null,
		theme_text: row.theme_text,
		rationale: row.rationale || null,
		created_at: row.created_at,
	};
}

// ─── Concept board CRUD ─────────────────────────────────────────────────────

export async function bookmarkConcept(env: MiseGraphEnv, params: BookmarkConceptParams): Promise<ConceptCard> {
	await migrateConceptBoardSchema(env);
	const planId = trim(params.plan_id);
	if (!planId) throw new Error("bookmarkConcept: plan_id required");
	const title = trim(params.title);
	if (!title) throw new Error("bookmarkConcept: title required");
	const sourceKind = params.source_kind;
	if (!sourceKind) throw new Error("bookmarkConcept: source_kind required");

	const now = new Date().toISOString();
	const concept_id = generateConceptId(planId, title, now);

	const card: ConceptCard = {
		concept_id,
		plan_id: planId,
		movement_id: params.movement_id ? trim(params.movement_id) || null : null,
		title,
		format: params.format ? trim(params.format) || null : null,
		cuisine: cleanStringArray(params.cuisine),
		source_kind: sourceKind,
		source_ref: params.source_ref ? trim(params.source_ref) || null : null,
		raw_ingredients: cleanIngredients(params.raw_ingredients),
		formula_ids: cleanStringArray(params.formula_ids),
		est_active_min: numberOrNull(params.est_active_min),
		est_idle_min: numberOrNull(params.est_idle_min),
		rationale: params.rationale ? trim(params.rationale) || null : null,
		vibe_tags: cleanStringArray(params.vibe_tags),
		status: "candidate",
		committed_to_slot: null,
		tetris_score: null,
		tetris_score_breakdown: null,
		created_at: now,
		updated_at: now,
	};

	await persistConcept(env, card);
	return card;
}

async function persistConcept(env: MiseGraphEnv, card: ConceptCard): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_concept_board
			(concept_id, plan_id, movement_id, title, format, cuisine_json,
			 source_kind, source_ref, raw_ingredients_json, formula_ids_json,
			 est_active_min, est_idle_min, rationale, vibe_tags_json,
			 status, committed_to_slot, tetris_score, tetris_score_breakdown_json,
			 created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			card.concept_id,
			card.plan_id,
			card.movement_id,
			card.title,
			card.format,
			JSON.stringify(card.cuisine),
			card.source_kind,
			card.source_ref,
			JSON.stringify(card.raw_ingredients),
			JSON.stringify(card.formula_ids),
			card.est_active_min,
			card.est_idle_min,
			card.rationale,
			JSON.stringify(card.vibe_tags),
			card.status,
			card.committed_to_slot,
			card.tetris_score,
			card.tetris_score_breakdown ? JSON.stringify(card.tetris_score_breakdown) : null,
			card.created_at,
			card.updated_at,
		)
		.run();
}

export async function getConcept(env: MiseGraphEnv, concept_id: string): Promise<ConceptCard | null> {
	const id = trim(concept_id);
	if (!id) return null;
	let row: ConceptRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT concept_id, plan_id, movement_id, title, format, cuisine_json,
			        source_kind, source_ref, raw_ingredients_json, formula_ids_json,
			        est_active_min, est_idle_min, rationale, vibe_tags_json,
			        status, committed_to_slot, tetris_score, tetris_score_breakdown_json,
			        created_at, updated_at
			 FROM mise_concept_board
			 WHERE concept_id = ?
			 LIMIT 1`,
		).bind(id).first<ConceptRow>();
	} catch {
		return null;
	}
	return row ? rowToConcept(row) : null;
}

export async function listConcepts(env: MiseGraphEnv, plan_id: string, opts: ListConceptsOptions = {}): Promise<ConceptCard[]> {
	const id = trim(plan_id);
	if (!id) return [];
	const limit = clampPositiveInt(opts.limit, 100);
	let rows: ConceptRow[] = [];
	try {
		const result = opts.status
			? await env.DB.prepare(
				`SELECT concept_id, plan_id, movement_id, title, format, cuisine_json,
				        source_kind, source_ref, raw_ingredients_json, formula_ids_json,
				        est_active_min, est_idle_min, rationale, vibe_tags_json,
				        status, committed_to_slot, tetris_score, tetris_score_breakdown_json,
				        created_at, updated_at
				 FROM mise_concept_board
				 WHERE plan_id = ? AND status = ?
				 ORDER BY created_at
				 LIMIT ?`,
			).bind(id, opts.status, limit).all<ConceptRow>()
			: await env.DB.prepare(
				`SELECT concept_id, plan_id, movement_id, title, format, cuisine_json,
				        source_kind, source_ref, raw_ingredients_json, formula_ids_json,
				        est_active_min, est_idle_min, rationale, vibe_tags_json,
				        status, committed_to_slot, tetris_score, tetris_score_breakdown_json,
				        created_at, updated_at
				 FROM mise_concept_board
				 WHERE plan_id = ?
				 ORDER BY created_at
				 LIMIT ?`,
			).bind(id, limit).all<ConceptRow>();
		rows = (result.results || []) as ConceptRow[];
	} catch {
		return [];
	}
	return rows.map(rowToConcept);
}

export async function updateConceptStatus(
	env: MiseGraphEnv,
	concept_id: string,
	status: ConceptStatus,
	committed_to_slot?: string,
): Promise<ConceptCard> {
	const id = trim(concept_id);
	if (!id) throw new Error("updateConceptStatus: concept_id required");
	const existing = await getConcept(env, id);
	if (!existing) throw new Error(`updateConceptStatus: concept ${id} not found`);

	const next: ConceptCard = {
		...existing,
		status,
		committed_to_slot: committed_to_slot ? trim(committed_to_slot) || null : (status === "committed" ? existing.committed_to_slot : null),
		updated_at: new Date().toISOString(),
	};
	await persistConcept(env, next);
	return next;
}

export async function discardConcept(env: MiseGraphEnv, concept_id: string, reason?: string): Promise<void> {
	const id = trim(concept_id);
	if (!id) return;
	const existing = await getConcept(env, id);
	if (!existing) return;
	const next: ConceptCard = {
		...existing,
		status: "discarded",
		rationale: reason ? `${existing.rationale || ""}${existing.rationale ? " | " : ""}discarded: ${trim(reason)}`.trim() : existing.rationale,
		updated_at: new Date().toISOString(),
	};
	await persistConcept(env, next);
}

export async function shortlistTopConcepts(
	env: MiseGraphEnv,
	plan_id: string,
	top_n: number = 7,
): Promise<ConceptCard[]> {
	const cards = await listConcepts(env, plan_id);
	const eligible = cards.filter(c => c.status === "candidate" || c.status === "shortlisted");
	const scored = [...eligible]
		.map(c => ({ c, score: c.tetris_score ?? -Infinity }))
		.sort((a, b) => b.score - a.score);

	const cap = clampPositiveInt(top_n, 7);
	const winners: ConceptCard[] = [];
	for (let i = 0; i < scored.length; i++) {
		const card = scored[i].c;
		const wantStatus: ConceptStatus = i < cap ? "shortlisted" : "candidate";
		if (card.status !== wantStatus) {
			const updated = await updateConceptStatus(env, card.concept_id, wantStatus);
			if (i < cap) winners.push(updated);
		} else if (i < cap) {
			winners.push(card);
		}
	}
	return winners;
}

interface ConceptRow {
	concept_id: string;
	plan_id: string;
	movement_id: string | null;
	title: string;
	format: string | null;
	cuisine_json: string;
	source_kind: string;
	source_ref: string | null;
	raw_ingredients_json: string;
	formula_ids_json: string;
	est_active_min: number | null;
	est_idle_min: number | null;
	rationale: string | null;
	vibe_tags_json: string | null;
	status: string;
	committed_to_slot: string | null;
	tetris_score: number | null;
	tetris_score_breakdown_json: string | null;
	created_at: string;
	updated_at: string;
}

function rowToConcept(row: ConceptRow): ConceptCard {
	return {
		concept_id: row.concept_id,
		plan_id: row.plan_id,
		movement_id: row.movement_id || null,
		title: row.title,
		format: row.format || null,
		cuisine: parseStringArray(row.cuisine_json),
		source_kind: (row.source_kind as ConceptSourceKind) || "manual",
		source_ref: row.source_ref || null,
		raw_ingredients: parseIngredients(row.raw_ingredients_json),
		formula_ids: parseStringArray(row.formula_ids_json),
		est_active_min: numberOrNull(row.est_active_min),
		est_idle_min: numberOrNull(row.est_idle_min),
		rationale: row.rationale || null,
		vibe_tags: parseStringArray(row.vibe_tags_json),
		status: (row.status as ConceptStatus) || "candidate",
		committed_to_slot: row.committed_to_slot || null,
		tetris_score: numberOrNull(row.tetris_score),
		tetris_score_breakdown: parseBreakdown(row.tetris_score_breakdown_json),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

// ─── Tetris scoring ─────────────────────────────────────────────────────────

const SCORE_DIMS: Array<keyof TetrisScoreBreakdown> = [
	"cuisine_fit",
	"format_diversity",
	"leftover_continuity",
	"prep_budget",
	"shop_efficiency",
	"cross_meal_reuse",
	"seasonality",
	"weather_fit",
	"calendar_fit",
	"anchor_pressure",
	"taste_feedback",
];

export async function scoreTetris(env: MiseGraphEnv, input: TetrisScoreInput): Promise<TetrisScoreResult> {
	const concept = await getConcept(env, input.concept_id);
	if (!concept) throw new Error(`scoreTetris: concept ${input.concept_id} not found`);
	const plan = await loadActivePlan(env, input.plan_id);
	const breakdown = computeBreakdown(concept, input.candidate_slot, plan);
	const total = scaleToHundred(breakdown);
	const warnings: string[] = [];
	if (!plan) warnings.push("plan_not_loaded: scoring used neutral defaults");
	if (plan && slotOccupied(plan, input.candidate_slot.date, input.candidate_slot.slot)) {
		warnings.push("slot_occupied");
	}
	return {
		concept_id: input.concept_id,
		candidate_slot: input.candidate_slot,
		total_score: total,
		breakdown,
		warnings,
	};
}

function computeBreakdown(
	concept: ConceptCard,
	slot: { date: string; slot: MiseMealSlot },
	plan: MiseWeeklyPlanDraft | null,
): TetrisScoreBreakdown {
	const composedMeals = plan ? collectComposedMeals(plan) : [];
	const composedFormats = composedMeals.map(m => (m.format || "").toLowerCase()).filter(Boolean);
	const composedCuisines = composedMeals.flatMap(m => (m.cuisine || []).map(c => c.toLowerCase())).filter(Boolean);
	const composedIngredientNames = new Set<string>();
	for (const m of composedMeals) {
		for (const r of m.raw_ingredients || []) composedIngredientNames.add(r.name.toLowerCase());
		for (const n of m.ingredient_names || []) composedIngredientNames.add(n.toLowerCase());
	}

	// cuisine_fit: -10..+10 based on whether the cuisine adds variety vs piles up.
	let cuisine_fit = 0;
	if (concept.cuisine.length === 0) {
		cuisine_fit = 0;
	} else {
		let saturated = 0;
		let novel = 0;
		for (const c of concept.cuisine) {
			const lc = c.toLowerCase();
			const usage = composedCuisines.filter(x => x === lc).length;
			if (usage === 0) novel++;
			else if (usage >= 3) saturated++;
		}
		cuisine_fit = clampScore(novel * 5 - saturated * 6);
		// Movement direction match — if the plan's constraints carry a cuisine_direction,
		// boost when the concept overlaps it.
		const direction = readCuisineDirection(plan);
		if (direction.length > 0) {
			const overlap = concept.cuisine.some(c => direction.includes(c.toLowerCase()));
			cuisine_fit = clampScore(cuisine_fit + (overlap ? 4 : -2));
		}
	}

	// format_diversity: -10..+10 — does it bring a format we don't have yet?
	let format_diversity = 0;
	if (concept.format) {
		const lf = concept.format.toLowerCase();
		const repeats = composedFormats.filter(f => f === lf).length;
		if (repeats === 0) format_diversity = clampScore(8);
		else if (repeats === 1) format_diversity = clampScore(2);
		else if (repeats === 2) format_diversity = clampScore(-3);
		else format_diversity = clampScore(-8);
	}

	// leftover_continuity: -10..+10 — does this consume an upstream raw ingredient?
	let leftover_continuity = 0;
	if (concept.raw_ingredients.length > 0) {
		let overlap = 0;
		for (const r of concept.raw_ingredients) {
			if (composedIngredientNames.has(r.name.toLowerCase())) overlap++;
		}
		leftover_continuity = clampScore(overlap * 4);
	}

	// prep_budget: penalize if active prep is huge on a day that already has lots of prep.
	let prep_budget = 0;
	if (concept.est_active_min !== null && plan) {
		const dayActive = composedMeals
			.filter(m => m.date === slot.date)
			.reduce((sum, m) => sum + (m.active_time_min || 0), 0);
		const projected = dayActive + (concept.est_active_min || 0);
		if (projected <= 30) prep_budget = clampScore(6);
		else if (projected <= 60) prep_budget = clampScore(3);
		else if (projected <= 90) prep_budget = clampScore(0);
		else if (projected <= 120) prep_budget = clampScore(-4);
		else prep_budget = clampScore(-9);
	}

	// shop_efficiency: reward concepts that lean on already-shopped items.
	let shop_efficiency = 0;
	if (plan && concept.raw_ingredients.length > 0) {
		const shopped = collectShoppedNames(plan);
		const reused = concept.raw_ingredients.filter(r => shopped.has(r.name.toLowerCase())).length;
		shop_efficiency = clampScore(reused * 3);
	}

	// cross_meal_reuse: reward overlap with existing component batches.
	let cross_meal_reuse = 0;
	if (plan && plan.component_batches && concept.raw_ingredients.length > 0) {
		const batchInputs = new Set<string>();
		for (const b of plan.component_batches) {
			for (const n of b.input_names || []) batchInputs.add(n.toLowerCase());
		}
		const reused = concept.raw_ingredients.filter(r => batchInputs.has(r.name.toLowerCase())).length;
		cross_meal_reuse = clampScore(reused * 4);
	}

	// calendar_fit: weekend slots favor higher-effort meals; weekdays favor quick.
	let calendar_fit = 0;
	const dow = dayOfWeek(slot.date);
	const isWeekend = dow === 0 || dow === 6;
	if (concept.est_active_min !== null) {
		if (isWeekend && concept.est_active_min >= 45) calendar_fit = clampScore(6);
		else if (!isWeekend && concept.est_active_min <= 30) calendar_fit = clampScore(5);
		else if (!isWeekend && concept.est_active_min >= 75) calendar_fit = clampScore(-5);
		else calendar_fit = clampScore(1);
	}

	// weather_fit: hot day cues hint that cold/raw formats win.
	const weather_fit = computeWeatherFit(concept, slot, plan);

	// Stubbed dimensions — wired but not yet computed in this version.
	const seasonality = 0;
	const anchor_pressure = 0;
	const taste_feedback = 0;

	return {
		cuisine_fit,
		format_diversity,
		leftover_continuity,
		prep_budget,
		shop_efficiency,
		cross_meal_reuse,
		seasonality,
		weather_fit,
		calendar_fit,
		anchor_pressure,
		taste_feedback,
	};
}

function computeWeatherFit(
	concept: ConceptCard,
	slot: { date: string; slot: MiseMealSlot },
	plan: MiseWeeklyPlanDraft | null,
): number {
	if (!plan) return 0;
	const constraints = plan.constraints as Record<string, unknown> | undefined;
	const weatherList = constraints?.weather_by_day;
	if (!Array.isArray(weatherList)) return 0;
	const entry = weatherList.find(e =>
		!!e && typeof e === "object" && (e as Record<string, unknown>).date === slot.date,
	) as { hint?: string; high_f?: number } | undefined;
	if (!entry) return 0;

	const format = (concept.format || "").toLowerCase();
	const tags = concept.vibe_tags.map(t => t.toLowerCase());
	const hint = (entry.hint || "").toLowerCase();
	const isHot = (typeof entry.high_f === "number" && entry.high_f >= 85) || hint.includes("hot");
	const isCold = (typeof entry.high_f === "number" && entry.high_f <= 50) || hint.includes("cold");

	const coldFormats = ["salad", "grain bowl", "ceviche", "tartare", "cold-noodle"];
	const warmFormats = ["soup", "stew", "braise", "casserole", "skillet"];

	if (isHot) {
		if (coldFormats.some(f => format.includes(f)) || tags.some(t => /no[\s_-]?oven|cold|grill/.test(t))) return 7;
		if (warmFormats.some(f => format.includes(f))) return -6;
	}
	if (isCold) {
		if (warmFormats.some(f => format.includes(f))) return 7;
		if (coldFormats.some(f => format.includes(f))) return -4;
	}
	return 0;
}

export async function autoTetrisFit(env: MiseGraphEnv, plan_id: string): Promise<AutoTetrisFitResult> {
	const cards = await listConcepts(env, plan_id);
	const candidates = cards.filter(c => c.status === "candidate" || c.status === "shortlisted");
	if (candidates.length === 0) return { scored: 0, best_assignments: [] };

	const plan = await loadActivePlan(env, plan_id);
	const emptySlots = plan ? collectEmptySlots(plan) : [];
	if (emptySlots.length === 0) {
		// Fall back to scoring the concept against a synthetic Saturday-dinner
		// slot so the agent still sees relative scores for sanity.
		const fallbackSlot = { date: "1970-01-03", slot: "dinner" as MiseMealSlot };
		const assignments = [];
		for (const card of candidates) {
			const result = await scoreTetris(env, {
				plan_id,
				concept_id: card.concept_id,
				candidate_slot: fallbackSlot,
			});
			const updated: ConceptCard = {
				...card,
				tetris_score: result.total_score,
				tetris_score_breakdown: breakdownToRecord(result.breakdown),
				updated_at: new Date().toISOString(),
			};
			await persistConcept(env, updated);
			assignments.push({
				concept_id: card.concept_id,
				suggested_slot: fallbackSlot,
				score: result.total_score,
			});
		}
		return { scored: candidates.length, best_assignments: assignments };
	}

	const assignments: Array<{ concept_id: string; suggested_slot: { date: string; slot: MiseMealSlot }; score: number }> = [];
	for (const card of candidates) {
		let bestSlot = emptySlots[0];
		let bestScore = -Infinity;
		let bestBreakdown: TetrisScoreBreakdown | null = null;
		for (const slot of emptySlots) {
			const result = await scoreTetris(env, { plan_id, concept_id: card.concept_id, candidate_slot: slot });
			if (result.total_score > bestScore) {
				bestScore = result.total_score;
				bestSlot = slot;
				bestBreakdown = result.breakdown;
			}
		}
		const updated: ConceptCard = {
			...card,
			tetris_score: bestScore,
			tetris_score_breakdown: bestBreakdown ? breakdownToRecord(bestBreakdown) : null,
			updated_at: new Date().toISOString(),
		};
		await persistConcept(env, updated);
		assignments.push({
			concept_id: card.concept_id,
			suggested_slot: bestSlot,
			score: bestScore,
		});
	}

	return { scored: candidates.length, best_assignments: assignments };
}

function breakdownToRecord(breakdown: TetrisScoreBreakdown): Record<string, number> {
	const out: Record<string, number> = {};
	for (const k of SCORE_DIMS) out[k] = breakdown[k];
	return out;
}

// ─── Plan reading helpers ──────────────────────────────────────────────────

interface ComposedMealLike {
	date: string;
	slot: MiseMealSlot;
	format?: string;
	cuisine?: string[];
	raw_ingredients?: Array<{ name: string }>;
	ingredient_names?: string[];
	active_time_min?: number;
}

function collectComposedMeals(plan: MiseWeeklyPlanDraft): ComposedMealLike[] {
	const out: ComposedMealLike[] = [];
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) out.push(mealToLike(meal));
	}
	for (const b of plan.breakfasts || []) out.push(mealToLike(b));
	for (const s of plan.snack_boxes || []) out.push(snackToLike(s));
	return out;
}

function mealToLike(meal: MisePlanMeal): ComposedMealLike {
	return {
		date: meal.date,
		slot: meal.slot,
		format: meal.format,
		cuisine: meal.cuisine || [],
		raw_ingredients: (meal.raw_ingredients || []).map(r => ({ name: r.name })),
		ingredient_names: meal.ingredient_names || [],
		active_time_min: meal.active_time_min,
	};
}

function snackToLike(snack: MiseSnackBox): ComposedMealLike {
	return {
		date: snack.date,
		slot: "snack",
		format: undefined,
		cuisine: [],
		raw_ingredients: (snack.raw_ingredients || []).map(r => ({ name: r.name })),
		ingredient_names: snack.items || [],
	};
}

function collectEmptySlots(plan: MiseWeeklyPlanDraft): Array<{ date: string; slot: MiseMealSlot }> {
	const slots: Array<{ date: string; slot: MiseMealSlot }> = [];
	const allSlots: MiseMealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
	const dates = enumerateDates(plan.start_date, plan.end_date);
	for (const date of dates) {
		for (const slot of allSlots) {
			if (!slotOccupied(plan, date, slot)) slots.push({ date, slot });
		}
	}
	return slots;
}

function slotOccupied(plan: MiseWeeklyPlanDraft, date: string, slot: MiseMealSlot): boolean {
	if (slot === "snack") return !!(plan.snack_boxes || []).find(s => s.date === date);
	if (slot === "breakfast") {
		if ((plan.breakfasts || []).some(b => b.date === date)) return true;
	}
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		if (day.meals.some(m => normalizeSlot(m.slot) === slot)) return true;
	}
	return false;
}

function normalizeSlot(slot: string): MiseMealSlot {
	const lower = (slot || "").toLowerCase().trim();
	if (lower === "breakfast" || lower === "lunch" || lower === "dinner" || lower === "snack") return lower;
	return "dinner";
}

function collectShoppedNames(plan: MiseWeeklyPlanDraft): Set<string> {
	const out = new Set<string>();
	for (const section of plan.shopping_list || []) {
		for (const item of section.items || []) {
			if (item.name) out.add(item.name.toLowerCase());
		}
	}
	return out;
}

function readCuisineDirection(plan: MiseWeeklyPlanDraft | null): string[] {
	if (!plan) return [];
	const constraints = plan.constraints as Record<string, unknown> | undefined;
	const direction = constraints?.cuisine_direction;
	if (!Array.isArray(direction)) return [];
	return direction.filter((s): s is string => typeof s === "string").map(s => s.toLowerCase());
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampScore(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n > 10) return 10;
	if (n < -10) return -10;
	return Math.round(n * 10) / 10;
}

function scaleToHundred(breakdown: TetrisScoreBreakdown): number {
	let sum = 0;
	for (const k of SCORE_DIMS) sum += breakdown[k];
	// Each dimension is -10..+10, total range across N dims is -10N..+10N.
	const max = SCORE_DIMS.length * 10;
	const normalized = (sum + max) / (2 * max); // 0..1
	const clamped = Math.max(0, Math.min(1, normalized));
	return Math.round(clamped * 1000) / 10; // 0..100, one decimal
}

function dayOfWeek(date: string): number {
	const ms = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(ms)) return 1;
	return new Date(ms).getUTCDay();
}

function enumerateDates(start: string, end: string): string[] {
	if (!isIsoDate(start) || !isIsoDate(end)) return [];
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
	const out: string[] = [];
	const cursor = new Date(startMs);
	while (cursor.getTime() <= endMs && out.length < 60) {
		out.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function trim(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim();
}

function cleanStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	return out;
}

function cleanIngredients(value: unknown): ConceptCardRawIngredient[] {
	if (!Array.isArray(value)) return [];
	const out: ConceptCardRawIngredient[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const name = typeof r.name === "string" ? r.name.trim() : "";
		if (!name) continue;
		const cleaned: ConceptCardRawIngredient = { name };
		if (typeof r.qty === "number" && Number.isFinite(r.qty)) cleaned.qty = r.qty;
		if (typeof r.unit === "string" && r.unit.trim()) cleaned.unit = r.unit.trim();
		if (typeof r.grams === "number" && Number.isFinite(r.grams)) cleaned.grams = r.grams;
		out.push(cleaned);
	}
	return out;
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function parseStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((i): i is string => typeof i === "string");
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed.filter((i): i is string => typeof i === "string");
		} catch { /* not JSON */ }
	}
	return [];
}

function parseIngredients(value: unknown): ConceptCardRawIngredient[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return cleanIngredients(parsed);
	} catch {
		return [];
	}
}

function parseBreakdown(value: unknown): Record<string, number> | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, number> = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
			}
			return out;
		}
	} catch { /* not JSON */ }
	return null;
}

function clampPositiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), 500);
}

function generateMovementId(plan_id: string, isoTime: string): string {
	const stamp = isoTime.replace(/[^0-9]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	const planSlug = plan_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24);
	return `mov_${planSlug}_${stamp}_${rand}`;
}

function generateConceptId(plan_id: string, title: string, isoTime: string): string {
	const stamp = isoTime.replace(/[^0-9]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 6);
	const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);
	const planSlug = plan_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 16);
	return `con_${planSlug}_${titleSlug}_${stamp}_${rand}`;
}

// Re-export saveActivePlan so callers that want to round-trip a plan after
// commit_concept don't need to import it themselves.
export { saveActivePlan } from "./active-plans";
