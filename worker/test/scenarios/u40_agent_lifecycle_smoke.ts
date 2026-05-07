// U40 — Wave 7 entity DO lifecycle smoke test.
//
// The Agents SDK requires a Cloudflare runtime (DurableObjectNamespace,
// per-DO SQLite, alarm scheduler) that's not present in the in-process
// runner. So this scenario locks the *contract* that Wave 7B + the smoke
// integration test will rely on:
//
//   1. The id helpers in agents/base.ts produce the documented format.
//   2. The transition guard map is wired so isLegalTransition resolves.
//   3. scheduleNextAlarm short-circuits cleanly when the rule returns null
//      (the Wave 7 foundation contract — every rule is null).
//   4. ensurePhaseTransitionsTable + recordPhaseTransition + listPhaseTransitions
//      round-trip through a tagged-template sql sink (mocking what the SDK
//      gives us via this.sql).
//   5. The DO classes export and load (no top-level side effects).
//
// Wave 7B integration: a separate live-tier scenario will boot wrangler dev,
// hit /mise-graph/agents/spawn, and assert the HTTP roundtrip works against
// real DOs. That requires miniflare wiring; not in scope for foundation.

import type { Scenario } from "../lib/types";
import {
	cookAgentName,
	COOK_TRANSITIONS,
	ensurePhaseTransitionsTable,
	generateAgentId,
	householdAgentName,
	isLegalTransition,
	listPhaseTransitions,
	mealAgentName,
	MEAL_TRANSITIONS,
	memberAgentName,
	planAgentName,
	recordPhaseTransition,
	scheduleNextAlarm,
	shopAgentName,
	SHOP_TRANSITIONS,
	type AgentSqlSink,
} from "../../src/mise-graph/agents/base";

const u40: Scenario = {
	id: "u40",
	name: "Wave 7 entity-DO foundation: id helpers, guards, scheduler, audit log",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. Id helpers ──────────────────────────────────────────────────
		ctx.assert.eq(
			householdAgentName("hh_a"),
			"household:hh_a",
			"household DO id format",
		);
		ctx.assert.eq(planAgentName("p1"), "plan:p1", "plan DO id format");
		ctx.assert.eq(
			mealAgentName("p1", "2026-05-13", "dinner"),
			"meal:p1:2026-05-13:dinner",
			"meal DO id format matches existing meal_id format",
		);
		ctx.assert.eq(
			shopAgentName("p1", "shop_run_42"),
			"shop:p1:shop_run_42",
			"shop DO id format",
		);
		ctx.assert.eq(
			cookAgentName("meal:p1:2026-05-13:dinner", "sess_abc"),
			"cook:meal:p1:2026-05-13:dinner:sess_abc",
			"cook DO id format embeds the meal_id",
		);
		ctx.assert.eq(
			memberAgentName("hh_a", "m_corey"),
			"member:hh_a:m_corey",
			"member DO id format",
		);

		// ── 2. Transition guards ───────────────────────────────────────────
		ctx.assert.ok(
			isLegalTransition(MEAL_TRANSITIONS, "planned", "pre_eve"),
			"meal: planned → pre_eve is legal",
		);
		ctx.assert.ok(
			!isLegalTransition(MEAL_TRANSITIONS, "planned", "active_cook"),
			"meal: planned → active_cook is illegal (skipping pre_eve/day_of)",
		);
		ctx.assert.ok(
			isLegalTransition(SHOP_TRANSITIONS, "planned", "active_today"),
			"shop: planned → active_today is legal",
		);
		ctx.assert.ok(
			!isLegalTransition(SHOP_TRANSITIONS, "completed", "planned"),
			"shop: completed is terminal",
		);
		ctx.assert.ok(
			isLegalTransition(COOK_TRANSITIONS, "pre_session", "active_session"),
			"cook: pre_session → active_session is legal",
		);

		// ── 3. Scheduler short-circuits when rule returns null ─────────────
		const fakeAgent = {
			scheduledCalls: [] as Array<{ at: Date; cb: string; payload: unknown }>,
			schedule(at: Date | string | number, cb: string, payload?: unknown) {
				if (at instanceof Date) this.scheduledCalls.push({ at, cb, payload });
				return Promise.resolve({} as unknown);
			},
		};
		const noOpResult = await scheduleNextAlarm(
			fakeAgent,
			{ phase: "planned" as const },
			() => null,
			"onPhaseAlarm",
			{ tag: "noop" },
		);
		ctx.assert.eq(noOpResult.scheduled, false, "null rule does not schedule");
		ctx.assert.eq(
			fakeAgent.scheduledCalls.length,
			0,
			"no schedule call when rule returns null",
		);

		const target = new Date("2030-01-01T00:00:00.000Z");
		const realResult = await scheduleNextAlarm(
			fakeAgent,
			{ phase: "planned" as const },
			() => target,
			"onPhaseAlarm",
			{ tag: "real" },
		);
		ctx.assert.eq(realResult.scheduled, true, "rule with Date schedules");
		ctx.assert.eq(realResult.at, target.toISOString(), "scheduled at echoed");
		ctx.assert.eq(
			fakeAgent.scheduledCalls.length,
			1,
			"schedule called exactly once",
		);
		ctx.assert.eq(
			fakeAgent.scheduledCalls[0].cb,
			"onPhaseAlarm",
			"callback name forwarded",
		);

		// ── 4. Phase-transition audit log round-trip ───────────────────────
		const sink = makeFakeSqlSink();
		ensurePhaseTransitionsTable(sink);
		ctx.assert.ok(
			sink.tables.has("phase_transitions"),
			"ensurePhaseTransitionsTable created phase_transitions",
		);
		recordPhaseTransition(sink, {
			id: generateAgentId("ph"),
			from_phase: "planned",
			to_phase: "pre_eve",
			at_ms: 1700000000000,
			reason: "alarm:pre_eve",
		});
		recordPhaseTransition(sink, {
			id: generateAgentId("ph"),
			from_phase: "pre_eve",
			to_phase: "day_of",
			at_ms: 1700000086400,
			reason: "alarm:day_of",
		});
		const rows = listPhaseTransitions(sink);
		ctx.assert.eq(rows.length, 2, "two rows persisted to phase_transitions");
		ctx.assert.eq(rows[0].from_phase, "planned", "first row from_phase");
		ctx.assert.eq(rows[0].to_phase, "pre_eve", "first row to_phase");
		ctx.assert.eq(rows[1].from_phase, "pre_eve", "second row from_phase");
		ctx.assert.eq(rows[1].to_phase, "day_of", "second row to_phase");

		// ── 5. DO source files exist with the documented exports ──────────
		// The Agents SDK imports `cloudflare:workers` at module-load time, which
		// throws under Node. So we can't `await import(...)` the agent class
		// files here — instead we statically inspect each source file to confirm
		// it declares the expected `export class ...` symbol. The Wave 7B
		// miniflare integration test will exercise the runtime side.
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const AGENTS_DIR = path.resolve(HERE, "../../src/mise-graph/agents");

		const expectedClasses: Array<[string, string]> = [
			["household-agent.ts", "HouseholdAgent"],
			["plan-agent.ts", "PlanAgent"],
			["meal-agent.ts", "MealAgent"],
			["shop-agent.ts", "ShopAgent"],
			["cook-agent.ts", "CookAgent"],
			["member-agent.ts", "MemberAgent"],
		];
		for (const [file, className] of expectedClasses) {
			const src = await fs.readFile(path.join(AGENTS_DIR, file), "utf8");
			ctx.assert.matches(
				src,
				new RegExp(`export class ${className}\\s+extends\\s+Agent`),
				`${file} declares 'export class ${className} extends Agent'`,
			);
		}

		// ── 6. Worker entry re-exports the DO classes (static check) ───────
		const workerSrc = await fs.readFile(
			path.resolve(HERE, "../../src/mise-graph-worker.ts"),
			"utf8",
		);
		for (const [, className] of expectedClasses) {
			ctx.assert.matches(
				workerSrc,
				new RegExp(`export\\s*\\{\\s*${className}\\s*\\}`),
				`mise-graph-worker.ts re-exports ${className}`,
			);
		}

		ctx.notes.push(`generateAgentId sample: ${generateAgentId("test")}`);
		ctx.notes.push(`audit rows: ${rows.length}`);
		ctx.notes.push(`scheduler calls: ${fakeAgent.scheduledCalls.length}`);
		ctx.notes.push(
			"DO runtime tests deferred to Wave 7B miniflare integration",
		);
	},
};

