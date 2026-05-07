// U74 — Brigade completion → MemberAgent skill-outcome fan-out.
//
// When a member completes a task (either via WS `complete_task` or via the
// lead's `brigade_mark_task_complete` MCP tool), the CookingLeadAgent calls
// the pure helper `fanOutBrigadeSkillOutcome` which POSTs to the
// MemberAgent's `/skill-outcome` route. The brigade event log is the
// authoritative record; the MemberAgent fan-out is a sidecar.
//
// This scenario asserts the fan-out contract end-to-end (helper-level):
//   1. Happy path → MemberAgent receives the skill-outcome with
//      {skill_name, outcome, task_id, meal_id, notes}.
//   2. Missing MEMBER_AGENT binding → silent skip with reason.
//   3. Missing household_id → silent skip with reason.
//   4. Empty member_id / task_id → silent skip (defensive).
//   5. Stub fetch error → caught, returns {ok: false, error} (does NOT throw).
//   6. DO id is `member:<household_id>:<member_id>` (matches memberAgentName).

import type { Scenario } from "../lib/types";
import { fanOutBrigadeSkillOutcome } from "../../src/mise-graph/agents/brigade-skill-fanout";

interface CapturedCall {
	id_name: string;
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

interface MockOptions {
	throw_error?: string;
}

function makeMockMemberNs(captured: CapturedCall[], opts: MockOptions = {}): DurableObjectNamespace {
	let last_id: string = "";
	return {
		idFromName(name: string) {
			last_id = name;
			return { _name: name } as unknown as DurableObjectId;
		},
		get(_id: DurableObjectId) {
			return {
				async fetch(req: Request): Promise<Response> {
					if (opts.throw_error) throw new Error(opts.throw_error);
					const text = await req.text();
					let body: Record<string, unknown> | null = null;
					try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
					captured.push({
						id_name: last_id,
						url: req.url,
						method: req.method,
						body,
					});
					return new Response(
						JSON.stringify({ ok: true }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			} as unknown as DurableObjectStub;
		},
	} as unknown as DurableObjectNamespace;
}

const u74: Scenario = {
	id: "u74",
	name: "Brigade completion → MemberAgent skill-outcome fan-out (best-effort)",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Happy path.
		const captured: CapturedCall[] = [];
		const ns = makeMockMemberNs(captured);
		const env_ok = { MEMBER_AGENT: ns };
		const r1 = await fanOutBrigadeSkillOutcome({
			env: env_ok,
			household_id: "hh_test",
			member_id: "m_alice",
			task_id: "t_chop_onion",
			outcome: "success",
			meal_id: "meal:p1:2026-05-13:dinner",
			notes: "good knife work",
		});
		ctx.assert.ok(r1.ok, "happy path returns ok=true");
		ctx.assert.eq(captured.length, 1, "exactly one MemberAgent call");
		ctx.assert.eq(
			captured[0].id_name,
			"member:hh_test:m_alice",
			"DO id is member:<household_id>:<member_id>",
		);
		ctx.assert.contains(captured[0].url, "/skill-outcome", "routes to /skill-outcome");
		ctx.assert.eq(captured[0].method, "POST", "POST method");
		ctx.assert.eq(captured[0].body?.outcome, "success", "outcome forwarded");
		ctx.assert.eq(captured[0].body?.task_id, "t_chop_onion", "task_id forwarded");
		ctx.assert.eq(captured[0].body?.meal_id, "meal:p1:2026-05-13:dinner", "meal_id forwarded");
		ctx.assert.eq(captured[0].body?.notes, "good knife work", "notes forwarded");
		ctx.assert.eq(captured[0].body?.skill_name, "general", "default skill_name=general");

		// 2. Missing binding → silent skip.
		const captured2: CapturedCall[] = [];
		const r2 = await fanOutBrigadeSkillOutcome({
			env: {}, // no MEMBER_AGENT
			household_id: "hh_test",
			member_id: "m_alice",
			task_id: "t_x",
			outcome: "success",
		});
		ctx.assert.ok(!r2.ok, "missing binding → ok=false");
		ctx.assert.eq(r2.skipped, "missing_binding", "skipped reason recorded");
		ctx.assert.eq(captured2.length, 0, "no DO call captured");

		// 3. Missing household_id → silent skip.
		const r3 = await fanOutBrigadeSkillOutcome({
			env: env_ok,
			household_id: null,
			member_id: "m_alice",
			task_id: "t_x",
			outcome: "success",
		});
		ctx.assert.ok(!r3.ok, "missing household → ok=false");
		ctx.assert.eq(r3.skipped, "missing_household", "skipped reason recorded");

		// 4. Empty member_id → silent skip.
		const r4 = await fanOutBrigadeSkillOutcome({
			env: env_ok,
			household_id: "hh_test",
			member_id: "",
			task_id: "t_x",
			outcome: "success",
		});
		ctx.assert.ok(!r4.ok, "empty member_id → ok=false");
		ctx.assert.eq(r4.skipped, "missing_member", "skipped reason");

		// 5. Empty task_id → silent skip.
		const r5 = await fanOutBrigadeSkillOutcome({
			env: env_ok,
			household_id: "hh_test",
			member_id: "m_alice",
			task_id: "",
			outcome: "success",
		});
		ctx.assert.ok(!r5.ok, "empty task_id → ok=false");
		ctx.assert.eq(r5.skipped, "missing_task", "skipped reason");

		// 6. Stub fetch error → caught, returns ok=false with error message.
		const captured6: CapturedCall[] = [];
		const ns_err = makeMockMemberNs(captured6, { throw_error: "boom" });
		const r6 = await fanOutBrigadeSkillOutcome({
			env: { MEMBER_AGENT: ns_err },
			household_id: "hh_test",
			member_id: "m_alice",
			task_id: "t_x",
			outcome: "success",
		});
		ctx.assert.ok(!r6.ok, "stub error → ok=false");
		ctx.assert.contains(String(r6.error || ""), "boom", "error captured");

		// 7. Custom skill_name passes through (Wave 8B Track A future input).
		const captured7: CapturedCall[] = [];
		const ns7 = makeMockMemberNs(captured7);
		const r7 = await fanOutBrigadeSkillOutcome({
			env: { MEMBER_AGENT: ns7 },
			household_id: "hh_test",
			member_id: "m_bob",
			task_id: "t_sear",
			outcome: "partial",
			skill_name: "saute",
		});
		ctx.assert.ok(r7.ok, "custom skill_name happy path");
		ctx.assert.eq(captured7[0].body?.skill_name, "saute", "skill_name pass-through");
		ctx.assert.eq(captured7[0].body?.outcome, "partial", "outcome=partial pass-through");

		ctx.notes.push(`fan-out covered 7 paths; happy + 4 skip + 1 error + 1 custom`);
	},
};

export default u74;
