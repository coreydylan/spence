// U103 — Wave 7F household_read_brief MCP tool.
//
// Verifies the MCP read tool returns the brief that the cron sweep wrote,
// and that asking for a missing date returns { ok: false, reason: "no_brief" }
// without throwing.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	migrateDailyBriefsSchema,
} from "../../src/mise-graph/schemas/migrations";
import {
	computeMorningBrief,
	persistMorningBrief,
} from "../../src/mise-graph/agents/household-cycles";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u103: Scenario = {
	id: "u103",
	name: "Wave 7F: household_read_brief returns persisted brief; surfaces no_brief on missing date",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;

		await migrateHouseholdMemorySchema(env);
		await migrateDailyBriefsSchema(env);

		// ── 1. Ask for a brief that doesn't exist → no_brief ─────────────────
		const empty = await callPlanWorldTool(
			"household_read_brief",
			{ household_id: "hh_x", date: "2026-05-08" },
			env,
		);
		ctx.assert.eq(empty.ok, false, "missing brief returns ok:false");
		ctx.assert.eq(empty.reason, "no_brief", "reason is no_brief");
		ctx.assert.eq(empty.household_id, "hh_x", "household_id echoed back");
		ctx.assert.eq(empty.for_date, "2026-05-08", "for_date echoed back");
		ctx.assert.eq(empty.latest, null, "latest is null when caller supplied a date and no rows exist");

		// ── 2. Persist a brief manually + read it back ───────────────────────
		const brief = await computeMorningBrief(env, "hh_x", {
			now: new Date("2026-05-08T14:00:00Z"),
			skip_weather: true,
		});
		await persistMorningBrief(env, brief);

		const read = await callPlanWorldTool(
			"household_read_brief",
			{ household_id: "hh_x", date: "2026-05-08" },
			env,
		);
		ctx.assert.eq(read.ok, true, "brief read returns ok:true");
		const readBrief = read.brief as Record<string, unknown>;
		ctx.assert.ok(!!readBrief, "brief payload present");
		ctx.assert.eq(readBrief.household_id, "hh_x", "household_id round-trips");
		ctx.assert.eq(readBrief.date, "2026-05-08", "date matches for_date");
		ctx.assert.eq(typeof readBrief.generated_at_ms, "number", "generated_at_ms is a number");
		ctx.assert.ok(Array.isArray(readBrief.calendar), "calendar is an array");
		ctx.assert.ok(Array.isArray(readBrief.plan_health), "plan_health is an array");
		ctx.assert.ok(Array.isArray(readBrief.suggestions), "suggestions is an array");
		ctx.assert.ok("onboarding_question" in readBrief, "onboarding_question key present");
		const summary = readBrief.notifications_summary as { count_by_kind: Record<string, number> };
		ctx.assert.ok(!!summary && typeof summary.count_by_kind === "object", "notifications_summary present");

		// ── 3. Default date (no `date` arg) → today (UTC) ────────────────────
		// We can't predict today, but we CAN verify the call succeeds and
		// reports "no_brief" + a `latest` pointer back to our 2026-05-08 row
		// (since the test machine's "today" is almost certainly not 2026-05-08).
		const defaulted = await callPlanWorldTool(
			"household_read_brief",
			{ household_id: "hh_x" },
			env,
		);
		// Either:
		//   * test runs on 2026-05-08 → ok=true matching our row
		//   * test runs any other day → ok=false but latest points at the row
		if (defaulted.ok === true) {
			const b = defaulted.brief as Record<string, unknown>;
			ctx.assert.eq(b.household_id, "hh_x", "today-brief is for hh_x");
		} else {
			ctx.assert.eq(defaulted.ok, false, "default-date with no row for today is ok:false");
			ctx.assert.eq(defaulted.reason, "no_brief", "reason is no_brief");
			const latest = defaulted.latest as { id: string; for_date: string } | null;
			ctx.assert.ok(!!latest, "latest fallback is populated");
			ctx.assert.eq(latest!.for_date, "2026-05-08", "latest points at our seeded brief");
		}

		// ── 4. notifications_summary counts suggestions by kind ──────────────
		// The brief computeMorningBrief produced for an empty-plan household
		// should have zero suggestions; verify the count map matches.
		const counts = summary.count_by_kind;
		const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
		ctx.assert.eq(totalCount, brief.suggestions.length, "count_by_kind totals match suggestions");

		ctx.notes.push(`brief id: ${brief.id}`);
		ctx.notes.push(`suggestions: ${brief.suggestions.length}`);
	},
};

export default u103;
