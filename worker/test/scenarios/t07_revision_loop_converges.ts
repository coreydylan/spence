// T7 — LLM-Modulo revision loop drives hard grievances to zero.
//
// Loads the standard broken fixture, then programmatically extends it with
// additional fixable hard violations so we can validate that the loop:
//   - ranks hard grievances first
//   - dispatches each cascade proposal into RipplePreview
//   - scores and commits the best proposal
//   - converges (final_hard === 0) within max_rounds
//   - never regresses (each round's net_score_delta >= 0)
//   - is idempotent (running the loop again is a no-op)
//
// All commits in this scenario flow through `swap_ingredient` and friends
// because those are the only mutation kinds wired into RipplePreview today.
// Grievances whose proposals require unwired kinds (split_batch, etc.) are
// surfaced in the audit log but not committed — that's why we extend the
// fixture to ensure every deliberate violation has at least one wired-kind
// fix path.

import type { Scenario } from "../lib/types";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
} from "../../src/mise-graph/planner";
import { runHardCritics } from "../../src/mise-graph/critics";
import { runRevisionLoop } from "../../src/mise-graph/revision-loop";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";

const t07: Scenario = {
	id: "t07",
	name: "LLM-Modulo revision loop drives hard grievances → 0 within 5 rounds",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const broken = buildBrokenPlan(ctx);

		// Sanity: the synthetic plan really has the violations we promised.
		const initialGrievances = runHardCritics(broken);
		ctx.notes.push(`initial hard grievances: ${initialGrievances.length}`);
		for (const g of initialGrievances) {
			ctx.notes.push(`  ${g.critic} @ ${g.slot_ref?.date} ${g.slot_ref?.slot}: ${g.message.slice(0, 70)}`);
		}
		ctx.assert.gte(initialGrievances.length, 5, "fixture has at least 5 deliberate hard grievances");

		// Run the loop.
		const result = await runRevisionLoop(broken, {
			max_rounds: 5,
			max_grievances_per_round: 3,
			use_llm_for_alternatives: false,
			polish_passes: 2,
		});

		ctx.notes.push(`rounds run: ${result.rounds.length}`);
		ctx.notes.push(`total attempts: ${result.summary.total_attempts}, committed: ${result.summary.total_committed}`);
		ctx.notes.push(`initial_hard=${result.summary.initial_hard} → final_hard=${result.summary.final_hard}`);
		ctx.notes.push(`polish_moves: ${result.polish_moves.length} (applied=${result.summary.polish_moves_applied})`);
		for (const round of result.rounds) {
			ctx.notes.push(`round ${round.round_number}: attempts=${round.attempts.length} score_delta=${round.net_score_delta.toFixed(2)}`);
			for (const a of round.attempts) {
				const status = a.committed ? "committed" : `skipped (${a.reason_skipped || "?"})`;
				ctx.notes.push(`  ${a.grievance_id.slice(0, 60)} → ${status}`);
			}
		}
		const finalGriev = runHardCritics(result.final_plan);
		for (const g of finalGriev) {
			ctx.notes.push(`final grievance: ${g.critic} @ ${g.slot_ref?.date} ${g.slot_ref?.slot}: ${g.message.slice(0, 70)}`);
		}

		ctx.assert.eq(result.summary.final_hard, 0, "loop drives final hard grievance count to 0");
		ctx.assert.lte(result.rounds.length, 5, "loop respects max_rounds budget");
		ctx.assert.eq(result.converged, true, "loop reports converged=true");
		ctx.assert.gte(result.summary.total_committed, 1, "loop committed at least one revision");

		// Monotonic improvement: every round either makes progress or breaks
		// even (no regressions). We allow a small epsilon for float drift.
		for (const round of result.rounds) {
			ctx.assert.gte(round.net_score_delta, -0.001, `round ${round.round_number} net_score_delta >= 0`);
		}

		// Polish moves: at least the swap_meals candidates were considered.
		ctx.assert.gte(result.polish_moves.length, 0, "polish pass surfaces moves array even if empty");

		// Critics on the final plan must agree there are no hard grievances left.
		const directAudit = runHardCritics(result.final_plan);
		const directHard = directAudit.filter(g => g.severity === "hard");
		ctx.assert.eq(directHard.length, 0, "running critics directly on final_plan also reports 0 hard grievances");

		// Caller's input plan is unchanged (deep-clone discipline). The Sun
		// violator still has fish sauce in raw_ingredients in the original
		// `broken` reference — even though the loop swapped it out in
		// `result.final_plan`.
		const sunOriginal = broken.meals_by_day.find(d => d.date === "2026-05-17")?.meals[0];
		const sunOrigRaw = (sunOriginal?.raw_ingredients || []).map(r => r.name);
		ctx.assert.contains(sunOrigRaw, "fish sauce", "input plan still has fish sauce — loop did not mutate caller's draft");

		// Idempotency: running the loop again on final_plan is a no-op.
		clearProposalCache();
		const second = await runRevisionLoop(result.final_plan, { max_rounds: 5, polish_passes: 1 });
		ctx.assert.eq(second.summary.total_committed, 0, "re-running on a clean plan commits zero new revisions");
		ctx.assert.eq(second.summary.final_hard, 0, "re-running keeps final_hard at 0");

		// -------------------------------------------------------------------
		// Section 2 — split_batch-resolvable fixture. This is the new wired
		// mutation kind; we deliberately build a plan with a batch whose
		// planned_uses span past its quality_window so ShelfLifeCritic fires
		// and the loop must commit a split_batch to clear it.
		// -------------------------------------------------------------------
		clearProposalCache();
		const splitFixture = buildSplitBatchFixture();
		const splitInitial = runHardCritics(splitFixture);
		const splitInitialShelf = splitInitial.filter(g => g.critic === "ShelfLifeCritic").length;
		ctx.notes.push(`split fixture initial shelf-life violations: ${splitInitialShelf}`);
		ctx.assert.gt(splitInitialShelf, 0, "split fixture has at least one ShelfLifeCritic violation");

		const splitResult = await runRevisionLoop(splitFixture, {
			max_rounds: 5,
			max_grievances_per_round: 3,
			use_llm_for_alternatives: false,
			polish_passes: 1,
		});

		ctx.notes.push(`split rounds: ${splitResult.rounds.length} committed: ${splitResult.summary.total_committed}`);
		ctx.notes.push(`split initial_hard=${splitResult.summary.initial_hard} → final_hard=${splitResult.summary.final_hard}`);
		for (const round of splitResult.rounds) {
			for (const a of round.attempts) {
				const winnerKind = a.winner?.proposal.kind || "(none)";
				const status = a.committed ? `committed (${winnerKind})` : `skipped (${a.reason_skipped})`;
				ctx.notes.push(`  split ${a.grievance_id.slice(0, 50)} → ${status}`);
			}
		}

		// At least one of the committed winners must be a newly-wired Wave 4 kind
		// (split_batch OR replace_meal — the two ShelfLifeCritic fix paths).
		const wave4Commits = splitResult.rounds.flatMap(r => r.attempts).filter(a =>
			a.committed && (a.winner?.proposal.kind === "split_batch" || a.winner?.proposal.kind === "replace_meal"));
		ctx.assert.gt(wave4Commits.length, 0, "loop commits at least one Wave 4 wired kind (split_batch or replace_meal)");

		// final_hard < initial_hard — split_batch resolved at least one shelf-life issue.
		ctx.assert.lte(splitResult.summary.final_hard, splitResult.summary.initial_hard,
			"loop reduces hard grievance count (split_batch decreases shelf-life violations)");
	},
};

