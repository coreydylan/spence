// T2 — Hard critics produce structured grievances on a known-bad plan.
//
// Loads a hand-crafted plan with 3 deliberate violations:
//   - ShelfLifeCritic on Sat dinner (chickpea batch past use_by)
//   - DietaryCritic on Sun dinner (fish sauce in vegetarian household)
//   - LeftoverGraphCritic on Mon dinner (claims slot not in plan)
// And one control meal (Wed) that should produce ZERO grievances.

import type { Scenario } from "../lib/types";
import { runHardCritics, type Grievance } from "../../src/mise-graph/critics";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";
import type { CascadeProposal } from "../../src/mise-graph/cascade-proposals";

const t02: Scenario = {
	id: "t02",
	name: "Hard critics catch shelf-life, dietary, leftover-graph violations",
	group: "golden",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<MiseWeeklyPlanDraft & {
			_expected_grievances: Array<{ critic: string; severity: string; slot_ref: { date: string; slot: string }; must_mention: string[] }>;
		}>("plan-broken-shelf-life-and-dietary.json");

		// Inject dietary into constraints since the fixture uses a top-level field
		(fixture as { constraints?: Record<string, unknown> }).constraints = { dietary: fixture.dietary };

		const grievances = runHardCritics(fixture as unknown as MiseWeeklyPlanDraft);
		ctx.notes.push(`grievances produced: ${grievances.length}`);
		for (const g of grievances) ctx.notes.push(`  ${g.critic} [${g.severity}] @ ${g.slot_ref?.date} ${g.slot_ref?.slot}: ${g.message.slice(0, 80)}`);

		const expected = fixture._expected_grievances;
		ctx.assert.gte(grievances.length, expected.length, `at least ${expected.length} grievances expected, got ${grievances.length}`);

		for (const exp of expected) {
			const matched = grievances.find((g: Grievance) =>
				g.critic === exp.critic
				&& g.severity === exp.severity
				&& g.slot_ref?.date === exp.slot_ref.date
				&& g.slot_ref?.slot === exp.slot_ref.slot
				&& exp.must_mention.every(needle => g.message.toLowerCase().includes(needle.toLowerCase()))
			);
			ctx.assert.ok(!!matched, `expected grievance from ${exp.critic} on ${exp.slot_ref.date} ${exp.slot_ref.slot} mentioning {${exp.must_mention.join(", ")}}`);
		}

		// Control: Wed dinner should NOT produce a grievance
		const wedGrievances = grievances.filter(g => g.slot_ref?.date === "2026-05-13");
		ctx.assert.eq(wedGrievances.length, 0, "control Wed dinner produces 0 grievances (within shelf life, dietary clean, no leftover claim)");

		// Every grievance has a suggested_repair
		for (const g of grievances) {
			ctx.assert.ok(!!g.suggested_repair && g.suggested_repair.length > 10, `grievance from ${g.critic} has actionable suggested_repair`);
		}

		// --- Cascade proposals (Wave 2) -----------------------------------------
		// Every emitted grievance carries at least one structured proposal.
		for (const g of grievances) {
			ctx.assert.ok(Array.isArray(g.cascade_proposals), `grievance from ${g.critic} has cascade_proposals array`);
			ctx.assert.gte(g.cascade_proposals?.length || 0, 1, `grievance from ${g.critic} carries >=1 cascade proposal`);
			for (const p of g.cascade_proposals || []) {
				ctx.assert.ok(typeof p.description === "string" && p.description.length > 5, `proposal description is non-empty`);
				ctx.assert.gte(p.confidence, 0, `proposal confidence is >= 0`);
				ctx.assert.lte(p.confidence, 1, `proposal confidence is <= 1`);
			}
		}

		// ShelfLifeCritic on Sat must propose split_batch + replace_meal.
		const shelf = grievances.find(g => g.critic === "ShelfLifeCritic");
		ctx.assert.ok(!!shelf, "ShelfLifeCritic grievance present");
		const shelfProps: CascadeProposal[] = shelf?.cascade_proposals || [];
		ctx.assert.ok(shelfProps.some(p => p.kind === "split_batch"), "ShelfLifeCritic emits split_batch proposal");
		ctx.assert.ok(shelfProps.some(p => p.kind === "replace_meal"), "ShelfLifeCritic emits replace_meal alternative");

		// DietaryCritic on Sun must propose swap_ingredient with a real plant alternative.
		const diet = grievances.find(g => g.critic === "DietaryCritic");
		ctx.assert.ok(!!diet, "DietaryCritic grievance present");
		const dietProps: CascadeProposal[] = diet?.cascade_proposals || [];
		const swap = dietProps.find(p => p.kind === "swap_ingredient");
		ctx.assert.ok(!!swap, "DietaryCritic emits swap_ingredient proposal");
		const swapTo = (swap?.parameters?.to_name as string | undefined) || "";
		ctx.assert.ok(swapTo.length > 0, `swap_ingredient.to_name is a real plant alternative (got "${swapTo}")`);

		// LeftoverGraphCritic on Mon must propose add_meal OR a surgical leftovers_to drop.
		const left = grievances.find(g => g.critic === "LeftoverGraphCritic");
		ctx.assert.ok(!!left, "LeftoverGraphCritic grievance present");
		const leftProps: CascadeProposal[] = left?.cascade_proposals || [];
		const addOrFix = leftProps.find(p =>
			p.kind === "add_meal"
			|| (p.kind === "swap_ingredient" && p.parameters?.field === "leftovers_to"),
		);
		ctx.assert.ok(!!addOrFix, "LeftoverGraphCritic emits add_meal or a surgical leftovers_to fix");
	},
};

export default t02;
