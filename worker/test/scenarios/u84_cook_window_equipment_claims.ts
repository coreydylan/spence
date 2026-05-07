// U84 — cook_window_entry claims real household equipment + surfaces conflicts.
//
// Track D wires MealAgent.cook_window_entry to the canonical D1-backed
// equipment tracker (worker/src/mise-graph/equipment.ts) so two meals on
// the same household can no longer both claim the oven for an overlapping
// window. The scenario walks four assertions:
//
//   1. First meal cleanly claims oven for cook+eat window
//      (granted=N, conflicts=0, no equipment_conflict notification).
//   2. Second meal SAME-DAY overlapping the same oven sees a conflict
//      (granted=0, conflicts=1, kind="equipment_conflict" notification
//      emitted to each adult, briefing payload carries conflict details).
//   3. After eaten_entry runs on meal 1, the oven is released → meal 2
//      can re-claim cleanly.
//   4. cancelled_entry on meal 2 also releases the canonical D1 claims.
//
// The fake D1 is the same EquipmentFakeD1 used by u53 — it speaks just
// enough of equipment.ts's SQL grammar to round-trip definitions and
// claims through `prepare(...).bind(...).run()/first()/all()`.

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	cancelled_entry,
	cook_window_entry,
	defaultWindowsForSlot,
	eaten_entry,
	type MealSnapshot,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import {
	defaultEquipmentDefinition,
	ensureEquipmentDefined,
} from "../../src/mise-graph/equipment";
import { type AgentSqlSink } from "../../src/mise-graph/agents/base";
import { EquipmentFakeD1 } from "../lib/wave7c-fake-d1";

