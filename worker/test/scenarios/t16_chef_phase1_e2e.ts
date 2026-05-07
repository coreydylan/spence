// T16 — Chef-of-staff Phase-1 (inspiration) end-to-end.
//
// Walks the full concept-board flow on a synthetic plan:
//   * Set the week's movement
//   * Bookmark 8 concepts (mix of corpus + personal_recipe sources)
//   * autoTetrisFit scores every concept against every empty slot
//   * shortlistTopConcepts(7) marks the top 7 by tetris_score
//   * Commit one shortlisted concept to a slot — verifies the concept moves
//     out of the "list" and a meal lands at the slot.
//
// Uses a purpose-built FakeD1 that wraps the mock-d1 helper for concept-board
// queries while shimming active-plans/proposals/legacy plan tables (which use
// SQL syntax — ON CONFLICT, complex INSERTs — that the generic mock can't
// parse). Every plan_compose_meal call exercises the full active-plan
// load+save round-trip, so the integration is real end-to-end.

import type { Scenario } from "../lib/types";
import { createMockD1, type MockD1, type MockD1Statement } from "../lib/mock-d1";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";

const t16: Scenario = {
	id: "t16",
	name: "Chef-of-staff Phase-1: movement → bookmark → autoTetris → shortlist → commit",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const fake = new FakeD1();
		const env = { DB: fake as unknown as D1Database } as { DB: D1Database };

		// ── Step 0: Create an empty 7-day plan ─────────────────────────────
		const created = await callPlanWorldTool("plan_create", {
			household_id: "t16_household",
			start_date: "2026-05-11",
			end_date: "2026-05-17",
			people_default: 2,
			ingredients: ["chickpea", "tomato", "lemon"],
			cuisine_direction: ["mediterranean", "korean"],
		}, env);
		const planId = created.plan_id as string;
		ctx.assert.ok(planId.length > 0, "plan_create returns a plan id");

		// ── Step 1: Set the week's movement ────────────────────────────────
		const movementResult = await callPlanWorldTool("inspire_set_movement", {
			plan_id: planId,
			household_id: "t16_household",
			theme_text: "Chickpea anchor + Korean-Med fusion + Sat Ooni opportunity",
			rationale: "Chickpea pantry pressure + warm forecast + open Sat night.",
		}, env);
		ctx.assert.eq((movementResult.ok as boolean), true, "inspire_set_movement ok");
		const movementId = (movementResult.movement as { movement_id: string }).movement_id;
		ctx.assert.ok(movementId.length > 0, "movement_id returned");

		// Verify get_movement round-trip.
		const fetchedMovement = await callPlanWorldTool("inspire_get_movement", { plan_id: planId }, env);
		ctx.assert.eq(fetchedMovement.found, true, "inspire_get_movement finds the movement");

		// ── Step 2: Bookmark 8 candidate concepts (mix of source kinds) ────
		const candidates: Array<{
			title: string;
			format: string;
			cuisine: string[];
			source_kind: "corpus" | "personal_recipe";
			raw_ingredients: Array<{ name: string; grams: number }>;
			est_active_min: number;
		}> = [
			{ title: "Chickpea harissa stew",          format: "soup",      cuisine: ["mediterranean"], source_kind: "corpus",          raw_ingredients: [{ name: "chickpea", grams: 300 }, { name: "harissa", grams: 30 }],  est_active_min: 25 },
			{ title: "Crispy chickpea grain bowl",     format: "bowl",      cuisine: ["mediterranean"], source_kind: "corpus",          raw_ingredients: [{ name: "chickpea", grams: 250 }, { name: "lemon", grams: 60 }],    est_active_min: 30 },
			{ title: "Sat Ooni flatbread",             format: "flatbread", cuisine: ["italian"],       source_kind: "personal_recipe", raw_ingredients: [{ name: "flour", grams: 500 }, { name: "tomato", grams: 200 }],     est_active_min: 60 },
			{ title: "Kimchi chickpea noodle soup",    format: "soup",      cuisine: ["korean"],        source_kind: "corpus",          raw_ingredients: [{ name: "noodle", grams: 200 }, { name: "kimchi", grams: 100 }],    est_active_min: 35 },
			{ title: "Smashburger with kimchi slaw",   format: "burger",    cuisine: ["korean", "american"], source_kind: "personal_recipe", raw_ingredients: [{ name: "beef", grams: 400 }, { name: "kimchi", grams: 80 }],   est_active_min: 40 },
			{ title: "Tomato salad with feta",         format: "salad",     cuisine: ["mediterranean"], source_kind: "corpus",          raw_ingredients: [{ name: "tomato", grams: 250 }, { name: "feta", grams: 80 }],       est_active_min: 15 },
			{ title: "Chickpea pasta puttanesca",      format: "pasta",     cuisine: ["italian"],       source_kind: "personal_recipe", raw_ingredients: [{ name: "chickpea", grams: 200 }, { name: "tomato", grams: 200 }],   est_active_min: 30 },
			{ title: "Korean tofu skillet",            format: "skillet",   cuisine: ["korean"],        source_kind: "corpus",          raw_ingredients: [{ name: "tofu", grams: 300 }, { name: "scallion", grams: 30 }],    est_active_min: 25 },
		];

		for (const c of candidates) {
			const result = await callPlanWorldTool("inspire_bookmark_concept", {
				plan_id: planId,
				movement_id: movementId,
				title: c.title,
				format: c.format,
				cuisine: c.cuisine,
				source_kind: c.source_kind,
				raw_ingredients: c.raw_ingredients,
				est_active_min: c.est_active_min,
				rationale: `Fits movement: ${c.title}`,
			}, env);
			ctx.assert.eq(result.ok, true, `bookmark concept ${c.title}`);
		}

		const allList = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId }, env);
		ctx.assert.eq(allList.count, 8, "8 concepts on the board");

		// ── Step 3: autoTetrisFit scores all candidates ─────────────────────
		const auto = await callPlanWorldTool("inspire_auto_tetris", { plan_id: planId }, env);
		ctx.assert.eq(auto.scored, 8, "autoTetrisFit scored all 8 concepts");
		const assignments = auto.best_assignments as Array<{ concept_id: string; suggested_slot: { date: string; slot: string }; score: number }>;
		ctx.assert.eq(assignments.length, 8, "8 best_assignments returned");
		ctx.assert.ok(
			assignments.every(a => typeof a.score === "number" && a.score >= 0 && a.score <= 100),
			"every assignment has a 0..100 score",
		);
		ctx.notes.push(`t16 score distribution: ${assignments.map(a => a.score).sort((a, b) => b - a).join(", ")}`);

		const scoredList = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId }, env);
		const scoredConcepts = scoredList.concepts as Array<{ concept_id: string; tetris_score: number | null; status: string }>;
		const allScored = scoredConcepts.every(c => typeof c.tetris_score === "number");
		ctx.assert.eq(allScored, true, "every concept now has a tetris_score");

		// ── Step 4: shortlistTopConcepts(7) ────────────────────────────────
		const shortlist = await callPlanWorldTool("inspire_shortlist_top", { plan_id: planId, top_n: 7 }, env);
		const shortlistedCards = shortlist.shortlisted as Array<{ concept_id: string; tetris_score: number; status: string }>;
		ctx.assert.eq(shortlistedCards.length, 7, "7 concepts shortlisted");
		ctx.assert.ok(shortlistedCards.every(c => c.status === "shortlisted"), "all winners have shortlisted status");

		const afterShortlist = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId }, env);
		const afterCards = afterShortlist.concepts as Array<{ concept_id: string; status: string; tetris_score: number | null }>;
		const sl = afterCards.filter(c => c.status === "shortlisted");
		const cand = afterCards.filter(c => c.status === "candidate");
		ctx.assert.eq(sl.length, 7, "7 cards now shortlisted");
		ctx.assert.eq(cand.length, 1, "1 card stays as candidate (lowest score)");

		// Verify the rejected card had the lowest tetris_score.
		const rejectedScore = cand[0].tetris_score ?? 0;
		const lowestShortlisted = Math.min(...sl.map(c => c.tetris_score ?? 0));
		ctx.assert.lte(rejectedScore, lowestShortlisted, "rejected card had the lowest score");

		// ── Step 5: Commit one shortlisted concept to a slot ───────────────
		const candidateForCommit = shortlistedCards[0];
		const commit = await callPlanWorldTool("inspire_commit_concept", {
			plan_id: planId,
			concept_id: candidateForCommit.concept_id,
			slot: { date: "2026-05-13", slot: "dinner" },
		}, env);
		ctx.assert.eq(commit.ok, true, "inspire_commit_concept ok");
		ctx.assert.eq(commit.committed_to_slot, "2026-05-13_dinner", "committed_to_slot key matches slot");
		const committedConcept = commit.concept as { status: string };
		ctx.assert.eq(committedConcept.status, "committed", "concept status is committed");

		// The compose result should report a meal_id at that slot.
		const composeResult = commit.compose as { ok?: boolean; meal_id?: string };
		ctx.assert.eq(composeResult.ok, true, "underlying plan_compose_meal succeeded");
		ctx.assert.ok(typeof composeResult.meal_id === "string" && composeResult.meal_id.length > 0, "meal_id returned");

		// ── Step 6: Verify the committed concept is gone from candidate/shortlisted lists ──
		const finalCandidates = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId, status: "candidate" }, env);
		ctx.assert.eq(finalCandidates.count, 1, "candidate list excludes committed concept");
		const finalShortlisted = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId, status: "shortlisted" }, env);
		ctx.assert.eq(finalShortlisted.count, 6, "shortlisted list now has 6 (one committed)");
		const finalCommitted = await callPlanWorldTool("inspire_list_concepts", { plan_id: planId, status: "committed" }, env);
		ctx.assert.eq(finalCommitted.count, 1, "exactly 1 concept now committed");

		// ── Step 7: Verify the meal landed in the plan ──────────────────────
		const mealRead = await callPlanWorldTool("plan_read_meal", {
			plan_id: planId,
			slot: { date: "2026-05-13", slot: "dinner" },
		}, env);
		ctx.assert.eq(mealRead.found, true, "the meal at the committed slot was actually composed");
		ctx.notes.push(`t16 final: 6 shortlisted + 1 candidate + 1 committed = 8 concepts; meal landed at 2026-05-13/dinner`);
	},
};

