// PlanAgent — Durable Object, one per active plan.
//
// Wave 7B Track B: implementation.
//   * onStart loads the plan from D1 (mise_active_plans) on first wake and
//     caches counts in DO state.
//   * /finalize spawns a MealAgent per meal in the plan and a ShopAgent per
//     shop_run; idempotent.
//   * /archive flips status and signals child agents.
//   * /coherence runs scoreCoherence and updates state cache.
//   * /spawn-meal and /spawn-shop are convenience routes for mid-plan adds.
//   * Nightly recompute alarm refreshes coherence + writes to mise_plan_health.
//   * /child-status-changed is the inbound channel children use to notify
//     the parent (e.g., ShopAgent flipped to active_today).
//   * All mutations wrap with begin/completeTrace.

import { Agent, type FiberRecoveryContext } from "agents";
import {
	type AgentEnv,
	generateAgentId,
	mealAgentName,
	planAgentName,
	shopAgentName,
} from "./base";
import { beginTrace, completeTrace } from "../agent-trace";
import { loadActivePlan } from "../active-plans";
import { scorePlanCoherence } from "../coherence-score";
import { nextRecomputeAt, recomputePlanHealth } from "./plan-cycles";

export type PlanAgentStatus = "draft" | "active" | "finalized" | "archived";

/**
 * Phase 4 — fiber checkpoint snapshot for the finalize spawn loop.
 * Tracks per-child spawn status so a recovery picks up where the
 * pre-crash run left off instead of re-spawning everything.
 */
export interface FinalizeFiberSnapshot {
	plan_loaded: boolean;
	meal_total: number;
	shop_total: number;
	spawned_meals: string[];
	spawned_shops: string[];
	finalized?: boolean;
}

export interface PlanAgentState {
	plan_id: string;
	household_id: string | null;
	status: PlanAgentStatus;
	meal_count: number;
	shop_count: number;
	last_coherence_score: number | null;
	last_action: string | null;
	created_at_ms: number | null;
}

const INITIAL_STATE: PlanAgentState = {
	plan_id: "",
	household_id: null,
	status: "draft",
	meal_count: 0,
	shop_count: 0,
	last_coherence_score: null,
	last_action: null,
	created_at_ms: null,
};