const u84: Scenario = {
	id: "u84",
	name: "cook_window_entry: real household equipment claim + conflict notification + release on eaten/cancel",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Setup ──────────────────────────────────────────────────────────
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
		const HH = "hh_u84";

		const db = new EquipmentFakeD1();
		const env = { DB: db as unknown as D1Database } as unknown as MiseGraphEnv;

		// Sanity: the helper auto-defines + ensureEquipmentDefined caches.
		const oven_def = defaultEquipmentDefinition("oven", HH);
		ctx.assert.ok(oven_def.exclusive, "default 'oven' is exclusive");
		const burner_def = defaultEquipmentDefinition("stovetop", HH);
		ctx.assert.ok(!burner_def.exclusive, "default 'stovetop' is shared");
		ctx.assert.eq(burner_def.capacity, 4, "stovetop default capacity = 4");

		const def_first = await ensureEquipmentDefined(env, HH, "oven");
		ctx.assert.eq(def_first.slug, "oven", "ensureEquipmentDefined inserts oven");
		const def_again = await ensureEquipmentDefined(env, HH, "oven");
		ctx.assert.eq(def_again.slug, "oven", "ensureEquipmentDefined is idempotent");
		ctx.assert.eq(db.definitions.size, 1, "only one definition row after idempotent calls");

		// ── Test 1: meal 1 claims oven cleanly ────────────────────────────
		const meal1: MealSnapshot = {
			meal_id: "meal:p1:2026-05-13:dinner",
			plan_id: "p1",
			household_id: HH,
			date,
			slot: "dinner",
			format: "roast",
			cuisine: ["mediterranean"],
			recipe_id: "recipe:lemon_chicken",
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms:   windows.cook_window_end_ms,
			eat_window_start_ms:  windows.eat_window_start_ms,
			eat_window_end_ms:    windows.eat_window_end_ms,
			equipment: ["oven"],
		};
		const sink1 = makeFakeSqlSink();
		const r1 = await cook_window_entry(meal1, {
			env,
			now_ms: meal1.cook_window_start_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		}, sink1);

		ctx.assert.eq(r1.phase, "cook_window", "phase=cook_window for meal 1");
		ctx.assert.ok(!!r1.household_equipment_claim, "household_equipment_claim populated");
		ctx.assert.ok(r1.household_equipment_claim!.ok, "meal 1 claim ok=true");
		ctx.assert.eq(r1.household_equipment_claim!.granted.length, 1, "1 oven claim granted");
		ctx.assert.eq(r1.household_equipment_claim!.conflicts.length, 0, "no conflicts on fresh oven");
		ctx.assert.eq(r1.household_equipment_claim!.granted[0].equipment_slug, "oven", "granted slug = oven");
		ctx.assert.eq(
			r1.household_equipment_claim!.granted[0].claim_for.id,
			meal1.meal_id,
			"claim_for.id = meal 1's id",
		);

		// No equipment_conflict notification on a clean claim.
		const conflictNotifs1 = r1.notifications.filter(n => n.kind === "equipment_conflict");
		ctx.assert.eq(conflictNotifs1.length, 0, "no equipment_conflict notifications when clean");
		ctx.assert.eq(
			r1.notifications.filter(n => n.kind === "member_call").length,
			2,
			"two member_call notifications fan-out to adults",
		);

		// Briefing carries the household summary.
		const brief1 = JSON.parse(r1.briefings[0].payload_json) as {
			household_equipment_claim_summary: {
				ok: boolean;
				granted_count: number;
				conflict_count: number;
				granted_slugs: string[];
			} | null;
		};
		ctx.assert.ok(!!brief1.household_equipment_claim_summary, "briefing carries household summary");
		ctx.assert.eq(brief1.household_equipment_claim_summary!.granted_count, 1, "briefing granted_count=1");
		ctx.assert.eq(brief1.household_equipment_claim_summary!.conflict_count, 0, "briefing conflict_count=0");
		ctx.assert.contains(brief1.household_equipment_claim_summary!.granted_slugs, "oven", "briefing names oven slug");

		// ── Test 2: meal 2 SAME-DAY overlapping oven → conflict ────────────
		const meal2: MealSnapshot = {
			...meal1,
			meal_id: "meal:p1:2026-05-13:dinner_alt",
			format: "casserole",
			equipment: ["oven"],
		};
		const sink2 = makeFakeSqlSink();
		const r2 = await cook_window_entry(meal2, {
			env,
			now_ms: meal2.cook_window_start_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		}, sink2);

		ctx.assert.ok(!!r2.household_equipment_claim, "meal 2 household claim populated");
		ctx.assert.ok(!r2.household_equipment_claim!.ok, "meal 2 claim ok=false on overlap");
		ctx.assert.eq(r2.household_equipment_claim!.granted.length, 0, "all_or_nothing: 0 granted on conflict");
		ctx.assert.eq(r2.household_equipment_claim!.conflicts.length, 1, "1 oven conflict reported");
		ctx.assert.eq(
			r2.household_equipment_claim!.conflicts[0].requested.equipment_slug,
			"oven",
			"conflict is on oven slug",
		);
		ctx.assert.eq(
			r2.household_equipment_claim!.conflicts[0].conflicts_with[0].claim_for.id,
			meal1.meal_id,
			"conflict points back at meal 1",
		);

		// Each adult gets one equipment_conflict notification per conflict.
		const conflictNotifs2 = r2.notifications.filter(n => n.kind === "equipment_conflict");
		ctx.assert.eq(conflictNotifs2.length, 2, "two adults × one conflict = 2 equipment_conflict notifs");
		ctx.assert.contains(conflictNotifs2[0].title, "Equipment conflict", "conflict title prefix");
		ctx.assert.contains(conflictNotifs2[0].body, "oven", "conflict body names equipment");
		ctx.assert.contains(conflictNotifs2[0].body, "busy", "conflict body says busy");
		const conflictPayload = JSON.parse(conflictNotifs2[0].payload_json || "{}") as {
			equipment_slug: string;
			meal_id: string;
		};
		ctx.assert.eq(conflictPayload.equipment_slug, "oven", "conflict payload equipment_slug");
		ctx.assert.eq(conflictPayload.meal_id, meal2.meal_id, "conflict payload meal_id = the requesting meal");

		// Briefing surfaces conflict_count > 0.
		const brief2 = JSON.parse(r2.briefings[0].payload_json) as {
			household_equipment_claim_summary: {
				ok: boolean;
				granted_count: number;
				conflict_count: number;
			} | null;
		};
		ctx.assert.eq(brief2.household_equipment_claim_summary!.conflict_count, 1, "meal 2 briefing conflict_count=1");

		// ── Test 3: meal 1 eaten → oven released → meal 2 re-claims ────────
		const eaten1 = await eaten_entry(meal1, {
			env,
			now_ms: meal1.eat_window_end_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		}, "cook_session_meal1");
		ctx.assert.eq(eaten1.phase, "eaten", "phase=eaten");
		ctx.assert.ok(!!eaten1.equipment_released, "eaten releases equipment");
		ctx.assert.eq(eaten1.equipment_released!.released, 1, "released the 1 oven claim from meal 1");

		// Verify the underlying row is now status='released'.
		const m1Claims = [...db.claims.values()].filter(c => c.claim_for_id === meal1.meal_id);
		ctx.assert.eq(m1Claims.length, 1, "meal 1's claim row still exists");
		ctx.assert.eq(m1Claims[0].status, "released", "meal 1's claim status flipped to released");

		// Now meal 2 retries. Use the same env (carries the released claim).
		const sink3 = makeFakeSqlSink();
		const r2b = await cook_window_entry(meal2, {
			env,
			now_ms: meal2.cook_window_start_ms,
			adults: { adult_member_ids: ["m_corey"] },
		}, sink3);
		ctx.assert.ok(r2b.household_equipment_claim!.ok, "meal 2 retry claim ok=true after release");
		ctx.assert.eq(r2b.household_equipment_claim!.granted.length, 1, "meal 2 retry: 1 granted");
		ctx.assert.eq(r2b.household_equipment_claim!.conflicts.length, 0, "meal 2 retry: 0 conflicts");

		// ── Test 4: cancelled_entry releases the canonical D1 claims ───────
		const sinkCancel = makeFakeSqlSink();
		const cancel = await cancelled_entry(
			meal2,
			{
				env,
				now_ms: meal2.eat_window_end_ms,
				adults: { adult_member_ids: ["m_corey"] },
			},
			sinkCancel,
			"calendar conflict",
		);
		ctx.assert.eq(cancel.phase, "archived", "cancel returns phase=archived");
		ctx.assert.ok(!!cancel.equipment_released, "cancel releases equipment");
		// release count = legacy stub (0, fresh sink) + household (1 oven row from r2b).
		ctx.assert.gte(
			cancel.equipment_released!.released,
			1,
			"cancel releases at least the 1 household oven claim",
		);
		const m2Claims = [...db.claims.values()].filter(c => c.claim_for_id === meal2.meal_id);
		ctx.assert.gte(m2Claims.length, 1, "meal 2's claim row exists");
		const heldM2 = m2Claims.filter(c => c.status === "held");
		ctx.assert.eq(heldM2.length, 0, "no held claims left for meal 2 after cancel");

		ctx.notes.push(`def rows: ${db.definitions.size}, claim rows: ${db.claims.size}`);
		ctx.notes.push(`meal1 grant=1 conflict=0; meal2 first grant=0 conflict=1; meal2 retry grant=1`);
		ctx.notes.push(`equipment_conflict notifications fanned out: ${conflictNotifs2.length}`);
	},
};

