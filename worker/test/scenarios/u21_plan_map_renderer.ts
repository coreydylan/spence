// U21 — plan-map renderer (the new compact world-state view).
//
// Loads the 14-day vegetarian snapshot and asserts that renderPlanMap
// produces a markdown document with all seven labelled sections, an
// embedded Mermaid graph fence, a reasonable token budget, cascade
// proposal kinds for any grievance that supplies them, and a working
// highlight_slot bolding option.

import type { Scenario } from "../lib/types";
import { renderPlanMap } from "../../src/mise-graph/plan-map";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

interface PlanFixture {
	plan: MiseWeeklyPlanDraft;
}

const u21: Scenario = {
	id: "u21",
	name: "renderPlanMap renders all seven sections under the compact token budget",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<PlanFixture>("snapshot-14day-veg-plan.json");
		const plan = fixture.plan;
		ctx.assert.ok(!!plan, "fixture has plan field");

		const compact = renderPlanMap(plan, { detail: "compact" });
		ctx.assert.ok(compact.length > 0, "compact render is non-empty");
		ctx.assert.contains(compact, "## §1", "section §1 (Window) is present");
		ctx.assert.contains(compact, "## §2", "section §2 (Calendar grid) is present");
		ctx.assert.contains(compact, "## §3", "section §3 (Resource ledger) is present");
		ctx.assert.contains(compact, "## §4", "section §4 (Dependency edges) is present");
		ctx.assert.contains(compact, "## §5", "section §5 (Shopping) is present");
		ctx.assert.contains(compact, "## §6", "section §6 (Grievances) is present");
		ctx.assert.contains(compact, "## §7", "section §7 (Coherence score) is present");

		// Token budget: ~chars / 4. Compact under 6000 tokens for 14-day plan.
		const compactTokens = Math.ceil(compact.length / 4);
		ctx.notes.push(`compact token estimate: ${compactTokens} (chars=${compact.length})`);
		ctx.assert.lte(compactTokens, 6000, "compact mode stays under 6k tokens for 14-day plan");

		// Mermaid graph fence is present in §4.
		ctx.assert.contains(compact, "```mermaid", "compact mode includes a Mermaid graph fence");
		ctx.assert.contains(compact, "graph LR", "Mermaid graph is left-to-right");

		// Compact mode does NOT include raw plan JSON dump.
		ctx.assert.ok(!compact.includes("## §8"), "compact mode omits §8 full data dump");

		// Determinism: same input → same output.
		const compactAgain = renderPlanMap(plan, { detail: "compact" });
		ctx.assert.eq(compact, compactAgain, "compact render is deterministic byte-identical");

		// Header carries plan title and window.
		ctx.assert.contains(compact, plan.title, "header line shows plan title");
		ctx.assert.contains(compact, plan.start_date, "window line shows plan start_date");
		ctx.assert.contains(compact, plan.end_date, "window line shows plan end_date");

		// Cascade proposal kinds: every grievance with a non-empty cascade_proposals
		// array must show at least one proposal kind label in the rendered output.
		const grievSection = compact.split("## §6")[1] || "";
		ctx.assert.ok(grievSection.length > 0, "grievance section text was extracted");
		// Any standard cascade proposal kind should appear if grievances were emitted.
		// We only require this when grievances emitted in the section.
		const kinds = ["split_batch", "replace_meal", "swap_ingredient", "slide_prep_date", "move_meal", "cancel_meal", "add_meal", "drop_item_from_shop", "move_shop", "add_shop", "merge_batches", "substitute_recipe", "lock_slot"];
		const hasAnyProposal = grievSection.includes("proposals:");
		if (hasAnyProposal) {
			const matched = kinds.some(k => grievSection.includes(k));
			ctx.assert.ok(matched, "at least one cascade proposal kind label appears");
		}

		// highlight_slot option: bolds the chosen meal cell with *…* markers in §2.
		// Pick the first dinner from the plan.
		const firstDinner = (plan.meals_by_day || []).flatMap(d => d.meals).find(m => m.slot === "dinner");
		ctx.assert.ok(!!firstDinner, "fixture has at least one dinner");
		const highlighted = renderPlanMap(plan, {
			detail: "compact",
			highlight_slot: { date: firstDinner!.date, slot: "dinner" },
		});
		const calendarSection = highlighted.split("## §2")[1]?.split("## §3")[0] || "";
		ctx.assert.contains(calendarSection, "*", "calendar grid contains a bold/highlight marker");
		// Highlight changes output relative to no-highlight.
		ctx.assert.notEq(highlighted, compact, "highlight_slot changes the rendered output");

		// Full mode adds JSON code fences with raw plan/edges/grievances/coherence.
		const full = renderPlanMap(plan, { detail: "full" });
		ctx.assert.contains(full, "```json", "full mode includes JSON code fences");
		ctx.assert.contains(full, "## §8", "full mode includes §8 full data section");
		ctx.assert.contains(full, "### plan_summary", "full mode includes plan_summary JSON block");
		ctx.assert.contains(full, "### dependency_edges", "full mode includes edges JSON block");
		ctx.assert.contains(full, "### grievances", "full mode includes grievances JSON block");
		ctx.assert.contains(full, "### coherence", "full mode includes coherence JSON block");
		const fullTokens = Math.ceil(full.length / 4);
		ctx.notes.push(`full token estimate: ${fullTokens} (chars=${full.length})`);
		ctx.assert.lte(fullTokens, 60000, "full mode stays under 60k tokens for 14-day plan");
	},
};

export default u21;