// ─── FakeD1 with hybrid mock-d1 + active-plans shim ────────────────────────

class FakeD1 {
	// Active plans table — uses non-standard ON CONFLICT syntax that mock-d1
	// can't parse, so we shim it with a Map.
	active = new Map<string, { plan_json: string; status: string; household: string | null }>();
	plans = new Map<string, string>(); // legacy mise_week_plans
	proposals = new Map<string, { plan_id: string; status: string; meta_json: string }>();

	// Concept-board tables go through the real mock-d1 so we exercise the
	// concept-board.ts queries against actual SQL parsing.
	private inner: MockD1 = createMockD1();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}

	innerPrepare(sql: string): MockD1Statement {
		return this.inner.prepare(sql);
	}
}

class FakeStatement {
	private bindings: unknown[] = [];
	private innerStmt: MockD1Statement | null = null;

	constructor(private readonly db: FakeD1, private readonly sql: string) {
		// Detect concept-board / household-memory tables and route to mock-d1.
		if (
			/mise_concept_board|mise_plan_movements|mise_conversation_threads|mise_household_profiles|mise_kitchen_inventory|mise_anchor_evolution|mise_meal_history|mise_household_members|mise_member_skills|mise_member_skill_history|mise_member_presence/i
				.test(sql)
		) {
			this.innerStmt = this.db.innerPrepare(sql);
		}
	}

