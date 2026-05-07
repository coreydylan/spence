// MealAgent — Durable Object, one per meal.
//
// Wave 7B Track A: full state machine implementation.
//
// State machine: planned → pre_eve → day_of → cook_window → active_cook → eaten → archived.
// `archived` is also the cancellation terminal — `/cancel` writes a phase
// transition with reason `cancelled:<msg>` so observers can distinguish
// completion from cancellation. See agents/base.ts for the legal-transition
// matrix (locked by u41).
//
// Per-phase entry handlers live in meal-phase-handlers.ts as PURE async
// functions that take (snapshot, deps) and return a structured
// `PhaseHandlerResult`. The MealAgent wraps those handlers, applies their
// side effects (D1 writes via env.DB, embedded SQLite writes via this.sql),
// and schedules the next-phase alarm.
//
// Tracing: every transition is wrapped in beginTrace/completeTrace so
// PlanAgent / replay UI can walk the state-machine history.

import { Agent } from "agents";
import {
	beginTrace,
	completeTrace,
	type CallerKind,
} from "../agent-trace";
import {
	type AgentEnv,
	type MealPhase,
	MEAL_TRANSITIONS,
	generateAgentId,
	isLegalTransition,
} from "./base";
import {
	active_cook_entry,
	archived_entry,
	cancelled_entry,
	cook_window_entry,
	day_of_entry,
	defaultWindowsForSlot,
	eaten_entry,
	loadMealSnapshotFromActivePlan,
	pre_eve_entry,
	type AdultsList,
	type BriefingRow,
	type CookSessionRow,
	type LocationContext,
	type MealSnapshot,
	type NotificationRow,
	type PhaseHandlerDeps,
	type PhaseHandlerResult,
} from "./meal-phase-handlers";
import { ensureEquipmentClaimsStubTable } from "./equipment-stub";
import { spawnCookingLeadAgent } from "./cooking-lead-handoff";

export interface MealAgentState {
	meal_id: string;
	plan_id: string;
	household_id: string | null;
	date: string | null;
	slot: string | null;
	phase: MealPhase;
	last_transition_at_ms: number | null;
	initialized_at_ms: number | null;
	cook_session_id: string | null;
	eaten_at_ms: number | null;
	cancelled_reason: string | null;
	location: LocationContext | null;
	adult_member_ids: string[];
	next_alarm_at_ms: number | null;
}

const INITIAL_STATE: MealAgentState = {
	meal_id: "",
	plan_id: "",
	household_id: null,
	date: null,
	slot: null,
	phase: "planned",
	last_transition_at_ms: null,
	initialized_at_ms: null,
	cook_session_id: null,
	eaten_at_ms: null,
	cancelled_reason: null,
	location: null,
	adult_member_ids: [],
	next_alarm_at_ms: null,
};

interface InitBody {
	meal_id?: string;
	plan_id?: string;
	household_id?: string;
	location?: LocationContext;
	adult_member_ids?: string[];
	// Optional explicit windows — when supplied, override the slot-default
	// windows derived from `date` + `slot`.
	cook_window_start_ms?: number;
	cook_window_end_ms?: number;
	eat_window_start_ms?: number;
	eat_window_end_ms?: number;
	// Test/dev only — initial phase override (defaults to planned).
	initial_phase?: MealPhase;
}

interface TransitionBody {
	to_phase?: MealPhase;
	reason?: string;
	force?: boolean;
}

interface CancelBody {
	reason?: string;
}

interface StartCookBody {
	member_id?: string;
}

interface MarkEatenBody {
	member_id?: string;
}

interface AlarmPayload {
	target_phase: MealPhase;
	scheduled_at_ms: number;
}

