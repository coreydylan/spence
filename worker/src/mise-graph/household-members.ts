// Household members — per-person identity, skills, safety, preferences.
//
// Wave 6 makes "household = single person" go away. Where the household
// profile holds household-wide defaults (people_count, household dietary,
// equipment), members layer per-person overrides on top:
//   * dietary tags ("the kid hates cilantro")
//   * preferences (loves / dislikes / allergies)
//   * safety (kid: stove_authorized=false, knife_authorized="supervised")
//   * skills with auto-learning confidence (knife_basic 0.8, dough 0.0, ...)
//
// Skill confidence is updated by recordSkillOutcome whenever the brigade
// scheduler reports a task outcome:
//   success +0.05, partial +0.02, retry +0.01, failure -0.03
// All clamped to [0, 1]. speed_multiplier is the average actual/expected
// duration over the last 10 history entries for the same skill.
//
// Storage: mise_household_members + mise_member_skills + mise_member_skill_history
// (see schema-members.sql / admin-household-memory.ts migration).

import type { MiseGraphEnv } from "./types";

export type AgeGroup = "adult" | "teen" | "kid" | "toddler";
export type SkillOutcome = "success" | "partial" | "failure" | "retry";

export interface MemberSafety {
	stove_authorized: boolean;
	oven_authorized: boolean;
	knife_authorized: boolean | "supervised";
	heavy_lift_authorized: boolean;
	sharp_oils_authorized: boolean;
	minimum_supervision: "none" | "adult" | "designated";
}

export interface MemberSkill {
	skill_name: string;
	confidence: number;          // 0..1
	tasks_completed: number;
	last_used_at: string | null;
	speed_multiplier: number;
}

export interface MemberPreferences {
	loves: string[];
	dislikes: string[];
	allergies: string[];
}

export interface MemberPrivacy {
	share_skills_with_household: boolean;
	share_tastes_with_household: boolean;
}

export interface HouseholdMember {
	member_id: string;
	household_id: string;
	display_name: string;
	age_group: AgeGroup;
	dietary: string[];
	preferences: MemberPreferences;
	safety: MemberSafety;
	skills: MemberSkill[];
	active_skill_quests: string[];
	privacy: MemberPrivacy;
	created_at: string;
	updated_at: string;
}

export interface UpsertMemberInput {
	member_id?: string;
	household_id: string;
	display_name: string;
	age_group?: AgeGroup;
	dietary?: string[];
	preferences?: Partial<MemberPreferences>;
	safety?: Partial<MemberSafety>;
	active_skill_quests?: string[];
	privacy?: Partial<MemberPrivacy>;
}

export interface RecordSkillOutcomeParams {
	member_id: string;
	skill_name: string;
	outcome: SkillOutcome;
	duration_actual_min?: number;
	duration_expected_min?: number;
	user_rating?: number;
	task_id?: string;
	meal_id?: string;
	notes?: string;
}

export interface RecordSkillOutcomeResult {
	new_confidence: number;
	tasks_completed: number;
	speed_multiplier: number;
}

export interface CanDoTaskInput {
	required_skill: string;
	min_confidence?: number;
	safety_required?: Partial<MemberSafety>;
}

export interface CanDoTaskResult {
	ok: boolean;
	reason?: string;
}

const VALID_AGE_GROUPS: ReadonlyArray<AgeGroup> = ["adult", "teen", "kid", "toddler"];
const VALID_OUTCOMES: ReadonlyArray<SkillOutcome> = ["success", "partial", "failure", "retry"];

const CONFIDENCE_DELTA: Record<SkillOutcome, number> = {
	success: 0.05,
	partial: 0.02,
	retry: 0.01,
	failure: -0.03,
};

const SPEED_WINDOW = 10;

const MEMBER_COLS = `member_id, household_id, display_name, age_group,
	dietary_json, preferences_json, safety_json, active_skill_quests_json,
	privacy_json, created_at, updated_at`;
const SKILL_COLS = `member_id, skill_name, confidence, tasks_completed,
	last_used_at, speed_multiplier, notes`;
const HISTORY_COLS = `history_id, member_id, skill_name, task_id, meal_id,
	outcome, duration_actual_min, duration_expected_min, user_rating, notes,
	recorded_at`;

