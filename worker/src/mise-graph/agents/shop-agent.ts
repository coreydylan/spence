// ShopAgent — Durable Object, one per shop run.
//
// Wave 7B Track B: implementation.
//
// State machine (Track B widens base SHOP_TRANSITIONS by adding `cancelled`):
//   planned → active_today → completed
//   planned → cancelled
//   active_today → cancelled
//
// The base.ts SHOP_TRANSITIONS (foundation locked) only knows planned →
// active_today → completed. shop-phase-handlers.ts holds the extended
// transition map. This DO uses the extended map.

import { Agent } from "agents";
import {
	type AgentEnv,
	generateAgentId,
	planAgentName,
	shopAgentName,
} from "./base";
import {
	type ShopPhaseExt,
	SHOP_PHASES_EXT,
	activeTodayAlarmAt,
	buildShopReminderRow,
	decideShopEntry,
	isLegalShopTransition,
	persistShopReminder,
} from "./shop-phase-handlers";
import { beginTrace, completeTrace } from "../agent-trace";

export interface ShopAgentState {
	shop_run_id: string;
	plan_id: string;
	phase: ShopPhaseExt;
	run_date: string | null;
	last_known_total_items: number;
	completed_at_ms: number | null;
	last_transition_at_ms: number | null;
}

const INITIAL_STATE: ShopAgentState = {
	shop_run_id: "",
	plan_id: "",
	phase: "planned",
	run_date: null,
	last_known_total_items: 0,
	completed_at_ms: null,
	last_transition_at_ms: null,
};

export class ShopAgent extends Agent<AgentEnv, ShopAgentState> {
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
		this.sql`CREATE INDEX IF NOT EXISTS idx_shop_phase_at ON phase_transitions(at_ms ASC)`;
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		if (route === "init" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				shop_run_id?: string;
				plan_id?: string;
				run_date?: string | null;
			};
			return await this.routeInit(body);
		}

		if (route === "state" && request.method === "GET") {
			return json(this.state);
		}

		if (route === "transition" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				to_phase?: ShopPhaseExt;
				to?: ShopPhaseExt;
				reason?: string;
				force?: boolean;
			};
			const target = body.to_phase || body.to;
			if (!target) return json({ error: "to_phase required" }, 400);
			return await this.transitionTo(target, body.reason ?? "manual", !!body.force);
		}

		if (route === "mark-completed" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				member_id?: string;
				items_purchased_count?: number;
			};
			const result = await this.transitionTo("completed", `mark_completed${body.member_id ? `:${body.member_id}` : ""}`, false);
			if (typeof body.items_purchased_count === "number") {
				this.setState({
					...this.state,
					last_known_total_items: body.items_purchased_count,
					completed_at_ms: Date.now(),
				});
			} else {
				this.setState({ ...this.state, completed_at_ms: Date.now() });
			}
			return result;
		}

		if (route === "cancel" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { reason?: string };
			return await this.transitionTo("cancelled", body.reason || "manual_cancel", true);
		}

		return json({ error: `unknown route: ${route}` }, 404);
	}

	private async routeInit(body: { shop_run_id?: string; plan_id?: string; run_date?: string | null }): Promise<Response> {
		const trace = beginTrace({
			tool_name: "shop_agent.init",
			tool_args: body,
			caller_kind: "agent",
			caller_id: shopAgentName(body.plan_id || "", body.shop_run_id || ""),
			plan_id: body.plan_id,
		});
		try {
			const next: ShopAgentState = {
				...this.state,
				shop_run_id: body.shop_run_id ?? this.state.shop_run_id,
				plan_id: body.plan_id ?? this.state.plan_id,
				run_date: body.run_date ?? this.state.run_date,
			};
			this.setState(next);

			// Schedule the active_today alarm if we know the run_date and we're
			// still in `planned`.
			if (next.phase === "planned" && next.run_date) {
				const at = activeTodayAlarmAt(next.run_date);
				if (at) {
					try {
						await this.schedule(at, "onActiveToday", {});
					} catch (err) {
						console.warn(`[shop-agent] failed to schedule onActiveToday:`, err);
					}
				}
			}

			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `shop_init shop=${next.shop_run_id} run=${next.run_date}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	async transitionTo(to: ShopPhaseExt, reason: string, force: boolean): Promise<Response> {
		const from = this.state.phase;
		if (!force && !isLegalShopTransition(from, to)) {
			return json({ ok: false, from, to, error: `illegal transition: ${from} → ${to}` }, 400);
		}
		if (!SHOP_PHASES_EXT.includes(to)) {
			return json({ ok: false, from, to, error: `unknown phase: ${to}` }, 400);
		}
		const trace = beginTrace({
			tool_name: "shop_agent.transition",
			tool_args: { from, to, reason, force },
			caller_kind: "agent",
			caller_id: shopAgentName(this.state.plan_id, this.state.shop_run_id),
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
			const completed_at_ms = to === "completed" ? now : this.state.completed_at_ms;
			this.setState({ ...this.state, phase: to, last_transition_at_ms: now, completed_at_ms });

			// Per-phase entry side effects.
			const decision = decideShopEntry(to, this.state.run_date);
			if (decision.side_effect_kind === "shop_reminder") {
				const row = buildShopReminderRow({
					shop_run_id: this.state.shop_run_id,
					plan_id: this.state.plan_id,
					run_date: this.state.run_date || "",
					payload: { reason },
				});
				try {
					await persistShopReminder(this.env, row);
				} catch (err) {
					console.warn(`[shop-agent] failed to persist shop reminder:`, err);
				}
				await this.notifyParent("shop_active_today", { shop_run_id: this.state.shop_run_id });
			} else if (decision.side_effect_kind === "completion") {
				await this.notifyParent("shop_completed", {
					shop_run_id: this.state.shop_run_id,
					completed_at_ms: now,
				});
			} else if (decision.side_effect_kind === "cancellation") {
				await this.notifyParent("shop_cancelled", {
					shop_run_id: this.state.shop_run_id,
					reason,
				});
			}

			if (decision.next_alarm_at) {
				try {
					await this.schedule(decision.next_alarm_at, "onActiveToday", {});
				} catch (err) {
					console.warn(`[shop-agent] failed to schedule next alarm:`, err);
				}
			}

			await completeTrace(this.env, trace, {
				ok: true,
				result: { from, to, side_effect: decision.side_effect_kind },
				result_summary: `shop_transition ${from}→${to}`,
			});
			return json({ ok: true, from, to, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	async onActiveToday(): Promise<void> {
		// Idempotent: if already past planned, do nothing.
		if (this.state.phase !== "planned") return;
		await this.transitionTo("active_today", "alarm:active_today", false);
	}

	private async notifyParent(signal_kind: string, payload: Record<string, unknown>): Promise<void> {
		if (!this.state.plan_id) return;
		try {
			const ns = this.env.PLAN_AGENT;
			const stub = ns.get(ns.idFromName(planAgentName(this.state.plan_id)));
			await stub.fetch(new Request("https://agent/internal/child-status-changed", {
				method: "POST",
				body: JSON.stringify({
					child_kind: "shop",
					child_name: shopAgentName(this.state.plan_id, this.state.shop_run_id),
					signal_kind,
					payload,
				}),
				headers: { "content-type": "application/json" },
			}));
		} catch (err) {
			console.warn(`[shop-agent] failed to notify parent:`, err);
		}
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
