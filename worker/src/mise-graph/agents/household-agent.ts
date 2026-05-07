// HouseholdAgent — long-lived Durable Object, one per household.
//
// Wave 7B Track B: implementation.
//   * onStart loads the household profile + member count from D1 and caches
//     in DO state.
//   * /init bootstraps state from supplied household_id + schedules the
//     daily-brief alarm.
//   * /spawn-plan calls PlanAgent#/init via the DO namespace.
//   * /daily-brief returns the latest persisted brief (read-only).
//   * morningCheckin alarm runs the brief pipeline, persists, and reschedules
//     itself for the next local 7am.
//   * Every state-mutating route wraps with beginTrace/completeTrace for
//     replay debug.

import { Agent, type FiberRecoveryContext } from "agents";
import {
	type AgentEnv,
	generateAgentId,
	householdAgentName,
	planAgentName,
} from "./base";
import {
	computeMorningBrief,
	loadBriefForDate,
	loadLatestBrief,
	type MorningBriefResult,
	nextLocal7am,
	persistMorningBrief,
} from "./household-cycles";
import { beginTrace, completeTrace } from "../agent-trace";
import { getHouseholdProfile } from "../household-model";
import { listMembers } from "../household-members";

/**
 * Phase 4 — checkpoint snapshot for the `morning_brief` fiber. Each step
 * of `runMorningBriefPipeline` stashes a richer snapshot so a recovery
 * call can short-circuit work that's already durable.
 */
export interface MorningBriefSnapshot {
	brief: MorningBriefResult;
	persisted_id: string;
}

export interface HouseholdAgentState {
	household_id: string;
	profile_loaded: boolean;
	last_brief_at_ms: number | null;
	last_brief_id: string | null;
	active_plan_ids: string[];
	member_count: number;
	bootstrapped: boolean;
}

const INITIAL_STATE: HouseholdAgentState = {
	household_id: "",
	profile_loaded: false,
	last_brief_at_ms: null,
	last_brief_id: null,
	active_plan_ids: [],
	member_count: 0,
	bootstrapped: false,
};

