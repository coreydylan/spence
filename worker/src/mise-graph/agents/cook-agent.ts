// Wave 8 will replace this with ephemeral CookingLeadAgent for brigade mode.
//
// CookAgent — Durable Object, one per cook session.
//
// Wave 7B Track B: implementation. Minimal but functional. Same shape as
// ShopAgent.
//
// State machine (Track B widens base COOK_TRANSITIONS by adding `cancelled`):
//   planned → pre_session → active_session → completed
//   any non-terminal → cancelled

import { Agent } from "agents";
import {
	type AgentEnv,
	cookAgentName,
	generateAgentId,
} from "./base";
import {
	type CookPhaseExt,
	COOK_PHASES_EXT,
	decideCookEntry,
	isLegalCookTransition,
	preSessionAlarmAt,
	recordCookFinish,
} from "./cook-phase-handlers";
import { beginTrace, completeTrace } from "../agent-trace";

export interface CookAgentState {
	cook_id: string;
	meal_id: string;
	plan_id: string;
	household_id: string;
	phase: CookPhaseExt;
	cook_window_start_iso: string | null;
	started_at_ms: number | null;
	completed_at_ms: number | null;
	last_transition_at_ms: number | null;
}

const INITIAL_STATE: CookAgentState = {
	cook_id: "",
	meal_id: "",
	plan_id: "",
	household_id: "",
	phase: "planned",
	cook_window_start_iso: null,
	started_at_ms: null,
	completed_at_ms: null,
	last_transition_at_ms: null,
};

export class CookAgent extends Agent<AgentEnv, CookAgentState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		this.sql`
			CREATE TABLE IF NOT EXISTS phase_transitions (
				id TEXT PRIMARY KEY,
				from_phase TEXT NOT NULL,
				to_phase TEXT NOT NULL,
				at_ms INTEGER NOT NULL,
				reason TEXT,
				trace_id TEXT
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_cook_phase_at ON phase_transitions(at_ms ASC)`;
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		if (route === "init" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				cook_id?: string;
				meal_id?: string;
				plan_id?: string;
				household_id?: string;
				cook_window_start_iso?: string | null;
			};
			return await this.routeInit(body);
		}

		if (route === "state" && request.method === "GET") {
			return json(this.state);
		}

		if (route === "start" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { member_id?: string };
			const reason = body.member_id ? `start:${body.member_id}` : "start";
			// planned/pre_session → active_session.
			let from = this.state.phase;
			if (from === "planned") {
				const r1 = await this.transitionTo("pre_session", "auto:pre_session_on_start", false);
				if ((r1.status >= 400)) return r1;
				from = "pre_session";
			}
			const result = await this.transitionTo("active_session", reason, false);
			this.setState({ ...this.state, started_at_ms: Date.now() });
			return result;
		}

		if (route === "finish" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { rating?: number; notes?: string };
			const result = await this.transitionTo("completed", "finish", false);
			if (result.status >= 400) return result;
			this.setState({ ...this.state, completed_at_ms: Date.now() });
			try {
				await recordCookFinish(this.env, {
					cook_id: this.state.cook_id,
					meal_id: this.state.meal_id,
					household_id: this.state.household_id,
					plan_id: this.state.plan_id,
					rating: body.rating,
					notes: body.notes,
				});
			} catch (err) {
				console.warn(`[cook-agent] recordCookFinish failed:`, err);
			}
			return result;
		}

		if (route === "cancel" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { reason?: string };
			return await this.transitionTo("cancelled", body.reason || "manual_cancel", true);
		}

		if (route === "transition" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				to_phase?: CookPhaseExt;
				to?: CookPhaseExt;
				reason?: string;
				force?: boolean;
			};
			const target = body.to_phase || body.to;
			if (!target) return json({ error: "to_phase required" }, 400);
			return await this.transitionTo(target, body.reason ?? "manual", !!body.force);
		}

		return json({ error: `unknown route: ${route}` }, 404);
	}

	private async routeInit(body: {
		cook_id?: string;
		meal_id?: string;
		plan_id?: string;
		household_id?: string;
		cook_window_start_iso?: string | null;
	}): Promise<Response> {
		const trace = beginTrace({
			tool_name: "cook_agent.init",
			tool_args: body,
			caller_kind: "agent",
			caller_id: cookAgentName(body.meal_id || "", body.cook_id || ""),
			plan_id: body.plan_id,
			household_id: body.household_id,
		});
		try {
			const next: CookAgentState = {
				...this.state,
				cook_id: body.cook_id ?? this.state.cook_id,
				meal_id: body.meal_id ?? this.state.meal_id,
				plan_id: body.plan_id ?? this.state.plan_id,
				household_id: body.household_id ?? this.state.household_id,
				cook_window_start_iso: body.cook_window_start_iso ?? this.state.cook_window_start_iso,
			};
			this.setState(next);
			// Schedule pre_session alarm if we have a window.
			if (next.phase === "planned" && next.cook_window_start_iso) {
				const at = preSessionAlarmAt(next.cook_window_start_iso);
				if (at) {
					try {
						await this.schedule(at, "onPreSession", {});
					} catch (err) {
						console.warn(`[cook-agent] failed to schedule onPreSession:`, err);
					}
				}
			}
			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `cook_init meal=${next.meal_id}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	async transitionTo(to: CookPhaseExt, reason: string, force: boolean): Promise<Response> {
		const from = this.state.phase;
		if (!force && !isLegalCookTransition(from, to)) {
			return json({ ok: false, from, to, error: `illegal transition: ${from} → ${to}` }, 400);
		}
		if (!COOK_PHASES_EXT.includes(to)) {
			return json({ ok: false, from, to, error: `unknown phase: ${to}` }, 400);
		}
		const trace = beginTrace({
			tool_name: "cook_agent.transition",
			tool_args: { from, to, reason, force },
			caller_kind: "agent",
			caller_id: cookAgentName(this.state.meal_id, this.state.cook_id),
			plan_id: this.state.plan_id,
		});
		try {
			const now = Date.now();
			this.sql`
				INSERT INTO phase_transitions (id, from_phase, to_phase, at_ms, reason, trace_id)
				VALUES (
					${generateAgentId("ph")},
					${from},
					${to},
					${now},
					${reason},
					${trace.trace_id}
				)
			`;
			this.setState({ ...this.state, phase: to, last_transition_at_ms: now });
			const decision = decideCookEntry(to, this.state.cook_window_start_iso);
			if (decision.next_alarm_at) {
				try {
					await this.schedule(decision.next_alarm_at, "onPreSession", {});
				} catch (err) {
					console.warn(`[cook-agent] failed to schedule alarm:`, err);
				}
			}
			await completeTrace(this.env, trace, {
				ok: true,
				result: { from, to, side_effect: decision.side_effect_kind },
				result_summary: `cook_transition ${from}→${to}`,
			});
			return json({ ok: true, from, to, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	async onPreSession(): Promise<void> {
		if (this.state.phase !== "planned") return;
		await this.transitionTo("pre_session", "alarm:pre_session", false);
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