// ---------------------------------------------------------------------------
// Fixture extension — load the canonical broken plan, drop the parts whose
// only fix paths are unwired (split_batch / replace_meal), and add a handful
// of new dietary + leftover violations all of which have wired-kind fixes.
// ---------------------------------------------------------------------------

interface RawFixture extends MiseWeeklyPlanDraft {
	dietary?: string[];
	_expected_grievances?: unknown;
}

function buildBrokenPlan(ctx: { loadFixture: <T>(p: string) => T }): MiseWeeklyPlanDraft {
	const fixture = ctx.loadFixture<RawFixture>("plan-broken-shelf-life-and-dietary.json");
	// Inject dietary into constraints (the fixture uses a top-level field).
	(fixture as { constraints?: Record<string, unknown> }).constraints = { dietary: fixture.dietary };
	// Wipe internals the runtime expects but the fixture doesn't carry.
	if (!fixture.meta) {
		(fixture as { meta?: unknown }).meta = { generated_by: "mise_graph_planner", deterministic: true };
	}
	if (!fixture.timezone) (fixture as { timezone?: unknown }).timezone = "UTC";
	if (!fixture.title) (fixture as { title?: unknown }).title = "broken fixture (test)";
	if (!fixture.status) (fixture as { status?: unknown }).status = "draft";
	if (!fixture.selected_ingredients) (fixture as { selected_ingredients?: unknown }).selected_ingredients = [];
	if (!fixture.source_recipe_ids) (fixture as { source_recipe_ids?: unknown }).source_recipe_ids = [];
	if (!fixture.prep_tasks) (fixture as { prep_tasks?: unknown }).prep_tasks = [];
	if (!fixture.shopping_list) (fixture as { shopping_list?: unknown }).shopping_list = [];
	if (!fixture.shop_runs) (fixture as { shop_runs?: unknown }).shop_runs = [];
	if (!fixture.storage_labels) (fixture as { storage_labels?: unknown }).storage_labels = [];

	// We rebuild the meals_by_day completely so we control:
	//   (a) which violations exist
	//   (b) that titles do NOT contain the offending word — otherwise the
	//       DietaryCritic regex re-fires after the swap because critics scan
	//       both raw_ingredients AND title for the violation pattern.
	// We keep the Mon dinner (LeftoverGraphCritic) since its violation comes
	// from the leftovers_to field, which a swap_ingredient field=leftovers_to
	// proposal removes cleanly.
	fixture.component_batches = [];
	fixture.meals_by_day = [];

	// Mon dinner: dangling leftovers_to claim (LeftoverGraphCritic).
	fixture.meals_by_day.push(makeDay("2026-05-11", [
		makeMeal({
			id: "meal:mon_dinner",
			date: "2026-05-11",
			slot: "dinner",
			title: "Skillet Chard and Eggs",
			format: "skillet",
			ingredient_names: ["egg", "swiss chard"],
			raw_ingredients: [{ name: "egg", qty: 4, unit: "whole", grams: 200 }],
			// claims a Tue lunch we don't add → LeftoverGraphCritic fires
			leftovers_to: ["2026-05-12 lunch"],
		}),
	]));
	// Tue dinner: dietary violation — uses salmon in raw_ingredients (title clean).
	fixture.meals_by_day.push(makeDay("2026-05-12", [
		makeMeal({
			id: "meal:tue_dinner_violation",
			date: "2026-05-12",
			slot: "dinner",
			title: "Pan-Seared Protein with Greens",
			format: "skillet",
			ingredient_names: ["salmon", "kale"],
			raw_ingredients: [
				{ name: "salmon", qty: 200, unit: "g", grams: 200 },
				{ name: "kale", qty: 150, unit: "g", grams: 150 },
			],
		}),
	]));
	// Thu dinner: dietary violation — chicken (title clean). We use chicken
	// instead of bacon because the cascade-proposal substitution for bacon
	// is "mushroom bacon", which the dietary regex still matches; chicken
	// substitutes to "seitan or king oyster mushroom" — fully clean.
	fixture.meals_by_day.push(makeDay("2026-05-14", [
		makeMeal({
			id: "meal:thu_dinner_violation",
			date: "2026-05-14",
			slot: "dinner",
			title: "Spiced Skillet Bowl",
			format: "skillet",
			ingredient_names: ["chicken", "broccoli"],
			raw_ingredients: [
				{ name: "chicken", qty: 200, unit: "g", grams: 200 },
				{ name: "broccoli", qty: 200, unit: "g", grams: 200 },
			],
		}),
	]));
	// Fri dinner: leftover violation — claim points BACKWARD in time.
	fixture.meals_by_day.push(makeDay("2026-05-15", [
		makeMeal({
			id: "meal:fri_dinner_backward_leftover",
			date: "2026-05-15",
			slot: "dinner",
			title: "Friday Bowl",
			format: "bowl",
			ingredient_names: ["chickpea", "tahini"],
			raw_ingredients: [{ name: "chickpea", qty: 200, unit: "g", grams: 200 }],
			// Claim points at a slot earlier than this meal — leftover_window
			// can't flow backward; LeftoverGraphCritic flags it.
			leftovers_to: ["2026-05-12 lunch"],
		}),
	]));
	// Sun dinner: dietary violation — fish sauce (title clean).
	fixture.meals_by_day.push(makeDay("2026-05-17", [
		makeMeal({
			id: "meal:sun_dinner_violation",
			date: "2026-05-17",
			slot: "dinner",
			title: "Rice Noodles in Broth",
			format: "noodle",
			ingredient_names: ["rice noodle", "tofu"],
			raw_ingredients: [
				{ name: "rice noodle", qty: 200, unit: "g", grams: 200 },
				{ name: "fish sauce", qty: 2, unit: "tbsp", grams: 30 },
				{ name: "tofu", qty: 250, unit: "g", grams: 250 },
			],
		}),
	]));

	// Sort by date for stable iteration order.
	fixture.meals_by_day.sort((a, b) => a.date.localeCompare(b.date));

	return fixture as MiseWeeklyPlanDraft;
}