export class PlanAgent extends Agent<AgentEnv, PlanAgentState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		this.sql`
			CREATE TABLE IF NOT EXISTS spawned_children (
				child_kind TEXT NOT NULL,
				child_name TEXT NOT NULL,
				spawned_at_ms INTEGER NOT NULL,
				status TEXT NOT NULL,
				PRIMARY KEY (child_kind, child_name)
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS actions (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				action TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				ok INTEGER NOT NULL DEFAULT 1,
				error TEXT,
				trace_id TEXT
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS child_signals (
				id TEXT PRIMARY KEY,
				at_ms INTEGER NOT NULL,
				child_kind TEXT NOT NULL,
				child_name TEXT NOT NULL,
				signal_kind TEXT NOT NULL,
				payload_json TEXT
			)
		`;
		// If we already know our plan_id, refresh counts.
		if (this.state.plan_id) {
			await this.refreshPlanCounts();
		}
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		if (route === "init" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				plan_id?: string;
				household_id?: string;
			};
			if (!body.plan_id) return json({ error: "plan_id required" }, 400);
			return await this.routeInit(body);
		}

		if (route === "state" && request.method === "GET") {
			return json(this.state);
		}

		if (route === "finalize" && request.method === "POST") {
			return await this.routeFinalize();
		}

		if (route === "archive" && request.method === "POST") {
			return await this.routeArchive();
		}

		if (route === "coherence" && request.method === "GET") {
			return await this.routeCoherence();
		}

		if (route === "spawn-meal" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				meal_id?: string;
				date?: string;
				slot?: string;
			};
			if (!body.date || !body.slot) return json({ error: "date + slot required" }, 400);
			return await this.routeSpawnMeal(body.meal_id, body.date, body.slot);
		}

		if (route === "spawn-shop" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				shop_run_id?: string;
				run_date?: string;
			};
			if (!body.shop_run_id) return json({ error: "shop_run_id required" }, 400);
			return await this.routeSpawnShop(body.shop_run_id, body.run_date ?? null);
		}

		if (route === "child-status-changed" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				child_kind?: string;
				child_name?: string;
				signal_kind?: string;
				payload?: Record<string, unknown>;
			};
			if (!body.child_kind || !body.child_name || !body.signal_kind) {
				return json({ error: "child_kind, child_name, signal_kind required" }, 400);
			}
			this.sql`
				INSERT INTO child_signals (id, at_ms, child_kind, child_name, signal_kind, payload_json)
				VALUES (
					${generateAgentId("sig")},
					${Date.now()},
					${body.child_kind},
					${body.child_name},
					${body.signal_kind},
					${body.payload ? JSON.stringify(body.payload) : null}
				)
			`;
			return json({ ok: true });
		}

		return json({ error: `unknown route: ${route}` }, 404);
	}

	// ─── Routes ──────────────────────────────────────────────────────────

	private async routeInit(body: { plan_id?: string; household_id?: string }): Promise<Response> {
		const trace = beginTrace({
			tool_name: "plan_agent.init",
			tool_args: body,
			caller_kind: "agent",
			caller_id: planAgentName(body.plan_id || ""),
			plan_id: body.plan_id,
			household_id: body.household_id,
		});
		try {
			const wasFresh = !this.state.plan_id;
			this.setState({
				...this.state,
				plan_id: body.plan_id || this.state.plan_id,
				household_id: body.household_id ?? this.state.household_id,
				status: wasFresh ? "draft" : this.state.status,
				created_at_ms: this.state.created_at_ms ?? Date.now(),
			});
			await this.refreshPlanCounts();
			await this.scheduleNextRecompute();
			this.recordAction("init", { plan_id: body.plan_id, was_fresh: wasFresh }, trace.trace_id);
			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `plan_init plan=${body.plan_id}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeFinalize(): Promise<Response> {
		if (!this.state.plan_id) return json({ error: "plan not initialized" }, 400);
		const trace = beginTrace({
			tool_name: "plan_agent.finalize",
			tool_args: { plan_id: this.state.plan_id },
			caller_kind: "agent",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
			household_id: this.state.household_id || undefined,
		});
		try {
			let mealsSpawned = 0;
			let shopsSpawned = 0;

			// Phase 4 — wrap the spawn loop in a Fiber. If the worker dies
			// mid-spawn, the recovered fiber resumes at the last checkpoint
			// instead of re-spawning everything. Stash schedule:
			//   1. After loadActivePlan      → `{ plan_loaded: true, totals }`
			//   2. After each meal spawn     → push to `spawned_meals[]`
			//   3. After each shop spawn     → push to `spawned_shops[]`
			//   4. After status flip          → `{ finalized: true, ... }`
			await this.runFiber("finalize_spawn", async (fiberCtx) => {
				const counts = await this.runFinalizeSpawnFiber(fiberCtx);
				mealsSpawned = counts.mealsSpawned;
				shopsSpawned = counts.shopsSpawned;
			});

			this.recordAction("finalize", { meals_spawned: mealsSpawned, shops_spawned: shopsSpawned }, trace.trace_id);
			await completeTrace(this.env, trace, {
				ok: true,
				result: { meals_spawned: mealsSpawned, shops_spawned: shopsSpawned },
				result_summary: `finalize plan=${this.state.plan_id} meals=${mealsSpawned} shops=${shopsSpawned}`,
			});
			return json({
				ok: true,
				meals_spawned: mealsSpawned,
				shops_spawned: shopsSpawned,
				state: this.state,
				trace_id: trace.trace_id,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	/**
	 * Phase 4 — fiber body for `finalize_spawn`. Loads the plan, spawns
	 * every child MealAgent + ShopAgent, then flips status. Each spawn
	 * is checkpointed so a recovery starts at the next un-spawned child.
	 */
	private async runFinalizeSpawnFiber(
		ctx: { stash(d: unknown): void; snapshot: unknown | null },
	): Promise<{ mealsSpawned: number; shopsSpawned: number }> {
		const snap = (ctx.snapshot ?? {}) as Partial<FinalizeFiberSnapshot>;
		const spawnedMeals = new Set(snap.spawned_meals ?? []);
		const spawnedShops = new Set(snap.spawned_shops ?? []);

		const plan = await loadActivePlan(this.env, this.state.plan_id);
		const allMeals: Array<{ id: string; date: string; slot: string }> = [];
		const allShops: Array<{ id: string; date: string | null }> = [];
		if (plan) {
			for (const day of plan.meals_by_day || []) {
				for (const m of day.meals || []) {
					allMeals.push({ id: m.id, date: day.date, slot: m.slot });
				}
			}
			for (const b of plan.breakfasts || []) {
				allMeals.push({ id: b.id, date: b.date, slot: b.slot });
			}
			for (const run of plan.shop_runs || []) {
				allShops.push({ id: run.id, date: run.date });
			}
		}

		ctx.stash({
			plan_loaded: true,
			meal_total: allMeals.length,
			shop_total: allShops.length,
			spawned_meals: [...spawnedMeals],
			spawned_shops: [...spawnedShops],
		} satisfies FinalizeFiberSnapshot);

		// Spawn meals.
		for (const meal of allMeals) {
			const childName = mealAgentName(this.state.plan_id, meal.date, meal.slot);
			if (spawnedMeals.has(childName)) continue;
			try {
				const ns = this.env.MEAL_AGENT;
				const stub = ns.get(ns.idFromName(childName));
				await stub.fetch(new Request("https://agent/internal/init", {
					method: "POST",
					body: JSON.stringify({
						meal_id: meal.id,
						plan_id: this.state.plan_id,
						date: meal.date,
						slot: meal.slot,
					}),
					headers: { "content-type": "application/json" },
				}));
				this.recordChild("meal", childName);
				spawnedMeals.add(childName);
				ctx.stash({
					plan_loaded: true,
					meal_total: allMeals.length,
					shop_total: allShops.length,
					spawned_meals: [...spawnedMeals],
					spawned_shops: [...spawnedShops],
				} satisfies FinalizeFiberSnapshot);
			} catch (err) {
				console.warn(`[plan-agent] failed to spawn meal-agent for ${meal.id}:`, err);
			}
		}

		// Spawn shops.
		for (const run of allShops) {
			const childName = shopAgentName(this.state.plan_id, run.id);
			if (spawnedShops.has(childName)) continue;
			try {
				const ns = this.env.SHOP_AGENT;
				const stub = ns.get(ns.idFromName(childName));
				await stub.fetch(new Request("https://agent/internal/init", {
					method: "POST",
					body: JSON.stringify({
						shop_run_id: run.id,
						plan_id: this.state.plan_id,
						run_date: run.date,
					}),
					headers: { "content-type": "application/json" },
				}));
				this.recordChild("shop", childName);
				spawnedShops.add(childName);
				ctx.stash({
					plan_loaded: true,
					meal_total: allMeals.length,
					shop_total: allShops.length,
					spawned_meals: [...spawnedMeals],
					spawned_shops: [...spawnedShops],
				} satisfies FinalizeFiberSnapshot);
			} catch (err) {
				console.warn(`[plan-agent] failed to spawn shop-agent for ${run.id}:`, err);
			}
		}

		this.setState({ ...this.state, status: "finalized", last_action: "finalize" });
		ctx.stash({
			plan_loaded: true,
			meal_total: allMeals.length,
			shop_total: allShops.length,
			spawned_meals: [...spawnedMeals],
			spawned_shops: [...spawnedShops],
			finalized: true,
		} satisfies FinalizeFiberSnapshot);

		return { mealsSpawned: spawnedMeals.size, shopsSpawned: spawnedShops.size };
	}

	/**
	 * Phase 4 — recovery hook. Re-enters `runFinalizeSpawnFiber` with the
	 * saved snapshot so already-spawned children are skipped.
	 */
	async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
		if (ctx.name === "finalize_spawn") {
			try {
				await this.runFiber("finalize_spawn", async (inner) => {
					if (ctx.snapshot != null && (inner as { snapshot: unknown | null }).snapshot == null) {
						(inner as { stash(d: unknown): void }).stash(ctx.snapshot);
					}
					await this.runFinalizeSpawnFiber(
						inner as { stash(d: unknown): void; snapshot: unknown | null },
					);
				});
			} catch (err) {
				console.warn(`[plan-agent] onFiberRecovered(finalize_spawn) failed:`, err);
			}
			return;
		}
		await super.onFiberRecovered(ctx);
	}

	private async routeArchive(): Promise<Response> {
		if (!this.state.plan_id) return json({ error: "plan not initialized" }, 400);
		const trace = beginTrace({
			tool_name: "plan_agent.archive",
			tool_args: { plan_id: this.state.plan_id },
			caller_kind: "agent",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
			household_id: this.state.household_id || undefined,
		});
		try {
			// Best-effort signal to children. We don't await every call sequentially
			// because hundreds of children would blow the request budget; we
			// fire-and-forget and rely on the children's own state.
			const children = this.sql<{ child_kind: string; child_name: string }>`
				SELECT child_kind, child_name FROM spawned_children
			`;
			for (const c of children) {
				try {
					if (c.child_kind === "meal") {
						const ns = this.env.MEAL_AGENT;
						const stub = ns.get(ns.idFromName(c.child_name));
						await stub.fetch(new Request("https://agent/internal/transition", {
							method: "POST",
							body: JSON.stringify({ to: "archived", reason: "plan_archive" }),
							headers: { "content-type": "application/json" },
						}));
					} else if (c.child_kind === "shop") {
						const ns = this.env.SHOP_AGENT;
						const stub = ns.get(ns.idFromName(c.child_name));
						await stub.fetch(new Request("https://agent/internal/cancel", {
							method: "POST",
							body: JSON.stringify({ reason: "plan_archive" }),
							headers: { "content-type": "application/json" },
						}));
					}
				} catch (err) {
					console.warn(`[plan-agent] failed to signal archive to ${c.child_name}:`, err);
				}
			}
			this.setState({ ...this.state, status: "archived", last_action: "archive" });
			this.recordAction("archive", { plan_id: this.state.plan_id }, trace.trace_id);
			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `archive plan=${this.state.plan_id}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeCoherence(): Promise<Response> {
		if (!this.state.plan_id) return json({ error: "plan not initialized" }, 400);
		const trace = beginTrace({
			tool_name: "plan_agent.coherence",
			tool_args: { plan_id: this.state.plan_id },
			caller_kind: "agent",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
		});
		try {
			const plan = await loadActivePlan(this.env, this.state.plan_id);
			if (!plan) {
				await completeTrace(this.env, trace, { ok: false, error: "plan_not_loaded" });
				return json({ error: "plan_not_loaded" }, 404);
			}
			const result = scorePlanCoherence(plan);
			this.setState({ ...this.state, last_coherence_score: result.score });
			await completeTrace(this.env, trace, {
				ok: true,
				result: { score: result.score, issue_count: result.issues.length },
				result_summary: `coherence plan=${this.state.plan_id} score=${result.score}`,
			});
			return json({ ok: true, score: result.score, issues: result.issues, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeSpawnMeal(meal_id: string | undefined, date: string, slot: string): Promise<Response> {
		if (!this.state.plan_id) return json({ error: "plan not initialized" }, 400);
		const trace = beginTrace({
			tool_name: "plan_agent.spawn_meal",
			tool_args: { meal_id, date, slot },
			caller_kind: "agent",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
		});
		try {
			const childName = mealAgentName(this.state.plan_id, date, slot);
			const ns = this.env.MEAL_AGENT;
			const stub = ns.get(ns.idFromName(childName));
			const initResp = await stub.fetch(new Request("https://agent/internal/init", {
				method: "POST",
				body: JSON.stringify({
					meal_id: meal_id || childName,
					plan_id: this.state.plan_id,
					date,
					slot,
				}),
				headers: { "content-type": "application/json" },
			}));
			const child_state = await initResp.json().catch(() => ({}));
			this.recordChild("meal", childName);
			this.recordAction("spawn_meal", { child: childName }, trace.trace_id);
			await completeTrace(this.env, trace, {
				ok: true,
				result: { child: childName, child_state },
				result_summary: `spawn_meal child=${childName}`,
			});
			return json({ ok: true, child: childName, child_state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	private async routeSpawnShop(shop_run_id: string, run_date: string | null): Promise<Response> {
		if (!this.state.plan_id) return json({ error: "plan not initialized" }, 400);
		const trace = beginTrace({
			tool_name: "plan_agent.spawn_shop",
			tool_args: { shop_run_id, run_date },
			caller_kind: "agent",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
		});
		try {
			const childName = shopAgentName(this.state.plan_id, shop_run_id);
			const ns = this.env.SHOP_AGENT;
			const stub = ns.get(ns.idFromName(childName));
			const initResp = await stub.fetch(new Request("https://agent/internal/init", {
				method: "POST",
				body: JSON.stringify({
					shop_run_id,
					plan_id: this.state.plan_id,
					run_date,
				}),
				headers: { "content-type": "application/json" },
			}));
			const child_state = await initResp.json().catch(() => ({}));
			this.recordChild("shop", childName);
			this.recordAction("spawn_shop", { child: childName }, trace.trace_id);
			await completeTrace(this.env, trace, {
				ok: true,
				result: { child: childName, child_state },
				result_summary: `spawn_shop child=${childName}`,
			});
			return json({ ok: true, child: childName, child_state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ error: message }, 500);
		}
	}

	// ─── Alarm ────────────────────────────────────────────────────────────

	async nightlyRecompute(): Promise<void> {
		if (!this.state.plan_id) {
			await this.scheduleNextRecompute();
			return;
		}
		const trace = beginTrace({
			tool_name: "plan_agent.nightly_recompute",
			tool_args: { plan_id: this.state.plan_id },
			caller_kind: "cron",
			caller_id: planAgentName(this.state.plan_id),
			plan_id: this.state.plan_id,
			household_id: this.state.household_id || undefined,
		});
		try {
			const result = await recomputePlanHealth(
				this.env,
				this.state.plan_id,
				this.state.household_id,
			);
			if (result.persisted && typeof result.row.coherence_score === "number") {
				this.setState({ ...this.state, last_coherence_score: result.row.coherence_score });
			}
			await completeTrace(this.env, trace, {
				ok: true,
				result: {
					persisted: result.persisted,
					coherence_score: result.row.coherence_score,
					hard: result.row.hard_grievance_count,
					warning: result.row.warning_grievance_count,
				},
				result_summary: `nightly_recompute plan=${this.state.plan_id} persisted=${result.persisted}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
		} finally {
			await this.scheduleNextRecompute();
		}
	}

	private async scheduleNextRecompute(): Promise<void> {
		try {
			await this.schedule(nextRecomputeAt(), "nightlyRecompute", {});
		} catch (err) {
			console.warn(`[plan-agent] failed to schedule nightlyRecompute:`, err);
		}
	}

	// ─── Internal helpers ─────────────────────────────────────────────────

	private async refreshPlanCounts(): Promise<void> {
		if (!this.state.plan_id) return;
		try {
			const plan = await loadActivePlan(this.env, this.state.plan_id);
			if (!plan) return;
			let meal_count = 0;
			for (const day of plan.meals_by_day || []) meal_count += (day.meals || []).length;
			meal_count += (plan.breakfasts || []).length;
			const shop_count = (plan.shop_runs || []).length;
			this.setState({
				...this.state,
				meal_count,
				shop_count,
				household_id: plan.household_id || this.state.household_id,
			});
		} catch (err) {
			console.warn(`[plan-agent] refreshPlanCounts failed:`, err);
		}
	}

	private recordAction(action: string, payload: Record<string, unknown>, trace_id: string | null): void {
		this.setState({ ...this.state, last_action: action });
		this.sql`
			INSERT INTO actions (id, at_ms, action, payload_json, ok, error, trace_id)
			VALUES (
				${generateAgentId("act")},
				${Date.now()},
				${action},
				${JSON.stringify(payload)},
				${1},
				${null},
				${trace_id ?? null}
			)
		`;
	}

	private recordChild(kind: string, name: string): void {
		this.sql`
			INSERT OR REPLACE INTO spawned_children
				(child_kind, child_name, spawned_at_ms, status)
			VALUES (${kind}, ${name}, ${Date.now()}, ${"spawned"})
		`;
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