export class HouseholdAgent extends Agent<AgentEnv, HouseholdAgentState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		this.sql`
			CREATE TABLE IF NOT EXISTS decisions (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				kind TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				trace_id TEXT
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_household_decisions_at ON decisions(at_ms DESC)`;
		this.sql`
			CREATE TABLE IF NOT EXISTS checkins (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				result TEXT,
				brief_id TEXT,
				trace_id TEXT
			)
		`;
		// If we already know our household_id, refresh the cached profile + member count.
		if (this.state.household_id) {
			await this.refreshCachedProfile();
		}
		if (!this.state.bootstrapped) {
			this.setState({ ...this.state, bootstrapped: true });
		}
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		if (route === "state" && request.method === "GET") {
			return json(this.state);
		}

		if (route === "init" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { household_id?: string };
			if (!body.household_id) return json({ error: "household_id required" }, 400);
			const trace = beginTrace({
				tool_name: "household_agent.init",
				tool_args: { household_id: body.household_id },
				caller_kind: "agent",
				caller_id: householdAgentName(body.household_id),
				household_id: body.household_id,
			});
			try {
				this.setState({
					...this.state,
					household_id: body.household_id,
				});
				await this.refreshCachedProfile();
				await this.scheduleNextDailyBrief();
				await completeTrace(this.env, trace, {
					ok: true,
					result: { state: this.state },
					result_summary: `init household=${body.household_id}`,
				});
				return json({ ok: true, state: this.state, trace_id: trace.trace_id });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await completeTrace(this.env, trace, { ok: false, error: message });
				return json({ error: message }, 500);
			}
		}

		if (route === "daily-brief" && request.method === "GET") {
			if (!this.state.household_id) {
				return json({ error: "household_id not initialized" }, 400);
			}
			const brief = await loadLatestBrief(this.env, this.state.household_id);
			return json({ ok: true, brief });
		}

		// Wave 7F — POST /daily-brief drives the brief from outside the alarm.
		// The cron sweep calls this for every active household at 14:00 UTC.
		// Body: { for_date?: "YYYY-MM-DD", timezone?: string, force?: boolean }
		// Returns: { ok: true, brief: MorningBriefResult, persisted: { id, ... } }
		if (route === "daily-brief" && request.method === "POST") {
			if (!this.state.household_id) {
				return json({ error: "household_id not initialized" }, 400);
			}
			const body = (await request.json().catch(() => ({}))) as {
				for_date?: string;
				timezone?: string;
				force?: boolean;
			};
			const trace = beginTrace({
				tool_name: "household_agent.daily_brief",
				tool_args: body,
				caller_kind: "cron",
				caller_id: householdAgentName(this.state.household_id),
				household_id: this.state.household_id,
			});
			try {
				const now = body.for_date && /^\d{4}-\d{2}-\d{2}$/.test(body.for_date)
					? new Date(`${body.for_date}T14:00:00Z`)
					: new Date();
				// If a brief already exists for this date and force=false, return it.
				if (!body.force) {
					const existing = await loadBriefForDate(
						this.env,
						this.state.household_id,
						now.toISOString().slice(0, 10),
					);
					if (existing) {
						await completeTrace(this.env, trace, {
							ok: true,
							result: { reused: true, brief_id: existing.id },
							result_summary: `daily_brief reused id=${existing.id}`,
						});
						return json({
							ok: true,
							reused: true,
							brief: existing,
							persisted: {
								id: existing.id,
								household_id: existing.household_id,
								for_date: existing.for_date,
								created_at_ms: existing.created_at_ms,
							},
							trace_id: trace.trace_id,
						});
					}
				}
				const brief = await computeMorningBrief(this.env, this.state.household_id, {
					now,
					skip_weather: true,
				});
				const persisted = await persistMorningBrief(this.env, brief);
				this.sql`
					INSERT INTO checkins (id, at_ms, result, brief_id, trace_id)
					VALUES (
						${generateAgentId("ck")},
						${Date.now()},
						${"cron"},
						${persisted.id},
						${trace.trace_id}
					)
				`;
				this.setState({
					...this.state,
					last_brief_at_ms: Date.now(),
					last_brief_id: persisted.id,
				});
				await completeTrace(this.env, trace, {
					ok: true,
					result: {
						brief_id: persisted.id,
						plan_count: brief.plan_health.length,
						suggestion_count: brief.suggestions.length,
						timezone: body.timezone || null,
					},
					result_summary: `daily_brief brief=${persisted.id} plans=${brief.plan_health.length}`,
				});
				return json({
					ok: true,
					reused: false,
					brief,
					persisted,
					trace_id: trace.trace_id,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await completeTrace(this.env, trace, { ok: false, error: message });
				return json({ error: message }, 500);
			}
		}

		if (route === "spawn-plan" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				plan_id?: string;
				start_date?: string;
				end_date?: string;
			};
			if (!body.plan_id) return json({ error: "plan_id required" }, 400);
			const trace = beginTrace({
				tool_name: "household_agent.spawn_plan",
				tool_args: body,
				caller_kind: "agent",
				caller_id: householdAgentName(this.state.household_id || "unknown"),
				household_id: this.state.household_id || undefined,
				plan_id: body.plan_id,
			});
			try {
				const planNs = this.env.PLAN_AGENT;
				const stub = planNs.get(planNs.idFromName(planAgentName(body.plan_id)));
				const initResp = await stub.fetch(
					new Request("https://agent/internal/init", {
						method: "POST",
						body: JSON.stringify({
							plan_id: body.plan_id,
							household_id: this.state.household_id,
						}),
						headers: { "content-type": "application/json" },
					}),
				);
				const planState = await initResp.json().catch(() => ({}));
				const plans = this.state.active_plan_ids.includes(body.plan_id)
					? this.state.active_plan_ids
					: [...this.state.active_plan_ids, body.plan_id];
				this.setState({ ...this.state, active_plan_ids: plans });
				this.recordDecision("spawn_plan", { plan_id: body.plan_id, start_date: body.start_date, end_date: body.end_date }, trace.trace_id);
				await completeTrace(this.env, trace, {
					ok: true,
					result: { plan_id: body.plan_id, plan_state: planState },
					result_summary: `spawn_plan plan=${body.plan_id}`,
				});
				return json({ ok: true, plan_id: body.plan_id, plan_state: planState, trace_id: trace.trace_id });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await completeTrace(this.env, trace, { ok: false, error: message });
				return json({ error: message }, 500);
			}
		}

		return json({ error: `unknown route: ${route}` }, 404);
	}

	/**
	 * Daily brief alarm callback. Runs the brief pipeline and persists the
	 * row, then reschedules itself for the next local 7am.
	 *
	 * Phase 4: wraps the multi-step brief pipeline in a Fiber. Each major
	 * step stashes its result, so if the worker dies between steps the
	 * `onFiberRecovered` hook can resume from the last checkpoint instead
	 * of re-running everything (or losing the brief entirely).
	 */
	async morningCheckin(): Promise<void> {
		if (!this.state.household_id) return;
		try {
			await this.runFiber("morning_brief", async (ctx) => {
				await this.runMorningBriefPipeline(
					ctx as { stash(data: unknown): void; snapshot: unknown | null },
				);
			});
		} catch (err) {
			console.warn(`[household-agent] morning_brief fiber failed:`, err);
		} finally {
			await this.scheduleNextDailyBrief();
		}
	}

	/**
	 * Phase 4 — Fiber-checkpointed pipeline used by both `morningCheckin`
	 * (first run) and `onFiberRecovered` (resume after crash).
	 *
	 * Stash schedule:
	 *   1. After computeMorningBrief    → `{ brief }`
	 *   2. After persistMorningBrief    → `{ brief, persisted_id }`
	 *
	 * Resume policy: if we have `persisted_id`, the brief is durable in D1
	 * — just reapply the in-DO state mirror and exit. If we only have
	 * `brief`, skip the recompute and persist. Otherwise, run the whole
	 * pipeline.
	 */
	private async runMorningBriefPipeline(
		ctx: { stash(data: unknown): void; snapshot: unknown | null },
	): Promise<void> {
		const household_id = this.state.household_id;
		if (!household_id) return;

		const trace = beginTrace({
			tool_name: "household_agent.morning_checkin",
			tool_args: { household_id, resumed: ctx.snapshot != null },
			caller_kind: "cron",
			caller_id: householdAgentName(household_id),
			household_id,
		});
		try {
			const snap = (ctx.snapshot ?? {}) as Partial<MorningBriefSnapshot>;

			// Step 1 — compute the brief (skip if already in snapshot).
			const brief: MorningBriefResult = snap.brief
				?? (await computeMorningBrief(this.env, household_id, { skip_weather: true }));
			ctx.stash({ brief } satisfies Partial<MorningBriefSnapshot>);

			// Step 2 — persist to D1 (skip if already persisted on resume).
			let persisted_id: string;
			if (snap.persisted_id) {
				persisted_id = snap.persisted_id;
			} else {
				const persisted = await persistMorningBrief(this.env, brief);
				persisted_id = persisted.id;
				ctx.stash({ brief, persisted_id } satisfies Partial<MorningBriefSnapshot>);
			}

			// Step 3 — mirror into the DO's local state + checkin log.
			this.sql`
				INSERT INTO checkins (id, at_ms, result, brief_id, trace_id)
				VALUES (
					${generateAgentId("ck")},
					${Date.now()},
					${snap.persisted_id ? "recovered" : "ok"},
					${persisted_id},
					${trace.trace_id}
				)
			`;
			this.setState({
				...this.state,
				last_brief_at_ms: Date.now(),
				last_brief_id: persisted_id,
			});

			await completeTrace(this.env, trace, {
				ok: true,
				result: {
					brief_id: persisted_id,
					plan_count: brief.plan_health.length,
					suggestion_count: brief.suggestions.length,
					recovered: !!snap.persisted_id,
				},
				result_summary: `morning_checkin brief=${persisted_id} plans=${brief.plan_health.length}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			throw err;
		}
	}

	/**
	 * Phase 4 — Fiber recovery hook. Resumes interrupted fibers from their
	 * last checkpoint after a worker eviction.
	 */
	async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
		if (ctx.name === "morning_brief") {
			try {
				// Re-enter the pipeline with the recovered snapshot. The
				// pipeline itself decides which steps to skip based on what's
				// already stashed.
				await this.runFiber("morning_brief", async (inner) => {
					// Carry the recovered snapshot forward so the inner ctx
					// sees it on first read.
					if (ctx.snapshot != null && (inner as { snapshot: unknown | null }).snapshot == null) {
						(inner as { stash(d: unknown): void }).stash(ctx.snapshot);
					}
					await this.runMorningBriefPipeline(
						inner as { stash(d: unknown): void; snapshot: unknown | null },
					);
				});
			} catch (err) {
				console.warn(`[household-agent] onFiberRecovered(morning_brief) failed:`, err);
			}
			return;
		}
		// Unknown fiber — fall through to default warning behaviour.
		await super.onFiberRecovered(ctx);
	}

	private async scheduleNextDailyBrief(): Promise<void> {
		try {
			await this.schedule(nextLocal7am(), "morningCheckin", {});
		} catch (err) {
			console.warn(`[household-agent] failed to schedule morningCheckin:`, err);
		}
	}

	private async refreshCachedProfile(): Promise<void> {
		if (!this.state.household_id) return;
		try {
			const profile = await getHouseholdProfile(this.env, this.state.household_id);
			let memberCount = this.state.member_count;
			try {
				const members = await listMembers(this.env, this.state.household_id);
				memberCount = members.length;
			} catch {
				// noop — listMembers swallows D1 errors and returns []
			}
			this.setState({
				...this.state,
				profile_loaded: !!profile,
				member_count: memberCount,
			});
		} catch (err) {
			console.warn(`[household-agent] refreshCachedProfile failed:`, err);
		}
	}

	private recordDecision(kind: string, payload: Record<string, unknown>, trace_id: string | null): void {
		this.sql`
			INSERT INTO decisions (id, at_ms, kind, payload_json, trace_id)
			VALUES (
				${generateAgentId("dec")},
				${Date.now()},
				${kind},
				${JSON.stringify(payload)},
				${trace_id ?? null}
			)
		`;
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export { householdAgentName };