	bind(...values: unknown[]): this {
		this.bindings = values;
		if (this.innerStmt) this.innerStmt.bind(...values);
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (this.innerStmt) return this.innerStmt.first<T>();
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const row = this.db.active.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_week_plans/i.test(this.sql)) {
			const plan_json = this.db.plans.get(String(this.bindings[0]));
			return (plan_json ? { plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (!row || row.plan_id !== String(this.bindings[1])) return null;
			return { meta_json: row.meta_json } as T;
		}
		return null;
	}

	async run(): Promise<{ success: boolean; meta: { changes: number } }> {
		if (this.innerStmt) return this.innerStmt.run();
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.set(String(this.bindings[0]), {
				household: this.bindings[1] as string | null,
				plan_json: String(this.bindings[2]),
				status: String(this.bindings[3] ?? "draft"),
			});
		} else if (/DELETE\s+FROM\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.delete(String(this.bindings[0]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_week_plans/i.test(this.sql)) {
			this.db.plans.set(String(this.bindings[0]), String(this.bindings[11]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_proposals/i.test(this.sql)) {
			this.db.proposals.set(String(this.bindings[0]), {
				plan_id: String(this.bindings[1]),
				status: String(this.bindings[5]),
				meta_json: String(this.bindings[10]),
			});
		} else if (/UPDATE\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (row && row.plan_id === String(this.bindings[1])) row.status = "applied";
		}
		// Other tables (plan_components, plan_tasks, recipe_lineage, agent
		// trace tables) are no-ops — t16 doesn't read from them.
		return { success: true, meta: { changes: 1 } };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (this.innerStmt) return this.innerStmt.all<T>();
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const rows = Array.from(this.db.active.entries()).map(([plan_id, row]) => ({
				plan_id,
				household_id: row.household,
				status: row.status,
				updated_at: "now",
			}));
			return { results: rows as unknown as T[] };
		}
		return { results: [] };
	}
}

export default t16;
