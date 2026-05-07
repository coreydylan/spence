// MemberAgent — Durable Object, one per household member.
//
// Wave 7B Track B: implementation.
//
// Wraps the existing helpers in `household-members.ts` and `member-presence.ts`
// so the canonical store stays in D1, but every mutation flows through the
// DO and gets a trace id. The DO state caches lightweight fields the iOS
// client polls for (presence, last ping, skill outcome counts).

import { Agent } from "agents";
import {
	type AgentEnv,
	generateAgentId,
	memberAgentName,
} from "./base";
import {
	canMemberDoTask,
	getMember,
	recordSkillOutcome,
	type SkillOutcome,
} from "../household-members";
import { pingPresence, type PresenceState } from "../member-presence";
import {
	isMemberPresenceStale,
	nextPresenceSweepAt,
	PRESENCE_ALARM_INTERVAL_MS,
} from "./member-cycles";
import { beginTrace, completeTrace } from "../agent-trace";

export type MemberPresenceCache =
	| "absent"
	| "in_kitchen_idle"
	| "busy_assigned"
	| "stepped_away"
	| "unknown";

export interface MemberAgentState {
	member_id: string;
	household_id: string;
	display_name: string | null;
	age_group: string | null;
	profile_loaded: boolean;
	presence_state: MemberPresenceCache;
	last_presence_ping_ms: number | null;
	skill_count: number;
	recent_skill_outcomes_count: number;
}

const INITIAL_STATE: MemberAgentState = {
	member_id: "",
	household_id: "",
	display_name: null,
	age_group: null,
	profile_loaded: false,
	presence_state: "unknown",
	last_presence_ping_ms: null,
	skill_count: 0,
	recent_skill_outcomes_count: 0,
};