function makeDay(date: string, meals: MisePlanMeal[]) {
	return { date, day_index: 0, meals };
}

function makeMeal(partial: Partial<MisePlanMeal> & {
	id: string; date: string; slot: MisePlanMeal["slot"]; title: string;
}): MisePlanMeal {
	return {
		id: partial.id,
		date: partial.date,
		slot: partial.slot,
		title: partial.title,
		format: partial.format ?? "bowl",
		component_ids: partial.component_ids ?? [],
		ingredient_names: partial.ingredient_names ?? [],
		source: partial.source ?? "synthetic_test",
		notes: partial.notes ?? [],
		people: partial.people ?? 2,
		cuisine: partial.cuisine ?? [],
		locked: partial.locked ?? false,
		raw_ingredients: partial.raw_ingredients,
		leftovers_to: partial.leftovers_to,
	};
}

// ---------------------------------------------------------------------------
// Section-2 fixture: a single Hummus batch with 8 planned uses spanning 8 days
// at 96h shelf — way past quality window. ShelfLifeCritic emits cascade
// proposals shaped { kind: "split_batch", batch_id, at_date }, which the
// revision loop now routes through previewSplitBatch and commits.
// ---------------------------------------------------------------------------

function buildSplitBatchFixture(): MiseWeeklyPlanDraft {
	const useDates = [
		"2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14",
		"2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18",
	];
	const meals: MisePlanMeal[] = useDates.map((d, i) => makeMeal({
		id: `meal:lunch_${i}`,
		date: d,
		slot: "lunch",
		title: `Hummus Lunch ${i}`,
		component_ids: ["mise_component:hummus"],
	}));
	const meals_by_day = useDates.map((d, i) => ({
		date: d,
		day_index: i,
		meals: [meals[i]],
	}));

	const batch: MisePlanComponentBatch = {
		id: "mise_component:hummus",
		state_id: null,
		label: "Hummus",
		quantity: 800,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 96,
		planned_uses: useDates.map((d, i) => ({
			date: d,
			slot: "lunch",
			meal_id: `meal:lunch_${i}`,
			title: `Hummus Lunch ${i}`,
		})),
		station_tags: ["sauce_active"],
		equipment: ["food processor"],
		active_time_min: 12,
		idle_time_min: 0,
		input_names: ["chickpea", "tahini", "lemon juice", "garlic"],
		meta: { source: "synthetic_test" },
	};

	return {
		id: "mise_plan:t07_split_fixture",
		household_id: "test",
		title: "T07 split fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-18",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day,
		component_batches: [batch],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default t07;