interface MemberRow {
	member_id: string;
	household_id: string;
	display_name: string;
	age_group: string;
	dietary_json: string | null;
	preferences_json: string | null;
	safety_json: string | null;
	active_skill_quests_json: string | null;
	privacy_json: string | null;
	created_at: string;
	updated_at: string;
}

interface SkillRow {
	member_id: string;
	skill_name: string;
	confidence: number;
	tasks_completed: number;
	last_used_at: string | null;
	speed_multiplier: number;
	notes: string | null;
}

interface HistoryRow {
	history_id: string;
	member_id: string;
	skill_name: string;
	task_id: string | null;
	meal_id: string | null;
	outcome: string;
	duration_actual_min: number | null;
	duration_expected_min: number | null;
	user_rating: number | null;
	notes: string | null;
	recorded_at: string;
}

// ─── Default profiles by age group ──────────────────────────────────────────

export function defaultSkillsFor(age_group: AgeGroup): MemberSkill[] {
	const now: string | null = null;
	const seed = (name: string, confidence: number): MemberSkill => ({
		skill_name: name,
		confidence,
		tasks_completed: 0,
		last_used_at: now,
		speed_multiplier: 1.0,
	});
	switch (age_group) {
		case "adult":
			return [
				seed("knife_basic", 0.7),
				seed("saute", 0.7),
				seed("baking", 0.5),
				seed("emulsion", 0.4),
				seed("dough", 0.3),
				seed("timing", 0.7),
				seed("plating", 0.6),
			];
		case "teen":
			return [
				seed("knife_basic", 0.4),
				seed("saute", 0.4),
				seed("baking", 0.5),
				seed("plating", 0.5),
			];
		case "kid":
			return [
				seed("measuring", 0.7),
				seed("mixing", 0.7),
				seed("washing", 0.8),
				seed("pouring", 0.6),
			];
		case "toddler":
			return [
				seed("stirring", 0.5),
				seed("pouring", 0.3),
			];
	}
}

export function defaultSafetyFor(age_group: AgeGroup): MemberSafety {
	switch (age_group) {
		case "adult":
			return {
				stove_authorized: true,
				oven_authorized: true,
				knife_authorized: true,
				heavy_lift_authorized: true,
				sharp_oils_authorized: true,
				minimum_supervision: "none",
			};
		case "teen":
			return {
				stove_authorized: true,
				oven_authorized: true,
				knife_authorized: true,
				heavy_lift_authorized: true,
				sharp_oils_authorized: false,
				minimum_supervision: "none",
			};
		case "kid":
			return {
				stove_authorized: false,
				oven_authorized: false,
				knife_authorized: "supervised",
				heavy_lift_authorized: false,
				sharp_oils_authorized: false,
				minimum_supervision: "adult",
			};
		case "toddler":
			return {
				stove_authorized: false,
				oven_authorized: false,
				knife_authorized: false,
				heavy_lift_authorized: false,
				sharp_oils_authorized: false,
				minimum_supervision: "adult",
			};
	}
}

function defaultPreferences(): MemberPreferences {
	return { loves: [], dislikes: [], allergies: [] };
}

function defaultPrivacy(): MemberPrivacy {
	return { share_skills_with_household: true, share_tastes_with_household: true };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function getMember(
	env: MiseGraphEnv,
	member_id: string,
): Promise<HouseholdMember | null> {
	const id = (member_id || "").trim();
	if (!id) return null;
	let row: MemberRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT ${MEMBER_COLS} FROM mise_household_members WHERE member_id = ?`,
		).bind(id).first<MemberRow>();
	} catch {
		return null;
	}
	if (!row) return null;
	const skills = await loadSkillsForMember(env, id);
	return rowToMember(row, skills);
}

export async function listMembers(
	env: MiseGraphEnv,
	household_id: string,
): Promise<HouseholdMember[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	let rows: MemberRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT ${MEMBER_COLS} FROM mise_household_members
			 WHERE household_id = ?
			 ORDER BY created_at ASC`,
		).bind(hh).all<MemberRow>();
		rows = (result.results || []) as MemberRow[];
	} catch {
		return [];
	}
	const out: HouseholdMember[] = [];
	for (const row of rows) {
		const skills = await loadSkillsForMember(env, row.member_id);
		out.push(rowToMember(row, skills));
	}
	return out;
}

