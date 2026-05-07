// U76 — Brigade pause / resume / end lifecycle.
//
// Asserts the brigade-mode lifecycle controls:
//   1. brigade_pause routes to /pause and returns paused=true.
//   2. brigade_resume routes to /resume and returns paused=false.
//   3. brigade_end with outcome=completed routes to /end with outcome.
//   4. brigade_end with outcome=abandoned propagates the abandoned outcome.
//   5. brigade_end with no outcome defaults to "completed".
//   6. brigade_pause is wrapped in a trace (caller_kind=agent).
//   7. The DO ID is consistent across the pause → resume → end sequence.
//
// We don't boot the DO under Node — the DO's actual pause-state semantics
// (scheduler tick short-circuit, broadcast lead_message, event log entries)
// are covered by the in-DO unit tests + integration tests once miniflare
// is wired (Wave 8C+). This scenario locks the routing/contract surface.

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

function makeMockNs(captured: CapturedCall[]): unknown {
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
					// Mirror what the DO would return for each lifecycle action.
					let result: Record<string, unknown>;
					switch (action) {
						case "pause":
							result = { ok: true, paused: true, at_ms: 1750000010000 };
							break;
						case "resume":
							result = { ok: true, paused: false, at_ms: 1750000020000 };
							break;
						case "end": {
							const outcome = (body?.outcome as string) || "completed";
							result = {
								ok: true,
								state: { status: outcome },
								outcome,
								at_ms: 1750000030000,
							};
							break;
						}
						default:
							result = { ok: true };
					}
					return new Response(
						JSON.stringify(result),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			};
		},
	};
}

const u76: Scenario = {
	id: "u76",
	name: "Brigade pause / resume / end lifecycle: routing + outcome propagation",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const captured: CapturedCall[] = [];
		const db = new BrigadeFakeD1();
		const ns = makeMockNs(captured);
		const env = {
			DB: db as unknown as D1Database,
			COOKING_LEAD_AGENT: ns,
		} as unknown as MiseGraphEnv;
		const SES = "cs_u76_lifecycle";
		const baseTraces = db.agentTraces.length;

		// 1. brigade_pause — routes to /pause, returns paused=true.
		const r_pause = await callPlanWorldTool("brigade_pause", {
			cook_session_id: SES,
		}, env);
		ctx.assert.ok(r_pause.ok === true, "pause ok=true");
		ctx.assert.eq(r_pause.paused, true, "pause flips paused=true");
		ctx.assert.eq(captured.length, 1, "one DO call after pause");
		ctx.assert.contains(captured[0].url, "/pause", "routes to /pause");
		ctx.assert.eq(captured[0].method, "POST", "pause uses POST");
		ctx.assert.eq(
			captured[0].id_name,
			`cooking_lead:${SES}`,
			"DO id format",
		);

		// 2. brigade_pause is trace-wrapped (caller=agent).
		ctx.assert.gt(
			db.agentTraces.length,
			baseTraces,
			"brigade_pause persisted a trace row",
		);

		// 3. brigade_resume — routes to /resume, returns paused=false.
		const r_resume = await callPlanWorldTool("brigade_resume", {
			cook_session_id: SES,
		}, env);
		ctx.assert.ok(r_resume.ok === true, "resume ok=true");
		ctx.assert.eq(r_resume.paused, false, "resume flips paused=false");
		const last_resume = captured[captured.length - 1];
		ctx.assert.contains(last_resume.url, "/resume", "routes to /resume");

		// 4. brigade_end (completed) — routes to /end with outcome=completed.
		const r_end_ok = await callPlanWorldTool("brigade_end", {
			cook_session_id: SES,
			outcome: "completed",
			notes: "all 12 plates out by 8:30",
		}, env);
		ctx.assert.ok(r_end_ok.ok === true, "end completed ok");
		ctx.assert.eq(r_end_ok.outcome, "completed", "outcome=completed surfaced");
		const last_end_ok = captured[captured.length - 1];
		ctx.assert.contains(last_end_ok.url, "/end", "routes to /end");
		ctx.assert.eq(last_end_ok.body?.outcome, "completed", "outcome forwarded");
		ctx.assert.eq(last_end_ok.body?.notes, "all 12 plates out by 8:30", "notes forwarded");

		// 5. brigade_end (abandoned) — alternate outcome.
		const SES2 = "cs_u76_abandoned";
		const r_end_ab = await callPlanWorldTool("brigade_end", {
			cook_session_id: SES2,
			outcome: "abandoned",
		}, env);
		ctx.assert.ok(r_end_ab.ok === true, "abandoned end ok");
		ctx.assert.eq(r_end_ab.outcome, "abandoned", "abandoned outcome propagated");
		const last_ab = captured[captured.length - 1];
		ctx.assert.eq(last_ab.body?.outcome, "abandoned", "abandoned forwarded");

		// 6. brigade_end with no outcome → defaults to "completed".
		const SES3 = "cs_u76_default";
		const r_end_def = await callPlanWorldTool("brigade_end", {
			cook_session_id: SES3,
		}, env);
		ctx.assert.ok(r_end_def.ok === true, "default end ok");
		const last_def = captured[captured.length - 1];
		ctx.assert.eq(
			last_def.body?.outcome,
			"completed",
			"default outcome=completed forwarded to DO",
		);

		// 7. The original SES targets the same DO across pause→resume→end.
		const seq_for_ses = captured.filter(c => c.id_name === `cooking_lead:${SES}`);
		ctx.assert.eq(seq_for_ses.length, 3, "3 calls in pause→resume→end on the same DO");

		// 8. Different cook_session_ids → different DO ids.
		const ids = new Set(captured.map(c => c.id_name));
		ctx.assert.eq(ids.size, 3, "3 distinct DO ids across the 3 cook sessions");
		ctx.assert.contains(
			Array.from(ids),
			`cooking_lead:${SES2}`,
			"abandoned session has its own DO id",
		);

		ctx.notes.push(`pause/resume/end lifecycle covered across 3 sessions`);
	},
};

export default u76;
