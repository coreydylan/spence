// U72 — Brigade MCP tool routing.
//
// Wave 8B Track C exposes the brigade-mode manual control surface as 11 MCP
// tools (brigade_start, brigade_grant_token, brigade_get_state, ...). Each
// tool is a thin wrapper over a CookingLeadAgent DO route via
// `routeCookingLead`. This scenario asserts the routing contract:
//   1. Each tool dispatches to the correct DO action with the correct payload.
//   2. The DO id is `cooking_lead:<cook_session_id>` for every call.
//   3. Missing COOKING_LEAD_AGENT binding returns a clean { ok: false } shape.
//   4. brigade_grant_token returns a usable ws_url constructed from the token.
//   5. brigade_get_event_log reads from D1.mise_brigade_events directly
//      (not via the DO) so the event log is observable post-hibernation.
//   6. Tool dispatch covers all 11 brigade_* tools.
//
// We don't boot the DO here — we install a mock DurableObjectNamespace on
// env.COOKING_LEAD_AGENT and assert what the tool dispatch sends.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { BrigadeFakeD1 } from "../lib/wave7c-fake-d1";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

interface CapturedCall {
	id_name: string | null;
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

interface StubResult {
	ok?: boolean;
	body?: Record<string, unknown>;
}

function makeMockCookingLeadNs(
	captured: CapturedCall[],
	resultByAction: Record<string, StubResult> = {},
): unknown {
	let last_id_name: string | null = null;
	return {
		idFromName(name: string) {
			last_id_name = name;
			return { _name: name };
		},
		get(_id: unknown) {
			return {
				async fetch(req: Request): Promise<Response> {
					const text = await req.text();
					let body: Record<string, unknown> | null = null;
					try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
					captured.push({
						id_name: last_id_name,
						url: req.url,
						method: req.method,
						body,
					});
					// Pull the action from the URL path.
					const url = new URL(req.url);
					const action = url.pathname.split("/").pop() || "";
					const stub = resultByAction[action] || { ok: true };
					const respBody = { ok: stub.ok ?? true, ...(stub.body || {}) };
					return new Response(
						JSON.stringify(respBody),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			};
		},
	};
}

const u72: Scenario = {
	id: "u72",
	name: "Brigade MCP tools route to CookingLeadAgent DO with locked payloads",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const captured: CapturedCall[] = [];
		const db = new BrigadeFakeD1();
		const ns = makeMockCookingLeadNs(captured, {
			"grant-token": { body: { token: "BRIGADE_TOKEN_42", expires_at_ms: 1750000600000 } },
			"get-state": { body: { state: { status: "active" }, brigade: { paused: false, completed_count: 3, total_assignments: 7 } } },
			"manual-assign": { body: { task_id: "t_chop", member_id: "m_alice", assigned_at_ms: 1750000010000 } },
			"manual-unassign": { body: { freed: 1 } },
			"manual-complete-task": { body: { completed_at_ms: 1750000050000 } },
			"send-message": { body: { sent_to: "broadcast", at_ms: 1750000060000 } },
			pause: { body: { paused: true, at_ms: 1750000070000 } },
			resume: { body: { paused: false, at_ms: 1750000080000 } },
			end: { body: { outcome: "completed", at_ms: 1750000090000 } },
			init: { body: { state: { status: "active" } } },
		});
		const env = {
			DB: db as unknown as D1Database,
			COOKING_LEAD_AGENT: ns,
		} as unknown as MiseGraphEnv;

		const SES = "cs_u72_test";

		// 1. brigade_start → init route on the DO.
		const r_start = await callPlanWorldTool("brigade_start", {
			cook_session_id: SES,
			meal_id: "meal_xyz",
			plan_id: "plan_abc",
			household_id: "hh_test",
		}, env);
		ctx.assert.ok(r_start.ok === true, "brigade_start ok");
		ctx.assert.eq(captured[0].id_name, `cooking_lead:${SES}`, "DO id is cooking_lead:<cook_session_id>");
		ctx.assert.contains(captured[0].url, "/init", "routes to /init");
		ctx.assert.eq(captured[0].body?.cook_session_id, SES, "passes cook_session_id");
		ctx.assert.eq(captured[0].body?.meal_id, "meal_xyz", "passes meal_id");

		// 2. brigade_grant_token → grant-token route + ws_url synthesis.
		const r_token = await callPlanWorldTool("brigade_grant_token", {
			cook_session_id: SES,
			member_id: "m_alice",
		}, env);
		ctx.assert.ok(r_token.ok === true, "brigade_grant_token ok");
		ctx.assert.eq(r_token.token, "BRIGADE_TOKEN_42", "token surfaced from DO");
		ctx.assert.contains(
			String(r_token.ws_url),
			"BRIGADE_TOKEN_42",
			"ws_url includes the token",
		);
		ctx.assert.contains(
			String(r_token.ws_url),
			"member_id=m_alice",
			"ws_url includes member_id",
		);
		ctx.assert.contains(captured[1].url, "/grant-token", "routes to /grant-token");

		// 3. brigade_get_state → get-state route + brigade summary surfaced.
		const r_state = await callPlanWorldTool("brigade_get_state", {
			cook_session_id: SES,
		}, env);
		ctx.assert.ok(r_state.ok === true, "brigade_get_state ok");
		ctx.assert.contains(captured[2].url, "/get-state", "routes to /get-state");
		ctx.assert.eq(captured[2].method, "GET", "GET method for state read");
		const brigade = r_state.brigade as Record<string, unknown>;
		ctx.assert.eq(brigade.completed_count, 3, "brigade summary completed_count round-trips");
		ctx.assert.eq(brigade.total_assignments, 7, "brigade summary total_assignments round-trips");

		// 4. brigade_get_event_log reads from D1 directly, not the DO. Seed
		// a couple of events first.
		await db.prepare(`
			INSERT INTO mise_brigade_events
				(id, cook_session_id, kind, member_id, payload_json, emitted_at_ms)
			VALUES (?, ?, ?, ?, ?, ?)
		`).bind("ev1", SES, "session_initialized", null, JSON.stringify({ x: 1 }), 1000).run();
		await db.prepare(`
			INSERT INTO mise_brigade_events
				(id, cook_session_id, kind, member_id, payload_json, emitted_at_ms)
			VALUES (?, ?, ?, ?, ?, ?)
		`).bind("ev2", SES, "task_assigned", "m_alice", JSON.stringify({ task_id: "t1" }), 2000).run();
		const captured_before_log = captured.length;
		const r_log = await callPlanWorldTool("brigade_get_event_log", {
			cook_session_id: SES,
		}, env);
		ctx.assert.ok(r_log.ok === true, "brigade_get_event_log ok");
		ctx.assert.eq(captured.length, captured_before_log, "event-log read does NOT hit the DO");
		const events = r_log.events as Array<Record<string, unknown>>;
		ctx.assert.eq(events.length, 2, "two seeded events returned");
		ctx.assert.eq(events[0].id, "ev1", "events ordered by emitted_at_ms ASC");

		// 5. brigade_assign_task_manually → manual-assign route.
		const r_assign = await callPlanWorldTool("brigade_assign_task_manually", {
			cook_session_id: SES,
			task_id: "t_chop",
			member_id: "m_alice",
			reason: "alice has knife skills",
		}, env);
		ctx.assert.ok(r_assign.ok === true, "brigade_assign_task_manually ok");
		const last_assign = captured[captured.length - 1];
		ctx.assert.contains(last_assign.url, "/manual-assign", "routes to /manual-assign");
		ctx.assert.eq(last_assign.body?.task_id, "t_chop", "task_id passed through");
		ctx.assert.eq(last_assign.body?.member_id, "m_alice", "member_id passed through");
		ctx.assert.eq(last_assign.body?.reason, "alice has knife skills", "reason passed through");

		// 6. brigade_unassign_task → manual-unassign route.
		await callPlanWorldTool("brigade_unassign_task", {
			cook_session_id: SES,
			task_id: "t_stuck",
			reason: "took too long",
		}, env);
		const last_unassign = captured[captured.length - 1];
		ctx.assert.contains(last_unassign.url, "/manual-unassign", "routes to /manual-unassign");

		// 7. brigade_mark_task_complete → manual-complete-task route.
		await callPlanWorldTool("brigade_mark_task_complete", {
			cook_session_id: SES,
			task_id: "t_done",
			member_id: "m_bob",
			outcome: "success",
			notes: "looked great",
		}, env);
		const last_complete = captured[captured.length - 1];
		ctx.assert.contains(last_complete.url, "/manual-complete-task", "routes to /manual-complete-task");
		ctx.assert.eq(last_complete.body?.outcome, "success", "outcome passed through");

		// 8. brigade_send_message → send-message route.
		await callPlanWorldTool("brigade_send_message", {
			cook_session_id: SES,
			message: "Great work team!",
		}, env);
		const last_msg = captured[captured.length - 1];
		ctx.assert.contains(last_msg.url, "/send-message", "routes to /send-message");
		ctx.assert.eq(last_msg.body?.message, "Great work team!", "message passed through");

		// 9. brigade_pause / brigade_resume.
		await callPlanWorldTool("brigade_pause", { cook_session_id: SES }, env);
		ctx.assert.contains(captured[captured.length - 1].url, "/pause", "routes to /pause");
		await callPlanWorldTool("brigade_resume", { cook_session_id: SES }, env);
		ctx.assert.contains(captured[captured.length - 1].url, "/resume", "routes to /resume");

		// 10. brigade_end → end route + outcome propagation.
		const r_end = await callPlanWorldTool("brigade_end", {
			cook_session_id: SES,
			outcome: "completed",
			notes: "all done",
		}, env);
		ctx.assert.ok(r_end.ok === true, "brigade_end ok");
		const last_end = captured[captured.length - 1];
		ctx.assert.contains(last_end.url, "/end", "routes to /end");
		ctx.assert.eq(last_end.body?.outcome, "completed", "outcome passed through");

		// 11. Missing binding — clean error shape, no throw.
		const env_no_binding = {
			DB: db as unknown as D1Database,
		} as unknown as MiseGraphEnv;
		const r_no_binding = await callPlanWorldTool("brigade_start", {
			cook_session_id: "cs_nobinding",
			meal_id: "meal_x",
		}, env_no_binding);
		ctx.assert.ok(r_no_binding.ok === false, "missing binding → ok=false");
		ctx.assert.contains(
			String(r_no_binding.error || ""),
			"COOKING_LEAD_AGENT not bound",
			"error names the missing binding",
		);

		ctx.notes.push(`captured ${captured.length} DO calls across 11 brigade tools`);
	},
};

export default u72;