export async function upsertMember(
	env: MiseGraphEnv,
	input: UpsertMemberInput,
): Promise<HouseholdMember> {
	const hh = (input.household_id || "").trim();
	if (!hh) throw new Error("upsertMember: household_id required");
	const display_name = (input.display_name || "").trim();
	if (!display_name) throw new Error("upsertMember: display_name required");
	const age_group = normalizeAgeGroup(input.age_group);
	const member_id = (input.member_id && input.member_id.trim()) || generateMemberId(hh, display_name);

	const existing = await getMember(env, member_id);
	const now = new Date().toISOString();
	const created_at = existing?.created_at || now;

	const merged: HouseholdMember = {
		member_id,
		household_id: hh,
		display_name,
		age_group,
		dietary: input.dietary !== undefined
			? cleanStringArray(input.dietary)
			: existing?.dietary ?? [],
		preferences: mergePreferences(existing?.preferences, input.preferences),
		safety: mergeSafety(age_group, existing?.safety, input.safety),
		skills: existing?.skills ?? [],
		active_skill_quests: input.active_skill_quests !== undefined
			? cleanStringArray(input.active_skill_quests)
			: existing?.active_skill_quests ?? [],
		privacy: mergePrivacy(existing?.privacy, input.privacy),
		created_at,
		updated_at: now,
	};

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_household_members (${MEMBER_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		merged.member_id,
		merged.household_id,
		merged.display_name,
		merged.age_group,
		JSON.stringify(merged.dietary),
		JSON.stringify(merged.preferences),
		JSON.stringify(merged.safety),
		JSON.stringify(merged.active_skill_quests),
		JSON.stringify(merged.privacy),
		merged.created_at,
		merged.updated_at,
	).run();

	// Seed default skills on first creation only.
	if (!existing) {
		const seeds = defaultSkillsFor(age_group);
		for (const skill of seeds) {
			await upsertSkillRow(env, member_id, skill);
		}
		merged.skills = seeds;
	}

	return merged;
}

export async function deleteMember(env: MiseGraphEnv, member_id: string): Promise<void> {
	const id = (member_id || "").trim();
	if (!id) return;
	await env.DB.prepare(
		`DELETE FROM mise_household_members WHERE member_id = ?`,
	).bind(id).run();
	await env.DB.prepare(
		`DELETE FROM mise_member_skills WHERE member_id = ?`,
	).bind(id).run();
	await env.DB.prepare(
		`DELETE FROM mise_member_presence WHERE member_id = ?`,
	).bind(id).run();
}

// ─── Skill auto-learning ────────────────────────────────────────────────────

export async function recordSkillOutcome(
	env: MiseGraphEnv,
	params: RecordSkillOutcomeParams,
): Promise<RecordSkillOutcomeResult> {
	const member_id = (params.member_id || "").trim();
	const skill_name = (params.skill_name || "").trim();
	if (!member_id) throw new Error("recordSkillOutcome: member_id required");
	if (!skill_name) throw new Error("recordSkillOutcome: skill_name required");
	if (!VALID_OUTCOMES.includes(params.outcome)) {
		throw new Error(`recordSkillOutcome: outcome must be one of ${VALID_OUTCOMES.join(", ")}`);
	}

	const now = new Date().toISOString();

	// 1. Append history row.
	const history_id = generateHistoryId(member_id, skill_name, now);
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_member_skill_history (${HISTORY_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		history_id,
		member_id,
		skill_name,
		params.task_id ?? null,
		params.meal_id ?? null,
		params.outcome,
		typeof params.duration_actual_min === "number" ? params.duration_actual_min : null,
		typeof params.duration_expected_min === "number" ? params.duration_expected_min : null,
		typeof params.user_rating === "number" ? params.user_rating : null,
		params.notes ?? null,
		now,
	).run();

	// 2. Load current skill row (or seed a fresh one).
	const existing = await loadSkillRow(env, member_id, skill_name);
	const prevConfidence = existing?.confidence ?? 0;
	const prevTasks = existing?.tasks_completed ?? 0;

	const delta = CONFIDENCE_DELTA[params.outcome];
	const new_confidence = clamp01(prevConfidence + delta);
	const tasks_completed = prevTasks + 1;

	// 3. Recompute speed_multiplier from last SPEED_WINDOW history rows.
	const speed_multiplier = await recomputeSpeedMultiplier(env, member_id, skill_name);

	const next: MemberSkill = {
		skill_name,
		confidence: new_confidence,
		tasks_completed,
		last_used_at: now,
		speed_multiplier,
	};
	await upsertSkillRow(env, member_id, next);

	return { new_confidence, tasks_completed, speed_multiplier };
}

async function recomputeSpeedMultiplier(
	env: MiseGraphEnv,
	member_id: string,
	skill_name: string,
): Promise<number> {
	let rows: HistoryRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT ${HISTORY_COLS} FROM mise_member_skill_history
			 WHERE member_id = ? AND skill_name = ?
			 ORDER BY recorded_at DESC
			 LIMIT ?`,
		).bind(member_id, skill_name, SPEED_WINDOW).all<HistoryRow>();
		rows = (result.results || []) as HistoryRow[];
	} catch {
		return 1.0;
	}
	const ratios: number[] = [];
	for (const row of rows) {
		const actual = typeof row.duration_actual_min === "number" ? row.duration_actual_min : null;
		const expected = typeof row.duration_expected_min === "number" ? row.duration_expected_min : null;
		if (actual === null || expected === null || expected <= 0 || actual <= 0) continue;
		ratios.push(actual / expected);
	}
	if (ratios.length === 0) return 1.0;
	const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
	return round3(avg);
}

// ─── Eligibility ────────────────────────────────────────────────────────────

export function canMemberDoTask(
	member: HouseholdMember,
	task: CanDoTaskInput,
): CanDoTaskResult {
	const required = (task.required_skill || "").trim();
	if (!required) return { ok: false, reason: "task missing required_skill" };

	// Skill check.
	const skill = member.skills.find(s => s.skill_name === required);
	const minConfidence = typeof task.min_confidence === "number" ? task.min_confidence : 0;
	if (!skill) {
		return { ok: false, reason: `member lacks skill ${required}` };
	}
	if (skill.confidence < minConfidence) {
		return {
			ok: false,
			reason: `member skill ${required} confidence ${skill.confidence.toFixed(2)} below required ${minConfidence.toFixed(2)}`,
		};
	}

	// Safety checks — every requested authorization must be allowed.
	const required_safety = task.safety_required || {};
	const safety = member.safety;

	if (required_safety.stove_authorized && !safety.stove_authorized) {
		return { ok: false, reason: "stove not authorized for member" };
	}
	if (required_safety.oven_authorized && !safety.oven_authorized) {
		return { ok: false, reason: "oven not authorized for member" };
	}
	if (required_safety.knife_authorized) {
		const memberKnife = safety.knife_authorized;
		if (memberKnife === false) {
			return { ok: false, reason: "knife not authorized for member" };
		}
		if (memberKnife === "supervised" && required_safety.knife_authorized === true) {
			return { ok: false, reason: "knife requires unsupervised authorization; member has supervised only" };
		}
	}
	if (required_safety.heavy_lift_authorized && !safety.heavy_lift_authorized) {
		return { ok: false, reason: "heavy lift not authorized for member" };
	}
	if (required_safety.sharp_oils_authorized && !safety.sharp_oils_authorized) {
		return { ok: false, reason: "sharp oils not authorized for member" };
	}

	return { ok: true };
}

// ─── Skill row helpers ──────────────────────────────────────────────────────

async function loadSkillsForMember(
	env: MiseGraphEnv,
	member_id: string,
): Promise<MemberSkill[]> {
	let rows: SkillRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT ${SKILL_COLS} FROM mise_member_skills
			 WHERE member_id = ?
			 ORDER BY skill_name ASC`,
		).bind(member_id).all<SkillRow>();
		rows = (result.results || []) as SkillRow[];
	} catch {
		return [];
	}
	return rows.map(rowToSkill);
}

