// Task graph types — Wave 7B Track C.
//
// A "task graph" is a directed acyclic graph of atomic, schedulable cook
// tasks derived from a recipe. The graph is the unit of work in Wave 8
// brigade mode (multiple cooks dividing the work) and the input to the
// scheduler that lays tasks on a timeline against a cook_window.
//
// A recipe is human-facing prose ("preheat oven to 400, dice the onion,
// roast for 30 minutes…"). A task graph is its mechanized form: each step
// becomes one or more TaskNode rows with skill, equipment, and dependency
// metadata so the scheduler can answer:
//   * who is qualified to do this?
//   * what do we need to claim before they can start?
//   * what other tasks must finish first?
//   * can it run in parallel with sibling tasks?
//
// The decomposition heuristics live in task-graph.ts; this file is just
// the type-level contract.

export type TaskKind =
	| "prep"      // chopping, measuring, mise en place
	| "cook"      // active heat application — frying, sautéing, searing
	| "passive"   // simmering, baking, proofing — no attention needed
	| "assembly"  // plating, building, garnishing
	| "cleanup";  // wash, wipe, restock

/**
 * Skill kinds map to MemberSkill.skill_name in household-members.ts. The
 * scheduler uses skill_floor + member confidence to gate assignment:
 * a member with confidence < skill_floor cannot claim the task.
 *
 * `supervision_only` is a special slot — it means "the task is safe for
 * a kid with adult supervision present but doesn't require any active
 * skill" (e.g. watching dough proof). It always assigns to whoever is
 * available with the lowest other workload.
 */
export type SkillKind =
	| "knife_basic" | "knife_advanced"
	| "stove_basic" | "stove_searing" | "stove_emulsion"
	| "oven_basic" | "oven_temp_control"
	| "baking" | "dough_handling"
	| "fermentation" | "fryer"
	| "supervision_only";

export interface TaskNode {
	id: string;                       // ulid-like; stable per recipe
	recipe_id: string;
	step_idx: number;                 // ordering within recipe (NOT the DAG order)
	kind: TaskKind;
	label: string;                    // "dice onion", "preheat oven to 400", etc.
	skill: SkillKind;
	skill_floor: number;              // 0..1; min member confidence to assign
	equipment: string[];              // equipment slugs ["oven", "8in_chefs_knife"]
	ingredients_in: string[];         // raw_ingredient names consumed
	produces: string;                 // intermediate component name ("diced_onion")
	active_min: number;               // attended duration
	passive_min: number;              // unattended (oven baking, simmer)
	parallelizable: boolean;          // can run concurrent with sibling tasks?
	depends_on: string[];             // other TaskNode.ids
	earliest_start_offset_min?: number;  // relative to cook_window_start
	notes?: string;
}

export interface TaskGraph {
	recipe_id: string;
	meal_id: string;
	tasks: TaskNode[];
	critical_path_min: number;        // longest path by active+passive duration
	total_active_min: number;
	total_passive_min: number;
	parallelism_max: number;          // max concurrent parallelizable tasks
}

// ─── Scheduling types ───────────────────────────────────────────────────────

export interface CrewMember {
	member_id: string;
	skills: Partial<Record<SkillKind, number>>;  // confidence 0..1
	available_from_offset_min: number;
}

export interface TaskAssignment {
	task_id: string;
	member_id: string;
	start_offset_min: number;
	end_offset_min: number;
}

export interface ScheduleResult {
	ok: boolean;
	assignments: TaskAssignment[];
	unassignable: TaskNode[];
	total_duration_min: number;
}

// ─── Recipe input shape ─────────────────────────────────────────────────────
//
// buildTaskGraph() can either look up a recipe in personal_recipes (by
// recipe_id) or accept inline recipe data — useful for tests and for the
// case where the recipe came from a corpus row that hasn't been imported
// yet. Either path normalizes to this shape internally.

export interface RecipeForDecomposition {
	id: string;
	title?: string | null;
	steps: string[];                 // each item is one human-written step
	ingredients: string[];           // canonical ingredient names
	servings?: number | null;
	active_time_min?: number | null;
	total_time_min?: number | null;
}