// ─── Fake SQL sink ──────────────────────────────────────────────────────────
//
// Mimics the tagged-template `this.sql` that the Agents SDK exposes. Stores
// rows in a Map per table; supports the small CREATE / INSERT / SELECT
// patterns the foundation uses. NOT a SQL parser — it pattern-matches the
// few statements base.ts emits.

interface FakeSqlSink extends AgentSqlSink {
	tables: Map<string, Array<Record<string, unknown>>>;
}

function makeFakeSqlSink(): FakeSqlSink {
	const tables = new Map<string, Array<Record<string, unknown>>>();

	function exec(strings: TemplateStringsArray, ...values: unknown[]): unknown[] {
		// Reconstruct the SQL with placeholders so we can pattern-match.
		const raw = strings.reduce((acc, s, i) => {
			const v = i < values.length ? `$${i}` : "";
			return acc + s + v;
		}, "").trim();

		// CREATE TABLE IF NOT EXISTS phase_transitions (...)
		const createMatch = raw.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
		if (createMatch) {
			const name = createMatch[1];
			if (!tables.has(name)) tables.set(name, []);
			return [];
		}

		// CREATE INDEX — just no-op.
		if (/^CREATE INDEX/i.test(raw)) return [];

		// INSERT INTO phase_transitions (id, from_phase, to_phase, at_ms, reason) VALUES ($0, $1, $2, $3, $4)
		const insertMatch = raw.match(
			/INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES/i,
		);
		if (insertMatch) {
			const name = insertMatch[1];
			const cols = insertMatch[2].split(",").map(c => c.trim());
			if (!tables.has(name)) tables.set(name, []);
			const row: Record<string, unknown> = {};
			cols.forEach((col, i) => {
				row[col] = values[i];
			});
			tables.get(name)!.push(row);
			return [];
		}

		// SELECT ... FROM phase_transitions ORDER BY at_ms ASC
		const selectMatch = raw.match(/FROM\s+(\w+)/i);
		if (/^SELECT/i.test(raw) && selectMatch) {
			const name = selectMatch[1];
			const rows = (tables.get(name) || []).slice();
			if (/ORDER BY at_ms ASC/i.test(raw)) {
				rows.sort(
					(a, b) =>
						(a.at_ms as number) - (b.at_ms as number),
				);
			}
			return rows;
		}

		return [];
	}

	const sink: FakeSqlSink = {
		tables,
		sql: <T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] => exec(strings, ...values) as T[],
	};
	return sink;
}

export default u40;
