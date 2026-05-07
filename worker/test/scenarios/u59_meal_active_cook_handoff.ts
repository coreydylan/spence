// U59 — MealAgent active_cook → CookingLeadAgent hand-off.
//
// Exercises the Wave 8 boundary contract. Two layers:
//   A. The pure `active_cook_entry` handler still emits the cook_session_id
//      + marker + 4h alarm (no behavioural drift from Wave 7B Track A).
//   B. The free-standing `spawnCookingLeadAgent` helper:
//        1. Skips silently when COOKING_LEAD_AGENT binding is absent.
//        2. POSTs to /init with the right payload when bound.
//        3. Returns ok:false with an error message on stub.fetch failure
//           (without throwing).
//        4. Refuses to spawn with empty cook_session_id.
//
// We do NOT instantiate the MealAgent class here — it imports the Agents
// SDK which doesn't load under Node tests. The MealAgent instance method
// `spawnCookingLeadAgent` delegates to the pure helper this scenario tests.

import type { Scenario } from "../lib/types";
import {
	active_cook_entry,
	defaultWindowsForSlot,
	type MealSnapshot,
	type PhaseHandlerDeps,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import { spawnCookingLeadAgent } from "../../src/mise-graph/agents/cooking-lead-handoff";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

interface CapturedRequest {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

interface MockStubResult {
	ok?: boolean;
	throw_error?: string;
}

function makeMockNamespace(captured: CapturedRequest[], stubResult: MockStubResult = { ok: true }): {
	idFromName: (name: string) => unknown;
	get: (id: unknown) => { fetch: (req: Request) => Promise<Response> };
	last_id_name: string | null;
} {
	let last_id_name: string | null = null;
	return {
		last_id_name,
		idFromName(name: string) {
			(this as { last_id_name: string | null }).last_id_name = name;
			return { _name: name };
		},
		get(id: unknown) {
			return {
				async fetch(req: Request): Promise<Response> {
					if (stubResult.throw_error) throw new Error(stubResult.throw_error);
					const text = await req.text();
					let body: Record<string, unknown> | null = null;
					try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
					captured.push({ url: req.url, method: req.method, body });
					return new Response(
						JSON.stringify({ ok: stubResult.ok ?? true, _id: (id as { _name?: string })?._name }),
						{ status: stubResult.ok === false ? 500 : 200, headers: { "content-type": "application/json" } },
					);
				},
			};
		},
	};
}

const u59: Scenario = {
	id: "u59",
	name: "MealAgent active_cook entry → CookingLeadAgent hand-off",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Part A: active_cook_entry still emits the marker + 4h alarm ──
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
		const snapshot: MealSnapshot = {
			meal_id: "meal:p1:2026-05-13:dinner",
			plan_id: "p1",
			household_id: "hh_a",
			date,
			slot: "dinner",
			format: "skillet",
			cuisine: ["italian"],
			recipe_id: "recipe:lemon_chicken",
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms: windows.cook_window_end_ms,
			eat_window_start_ms: windows.eat_window_start_ms,
			eat_window_end_ms: windows.eat_window_end_ms,
			equipment: ["12in skillet"],
		};

		const fakeEnv = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) }) } } as unknown as MiseGraphEnv;
		const t_active_cook_now = snapshot.cook_window_start_ms + 15 * 60 * 1000;
		const deps: PhaseHandlerDeps = {
			env: fakeEnv,
			now_ms: t_active_cook_now,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		};
		const result = await active_cook_entry(snapshot, deps);
		ctx.assert.eq(result.phase, "active_cook", "phase=active_cook");
		ctx.assert.eq(result.cook_sessions.length, 1, "one cook session row emitted");
		ctx.assert.ok(!!result.cook_session_marker, "cook_session_marker present");
		ctx.assert.eq(
			result.cook_session_marker!.state,
			"started",
			"marker state=started",
		);
		ctx.assert.eq(
			result.next_alarm_at_ms,
			t_active_cook_now + 4 * 60 * 60 * 1000,
			"next_alarm = now + 4h (stale timeout)",
		);
		const cook_session_id = result.cook_session_marker!.cook_session_id;
		ctx.assert.matches(cook_session_id, /^cook_/, "cook_session_id has cook_ prefix");

		// Marker meta references the Wave 8 hand-off.
		const marker_meta = JSON.parse(result.cook_sessions[0].meta_json || "{}");
		ctx.assert.contains(
			JSON.stringify(marker_meta),
			"wave_8_handoff",
			"cook_session meta records the hand-off",
		);

		// ── Part B: hand-off helper behaviour ────────────────────────────

		// 1. Binding absent → skip cleanly.
		const skipResult = await spawnCookingLeadAgent({
			env: {},
			cook_session_id,
			meal_id: snapshot.meal_id,
			plan_id: snapshot.plan_id,
			household_id: snapshot.household_id,
		});
		ctx.assert.ok(!skipResult.ok, "no binding → ok=false");
		ctx.assert.ok(skipResult.skipped, "no binding → skipped=true");
		ctx.assert.eq(
			skipResult.skip_reason,
			"binding_absent",
			"skip_reason=binding_absent",
		);

		// 2. Bound → POSTs to /init with the right payload + DO id.
		const captured: CapturedRequest[] = [];
		const ns = makeMockNamespace(captured, { ok: true });
		const okResult = await spawnCookingLeadAgent({
			env: { COOKING_LEAD_AGENT: ns as unknown as DurableObjectNamespace },
			cook_session_id,
			meal_id: snapshot.meal_id,
			plan_id: snapshot.plan_id,
			household_id: snapshot.household_id,
		});
		ctx.assert.ok(okResult.ok, "spawn returns ok=true on success");
		ctx.assert.ok(!okResult.skipped, "spawn was not skipped");
		ctx.assert.eq(captured.length, 1, "exactly one DO fetch was made");
		ctx.assert.eq(captured[0].method, "POST", "POST request");
		ctx.assert.contains(captured[0].url, "/init", "URL targets /init");
		ctx.assert.eq(
			captured[0].body?.cook_session_id,
			cook_session_id,
			"payload includes cook_session_id",
		);
		ctx.assert.eq(
			captured[0].body?.meal_id,
			snapshot.meal_id,
			"payload includes meal_id",
		);
		ctx.assert.eq(
			captured[0].body?.plan_id,
			snapshot.plan_id,
			"payload includes plan_id",
		);
		ctx.assert.eq(
			captured[0].body?.household_id,
			snapshot.household_id,
			"payload includes household_id",
		);
		ctx.assert.eq(
			(ns as { last_id_name: string | null }).last_id_name,
			`cooking_lead:${cook_session_id}`,
			"DO id is cooking_lead:<cook_session_id>",
		);

		// 3. Stub fetch throws → ok=false, error captured.
		const captured2: CapturedRequest[] = [];
		const nsErr = makeMockNamespace(captured2, { throw_error: "boom" });
		const errResult = await spawnCookingLeadAgent({
			env: { COOKING_LEAD_AGENT: nsErr as unknown as DurableObjectNamespace },
			cook_session_id,
			meal_id: snapshot.meal_id,
			plan_id: snapshot.plan_id,
			household_id: snapshot.household_id,
		});
		ctx.assert.ok(!errResult.ok, "stub error → ok=false");
		ctx.assert.ok(!errResult.skipped, "stub error is NOT a skip");
		ctx.assert.contains(errResult.error || "", "boom", "error captured");

		// 4. Empty cook_session_id refuses to spawn.
		const emptyResult = await spawnCookingLeadAgent({
			env: { COOKING_LEAD_AGENT: ns as unknown as DurableObjectNamespace },
			cook_session_id: "",
			meal_id: snapshot.meal_id,
			plan_id: snapshot.plan_id,
			household_id: snapshot.household_id,
		});
		ctx.assert.ok(!emptyResult.ok, "empty cook_session_id → ok=false");
		ctx.assert.ok(emptyResult.skipped, "skipped");
		ctx.assert.eq(
			emptyResult.skip_reason,
			"missing_cook_session_id",
			"skip_reason=missing_cook_session_id",
		);
	},
};

export default u59;
