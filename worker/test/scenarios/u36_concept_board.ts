// U36 — Concept board: movement set/get + concept CRUD + tetris scoring + shortlist.
//
// Verifies the Wave 6 inspiration workspace:
//   * setMovement / getMovement round-trip
//   * bookmarkConcept × 5 + listConcepts returns all
//   * scoreTetris produces a sensible breakdown for a synthetic plan
//   * shortlistTopConcepts marks correct ones based on tetris_score

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import {
	bookmarkConcept,
	getMovement,
	listConcepts,
	migrateConceptBoardSchema,
	scoreTetris,
	setMovement,
	shortlistTopConcepts,
	updateConceptStatus,
} from "../../src/mise-graph/concept-board";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u36: Scenario = {
	id: "u36",
	name: "Concept board: movements, concepts, tetris scoring, shortlist",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateConceptBoardSchema(env);

		const planId = "plan_u36_test";

		// ── 1. Movement round-trip ─────────────────────────────────────────
		const movement = await setMovement(env, {
			plan_id: planId,
			household_id: "hh_u36",
			theme_text: "Cool weather + chickpea anchor + Sat Ooni opportunity",
			rationale: "Saturated chickpea pantry; cooling forecast wants warm formats.",
		});
		ctx.assert.ok(movement.movement_id.length > 0, "setMovement returns a movement_id");
		ctx.assert.eq(movement.plan_id, planId, "movement.plan_id round-trips");
		ctx.assert.eq(movement.household_id, "hh_u36", "household_id stored");
		ctx.assert.eq(movement.theme_text, "Cool weather + chickpea anchor + Sat Ooni opportunity", "theme_text stored");

		const fetched = await getMovement(env, planId);
		ctx.assert.ok(!!fetched, "getMovement returns a movement");
		ctx.assert.eq(fetched!.movement_id, movement.movement_id, "movement_id round-trips");

		const noMovement = await getMovement(env, "plan_does_not_exist");
		ctx.assert.eq(noMovement, null, "getMovement returns null for unknown plan");

		// ── 2. Bookmark 5 concepts ─────────────────────────────────────────
		const concepts = [
			{ title: "Chickpea harissa stew", format: "soup", cuisine: ["mediterranean"], rawIngredients: [{ name: "chickpea", grams: 300 }, { name: "harissa", grams: 30 }], formula_ids: ["chickpea-stew-base"] },
			{ title: "Crispy chickpea bowl", format: "bowl", cuisine: ["mediterranean"], rawIngredients: [{ name: "chickpea", grams: 250 }, { name: "lemon", grams: 60 }] },
			{ title: "Sat Ooni flatbread night", format: "flatbread", cuisine: ["italian"], rawIngredients: [{ name: "flour", grams: 500 }, { name: "tomato", grams: 200 }] },
			{ title: "Korean kimchi noodle soup", format: "soup", cuisine: ["korean"], rawIngredients: [{ name: "noodle", grams: 200 }, { name: "kimchi", grams: 100 }] },
			{ title: "Smashburger with kimchi slaw", format: "burger", cuisine: ["american", "korean"], rawIngredients: [{ name: "beef", grams: 400 }, { name: "kimchi", grams: 80 }] },
		];

		const created = [];
		for (const c of concepts) {
			const card = await bookmarkConcept(env, {
				plan_id: planId,
				movement_id: movement.movement_id,
				title: c.title,
				format: c.format,
				cuisine: c.cuisine,
				source_kind: "corpus",
				raw_ingredients: c.rawIngredients,
				formula_ids: c.formula_ids,
				est_active_min: 30,
				est_idle_min: 0,
				rationale: `fits the movement`,
			});
			created.push(card);
		}
		ctx.assert.eq(created.length, 5, "5 concepts bookmarked");
		ctx.assert.ok(created.every(c => c.status === "candidate"), "all start as candidate");

		const all = await listConcepts(env, planId);
		ctx.assert.eq(all.length, 5, "listConcepts returns all 5 cards");
		ctx.assert.ok(all.every(c => c.movement_id === movement.movement_id), "every concept linked to movement");

		const candidatesOnly = await listConcepts(env, planId, { status: "candidate" });
		ctx.assert.eq(candidatesOnly.length, 5, "filter by candidate status returns all 5");

		// ── 3. scoreTetris breakdown shape ─────────────────────────────────
		const conceptId = created[0].concept_id;
		const score = await scoreTetris(env, {
			plan_id: planId,
			concept_id: conceptId,
			candidate_slot: { date: "2026-05-13", slot: "dinner" },
		});
		ctx.assert.eq(score.concept_id, conceptId, "scoreTetris echoes concept_id");
		ctx.assert.gte(score.total_score, 0, "total_score >= 0");
		ctx.assert.lte(score.total_score, 100, "total_score <= 100");
		ctx.assert.ok(typeof score.breakdown.cuisine_fit === "number", "cuisine_fit dimension present");
		ctx.assert.ok(typeof score.breakdown.format_diversity === "number", "format_diversity dimension present");
		ctx.assert.ok(typeof score.breakdown.calendar_fit === "number", "calendar_fit dimension present");
		ctx.assert.ok(Array.isArray(score.warnings), "warnings is an array");
		ctx.notes.push(`u36 sample tetris total=${score.total_score} breakdown=${JSON.stringify(score.breakdown)}`);

		// Slot is unoccupied on a synthetic plan that doesn't even exist —
		// scoring still produces a deterministic neutral breakdown.
		ctx.assert.contains(score.warnings, "plan_not_loaded: scoring used neutral defaults", "warns when plan absent");

		// ── 4. shortlistTopConcepts uses tetris_score ──────────────────────
		// Manually patch tetris_score for each card so we have deterministic
		// ordering (avoids depending on the deterministic scoring engine
		// returning specific numbers).
		const targets = [82, 70, 65, 50, 30];
		for (let i = 0; i < created.length; i++) {
			const card = created[i];
			await env.DB.prepare(`UPDATE mise_concept_board SET tetris_score = ? WHERE concept_id = ?`)
				.bind(targets[i], card.concept_id)
				.run();
		}

		const top3 = await shortlistTopConcepts(env, planId, 3);
		ctx.assert.eq(top3.length, 3, "shortlistTopConcepts(3) returns 3 winners");
		ctx.assert.ok(top3.every(c => c.status === "shortlisted"), "winners are 'shortlisted'");
		const winnerIds = new Set(top3.map(c => c.concept_id));
		ctx.assert.ok(winnerIds.has(created[0].concept_id), "highest-score concept is in winners");
		ctx.assert.ok(winnerIds.has(created[1].concept_id), "2nd-highest concept is in winners");
		ctx.assert.ok(winnerIds.has(created[2].concept_id), "3rd-highest concept is in winners");

		const after = await listConcepts(env, planId);
		const shortlisted = after.filter(c => c.status === "shortlisted");
		const stillCandidates = after.filter(c => c.status === "candidate");
		ctx.assert.eq(shortlisted.length, 3, "3 cards now shortlisted");
		ctx.assert.eq(stillCandidates.length, 2, "2 cards stay as candidate");

		// ── 5. updateConceptStatus + commit lifecycle ──────────────────────
		const committed = await updateConceptStatus(
			env,
			created[0].concept_id,
			"committed",
			"2026-05-13_dinner",
		);
		ctx.assert.eq(committed.status, "committed", "concept status updated to committed");
		ctx.assert.eq(committed.committed_to_slot, "2026-05-13_dinner", "committed_to_slot stored");

		ctx.notes.push(`u36 final: shortlisted=${shortlisted.length}, candidate=${stillCandidates.length}, committed=1`);
	},
};

export default u36;