export class MealAgent extends Agent<AgentEnv, MealAgentState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		this.sql`
			CREATE TABLE IF NOT EXISTS phase_transitions (
				id TEXT PRIMARY KEY,
				from_phase TEXT NOT NULL,
				to_phase TEXT NOT NULL,
				at_ms INTEGER NOT NULL,
				reason TEXT
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_meal_phase_at ON phase_transitions(at_ms ASC)`;
		this.sql`
			CREATE TABLE IF NOT EXISTS meal_snapshot (
				snapshot_id TEXT PRIMARY KEY,
				meal_id TEXT NOT NULL,
				plan_id TEXT NOT NULL,
				date TEXT NOT NULL,
				slot TEXT NOT NULL,
				format TEXT,
				cuisine_json TEXT,
				recipe_id TEXT,
				cook_window_start_ms INTEGER NOT NULL,
				cook_window_end_ms INTEGER NOT NULL,
				eat_window_start_ms INTEGER NOT NULL,
				eat_window_end_ms INTEGER NOT NULL,
				equipment_json TEXT,
				source_json TEXT,
				loaded_at_ms INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS cook_session_marker (
				cook_session_id TEXT PRIMARY KEY,
				meal_id TEXT NOT NULL,
				state TEXT NOT NULL,
				started_at_ms INTEGER NOT NULL,
				stale_at_ms INTEGER,
				ended_at_ms INTEGER,
				ended_reason TEXT
			)
		`;
		ensureEquipmentClaimsStubTable(this);
	}

	/**
	 * HTTP entrypoint. Routes:
	 *   POST /init        — load meal from D1, set initial phase, kick alarms.
	 *   POST /transition  — manual transition with optional `force`.
	 *   POST /start-cook  — manual cook_window → active_cook.
	 *   POST /mark-eaten  — manual active_cook → eaten.
	 *   POST /cancel      — any non-terminal → archived (with reason).
	 *   GET  /state       — return current state JSON.
	 *   GET  /transitions — return phase audit log.
	 *   GET  /snapshot    — return cached MealSnapshot.
	 */
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname.split("/").filter(Boolean).pop() || "state";

		try {
			if (route === "init" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as InitBody;
				return await this.handleInit(body);
			}
			if (route === "state" && request.method === "GET") {
				return json({ ok: true, state: this.state });
			}
			if (route === "snapshot" && request.method === "GET") {
				return json({ ok: true, snapshot: this.readSnapshot() });
			}
			if (route === "transitions" && request.method === "GET") {
				const rows = this.sql`SELECT id, from_phase, to_phase, at_ms, reason FROM phase_transitions ORDER BY at_ms ASC`;
				return json({ ok: true, transitions: rows });
			}
			if (route === "transition" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as TransitionBody;
				if (!body.to_phase) return json({ ok: false, error: "to_phase required" }, 400);
				const reason = body.reason || "manual:transition";
				const result = await this.transitionTo(body.to_phase, reason, { force: !!body.force, caller_kind: "human" });
				if (!result.ok) return json(result, 400);
				return json({ ok: true, transitioned_to: result.to, state: this.state });
			}
			if (route === "start-cook" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as StartCookBody;
				if (this.state.phase !== "cook_window") {
					return json({
						ok: false,
						error: `start-cook requires phase=cook_window (current=${this.state.phase})`,
					}, 400);
				}
				const reason = `manual:start-cook${body.member_id ? `:${body.member_id}` : ""}`;
				const result = await this.transitionTo("active_cook", reason, { caller_kind: "human", caller_id: body.member_id });
				if (!result.ok) return json(result, 400);
				return json({ ok: true, transitioned_to: "active_cook", state: this.state });
			}
			if (route === "mark-eaten" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as MarkEatenBody;
				if (this.state.phase !== "active_cook") {
					return json({
						ok: false,
						error: `mark-eaten requires phase=active_cook (current=${this.state.phase})`,
					}, 400);
				}
				const reason = `manual:mark-eaten${body.member_id ? `:${body.member_id}` : ""}`;
				const result = await this.transitionTo("eaten", reason, { caller_kind: "human", caller_id: body.member_id });
				if (!result.ok) return json(result, 400);
				return json({ ok: true, transitioned_to: "eaten", state: this.state });
			}
			if (route === "cancel" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as CancelBody;
				const reason = body.reason || "no reason supplied";
				if (this.state.phase === "archived") {
					return json({ ok: false, error: "already archived" }, 400);
				}
				const fullReason = `cancelled:${reason}`;
				this.setState({ ...this.state, cancelled_reason: reason });
				const result = await this.transitionTo("archived", fullReason, { caller_kind: "human" });
				if (!result.ok) return json(result, 400);
				return json({ ok: true, transitioned_to: "archived", state: this.state });
			}

			return json({ ok: false, error: `unknown route: ${route}` }, 404);
		} catch (err) {
			return json({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}, 500);
		}
	}

	// ─── /init handler ────────────────────────────────────────────────────

	private async handleInit(body: InitBody): Promise<Response> {
		const meal_id = (body.meal_id || this.state.meal_id || "").trim();
		const plan_id = (body.plan_id || this.state.plan_id || "").trim();
		if (!meal_id || !plan_id) {
			return json({ ok: false, error: "meal_id and plan_id required" }, 400);
		}

		const overrides: Partial<MealSnapshot> = {};
		if (typeof body.cook_window_start_ms === "number") overrides.cook_window_start_ms = body.cook_window_start_ms;
		if (typeof body.cook_window_end_ms === "number")   overrides.cook_window_end_ms   = body.cook_window_end_ms;
		if (typeof body.eat_window_start_ms === "number")  overrides.eat_window_start_ms  = body.eat_window_start_ms;
		if (typeof body.eat_window_end_ms === "number")    overrides.eat_window_end_ms    = body.eat_window_end_ms;

		let snapshot: MealSnapshot | null = null;
		try {
			snapshot = await loadMealSnapshotFromActivePlan(this.env, plan_id, meal_id, overrides);
		} catch (err) {
			return json({
				ok: false,
				error: `failed to load meal from D1: ${err instanceof Error ? err.message : String(err)}`,
			}, 500);
		}

		// Allow init even when D1 doesn't have the row yet (e.g. tests, or
		// agent gets spawned before the plan is fully persisted). Synthesize
		// a snapshot from the supplied body.
		if (!snapshot) {
			if (!body.household_id || !overrides.cook_window_start_ms || !overrides.eat_window_start_ms) {
				return json({
					ok: false,
					error: `meal not found in D1 (plan_id=${plan_id} meal_id=${meal_id}); pass household_id + window overrides to synthesize`,
				}, 404);
			}
			snapshot = this.synthesizeSnapshot(meal_id, plan_id, body, overrides);
		}

		// Apply household_id override if explicitly supplied.
		if (body.household_id) snapshot = { ...snapshot, household_id: body.household_id };

		this.persistSnapshot(snapshot);

		const initial_phase: MealPhase = body.initial_phase || "planned";
		const now_ms = Date.now();

		this.setState({
			...this.state,
			meal_id,
			plan_id,
			household_id: snapshot.household_id,
			date: snapshot.date,
			slot: snapshot.slot,
			phase: initial_phase,
			initialized_at_ms: now_ms,
			location: body.location || null,
			adult_member_ids: Array.isArray(body.adult_member_ids) ? body.adult_member_ids : [],
		});

		// Kick off the alarm chain — schedule the next phase based on
		// current time vs. eat_window.
		const alarmAt = this.computeInitialAlarmAt(snapshot, initial_phase, now_ms);
		if (alarmAt) {
			await this.schedule(new Date(alarmAt), "onPhaseAlarm" as never, {
				target_phase: this.computeNextPhaseFromInit(snapshot, initial_phase, now_ms),
				scheduled_at_ms: alarmAt,
			} satisfies AlarmPayload as never);
			this.setState({ ...this.state, next_alarm_at_ms: alarmAt });
		}

		return json({
			ok: true,
			state: this.state,
			snapshot,
			next_alarm_at_ms: alarmAt,
		});
	}

	private synthesizeSnapshot(
		meal_id: string,
		plan_id: string,
		body: InitBody,
		overrides: Partial<MealSnapshot>,
	): MealSnapshot {
		const slot = "dinner";
		const date = new Date().toISOString().slice(0, 10);
		const windows = defaultWindowsForSlot(date, slot);
		return {
			meal_id,
			plan_id,
			household_id: body.household_id || null,
			date,
			slot,
			format: null,
			cuisine: [],
			recipe_id: null,
			cook_window_start_ms: overrides.cook_window_start_ms ?? windows.cook_window_start_ms,
			cook_window_end_ms:   overrides.cook_window_end_ms ?? windows.cook_window_end_ms,
			eat_window_start_ms:  overrides.eat_window_start_ms ?? windows.eat_window_start_ms,
			eat_window_end_ms:    overrides.eat_window_end_ms ?? windows.eat_window_end_ms,
			equipment: [],
		};
	}

	private persistSnapshot(snapshot: MealSnapshot): void {
		this.sql`DELETE FROM meal_snapshot WHERE meal_id = ${snapshot.meal_id}`;
		this.sql`
			INSERT INTO meal_snapshot
				(snapshot_id, meal_id, plan_id, date, slot, format, cuisine_json,
				 recipe_id, cook_window_start_ms, cook_window_end_ms,
				 eat_window_start_ms, eat_window_end_ms,
				 equipment_json, source_json, loaded_at_ms)
			VALUES (
				${generateAgentId("snap")},
				${snapshot.meal_id},
				${snapshot.plan_id},
				${snapshot.date},
				${snapshot.slot},
				${snapshot.format ?? null},
				${JSON.stringify(snapshot.cuisine || [])},
				${snapshot.recipe_id ?? null},
				${snapshot.cook_window_start_ms},
				${snapshot.cook_window_end_ms},
				${snapshot.eat_window_start_ms},
				${snapshot.eat_window_end_ms},
				${JSON.stringify(snapshot.equipment || [])},
				${JSON.stringify({ household_id: snapshot.household_id })},
				${Date.now()}
			)
		`;
	}

	private readSnapshot(): MealSnapshot | null {
		const meal_id = this.state.meal_id;
		if (!meal_id) return null;
		const rows = this.sql<{
			meal_id: string; plan_id: string; date: string; slot: string;
			format: string | null; cuisine_json: string | null; recipe_id: string | null;
			cook_window_start_ms: number; cook_window_end_ms: number;
			eat_window_start_ms: number; eat_window_end_ms: number;
			equipment_json: string | null; source_json: string | null;
		}>`
			SELECT meal_id, plan_id, date, slot, format, cuisine_json, recipe_id,
				cook_window_start_ms, cook_window_end_ms,
				eat_window_start_ms, eat_window_end_ms,
				equipment_json, source_json
			FROM meal_snapshot
			WHERE meal_id = ${meal_id}
			LIMIT 1
		`;
		const row = rows[0];
		if (!row) return null;
		return {
			meal_id: row.meal_id,
			plan_id: row.plan_id,
			household_id: this.state.household_id,
			date: row.date,
			slot: row.slot,
			format: row.format,
			cuisine: parseStringArray(row.cuisine_json),
			recipe_id: row.recipe_id,
			cook_window_start_ms: row.cook_window_start_ms,
			cook_window_end_ms: row.cook_window_end_ms,
			eat_window_start_ms: row.eat_window_start_ms,
			eat_window_end_ms: row.eat_window_end_ms,
			equipment: parseStringArray(row.equipment_json),
		};
	}

	private computeNextPhaseFromInit(
		snapshot: MealSnapshot,
		current: MealPhase,
		now_ms: number,
	): MealPhase {
		if (current !== "planned") return current;
		const eat = snapshot.eat_window_start_ms;
		const cook = snapshot.cook_window_start_ms;
		if (now_ms >= cook) return "cook_window";
		// "skip directly to day_of" when meal is <24h away (per prompt).
		if (eat - now_ms < 24 * 60 * 60 * 1000) return "day_of";
		return "pre_eve";
	}

	private computeInitialAlarmAt(
		snapshot: MealSnapshot,
		current: MealPhase,
		now_ms: number,
	): number | null {
		if (current !== "planned") return null;
		const next = this.computeNextPhaseFromInit(snapshot, current, now_ms);
		if (next === "pre_eve") {
			const at = snapshot.eat_window_start_ms - 24 * 60 * 60 * 1000;
			return at > now_ms ? at : now_ms + 1_000;
		}
		if (next === "day_of") {
			const at = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;
			return at > now_ms ? at : now_ms + 1_000;
		}
		if (next === "cook_window") {
			return Math.max(snapshot.cook_window_start_ms, now_ms + 1_000);
		}
		return null;
	}

	// ─── transitionTo: trace-wrapped state change ────────────────────────

	/**
	 * Move the meal to a new phase. Returns {ok: false} when the transition
	 * is illegal (and `force` is not set). On success: writes phase audit row,
	 * runs the new phase's entry handler, applies its side effects, schedules
	 * the next alarm, and updates DO state.
	 *
	 * Wrapped in beginTrace/completeTrace so the agent-trace replay UI can
	 * walk the state-machine history.
	 */
	async transitionTo(
		to: MealPhase,
		reason: string,
		opts: { force?: boolean; caller_kind?: CallerKind; caller_id?: string } = {},
	): Promise<{ ok: boolean; from?: MealPhase; to?: MealPhase; error?: string; result?: PhaseHandlerResult }> {
		const from = this.state.phase;

		if (!opts.force && !isLegalTransition(MEAL_TRANSITIONS, from, to)) {
			return {
				ok: false,
				from,
				to,
				error: `illegal transition: ${from} → ${to}`,
			};
		}

		const traceCtx = beginTrace({
			tool_name: `meal_agent.transition`,
			tool_args: { meal_id: this.state.meal_id, from, to, reason, force: !!opts.force },
			caller_kind: opts.caller_kind || "system",
			caller_id: opts.caller_id,
			plan_id: this.state.plan_id || undefined,
			household_id: this.state.household_id || undefined,
		});

		try {
			const now = Date.now();

			// 1. Write the audit row.
			this.sql`
				INSERT INTO phase_transitions (id, from_phase, to_phase, at_ms, reason)
				VALUES (
					${generateAgentId("ph")},
					${from},
					${to},
					${now},
					${reason ?? null}
				)
			`;

			// 2. Update state up-front so handlers see the new phase.
			this.setState({ ...this.state, phase: to, last_transition_at_ms: now });

			// 3. Run the new phase's entry handler.
			const result = await this.runPhaseEntry(to, reason, now);

			// 4. Schedule the next alarm if the handler asked for one.
			if (result.next_alarm_at_ms && to !== "archived") {
				await this.schedule(new Date(result.next_alarm_at_ms), "onPhaseAlarm" as never, {
					target_phase: this.nextPhaseAfter(to),
					scheduled_at_ms: result.next_alarm_at_ms,
				} satisfies AlarmPayload as never);
				this.setState({ ...this.state, next_alarm_at_ms: result.next_alarm_at_ms });
			} else {
				this.setState({ ...this.state, next_alarm_at_ms: null });
			}

			await completeTrace(this.env, traceCtx, {
				ok: true,
				result: { from, to, reason, next_alarm_at_ms: result.next_alarm_at_ms },
				result_summary: `meal_agent.transition: ${from}→${to}`,
			});

			return { ok: true, from, to, result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, traceCtx, {
				ok: false,
				error: message,
				result_summary: `meal_agent.transition error: ${message.slice(0, 100)}`,
			});
			throw err;
		}
	}

	private nextPhaseAfter(phase: MealPhase): MealPhase {
		switch (phase) {
			case "planned": return "pre_eve";
			case "pre_eve": return "day_of";
			case "day_of": return "cook_window";
			case "cook_window": return "active_cook";
			case "active_cook": return "eaten";
			case "eaten": return "archived";
			case "archived": return "archived";
			default: return phase;
		}
	}

	// ─── Run a phase's entry handler + apply side effects ────────────────

	private async runPhaseEntry(
		phase: MealPhase,
		reason: string,
		now_ms: number,
	): Promise<PhaseHandlerResult> {
		const snapshot = this.readSnapshot();
		if (!snapshot) {
			return {
				phase: phase as never,
				briefings: [],
				notifications: [],
				cook_sessions: [],
				notes: ["no_snapshot:skipping_handler"],
				next_alarm_at_ms: null,
			};
		}
		// Override household_id to current state value — covers the case
		// where init body supplied a household_id explicitly.
		const fullSnapshot: MealSnapshot = {
			...snapshot,
			household_id: this.state.household_id,
		};
		const adults: AdultsList = { adult_member_ids: this.state.adult_member_ids };
		const deps: PhaseHandlerDeps = {
			env: this.env,
			now_ms,
			location: this.state.location || undefined,
			adults,
		};

		let result: PhaseHandlerResult;
		const isCancelled = phase === "archived" && reason.startsWith("cancelled:");

		switch (phase) {
			case "planned":
				result = {
					phase: "planned",
					briefings: [],
					notifications: [],
					cook_sessions: [],
					notes: [],
					next_alarm_at_ms: null,
				};
				break;
			case "pre_eve":
				result = await pre_eve_entry(fullSnapshot, deps);
				break;
			case "day_of":
				result = await day_of_entry(fullSnapshot, deps);
				break;
			case "cook_window":
				result = await cook_window_entry(fullSnapshot, deps, this);
				break;
			case "active_cook":
				result = await active_cook_entry(fullSnapshot, deps);
				break;
			case "eaten":
				result = await eaten_entry(fullSnapshot, deps, this.state.cook_session_id);
				break;
			case "archived":
				if (isCancelled) {
					const reasonText = reason.slice("cancelled:".length) || "unspecified";
					result = await cancelled_entry(fullSnapshot, deps, this, reasonText);
				} else {
					result = await archived_entry(fullSnapshot, deps, this);
				}
				break;
			default:
				result = {
					phase: phase as never,
					briefings: [],
					notifications: [],
					cook_sessions: [],
					notes: [],
					next_alarm_at_ms: null,
				};
		}

		await this.applyHandlerResult(result);

		// Phase-specific state hooks.
		if (phase === "active_cook" && result.cook_session_marker) {
			const cook_session_id = result.cook_session_marker.cook_session_id;
			this.setState({
				...this.state,
				cook_session_id,
			});
			// ── Wave 8 hand-off boundary ──────────────────────────────────
			// Spawn the ephemeral CookingLeadAgent for this cook session.
			// Best-effort — when the binding isn't present (Wave 7 deploys,
			// tests without the namespace) the marker stays as the pre-Wave-8
			// "session started" indicator. Wave 8B builds out the brigade UX
			// from inside the lead agent.
			await this.spawnCookingLeadAgent(cook_session_id, result);
		}
		if (phase === "eaten") {
			this.setState({ ...this.state, eaten_at_ms: now_ms });
		}

		return result;
	}

	/**
	 * Wave 8 hand-off: ask the CookingLeadAgent to take over active cooking.
	 * Delegates to the pure helper `spawnCookingLeadAgent` so unit tests can
	 * inject a mock namespace without booting the Agents SDK.
	 */
	private async spawnCookingLeadAgent(
		cook_session_id: string,
		_result: PhaseHandlerResult,
	): Promise<void> {
		await spawnCookingLeadAgent({
			env: this.env,
			cook_session_id,
			meal_id: this.state.meal_id,
			plan_id: this.state.plan_id,
			household_id: this.state.household_id,
		});
	}

	private async applyHandlerResult(result: PhaseHandlerResult): Promise<void> {
		// Briefings → D1.mise_meal_briefings
		for (const row of result.briefings) {
			await this.insertBriefing(row);
		}
		// Notifications → D1.mise_member_notifications
		for (const row of result.notifications) {
			await this.insertNotification(row);
		}
		// Cook sessions → D1.mise_cook_sessions + local marker
		for (const row of result.cook_sessions) {
			await this.upsertCookSession(row);
			this.upsertLocalCookMarker(row);
		}
		if (result.cook_session_marker && !result.cook_sessions.length) {
			// Eaten path: marker but no full row — update the existing row.
			await this.markCookSessionEnded(result.cook_session_marker);
		}
	}

	private async insertBriefing(row: BriefingRow): Promise<void> {
		try {
			await this.env.DB.prepare(`
				INSERT INTO mise_meal_briefings
					(briefing_id, household_id, plan_id, meal_id, kind, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).bind(
				row.briefing_id,
				row.household_id,
				row.plan_id,
				row.meal_id,
				row.kind,
				row.payload_json,
				row.created_at,
			).run();
		} catch (err) {
			console.warn(`[meal-agent] briefing insert failed (${row.kind}): ${err}`);
		}
	}

	private async insertNotification(row: NotificationRow): Promise<void> {
		try {
			await this.env.DB.prepare(`
				INSERT INTO mise_member_notifications
					(notification_id, household_id, member_id, source_agent_kind,
					 source_agent_id, kind, title, body, payload_json, created_at, acknowledged_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				row.notification_id,
				row.household_id,
				row.member_id,
				row.source_agent_kind,
				row.source_agent_id,
				row.kind,
				row.title,
				row.body,
				row.payload_json,
				row.created_at,
				null,
			).run();
		} catch (err) {
			console.warn(`[meal-agent] notification insert failed: ${err}`);
		}
	}

	private async upsertCookSession(row: CookSessionRow): Promise<void> {
		try {
			await this.env.DB.prepare(`
				INSERT INTO mise_cook_sessions
					(cook_session_id, household_id, plan_id, meal_id, state,
					 started_at, stale_at, ended_at, ended_reason, meta_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(cook_session_id) DO UPDATE SET
					state = excluded.state,
					stale_at = excluded.stale_at,
					ended_at = excluded.ended_at,
					ended_reason = excluded.ended_reason,
					meta_json = COALESCE(excluded.meta_json, meta_json)
			`).bind(
				row.cook_session_id,
				row.household_id,
				row.plan_id,
				row.meal_id,
				row.state,
				row.started_at,
				row.stale_at,
				row.ended_at,
				row.ended_reason,
				row.meta_json,
			).run();
		} catch (err) {
			console.warn(`[meal-agent] cook session upsert failed: ${err}`);
		}
	}

	private async markCookSessionEnded(marker: {
		cook_session_id: string;
		state: "started" | "stale" | "ended";
		ended_reason?: string;
	}): Promise<void> {
		try {
			await this.env.DB.prepare(`
				UPDATE mise_cook_sessions
				SET state = ?, ended_at = ?, ended_reason = ?
				WHERE cook_session_id = ?
			`).bind(
				marker.state,
				new Date().toISOString(),
				marker.ended_reason ?? null,
				marker.cook_session_id,
			).run();
		} catch (err) {
			console.warn(`[meal-agent] cook session end-mark failed: ${err}`);
		}
		// Local mirror
		this.sql`
			UPDATE cook_session_marker
			SET state = ${marker.state},
			    ended_at_ms = ${Date.now()},
			    ended_reason = ${marker.ended_reason ?? null}
			WHERE cook_session_id = ${marker.cook_session_id}
		`;
	}

	private upsertLocalCookMarker(row: CookSessionRow): void {
		const startedMs = Date.parse(row.started_at);
		this.sql`
			INSERT INTO cook_session_marker (cook_session_id, meal_id, state, started_at_ms, stale_at_ms, ended_at_ms, ended_reason)
			VALUES (
				${row.cook_session_id},
				${row.meal_id},
				${row.state},
				${Number.isFinite(startedMs) ? startedMs : Date.now()},
				${row.stale_at ? Date.parse(row.stale_at) : null},
				${row.ended_at ? Date.parse(row.ended_at) : null},
				${row.ended_reason}
			)
			ON CONFLICT(cook_session_id) DO UPDATE SET
				state = excluded.state,
				stale_at_ms = excluded.stale_at_ms,
				ended_at_ms = excluded.ended_at_ms,
				ended_reason = excluded.ended_reason
		`;
	}

	// ─── Alarm callback ──────────────────────────────────────────────────

	/**
	 * Alarm callback dispatched by the SDK when a phase alarm fires. Applies
	 * the documented transition for the current phase, or — if the agent is
	 * still in `active_cook` after the 4h stale timeout — writes a stale
	 * marker without auto-transitioning (matches the prompt).
	 */
	async onPhaseAlarm(payload?: AlarmPayload): Promise<void> {
		const target = payload?.target_phase;
		const phase = this.state.phase;

		// Active-cook stale timeout: stay in active_cook, mark stale.
		if (phase === "active_cook" && (!target || target === "eaten")) {
			await this.markActiveCookStale();
			return;
		}

		// Default: try the documented forward transition.
		const next = target || this.nextPhaseAfter(phase);
		if (next === phase) return; // no-op
		if (!isLegalTransition(MEAL_TRANSITIONS, phase, next)) {
			console.warn(`[meal-agent] alarm fired for illegal transition ${phase}→${next}; ignoring`);
			return;
		}
		await this.transitionTo(next, `alarm:${next}`, { caller_kind: "system" });
	}

	private async markActiveCookStale(): Promise<void> {
		const sid = this.state.cook_session_id;
		if (!sid) return;
		try {
			await this.env.DB.prepare(`
				UPDATE mise_cook_sessions
				SET state = 'stale', stale_at = ?
				WHERE cook_session_id = ? AND state = 'started'
			`).bind(new Date().toISOString(), sid).run();
		} catch (err) {
			console.warn(`[meal-agent] stale mark failed: ${err}`);
		}
		this.sql`
			UPDATE cook_session_marker
			SET state = 'stale', stale_at_ms = ${Date.now()}
			WHERE cook_session_id = ${sid} AND state = 'started'
		`;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function parseStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.filter(v => typeof v === "string");
	} catch { /* ignore */ }
	return [];
}

