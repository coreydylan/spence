// U48 — ShopAgent state-machine: extended phase enum + alarm scheduling +
// reminder persistence.
//
// The DO can't boot in node-side tests, so we exercise the extracted
// shop-phase-handlers helpers directly — that's the contract Phase 2 wiring
// will rely on.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateShopRemindersSchema } from "../../src/mise-graph/schemas/migrations";
import {
	activeTodayAlarmAt,
	buildShopReminderRow,
	decideShopEntry,
	isLegalShopTransition,
	persistShopReminder,
	SHOP_PHASES_EXT,
	SHOP_TRANSITIONS_EXT,
} from "../../src/mise-graph/agents/shop-phase-handlers";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u48: Scenario = {
	id: "u48",
	name: "ShopAgent: extended state machine + alarm timing + reminder persistence",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. Extended phase enum includes `cancelled` ────────────────────
		ctx.assert.eq(SHOP_PHASES_EXT.length, 4, "extended enum has 4 phases");
		ctx.assert.contains(SHOP_PHASES_EXT, "cancelled", "extended enum includes cancelled");

		// ── 2. Forward path is legal ───────────────────────────────────────
		ctx.assert.ok(
			isLegalShopTransition("planned", "active_today"),
			"planned → active_today legal",
		);
		ctx.assert.ok(
			isLegalShopTransition("active_today", "completed"),
			"active_today → completed legal",
		);

		// ── 3. Cancellation paths ──────────────────────────────────────────
		ctx.assert.ok(
			isLegalShopTransition("planned", "cancelled"),
			"planned → cancelled legal",
		);
		ctx.assert.ok(
			isLegalShopTransition("active_today", "cancelled"),
			"active_today → cancelled legal",
		);

		// ── 4. Terminal phases are terminal ────────────────────────────────
		for (const term of ["completed", "cancelled"] as const) {
			for (const next of SHOP_PHASES_EXT) {
				ctx.assert.ok(
					!isLegalShopTransition(term, next),
					`${term} is terminal: ${term} → ${next} illegal`,
				);
			}
		}

		// ── 5. Self-transitions illegal ────────────────────────────────────
		for (const phase of SHOP_PHASES_EXT) {
			ctx.assert.ok(
				!isLegalShopTransition(phase, phase),
				`self-transition ${phase} → ${phase} illegal`,
			);
		}

		// ── 6. Skipping phases illegal ─────────────────────────────────────
		ctx.assert.ok(
			!isLegalShopTransition("completed", "active_today"),
			"completed cannot reopen",
		);

		// ── 7. activeTodayAlarmAt: future date → 13:00Z that day ───────────
		const now = new Date("2026-05-13T12:00:00Z");
		const futureAlarm = activeTodayAlarmAt("2026-05-15", now);
		ctx.assert.ok(!!futureAlarm, "alarm computed for future date");
		ctx.assert.eq(
			futureAlarm!.toISOString(),
			"2026-05-15T13:00:00.000Z",
			"alarm fires at 13:00Z (= 6am Pacific) on run_date",
		);

		// Past run_date → fire ~immediately (60s after now).
		const pastAlarm = activeTodayAlarmAt("2026-05-10", now);
		ctx.assert.ok(!!pastAlarm, "alarm computed for past date (catch-up)");
		ctx.assert.gt(pastAlarm!.getTime() - now.getTime(), 0, "catch-up alarm is in the future");
		ctx.assert.lte(pastAlarm!.getTime() - now.getTime(), 120_000, "catch-up alarm fires ~immediately");

		ctx.assert.eq(activeTodayAlarmAt("not-a-date", now), null, "invalid date returns null");

		// ── 8. decideShopEntry ─────────────────────────────────────────────
		const planned = decideShopEntry("planned", "2026-05-15", now);
		ctx.assert.eq(planned.side_effect_kind, "none", "planned has no side effect");
		ctx.assert.ok(!!planned.next_alarm_at, "planned schedules next alarm");
		const active = decideShopEntry("active_today", "2026-05-15", now);
		ctx.assert.eq(active.side_effect_kind, "shop_reminder", "active_today writes a reminder");
		ctx.assert.eq(active.next_alarm_at, null, "active_today: no further alarm");
		const done = decideShopEntry("completed", "2026-05-15", now);
		ctx.assert.eq(done.side_effect_kind, "completion", "completed: completion side-effect");
		const cancelled = decideShopEntry("cancelled", "2026-05-15", now);
		ctx.assert.eq(cancelled.side_effect_kind, "cancellation", "cancelled: cancellation side-effect");

		// ── 9. buildShopReminderRow + persist round-trip ───────────────────
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateShopRemindersSchema(env);

		const row = buildShopReminderRow({
			shop_run_id: "shop_42",
			plan_id: "p1",
			run_date: "2026-05-15",
			payload: { items: 12 },
			now: new Date("2026-05-15T13:00:00Z"),
		});
		ctx.assert.matches(row.id, /^rem_/, "reminder id is prefixed");
		ctx.assert.eq(row.shop_run_id, "shop_42", "shop_run_id round-trips");
		ctx.assert.eq(row.delivered, 0, "fresh reminder is not delivered");

		await persistShopReminder(env, row);
		const loaded = await env.DB.prepare(
			`SELECT shop_run_id, plan_id, run_date, delivered FROM mise_shop_reminders
			 WHERE shop_run_id = ? ORDER BY created_at_ms DESC LIMIT 1`,
		).bind("shop_42").first<{
			shop_run_id: string;
			plan_id: string;
			run_date: string;
			delivered: number;
		}>();
		ctx.assert.ok(!!loaded, "reminder persisted");
		ctx.assert.eq(loaded!.shop_run_id, "shop_42", "round-trip shop_run_id");
		ctx.assert.eq(loaded!.plan_id, "p1", "round-trip plan_id");
		ctx.assert.eq(loaded!.run_date, "2026-05-15", "round-trip run_date");
		ctx.assert.eq(loaded!.delivered, 0, "round-trip delivered=0");

		ctx.notes.push(`SHOP_PHASES_EXT: ${SHOP_PHASES_EXT.join(" / ")}`);
		ctx.notes.push(`reminder id sample: ${row.id}`);
		ctx.notes.push(
			`transitions: ${Object.entries(SHOP_TRANSITIONS_EXT).map(([k, v]) => `${k}→[${v.join(",")}]`).join(" | ")}`,
		);
	},
};

export default u48;