async function loadSkillRow(
	env: MiseGraphEnv,
	member_id: string,
	skill_name: string,
): Promise<MemberSkill | null> {
	let row: SkillRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT ${SKILL_COLS} FROM mise_member_skills
			 WHERE member_id = ? AND skill_name = ?`,
		).bind(member_id, skill_name).first<SkillRow>();
	} catch {
		return null;
	}
	return row ? rowToSkill(row) : null;
}

async function upsertSkillRow(
	env: MiseGraphEnv,
	member_id: string,
	skill: MemberSkill,
): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_member_skills (${SKILL_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		member_id,
		skill.skill_name,
		clamp01(skill.confidence),
		Math.max(0, Math.floor(skill.tasks_completed || 0)),
		skill.last_used_at ?? null,
		Number.isFinite(skill.speed_multiplier) ? skill.speed_multiplier : 1.0,
		null,
	).run();
}

function rowToSkill(row: SkillRow): MemberSkill {
	return {
		skill_name: row.skill_name,
		confidence: typeof row.confidence === "number" ? clamp01(row.confidence) : 0,
		tasks_completed: typeof row.tasks_completed === "number" ? row.tasks_completed : 0,
		last_used_at: row.last_used_at ?? null,
		speed_multiplier: typeof row.speed_multiplier === "number" ? row.speed_multiplier : 1.0,
	};
}

// ─── Member row helpers ─────────────────────────────────────────────────────

function rowToMember(row: MemberRow, skills: MemberSkill[]): HouseholdMember {
	const age_group = normalizeAgeGroup(row.age_group);
	const dietary = parseStringArray(row.dietary_json);
	const preferences = mergePreferences(undefined, parseObject<MemberPreferences>(row.preferences_json));
	const safety = mergeSafety(age_group, undefined, parseObject<MemberSafety>(row.safety_json));
	const active_skill_quests = parseStringArray(row.active_skill_quests_json);
	const privacy = mergePrivacy(undefined, parseObject<MemberPrivacy>(row.privacy_json));
	return {
		member_id: row.member_id,
		household_id: row.household_id,
		display_name: row.display_name,
		age_group,
		dietary,
		preferences,
		safety,
		skills,
		active_skill_quests,
		privacy,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function mergePreferences(
	base: MemberPreferences | undefined,
	patch: Partial<MemberPreferences> | undefined,
): MemberPreferences {
	const start = base ?? defaultPreferences();
	if (!patch) return { ...start };
	return {
		loves: cleanStringArray(patch.loves ?? start.loves),
		dislikes: cleanStringArray(patch.dislikes ?? start.dislikes),
		allergies: cleanStringArray(patch.allergies ?? start.allergies),
	};
}

function mergeSafety(
	age_group: AgeGroup,
	base: MemberSafety | undefined,
	patch: Partial<MemberSafety> | undefined,
): MemberSafety {
	const start = base ?? defaultSafetyFor(age_group);
	if (!patch) return { ...start };
	return {
		stove_authorized: patch.stove_authorized ?? start.stove_authorized,
		oven_authorized: patch.oven_authorized ?? start.oven_authorized,
		knife_authorized: patch.knife_authorized ?? start.knife_authorized,
		heavy_lift_authorized: patch.heavy_lift_authorized ?? start.heavy_lift_authorized,
		sharp_oils_authorized: patch.sharp_oils_authorized ?? start.sharp_oils_authorized,
		minimum_supervision: patch.minimum_supervision ?? start.minimum_supervision,
	};
}

function mergePrivacy(
	base: MemberPrivacy | undefined,
	patch: Partial<MemberPrivacy> | undefined,
): MemberPrivacy {
	const start = base ?? defaultPrivacy();
	if (!patch) return { ...start };
	return {
		share_skills_with_household: patch.share_skills_with_household ?? start.share_skills_with_household,
		share_tastes_with_household: patch.share_tastes_with_household ?? start.share_tastes_with_household,
	};
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

function normalizeAgeGroup(value: unknown): AgeGroup {
	if (typeof value !== "string") return "adult";
	const v = value.trim().toLowerCase();
	if (VALID_AGE_GROUPS.includes(v as AgeGroup)) return v as AgeGroup;
	return "adult";
}

function cleanStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

function parseStringArray(value: string | null | undefined): string[] {
	if (!value || typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return cleanStringArray(parsed);
	} catch {
		return [];
	}
}

function parseObject<T>(value: string | null | undefined): T | undefined {
	if (!value || typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as T;
	} catch {
		return undefined;
	}
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return Math.round(value * 1000) / 1000;
}

function round3(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 1000) / 1000;
}

function generateMemberId(household_id: string, display_name: string): string {
	const slug = slugify(display_name).slice(0, 24) || "member";
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `mem_${household_id}__${slug}__${stamp}${rand}`;
}

function generateHistoryId(member_id: string, skill_name: string, isoTime: string): string {
	const slug = slugify(skill_name).slice(0, 20) || "skill";
	const stamp = isoTime.replace(/[^0-9]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 6);
	return `skh_${member_id}__${slug}__${stamp}_${rand}`;
}

function slugify(value: string): string {
	return (value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}