// Tagged-template SQL sink that supports the legacy per-DO equipment-stub
// SQL the cook_window_entry's `claimEquipmentForMeal(sink, ...)` path
// issues. Lifted from u43; kept here so this scenario stands alone.
function makeFakeSqlSink(): AgentSqlSink {
	const tables = new Map<string, Array<Record<string, unknown>>>();
	function exec(strings: TemplateStringsArray, ...values: unknown[]): unknown[] {
		const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ""), "").trim();
		if (/CREATE TABLE/i.test(raw)) {
			const m = raw.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
			if (m && !tables.has(m[1])) tables.set(m[1], []);
			return [];
		}
		if (/^CREATE INDEX/i.test(raw)) return [];
		const insertM = raw.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
		if (insertM) {
			const name = insertM[1];
			const cols = insertM[2].split(",").map(c => c.trim());
			if (!tables.has(name)) tables.set(name, []);
			const row: Record<string, unknown> = {};
			cols.forEach((col, i) => { row[col] = values[i]; });
			tables.get(name)!.push(row);
			return [];
		}
		if (/^SELECT/i.test(raw)) {
			const fromM = raw.match(/FROM\s+(\w+)/i);
			if (!fromM) return [];
			const rows = tables.get(fromM[1]) || [];
			if (/equipment\s*=\s*\$0/.test(raw) && /start_ms\s*<\s*\$1/.test(raw) && /end_ms\s*>\s*\$2/.test(raw)) {
				const equipment = values[0];
				const queryEnd = values[1] as number;
				const queryStart = values[2] as number;
				return rows.filter(r => {
					if (r.equipment !== equipment) return false;
					if (r.released_at_ms !== null && r.released_at_ms !== undefined) return false;
					return (r.start_ms as number) < queryEnd && (r.end_ms as number) > queryStart;
				});
			}
			if (/COUNT\(\*\)/i.test(raw)) {
				const meal = String(values[0] ?? "");
				const n = rows.filter(r => r.meal_id === meal && r.released_at_ms == null).length;
				return [{ n }];
			}
			return rows.slice();
		}
		if (/^UPDATE/i.test(raw)) {
			const fromM = raw.match(/UPDATE\s+(\w+)/i);
			if (fromM) {
				const name = fromM[1];
				const rows = tables.get(name) || [];
				const meal = String(values[1] ?? "");
				for (const r of rows) {
					if (r.meal_id === meal && r.released_at_ms == null) {
						r.released_at_ms = values[0] as number;
					}
				}
			}
			return [];
		}
		return [];
	}
	return {
		sql: <T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] => exec(strings, ...values) as T[],
	};
}

export default u84;
