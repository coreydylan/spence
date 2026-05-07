// T18 — daily brief live (tier=live).
//
// Hits the real mesh-claude bridge to generate a brief from a synthetic
// context. Skipped by default — only runs with `npm test -- --tier=live`.
// Asserts only that the bridge returned non-empty text; does NOT score
// the prose itself.

import type { Scenario } from "../lib/types";
import { generateBrief, type DailyBriefContext } from "../../src/mise-graph/daily-brief";
import type { MeshClaudeEnv } from "../../src/mise-graph/llm-bridge";

const t18: Scenario = {
	id: "t18",
	name: "Daily brief live: bridge composes a 1-3 paragraph morning brief",
	group: "integration",
	tier: "live",
	async run(ctx) {
		const env = liveEnvFromProcess();
		if (!env) {
			ctx.assert.pending("MESH/BRIDGE_HOST/BRIDGE_PORT/BRIDGE_SECRET not set in env — skip");
		}

		const synthetic: DailyBriefContext = {
			household_id: "hh_live_test",
			plan_id: "mise_plan:t18",
			for_date: "2026-05-12",
			todays_meals: [{
				slot: "dinner",
				title: "Pad Thai",
				cuisine: ["thai"],
				format: "noodle bowl",
				component_uses: ["Hummus batch"],
			}],
			todays_cooks: [{
				title: "Make hummus",
				active_min: 25,
				idle_min: 30,
				starts_at_window: "morning",
			}],
			expiring_items: [{
				canonical_name: "shiitake mushroom",
				qty: 250,
				unit: "g",
				expires_at: "2026-05-13",
				days_until: 1,
			}],
			upcoming_grievances: [],
		};

		const brief = await generateBrief(env, synthetic);
		ctx.assert.ok(brief.text.length > 0, "bridge returned non-empty text");
		ctx.assert.lte(brief.text.length, 4000, "brief is reasonably short (<= 4000 chars)");
		ctx.notes.push(`bridge brief: ${brief.text.slice(0, 200)}`);
	},
};

function liveEnvFromProcess(): MeshClaudeEnv | null {
	const host = process.env.BRIDGE_HOST;
	const port = process.env.BRIDGE_PORT;
	const secret = process.env.BRIDGE_SECRET;
	if (!host || !port || !secret) return null;
	const url = `http://${host}:${port}`;
	return {
		MESH: { fetch: (input, init) => fetch(typeof input === "string" ? input : url, init as RequestInit) },
		BRIDGE_HOST: host,
		BRIDGE_PORT: port,
		BRIDGE_SECRET: secret,
	};
}

export default t18;
