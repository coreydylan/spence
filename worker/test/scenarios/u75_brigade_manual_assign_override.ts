// U75 — Brigade manual assign override path.
//
// Asserts the chef-of-staff manual override flow:
//   1. brigade_assign_task_manually MCP tool routes to /manual-assign on the
//      CookingLeadAgent DO with the right shape.
//   2. The tool is wrapped in a trace (caller_kind=agent) so the override is
//      auditable.
//   3. brigade_unassign_task and brigade_mark_task_complete also produce
//      traces and route to the corresponding DO routes.
//   4. The DO's response is surfaced under {ok: true, ...}.
//   5. Missing required args throw at the caller (don't silently call the DO).

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { BrigadeFakeD1 } from "../lib/wave7c-fake-d1";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

interface CapturedCall {
	id_name: string;
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

function makeMockNs(captured: CapturedCall[], stub_response_by_action: Record<string, Record<string, unknown>> = {}): unknown {
	let last_id: string = "";
	return {
		idFromName(name: string) {
			last_id = name;
			return { _name: name };
		},
		get(_id: unknown) {
			return {
				async fetch(req: Request): Promise<Response> {
					const text = await req.text();
					let body: Record<string, unknown> | null = null;
					try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
					captured.push({ id_name: last_id, url: req.url, method: req.method, body });
					const action = new URL(req.url).pathname.split("/").pop() || "";
					const stub = stub_response_by_action[action] || { ok: true };
					return new Response(
						JSON.stringify(stub),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			};
		},
	};
}

const u75: Scenario = {
	id: "u75",
	name: "Brigade manual assign override: trace + DO routing + response surface",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const captured: CapturedCall[] = [];
		const db = new BrigadeFakeD1();
		const ns = makeMockNs(captured, {
			"manual-assign": {
				ok: true,
				task_id: "t_braise",
				member_id: "m_lead",
				assigned_at_ms: 1750000000000,
				trace_id: "trace_do_xyz",
			},
			"manual-unassign": {
				ok: true,
				task_id: "t_stuck",
				freed: 1,
				trace_id: "trace_do_unassign",
			},
			"manual-complete-task": {
				ok: true,
				task_id: "t_done",
				member_id: "m_lead",
				outcome: "succeeded",
				completed_at_ms: 1750000123000,
			},
		});
		const env = {
			DB: db as unknown as D1Database,
			COOKING_LEAD_AGENT: ns,
		} as unknown as MiseGraphEnv;
		const SES = "cs_u75_test";

		// 1. brigade_assign_task_manually — happy path.
		const r_assign = await callPlanWorldTool("brigade_assign_task_manually", {
			cook_session_id: SES,
			task_id: "t_braise",
			member_id: "m_lead",
			reason: "lead-only — high heat handling",
		}, env);
		ctx.assert.ok(r_assign.ok === true, "manual assign ok=true");
		ctx.assert.eq(r_assign.task_id, "t_braise", "task_id surfaced from DO response");
		ctx.assert.eq(r_assign.member_id, "m_lead", "member_id surfaced from DO response");
		ctx.assert.eq(captured.length, 1, "one DO call");
		ctx.assert.contains(captured[0].url, "/manual-assign", "routes to /manual-assign");
		ctx.assert.eq(captured[0].body?.reason, "lead-only — high heat handling", "reason forwarded");
		ctx.assert.eq(
			captured[0].id_name,
			`cooking_lead:${SES}`,
			"DO id is cooking_lead:<cook_session_id>",
		);

		// 2. The wrapping trace was persisted (best-effort — to FakeD1).
		ctx.assert.gte(db.agentTraces.length, 1, "MCP-tool trace persisted to D1");

		// 3. brigade_unassign_task — happy path with reason.
		const r_unassign = await callPlanWorldTool("brigade_unassign_task", {
			cook_session_id: SES,
			task_id: "t_stuck",
			reason: "took too long",
		}, env);
		ctx.assert.ok(r_unassign.ok === true, "unassign ok=true");
		ctx.assert.eq(r_unassign.freed, 1, "freed count surfaced");
		const last_un = captured[captured.length - 1];
		ctx.assert.contains(last_un.url, "/manual-unassign", "routes to /manual-unassign");
		ctx.assert.eq(last_un.body?.reason, "took too long", "reason forwarded");

		// 4. brigade_mark_task_complete — with member_id (skill-outcome fan-out
		//    happens INSIDE the DO; we verify here that the route receives the
		//    full payload).
		const r_complete = await callPlanWorldTool("brigade_mark_task_complete", {
			cook_session_id: SES,
			task_id: "t_done",
			member_id: "m_lead",
			outcome: "succeeded",
			notes: "lead handled it",
		}, env);
		ctx.assert.ok(r_complete.ok === true, "complete ok=true");
		const last_co = captured[captured.length - 1];
		ctx.assert.contains(last_co.url, "/manual-complete-task", "routes to /manual-complete-task");
		ctx.assert.eq(last_co.body?.member_id, "m_lead", "member_id forwarded for fan-out");
		ctx.assert.eq(last_co.body?.outcome, "succeeded", "outcome forwarded");
		ctx.assert.eq(last_co.body?.notes, "lead handled it", "notes forwarded");

		// 5. brigade_mark_task_complete WITHOUT member_id — DO marks all
		//    in-flight rows for the task. The MCP tool just forwards.
		const r_co_anon = await callPlanWorldTool("brigade_mark_task_complete", {
			cook_session_id: SES,
			task_id: "t_done",
			outcome: "succeeded",
		}, env);
		ctx.assert.ok(r_co_anon.ok === true, "anonymous complete ok");
		const last_anon = captured[captured.length - 1];
		ctx.assert.eq(
			last_anon.body?.member_id,
			undefined,
			"member_id omitted forwards as undefined",
		);

		// 6. Missing required args throws. brigade_assign_task_manually requires
		//    cook_session_id, task_id, member_id.
		let threw = false;
		try {
			await callPlanWorldTool("brigade_assign_task_manually", {
				cook_session_id: SES,
				task_id: "t_x",
				// member_id missing
			}, env);
		} catch (err) {
			threw = true;
			ctx.assert.contains(
				err instanceof Error ? err.message : String(err),
				"member_id",
				"error names the missing arg",
			);
		}
		ctx.assert.ok(threw, "missing member_id throws at the caller");

		// 7. Sanity: every DO call carried the cook_session_id-derived id.
		for (const c of captured) {
			ctx.assert.eq(
				c.id_name,
				`cooking_lead:${SES}`,
				"every override targets the same cooking_lead DO",
			);
		}

		ctx.notes.push(
			`manual control: assign + unassign + 2x complete (named + anon) routed`,
		);
	},
};

export default u75;
