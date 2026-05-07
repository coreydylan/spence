// U22 — plan-map renderer compact vs full detail comparison.
//
// Renders the snapshot fixture in both detail levels and asserts:
//   - full mode is at least 1.5× compact by char count (carries more data),
//   - full mode includes JSON code fences for raw plan/edges/grievances,
//   - compact mode does not include the JSON full-data dump,
//   - both modes share the seven-section structure.

import type { Scenario } from "../lib/types";
import { renderPlanMap } from "../../src/mise-graph/plan-map";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

interface PlanFixture {
	plan: MiseWeeklyPlanDraft;
}

const u22: Scenario = {
	id: "u22",
	name: "renderPlanMap full mode is at least 1.5x compact and embeds JSON",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<PlanFixture>("snapshot-14day-veg-plan.json");
		const plan = fixture.plan;
		ctx.assert.ok(!!plan, "fixture has plan field");

		const compact = renderPlanMap(plan, { detail: "compact" });
		const full = renderPlanMap(plan, { detail: "full" });

		ctx.notes.push(`compact chars: ${compact.length}`);
		ctx.notes.push(`full chars: ${full.length}`);

		// Full must carry at least 1.5× compact by char count.
		ctx.assert.gte(full.length, compact.length * 1.5, "full mode is ≥1.5× compact length");

		// JSON fences in full only.
		const compactJsonFences = (compact.match(/```json/g) || []).length;
		const fullJsonFences = (full.match(/```json/g) || []).length;
		ctx.assert.eq(compactJsonFences, 0, "compact mode includes no JSON code fences");
		ctx.assert.gte(fullJsonFences, 4, "full mode includes ≥4 JSON code fences (plan/edges/grievances/coherence)");

		// Both modes carry the seven labelled sections.
		for (const tag of ["## §1", "## §2", "## §3", "## §4", "## §5", "## §6", "## §7"]) {
			ctx.assert.contains(compact, tag, `compact contains ${tag}`);
			ctx.assert.contains(full, tag, `full contains ${tag}`);
		}

		// Mermaid graph fence appears in both modes.
		ctx.assert.contains(compact, "```mermaid", "compact has mermaid graph");
		ctx.assert.contains(full, "```mermaid", "full has mermaid graph");

		// Sanity: §8 appears only in full mode.
		ctx.assert.ok(!compact.includes("## §8"), "compact omits §8 full-data dump");
		ctx.assert.contains(full, "## §8", "full includes §8 full-data dump");
	},
};

export default u22;