export class MemberAgent extends Agent<AgentEnv, MemberAgentState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		this.sql`
			CREATE TABLE IF NOT EXISTS presence_pings (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				state TEXT NOT NULL,
				source TEXT,
				meta_json TEXT,
				trace_id TEXT
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_member_presence_at ON presence_pings(at_ms DESC)`;
		this.sql`
			CREATE TABLE IF NOT EXISTS skill_outcomes_log (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				task_kind TEXT NOT NULL,
				skill_name TEXT,
				outcome TEXT NOT NULL,
				notes TEXT,
				trace_id TEXT
			)
		`;
		if (this.state.member_id) {
			await this.refreshProfile();
		}
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		if (route === "state" && request.method === "GET") {
			return json(this.state);
		}

		if (route === "init" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				member_id?: string;
				household_id?: string;
			};
			if (!body.member_id || !body.household_id) {
				return json({ error: "member_id + household_id required" }, 400);
			}
			return await this.routeInit(body.member_id, body.household_id);
		}

		if (route === "ping-presence" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				state?: PresenceState;
				expires_in_min?: number;
				current_task_id?: string;
				current_session_id?: string;
				source?: string;
				meta?: Record<string, unknown>;
			};
			if (!body.state) return json({ error: "state required" }, 400);
			return await this.routePingPresence(body);
		}

		if (route === "skill-outcome" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				task_kind?: string;
				skill_name?: string;
				outcome?: SkillOutcome;
				duration_actual_min?: number;
				duration_expected_min?: number;
				user_rating?: number;
				task_id?: string;
				meal_id?: string;
				notes?: string;
			};
			if (!body.outcome) return json({ error: "outcome required" }, 400);
			if (!body.task_kind && !body.skill_name) {
				return json({ error: "task_kind or skill_name required" }, 400);
			}
			return await this.routeSkillOutcome(body);
		}

		if (route === "can-do-task" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				task_kind?: string;
				required_skill?: string;
				min_confidence?: number;
				safety_required?: Record<string, unknown>;
			};
			const required_skill = body.required_skill || body.task_kind;
			if (!required_skill) return json({ error: "required_skill or task_kind required" }, 400);
			return await this.routeCanDoTask(required_skill, body);
		}

		return json({ error: `unknown route: ${route}` }, 404);
	}

	// ─── Routes ──────────────────────────────────────────────────────────

	private async routeInit(member_id: string, household_id: string): Promise<Response> {
		const trace = beginTrace({
			tool_name: "member_agent.init",
			tool_args: { member_id, household_id },
			caller_kind: "agent",
			caller_id: memberAgentName(household_id, member_id),
			household_id,
		});
		try {
			this.setState({ ...this.state, member_id, household_id });
			await this.refreshProfile();
			await this.scheduleNextPresenceSweep();
			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `member_init ${member_id}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routePingPresence(body: {
		state?: PresenceState;
		current_task_id?: string;
		current_session_id?: string;
		source?: string;
		meta?: Record<string, unknown>;
	}): Promise<Response> {
		if (!this.state.member_id) return json({ error: "member not initialized" }, 400);
		const target = body.state!;
		const trace = beginTrace({
			tool_name: "member_agent.ping_presence",
			tool_args: { state: target, current_task_id: body.current_task_id },
			caller_kind: "agent",
			caller_id: memberAgentName(this.state.household_id, this.state.member_id),
			household_id: this.state.household_id,
		});
		try {
			await pingPresence(this.env, {
				member_id: this.state.member_id,
				state: target,
				current_task_id: body.current_task_id,
				current_session_id: body.current_session_id,
			});
			const now = Date.now();
			this.sql`
				INSERT INTO presence_pings (id, at_ms, state, source, meta_json, trace_id)
				VALUES (
					${generateAgentId("pp")},
					${now},
					${target},
					${body.source ?? null},
					${body.meta ? JSON.stringify(body.meta) : null},
					${trace.trace_id}
				)
			`;
			this.setState({
				...this.state,
				presence_state: presenceCache(target),
				last_presence_ping_ms: now,
			});
			await completeTrace(this.env, trace, {
				ok: true,
				result: { presence: target, at_ms: now },
				result_summary: `ping_presence ${target}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeSkillOutcome(body: {
		task_kind?: string;
		skill_name?: string;
		outcome?: SkillOutcome;
		duration_actual_min?: number;
		duration_expected_min?: number;
		user_rating?: number;
		task_id?: string;
		meal_id?: string;
		notes?: string;
	}): Promise<Response> {
		if (!this.state.member_id) return json({ error: "member not initialized" }, 400);
		const skill_name = (body.skill_name || body.task_kind || "").trim();
		const outcome = body.outcome!;
		const trace = beginTrace({
			tool_name: "member_agent.skill_outcome",
			tool_args: { skill_name, outcome },
			caller_kind: "agent",
			caller_id: memberAgentName(this.state.household_id, this.state.member_id),
			household_id: this.state.household_id,
		});
		try {
			const result = await recordSkillOutcome(this.env, {
				member_id: this.state.member_id,
				skill_name,
				outcome,
				duration_actual_min: body.duration_actual_min,
				duration_expected_min: body.duration_expected_min,
				user_rating: body.user_rating,
				task_id: body.task_id,
				meal_id: body.meal_id,
				notes: body.notes,
			});
			const now = Date.now();
			this.sql`
				INSERT INTO skill_outcomes_log (id, at_ms, task_kind, skill_name, outcome, notes, trace_id)
				VALUES (
					${generateAgentId("so")},
					${now},
					${body.task_kind || skill_name},
					${skill_name},
					${outcome},
					${body.notes ?? null},
					${trace.trace_id}
				)
			`;
			this.setState({
				...this.state,
				recent_skill_outcomes_count: this.state.recent_skill_outcomes_count + 1,
			});
			await completeTrace(this.env, trace, {
				ok: true,
				result: result,
				result_summary: `skill_outcome ${skill_name} ${outcome} → conf=${result.new_confidence}`,
			});
			return json({ ok: true, ...result, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeCanDoTask(required_skill: string, body: {
		min_confidence?: number;
		safety_required?: Record<string, unknown>;
	}): Promise<Response> {
		if (!this.state.member_id) return json({ error: "member not initialized" }, 400);
		try {
			const member = await getMember(this.env, this.state.member_id);
			if (!member) {
				return json({
					ok: true,
					can_do: false,
					confidence: 0,
					reasons: ["member not found in store"],
				});
			}
			const result = canMemberDoTask(member, {
				required_skill,
				min_confidence: body.min_confidence,
				safety_required: body.safety_required as Parameters<typeof canMemberDoTask>[1]["safety_required"],
			});
			const skill = member.skills.find(s => s.skill_name === required_skill);
			return json({
				ok: true,
				can_do: result.ok,
				confidence: skill?.confidence ?? 0,
				reasons: result.ok ? [] : [result.reason ?? "unknown"],
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return json({ error: message }, 500);
		}
	}

	// ─── Alarm: presence timeout ─────────────────────────────────────────

	async onPresenceTimeout(): Promise<void> {
		if (!this.state.member_id) {
			await this.scheduleNextPresenceSweep();
			return;
		}
		const trace = beginTrace({
			tool_name: "member_agent.presence_timeout",
			tool_args: { member_id: this.state.member_id },
			caller_kind: "cron",
			caller_id: memberAgentName(this.state.household_id, this.state.member_id),
			household_id: this.state.household_id,
		});
		try {
			const stale = await isMemberPresenceStale(this.env, this.state.member_id, PRESENCE_ALARM_INTERVAL_MS);
			if (stale && this.state.presence_state !== "absent" && this.state.presence_state !== "stepped_away") {
				// Use the helper directly so the household-wide sweep keeps the
				// canonical D1 row in sync.
				await pingPresence(this.env, {
					member_id: this.state.member_id,
					state: "stepped_away",
				});
				this.setState({ ...this.state, presence_state: "stepped_away" });
			}
			await completeTrace(this.env, trace, {
				ok: true,
				result: { stale, presence: this.state.presence_state },
				result_summary: `presence_timeout stale=${stale}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
		} finally {
			await this.scheduleNextPresenceSweep();
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private async scheduleNextPresenceSweep(): Promise<void> {
		try {
			await this.schedule(nextPresenceSweepAt(), "onPresenceTimeout", {});
		} catch (err) {
			console.warn(`[member-agent] failed to schedule onPresenceTimeout:`, err);
		}
	}

	private async refreshProfile(): Promise<void> {
		if (!this.state.member_id) return;
		try {
			const member = await getMember(this.env, this.state.member_id);
			if (!member) {
				this.setState({ ...this.state, profile_loaded: false });
				return;
			}
			this.setState({
				...this.state,
				display_name: member.display_name,
				age_group: member.age_group,
				profile_loaded: true,
				skill_count: member.skills.length,
			});
		} catch (err) {
			console.warn(`[member-agent] refreshProfile failed:`, err);
		}
	}
}

function presenceCache(state: PresenceState): MemberPresenceCache {
	switch (state) {
		case "absent":
		case "in_kitchen_idle":
		case "busy_assigned":
		case "stepped_away":
			return state;
		default:
			return "unknown";
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
