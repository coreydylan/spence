// U73 — Brigade WS message dispatch routing helper contract.
//
// The CookingLeadAgent's `onMessage` switch dispatches inbound WS frames to
// per-kind handler methods. Hibernation-safe state writes go to the DO's
// embedded SQLite; cross-DO side effects (skill-outcome fan-out, presence
// forwarding) route through the `routeCookingLead` / MEMBER_AGENT bindings.
//
// We can't boot the DO under Node, so this scenario exercises the routing
// helpers that the WS dispatch sits on top of:
//   1. `routeCookingLead` calls reach the right DO id (cooking_lead:<id>)
//      with the right action + body shape.
//   2. Missing binding returns null without throwing (best-effort sidecar).
//   3. Empty cook_session_id returns null without dispatching (guard).
//   4. Method defaults to POST; explicit GET works.
//   5. The helper composes URLs the worker bridge expects.
//
// Dispatch-shape assertions for the WS kinds (ack_task / complete_task /
// request_help / decline_task / iteration_response / presence_update / ping)
// are covered by u74 (skill fan-out) + u72 (manual control surface) + the
// existing u59 hand-off test. Together they pin every code path the WS
// dispatch hits without spinning up partyserver.

import type { Scenario } from "../lib/types";
import { routeCookingLead } from "../../src/mise-graph/agents/router";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

interface CapturedCall {
	id_name: string;
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

function makeMockNs(captured: CapturedCall[], stub_response: Record<string, unknown> = { ok: true }): unknown {
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
					captured.push({
						id_name: last_id,
						url: req.url,
						method: req.method,
						body,
					});
					return new Response(
						JSON.stringify(stub_response),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			};
		},
	};
}

const u73: Scenario = {
	id: "u73",
	name: "Brigade WS message dispatch: routeCookingLead contract",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const captured: CapturedCall[] = [];
		const ns = makeMockNs(captured);
		const env = {
			COOKING_LEAD_AGENT: ns,
		} as unknown as MiseGraphEnv;
		const SES = "cs_u73";

		// 1. POST routing — default method, uses cooking_lead:<id> as DO id,
		//    forwards body as JSON, hits /internal/<action>.
		const r1 = await routeCookingLead(env, SES, "manual-assign", {
			task_id: "t_chop",
			member_id: "m_alice",
		});
		ctx.assert.ok(r1 !== null, "POST returns the DO response (not null)");
		ctx.assert.eq(captured.length, 1, "exactly one DO call");
		ctx.assert.eq(captured[0].id_name, `cooking_lead:${SES}`, "DO id format");
		ctx.assert.eq(captured[0].method, "POST", "default method is POST");
		ctx.assert.contains(captured[0].url, "/manual-assign", "url targets the action");
		ctx.assert.eq(captured[0].body?.task_id, "t_chop", "body forwards task_id");
		ctx.assert.eq(captured[0].body?.member_id, "m_alice", "body forwards member_id");

		// 2. GET routing — explicit method.
		const r2 = await routeCookingLead(env, SES, "get-state", undefined, "GET");
		ctx.assert.ok(r2 !== null, "GET returns the DO response");
		ctx.assert.eq(captured[1].method, "GET", "explicit GET method");
		ctx.assert.contains(captured[1].url, "/get-state", "url targets get-state");

		// 3. Missing binding → null, no throw, no captured calls.
		const env_no_binding = {} as unknown as MiseGraphEnv;
		const r3 = await routeCookingLead(env_no_binding, SES, "manual-assign", {});
		ctx.assert.eq(r3, null, "missing binding returns null");
		ctx.assert.eq(captured.length, 2, "no DO call captured for missing binding");

		// 4. Empty cook_session_id → null, no DO call.
		const r4 = await routeCookingLead(env, "", "manual-assign", { task_id: "x" });
		ctx.assert.eq(r4, null, "empty cook_session_id returns null");
		ctx.assert.eq(captured.length, 2, "no DO call for empty cook_session_id");

		// 5. Each WS-derived action surfaces with the right route. The DO's
		//    `onMessage` switch eventually invokes routes equivalent to:
		//      ack_task          → no router call (in-DO embedded SQLite)
		//      complete_task     → /skill-outcome on the MemberAgent
		//      decline_task      → in-DO; emits task_unassigned event
		//      request_help      → in-DO; broadcasts to other members
		//      iteration_response→ in-DO; recorded in event log
		//      presence_update   → /ping-presence on the MemberAgent
		//
		//    The brigade-side handlers don't fan back into routeCookingLead
		//    because they're already inside the DO. So the routing surface
		//    we test is the inbound side: the manual control HTTP routes
		//    + the brigade_* MCP tools that drive them. Those get a fresh
		//    routing call for every action — pinned in u72.

		// 6. Repeated calls reuse the same DO id (idFromName is idempotent).
		await routeCookingLead(env, SES, "pause", {});
		await routeCookingLead(env, SES, "resume", {});
		ctx.assert.eq(captured.length, 4, "two more calls captured");
		ctx.assert.eq(
			captured[2].id_name,
			captured[3].id_name,
			"same DO id across repeated routeCookingLead calls",
		);

		ctx.notes.push(`routed ${captured.length} actions through cooking_lead:${SES}`);
	},
};

export default u73;
