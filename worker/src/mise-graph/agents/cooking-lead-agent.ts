// Wave 8 foundation — CookingLeadAgent.
//
// Ephemeral DO spawned at MealAgent.active_cook entry. Lives only for the
// cook session (4h max). Owns:
//   - per-phone WebSocket sessions (each member's phone is one connection)
//   - a 10s scheduler tick that consumes the meal's task graph + member
//     presence and emits per-member assignments
//   - an append-only event log written to D1.mise_brigade_events
//
// Wave 8 (this layer) ships scaffolding only. Wave 8B fills in:
//   - actual scheduler heuristic (cooking-lead-scheduler.ts TODO)
//   - photo + vision response handling
//   - recipe iteration prompts
//   - reconnect / hibernation edge cases
//
// IMPORTANT — Agent vs raw DO:
// We extend `Agent<Env, State>` from the Cloudflare Agents SDK. Under the
// hood Agent extends partyserver.Server, which already implements:
//   - hibernation-aware WS upgrade in `fetch()`  (super.fetch handles the
//     `Upgrade: websocket` branch, dispatches through onConnect/onMessage/
//     onClose)
//   - tag-filtered broadcast via `getConnections(tag?: string)`
//   - hibernation persistence of WS state via DO attachments
// Falling back to raw DurableObject would cost us all of that for no gain.
// The auth layer slots into `getConnectionTags` (called *before* onConnect)
// so a token failure can return a closed socket without firing onConnect.

import { Agent, type FiberRecoveryContext } from "agents";
import {
	beginTrace,
	completeTrace,
} from "../agent-trace";
import {
	type AgentEnv,
	generateAgentId,
	memberAgentName,
} from "./base";
import {
	type BrigadeEvent,
	type BrigadeEventKind,
	type BrigadeMessage,
	type BrigadeSchedulerInput,
	type BrigadeSchedulerOutput,
	type BrigadeStatus,
	type CookingLeadState,
	type GrantTokenResponse,
	type InFlightAssignment,
	type TaskAssignmentRow,
} from "./cooking-lead-types";
import {
	grantToken as grantTokenInD1,
	verifyAndConsumeToken,
} from "./cooking-lead-tokens";
import { tickScheduler } from "./cooking-lead-scheduler";
import { fanOutBrigadeSkillOutcome } from "./brigade-skill-fanout";
import {
	planVisionApply,
	r2BucketAsStorage,
	resolveVisionPrompt,
	serialiseVisionResult,
	storePhotoBytes,
	type PhotoStorage,
} from "./photo-handler";
import { callBridgeVision, type VisionResult } from "../bridge-vision";
import type { TaskNode } from "../task-graph-types";
import type { RecipeContext } from "./vision-prompts";

// Connection tags. We tag every brigade WS with both `member` (for
// broadcast filtering) and `member:<id>` (for targeted exclusion).
const TAG_MEMBER = "member";
const TAG_MEMBER_PREFIX = "member:";
const TAG_AUTH_FAILED = "brigade:auth_failed";

// Keys stashed on the URL of the WS request after auth — partyserver only
// gives us the request to inspect inside `getConnectionTags`. We persist
// auth result there so onConnect can pick it up without re-verifying.
const SUB_ID_AUTH_OK = "__brigade_authed";
const SUB_ID_MEMBER  = "__brigade_member_id";

const SCHEDULER_TICK_MS = 10_000;
const SESSION_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Phase 4 — fiber checkpoint snapshot for the scheduler tick. Tracks
 * whether a tick had built its input, run the heuristic, and applied
 * the resulting assignments before the worker died.
 */
export interface SchedulerTickFiberSnapshot {
	now: number;
	input?: BrigadeSchedulerInput;
	output?: BrigadeSchedulerOutput;
	applied?: boolean;
}

const INITIAL_STATE: CookingLeadState = {
	cook_session_id: "",
	meal_id: "",
	plan_id: "",
	household_id: null,
	status: "planned",
	started_at_ms: null,
	completed_at_ms: null,
	last_tick_at_ms: null,
	expected_duration_min: 0,
	task_graph_id: null,
};

interface InitBody {
	cook_session_id?: string;
	meal_id?: string;
	plan_id?: string;
	household_id?: string;
	expected_duration_min?: number;
	task_graph_id?: string;
}

interface GrantTokenBody {
	member_id?: string;
	cook_session_id?: string;
}

// ──── Wave 8B-C: Manual control body shapes ─────────────────────────────
interface ManualAssignBody {
	task_id?: string;
	member_id?: string;
	reason?: string;
}

interface ManualUnassignBody {
	task_id?: string;
	reason?: string;
}

interface ManualCompleteBody {
	task_id?: string;
	member_id?: string;
	outcome?: string;
	notes?: string;
}

interface SendMessageBody {
	member_id?: string; // omit/null/empty → broadcast to all members
	message?: string;
	correlation_id?: string;
}

interface EndSessionBody {
	outcome?: "completed" | "abandoned";
	notes?: string;
}

export class CookingLeadAgent extends Agent<AgentEnv, CookingLeadState> {
	initialState = INITIAL_STATE;

	async onStart(): Promise<void> {
		// Embedded SQLite tables. Mirror cooking-lead-agent.sql; that file
		// exists for human reference / d1 execute. The DO embedded SQLite is
		// authoritative.
		this.sql`
			CREATE TABLE IF NOT EXISTS ws_connections (
				connection_id TEXT PRIMARY KEY,
				member_id TEXT NOT NULL,
				joined_at_ms INTEGER NOT NULL,
				closed_at_ms INTEGER
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_brigade_ws_member ON ws_connections(member_id, joined_at_ms DESC)`;
		this.sql`
			CREATE TABLE IF NOT EXISTS task_assignments (
				task_id TEXT NOT NULL,
				member_id TEXT NOT NULL,
				assigned_at_ms INTEGER NOT NULL,
				started_at_ms INTEGER,
				completed_at_ms INTEGER,
				outcome TEXT,
				iteration_note TEXT,
				PRIMARY KEY (task_id, member_id)
			)
		`;
		this.sql`
			CREATE TABLE IF NOT EXISTS lead_events (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				member_id TEXT,
				payload_json TEXT NOT NULL,
				emitted_at_ms INTEGER NOT NULL
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_brigade_events_at ON lead_events(emitted_at_ms ASC)`;
		this.sql`
			CREATE TABLE IF NOT EXISTS photo_uploads (
				id TEXT PRIMARY KEY,
				member_id TEXT NOT NULL,
				task_id TEXT,
				r2_key TEXT,
				mime TEXT,
				size_bytes INTEGER,
				uploaded_at_ms INTEGER NOT NULL,
				vision_pending INTEGER NOT NULL DEFAULT 1,
				vision_response_json TEXT,
				vision_response_at_ms INTEGER,
				iteration_action TEXT,
				iteration_detail TEXT
			)
		`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_brigade_photos_at ON photo_uploads(uploaded_at_ms DESC)`;
	}

	// ─── HTTP routes (admin + token grant + status) ───────────────────────

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
			if (route === "grant-token" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as GrantTokenBody;
				return await this.handleGrantToken(body);
			}
			if (route === "status" && request.method === "GET") {
				return json({ ok: true, status: this.computeStatusSummary() });
			}
			if (route === "events" && request.method === "GET") {
				const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
				const rows = this.sql<{
					id: string; kind: string; member_id: string | null;
					payload_json: string; emitted_at_ms: number;
				}>`
					SELECT id, kind, member_id, payload_json, emitted_at_ms
					FROM lead_events
					ORDER BY emitted_at_ms DESC
					LIMIT ${limit}
				`;
				return json({ ok: true, events: rows });
			}
			if (route === "complete" && request.method === "POST") {
				return await this.handleComplete();
			}

			// ──── Wave 8B-C: Manual control surface + extended observation ────
			// Friendly aliases: `start` → init, `assign` → manual-assign,
			// `complete-task` → manual-complete-task. Accept both names.
			if ((route === "start") && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as InitBody;
				return await this.handleInit(body);
			}
			if ((route === "manual-assign" || route === "assign") && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as ManualAssignBody;
				return await this.handleManualAssign(body);
			}
			if (route === "manual-unassign" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as ManualUnassignBody;
				return await this.handleManualUnassign(body);
			}
			if ((route === "manual-complete-task" || route === "complete-task") && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as ManualCompleteBody;
				return await this.handleManualCompleteTask(body);
			}
			if (route === "send-message" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as SendMessageBody;
				return await this.handleSendMessage(body);
			}
			if (route === "pause" && request.method === "POST") {
				return await this.handlePause();
			}
			if (route === "resume" && request.method === "POST") {
				return await this.handleResume();
			}
			if (route === "end" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as EndSessionBody;
				return await this.handleEndSession(body);
			}
			if (route === "get-state" && request.method === "GET") {
				return json({ ok: true, state: this.state, brigade: this.computeBrigadeSummary() });
			}
			if (route === "event-log" && request.method === "GET") {
				const since = Number(url.searchParams.get("since") || 0);
				const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
				return json({ ok: true, events: this.readEventsSince(since, limit) });
			}

			// ──── Wave 8B Track B: Photo upload + vision pipeline ────
			//
			// Phone-facing routes — auth via short-lived `token` query param,
			// same single-use scheme as the WS upgrade. Admin callers bypass
			// the token check (the worker's admin route reaches the DO with
			// X-Spence-Admin already validated upstream).
			if (route === "upload-photo" && request.method === "POST") {
				return await this.handleUploadPhoto(request);
			}
			if (route === "photo" && request.method === "GET") {
				return await this.handlePhotoFetch(request);
			}
			if (route === "photo-analysis" && request.method === "GET") {
				return await this.handlePhotoAnalysisFetch(request);
			}
			if (route === "photos" && request.method === "GET") {
				return json({ ok: true, photos: this.listPhotoUploadRows() });
			}

			return json({ ok: false, error: `unknown route: ${route}` }, 404);
		} catch (err) {
			return json({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}, 500);
		}
	}

	private async handleInit(body: InitBody): Promise<Response> {
		const cook_session_id = (body.cook_session_id || this.state.cook_session_id || "").trim();
		const meal_id = (body.meal_id || this.state.meal_id || "").trim();
		const plan_id = (body.plan_id || this.state.plan_id || "").trim();
		if (!cook_session_id || !meal_id || !plan_id) {
			return json({
				ok: false,
				error: "cook_session_id, meal_id, and plan_id required",
			}, 400);
		}

		const trace = beginTrace({
			tool_name: "cooking_lead_agent.init",
			tool_args: { cook_session_id, meal_id, plan_id },
			caller_kind: "agent",
			caller_id: `cooking_lead:${cook_session_id}`,
			plan_id,
			household_id: body.household_id || undefined,
		});

		try {
			const now = Date.now();
			this.setState({
				...this.state,
				cook_session_id,
				meal_id,
				plan_id,
				household_id: body.household_id || this.state.household_id,
				status: "active",
				started_at_ms: this.state.started_at_ms ?? now,
				expected_duration_min: body.expected_duration_min ?? this.state.expected_duration_min,
				task_graph_id: body.task_graph_id ?? this.state.task_graph_id,
			});

			await this.recordEvent({
				kind: "session_initialized",
				member_id: null,
				payload: {
					cook_session_id,
					meal_id,
					plan_id,
					expected_duration_min: this.state.expected_duration_min,
				},
				emitted_at_ms: now,
			});

			// Schedule the first scheduler tick + the hard-stop alarm.
			await this.schedule(
				new Date(now + SCHEDULER_TICK_MS),
				"onSchedulerTick",
				{},
			);
			await this.schedule(
				new Date(now + SESSION_HARD_TIMEOUT_MS),
				"onHardTimeout",
				{},
			);

			await completeTrace(this.env, trace, {
				ok: true,
				result: { state: this.state },
				result_summary: `cooking_lead.init ${cook_session_id}`,
			});
			return json({ ok: true, state: this.state, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ ok: false, error: message }, 500);
		}
	}

	private async handleGrantToken(body: GrantTokenBody): Promise<Response> {
		const cook_session_id = body.cook_session_id || this.state.cook_session_id;
		const member_id = body.member_id;
		if (!cook_session_id || !member_id) {
			return json({ ok: false, error: "cook_session_id and member_id required" }, 400);
		}

		const trace = beginTrace({
			tool_name: "cooking_lead_agent.grant_token",
			tool_args: { cook_session_id, member_id },
			caller_kind: "agent",
			caller_id: `cooking_lead:${cook_session_id}`,
			plan_id: this.state.plan_id || undefined,
			household_id: this.state.household_id || undefined,
		});

		try {
			const grant: GrantTokenResponse = await grantTokenInD1(this.env, {
				cook_session_id,
				member_id,
			});
			await completeTrace(this.env, trace, {
				ok: true,
				result: { expires_at_ms: grant.expires_at_ms },
				result_summary: `cooking_lead.grant_token ${member_id}`,
			});
			return json({ ok: true, ...grant, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ ok: false, error: message }, 500);
		}
	}

	private async handleComplete(): Promise<Response> {
		if (this.state.status === "completed") {
			return json({ ok: true, state: this.state });
		}
		const now = Date.now();
		this.setState({
			...this.state,
			status: "completed",
			completed_at_ms: now,
		});
		await this.recordEvent({
			kind: "session_completed",
			member_id: null,
			payload: { cook_session_id: this.state.cook_session_id },
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "session_ended",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: { reason: "completed" },
		});
		return json({ ok: true, state: this.state });
	}

	// ─── Wave 8B Track B — Photo upload + vision pipeline ────────────────
	//
	// Three phone-facing routes (token-gated, member-bound):
	//
	//   POST /upload-photo?member_id=&task_id=&token=  body=<image bytes>
	//     → 200 { ok, photo_id, vision_pending: true|false, analysis? }
	//     The DO writes the bytes to R2, kicks off bridge-vision INLINE
	//     (a few seconds), then writes the analysis to embedded SQLite +
	//     emits `photo_uploaded` and `vision_response_received` events.
	//     If a recipe iteration is suggested, also broadcasts a
	//     `recipe_iteration_suggested` envelope and (for "redo") un-completes
	//     the affected assignment.
	//
	//   GET  /photo?photo_id=&token=                    → image bytes
	//   GET  /photo-analysis?photo_id=&token=           → analysis JSON
	//
	// Admin callers (via the X-Spence-Admin-gated worker route) can also
	// reach these — they bypass the token check.

	private async handleUploadPhoto(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const member_id_q = (url.searchParams.get("member_id") || "").trim();
		const task_id_q = (url.searchParams.get("task_id") || "").trim() || null;
		const token = url.searchParams.get("token");
		const cook_session_id = this.state.cook_session_id;

		if (!cook_session_id || this.state.status !== "active") {
			return json({ ok: false, error: "session not active" }, 409);
		}
		if (!member_id_q) {
			return json({ ok: false, error: "member_id required" }, 400);
		}

		// Auth: either an admin caller (X-Spence-Admin already validated by
		// the worker) or a single-use token bound to this cook_session_id +
		// member_id. The token IS consumed here — phones grant a fresh token
		// per upload, same way the WS upgrade does.
		const isAdmin = !!request.headers.get("X-Spence-Admin");
		if (!isAdmin) {
			const verify = await verifyAndConsumeToken(this.env, token, {
				expected_cook_session_id: cook_session_id,
			});
			if (!verify.ok) {
				return json({ ok: false, error: `auth_failed:${verify.reason}` }, 401);
			}
			if (verify.member_id !== member_id_q) {
				return json({ ok: false, error: "auth_failed:member_mismatch" }, 401);
			}
		}

		const photo_id = generateAgentId("ph");
		const trace = beginTrace({
			tool_name: "cooking_lead_agent.upload_photo",
			tool_args: { cook_session_id, member_id: member_id_q, task_id: task_id_q, photo_id },
			caller_kind: "agent",
			caller_id: `cooking_lead:${cook_session_id}`,
			plan_id: this.state.plan_id || undefined,
			household_id: this.state.household_id || undefined,
		});

		try {
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (bytes.byteLength === 0) {
				await completeTrace(this.env, trace, { ok: false, error: "empty body" });
				return json({ ok: false, error: "empty body" }, 400);
			}
			const mime = request.headers.get("Content-Type") || "image/jpeg";

			// Store in R2. Falls back to a no-bytes upload row when the
			// bucket isn't bound (Wave 7-only deploy / tests). The row still
			// records the upload metadata.
			const storage = this.getPhotoStorage();
			let r2_key: string | null = null;
			if (storage) {
				try {
					const stored = await storePhotoBytes(storage, {
						cook_session_id,
						photo_id,
						member_id: member_id_q,
						task_id: task_id_q,
						bytes,
						mime,
					});
					r2_key = stored.r2_key;
				} catch (err) {
					console.warn(`[cooking-lead] R2 put failed for ${photo_id}: ${err}`);
				}
			}

			const now = Date.now();
			this.sql`
				INSERT INTO photo_uploads
					(id, member_id, task_id, r2_key, mime, size_bytes, uploaded_at_ms,
					 vision_pending, vision_response_json, vision_response_at_ms,
					 iteration_action, iteration_detail)
				VALUES (${photo_id}, ${member_id_q}, ${task_id_q}, ${r2_key}, ${mime},
					${bytes.byteLength}, ${now}, 1, NULL, NULL, NULL, NULL)
			`;
			await this.recordEvent({
				kind: "photo_uploaded",
				member_id: member_id_q,
				payload: {
					id: photo_id,
					task_id: task_id_q,
					r2_key,
					mime,
					size_bytes: bytes.byteLength,
					source: "http",
				},
				emitted_at_ms: now,
			});

			// Vision call — INLINE for MVP. Errors leave the row as
			// vision_pending = 1 so an ops job can retry later.
			const visionResult = await this.runVisionAnalysis({
				bytes,
				mime,
				task_id: task_id_q,
				member_id: member_id_q,
				photo_id,
			});

			await completeTrace(this.env, trace, {
				ok: true,
				result: { photo_id, vision_ok: visionResult?.ok ?? false },
				result_summary: `cooking_lead.upload_photo ${photo_id}`,
			});
			return json({
				ok: true,
				photo_id,
				r2_key,
				vision_pending: visionResult ? false : true,
				analysis: visionResult?.analysis ?? null,
				vision_error: visionResult?.error ?? null,
				trace_id: trace.trace_id,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ ok: false, error: message }, 500);
		}
	}

	private async handlePhotoFetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const photo_id = (url.searchParams.get("photo_id") || "").trim();
		const token = url.searchParams.get("token");
		const cook_session_id = this.state.cook_session_id;
		if (!photo_id) return json({ ok: false, error: "photo_id required" }, 400);

		const isAdmin = !!request.headers.get("X-Spence-Admin");
		if (!isAdmin) {
			const verify = await verifyAndConsumeToken(this.env, token, {
				expected_cook_session_id: cook_session_id,
			});
			if (!verify.ok) return json({ ok: false, error: `auth_failed:${verify.reason}` }, 401);
		}

		const row = this.sql<{
			id: string; r2_key: string | null; mime: string | null;
		}>`
			SELECT id, r2_key, mime FROM photo_uploads WHERE id = ${photo_id} LIMIT 1
		`[0];
		if (!row) return json({ ok: false, error: "photo_not_found" }, 404);
		if (!row.r2_key) return json({ ok: false, error: "photo_bytes_missing" }, 410);

		const storage = this.getPhotoStorage();
		if (!storage) {
			return json({ ok: false, error: "BRIGADE_PHOTOS not bound" }, 503);
		}
		const blob = await storage.get(row.r2_key);
		if (!blob) return json({ ok: false, error: "r2_object_missing" }, 404);

		return new Response(blob.body, {
			status: 200,
			headers: {
				"Content-Type": blob.contentType || row.mime || "image/jpeg",
				"Cache-Control": "private, max-age=300",
			},
		});
	}

	private async handlePhotoAnalysisFetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const photo_id = (url.searchParams.get("photo_id") || "").trim();
		const token = url.searchParams.get("token");
		const cook_session_id = this.state.cook_session_id;
		if (!photo_id) return json({ ok: false, error: "photo_id required" }, 400);

		const isAdmin = !!request.headers.get("X-Spence-Admin");
		if (!isAdmin) {
			const verify = await verifyAndConsumeToken(this.env, token, {
				expected_cook_session_id: cook_session_id,
			});
			if (!verify.ok) return json({ ok: false, error: `auth_failed:${verify.reason}` }, 401);
		}

		const row = this.sql<{
			id: string;
			vision_pending: number;
			vision_response_json: string | null;
			vision_response_at_ms: number | null;
			iteration_action: string | null;
			iteration_detail: string | null;
		}>`
			SELECT id, vision_pending, vision_response_json, vision_response_at_ms,
				iteration_action, iteration_detail
			FROM photo_uploads
			WHERE id = ${photo_id}
			LIMIT 1
		`[0];
		if (!row) return json({ ok: false, error: "photo_not_found" }, 404);

		if (row.vision_pending === 1 || !row.vision_response_json) {
			return json({ ok: true, pending: true, photo_id });
		}
		let analysis: unknown = null;
		try { analysis = JSON.parse(row.vision_response_json); } catch { analysis = null; }
		return json({
			ok: true,
			pending: false,
			photo_id,
			analysis,
			analysed_at_ms: row.vision_response_at_ms,
			iteration_action: row.iteration_action,
			iteration_detail: row.iteration_detail,
		});
	}

	/**
	 * Resolve the R2 storage backend. Returns null when the binding is
	 * absent (e.g. a Wave 7-only deploy or a unit test that didn't wire
	 * it). The DO falls back to a no-bytes-stored upload row in that case.
	 */
	private getPhotoStorage(): PhotoStorage | null {
		const bucket = (this.env as { BRIGADE_PHOTOS?: R2Bucket }).BRIGADE_PHOTOS;
		if (!bucket) return null;
		return r2BucketAsStorage(bucket);
	}

	/**
	 * Bridge-vision call + result application. Fetches across the MESH
	 * binding and writes embedded SQLite. Returns the vision result (for
	 * inclusion in the upload response) or null when vision is unavailable.
	 */
	private async runVisionAnalysis(args: {
		bytes: Uint8Array;
		mime: string;
		task_id: string | null;
		member_id: string;
		photo_id: string;
	}): Promise<VisionResult | null> {
		const cook_session_id = this.state.cook_session_id;

		// Resolve task + recipe context for the prompt registry. Best-effort
		// — if the task isn't found we fall back to the free-form prompt.
		const task = args.task_id ? await this.loadTaskForVision(args.task_id) : null;
		const recipe_context = await this.loadRecipeContext();

		const promptResolved = resolveVisionPrompt({
			task,
			recipe_context,
		});

		let result: VisionResult | null = null;
		try {
			result = await callBridgeVision(this.env, {
				image_bytes: args.bytes,
				image_mime: args.mime,
				prompt: promptResolved.prompt,
			});
		} catch (err) {
			console.warn(`[cooking-lead] vision bridge threw: ${err}`);
			result = null;
		}

		if (!result) return null;

		const now = Date.now();
		const plan = planVisionApply(result.analysis);
		const visionJson = serialiseVisionResult(result);

		this.sql`
			UPDATE photo_uploads
			SET vision_pending = 0,
				vision_response_json = ${visionJson},
				vision_response_at_ms = ${now},
				iteration_action = ${plan.iteration_action},
				iteration_detail = ${plan.iteration_note}
			WHERE id = ${args.photo_id}
		`;

		await this.recordEvent({
			kind: "vision_response_received",
			member_id: args.member_id,
			payload: {
				photo_id: args.photo_id,
				task_id: args.task_id,
				ok: result.ok,
				analysis: result.analysis,
				prompt_kind: promptResolved.prompt_kind,
				cost_usd: result.cost_usd ?? null,
			},
			emitted_at_ms: now,
		});

		// Apply iteration consequences: assignment note, optional un-complete,
		// and the WS broadcast.
		if (args.task_id && plan.update_assignment_iteration && plan.iteration_note) {
			this.sql`
				UPDATE task_assignments
				SET iteration_note = ${plan.iteration_note}
				WHERE task_id = ${args.task_id} AND member_id = ${args.member_id}
			`;
		}
		if (args.task_id && plan.uncomplete_task) {
			this.sql`
				UPDATE task_assignments
				SET completed_at_ms = NULL, outcome = NULL
				WHERE task_id = ${args.task_id} AND member_id = ${args.member_id}
			`;
		}
		if (plan.broadcast_iteration && plan.iteration_action) {
			this.sendToMember(args.member_id, {
				kind: "recipe_iteration_suggested",
				emitted_at_ms: now,
				cook_session_id,
				member_id: args.member_id,
				data: {
					photo_id: args.photo_id,
					task_id: args.task_id,
					action: plan.iteration_action,
					detail: plan.iteration_note,
					iteration_suggestion: result.analysis.iteration_suggestion ?? null,
				},
			});
			await this.recordEvent({
				kind: "recipe_iteration_suggested",
				member_id: args.member_id,
				payload: {
					photo_id: args.photo_id,
					task_id: args.task_id,
					action: plan.iteration_action,
					detail: plan.iteration_note,
				},
				emitted_at_ms: now,
			});
		}
		// Always inform the uploader that analysis is ready — even when no
		// iteration was needed. Wave 8C+ may convert this to a dedicated
		// `photo_analyzed` envelope kind; for MVP we ride lead_message.
		if (plan.broadcast_photo_analyzed) {
			this.sendToMember(args.member_id, {
				kind: "lead_message",
				emitted_at_ms: now,
				cook_session_id,
				member_id: args.member_id,
				data: {
					event: "photo_analyzed",
					photo_id: args.photo_id,
					task_id: args.task_id,
					on_track: result.analysis.on_track,
					observed: result.analysis.observed,
					concerns: result.analysis.concerns,
				},
			});
		}

		return result;
	}

	/**
	 * Load a TaskNode from D1.mise_task_graphs for prompt resolution.
	 * Best-effort — if the task graph isn't found or the task_id doesn't
	 * exist in it, we return null and the prompt falls back to free-form.
	 */
	private async loadTaskForVision(task_id: string): Promise<TaskNode | null> {
		try {
			const graphRow = await this.env.DB.prepare(
				`SELECT tasks_json FROM mise_task_graphs WHERE meal_id = ? LIMIT 1`,
			).bind(this.state.meal_id).first<{ tasks_json: string }>();
			if (!graphRow?.tasks_json) return null;
			const tasks = JSON.parse(graphRow.tasks_json) as TaskNode[];
			return tasks.find(t => t.id === task_id) ?? null;
		} catch (err) {
			console.warn(`[cooking-lead] loadTaskForVision failed: ${err}`);
			return null;
		}
	}

	/**
	 * Resolve the recipe context (title) for prompt personalisation. We
	 * pull from personal_recipes by recipe_id stamped into the task graph
	 * row. Returns null when missing — callers fall back to free-form.
	 */
	private async loadRecipeContext(): Promise<RecipeContext | null> {
		try {
			const graphRow = await this.env.DB.prepare(
				`SELECT recipe_id FROM mise_task_graphs WHERE meal_id = ? LIMIT 1`,
			).bind(this.state.meal_id).first<{ recipe_id: string }>();
			if (!graphRow?.recipe_id) return null;
			const recipeRow = await this.env.DB.prepare(
				`SELECT id, normalized_title, original_title
				 FROM personal_recipes WHERE id = ? LIMIT 1`,
			).bind(graphRow.recipe_id).first<{
				id: string;
				normalized_title: string | null;
				original_title: string | null;
			}>();
			if (!recipeRow) return null;
			const title = recipeRow.normalized_title || recipeRow.original_title || "this dish";
			return { title };
		} catch (err) {
			console.warn(`[cooking-lead] loadRecipeContext failed: ${err}`);
			return null;
		}
	}

	private listPhotoUploadRows(): Array<{
		id: string; member_id: string; task_id: string | null;
		r2_key: string | null; mime: string | null; size_bytes: number | null;
		uploaded_at_ms: number; vision_pending: number;
		vision_response_at_ms: number | null;
		iteration_action: string | null; iteration_detail: string | null;
	}> {
		return this.sql`
			SELECT id, member_id, task_id, r2_key, mime, size_bytes, uploaded_at_ms,
				vision_pending, vision_response_at_ms,
				iteration_action, iteration_detail
			FROM photo_uploads
			ORDER BY uploaded_at_ms DESC
		`;
	}

	// ─── WebSocket auth (in getConnectionTags) ───────────────────────────
	//
	// partyserver calls `getConnectionTags(connection, ctx)` *before*
	// `onConnect`. We use it as the auth choke point: if the token
	// verification fails, we tag the connection AUTH_FAILED so onConnect
	// can immediately close it. Tags survive hibernation, so the close
	// reason is preserved.

	override async getConnectionTags(
		connection: { id: string },
		ctx: { request: Request },
	): Promise<string[]> {
		const url = new URL(ctx.request.url);
		const token = url.searchParams.get("token");
		const claimed_session = this.state.cook_session_id || "";

		const result = await verifyAndConsumeToken(this.env, token, {
			expected_cook_session_id: claimed_session || undefined,
		});

		if (!result.ok) {
			console.warn(
				`[cooking-lead] auth failed for connection ${connection.id}: ${result.reason}`,
			);
			return [TAG_AUTH_FAILED, `reason:${result.reason}`];
		}

		// Stash the verified member id on the URL so onConnect picks it up.
		// We do this via the `connection` (Connection has setState), but
		// connection.setState comes available in onConnect. Instead, we set
		// a side-channel via the request URL hash, captured into a Map.
		this.pendingAuth.set(connection.id, {
			member_id: result.member_id,
			cook_session_id: result.cook_session_id,
		});

		return [TAG_MEMBER, `${TAG_MEMBER_PREFIX}${result.member_id}`];
	}

	private pendingAuth = new Map<string, { member_id: string; cook_session_id: string }>();

	override async onConnect(
		connection: { id: string; tags: readonly string[]; close: (code?: number, reason?: string) => void; send: (msg: string) => void },
		_ctx: { request: Request },
	): Promise<void> {
		// Reject failed-auth connections immediately.
		if (connection.tags.includes(TAG_AUTH_FAILED)) {
			connection.close(4401, "unauthorized");
			this.pendingAuth.delete(connection.id);
			return;
		}

		// Pull verified member from the pending-auth side channel; fall back
		// to scanning tags (covers the post-hibernation reconnect path).
		const pending = this.pendingAuth.get(connection.id);
		const member_id = pending?.member_id || this.memberIdFromTags(connection.tags);
		this.pendingAuth.delete(connection.id);
		if (!member_id) {
			connection.close(4401, "missing_member");
			return;
		}

		const now = Date.now();
		this.sql`
			INSERT OR REPLACE INTO ws_connections
				(connection_id, member_id, joined_at_ms, closed_at_ms)
			VALUES (${connection.id}, ${member_id}, ${now}, NULL)
		`;

		await this.recordEvent({
			kind: "member_joined",
			member_id,
			payload: { connection_id: connection.id },
			emitted_at_ms: now,
		});

		try {
			connection.send(JSON.stringify({
				kind: "welcome",
				emitted_at_ms: now,
				cook_session_id: this.state.cook_session_id,
				member_id,
				data: {
					meal_id: this.state.meal_id,
					plan_id: this.state.plan_id,
					expected_duration_min: this.state.expected_duration_min,
				},
			} satisfies BrigadeMessage));
		} catch (err) {
			console.warn(`[cooking-lead] welcome send failed: ${err}`);
		}
	}

	override async onMessage(
		connection: { id: string; tags: readonly string[]; send: (msg: string) => void },
		message: string | ArrayBuffer | ArrayBufferView,
	): Promise<void> {
		const member_id = this.memberIdFromTags(connection.tags);
		if (!member_id) return;

		let parsed: { kind?: string; data?: Record<string, unknown> } = {};
		try {
			const text = typeof message === "string"
				? message
				: new TextDecoder().decode(message as ArrayBuffer);
			parsed = JSON.parse(text);
		} catch {
			// Ignore non-JSON frames in the foundation; Wave 8B can add binary
			// photo upload streaming.
			return;
		}

		const now = Date.now();
		const kind = parsed.kind || "ping";

		// Dispatch inbound message kinds. The Wave 8 foundation locked the
		// short list (ping/hello/presence_update/task_started/task_completed/
		// task_help_requested/photo_uploaded); Wave 8B-C extends with the
		// brigade-mode kinds (ack_task / complete_task / request_help /
		// decline_task / iteration_response). Foundation kinds remain wire-
		// compatible with older clients.
		switch (kind) {
			case "ping":
				// Wave 8B-C: respond with pong so phones can detect dead sockets.
				await this.handlePing(connection, member_id, now);
				return;
			case "hello":
				await this.recordEvent({
					kind: "member_joined", // re-announce, idempotent
					member_id,
					payload: parsed.data || {},
					emitted_at_ms: now,
				});
				return;
			case "presence_update":
				// Wave 8B-C: forward to MemberAgent.ping-presence so the global
				// presence cache stays in sync.
				await this.handlePresenceUpdate(parsed.data, member_id, now);
				return;
			case "task_started":
				await this.recordTaskStarted(parsed.data, member_id, now);
				return;
			case "task_completed":
				await this.recordTaskCompleted(parsed.data, member_id, now);
				return;
			case "task_help_requested":
				await this.recordEvent({
					kind: "task_help_requested",
					member_id,
					payload: parsed.data || {},
					emitted_at_ms: now,
				});
				return;
			case "photo_uploaded":
				await this.recordPhotoUploaded(parsed.data, member_id, now);
				return;
			// ──── Wave 8B-C: brigade-mode WS kinds ──────────────────────
			case "ack_task":
				await this.handleAckTask(parsed.data, member_id, now);
				return;
			case "complete_task":
				await this.handleCompleteTaskMsg(parsed.data, member_id, now);
				return;
			case "request_help":
				await this.handleRequestHelp(parsed.data, member_id, now);
				return;
			case "decline_task":
				await this.handleDeclineTask(parsed.data, member_id, now);
				return;
			case "iteration_response":
				await this.handleIterationResponse(parsed.data, member_id, now);
				return;
			default:
				console.warn(`[cooking-lead] unhandled message kind: ${kind}`);
		}
	}

	override async onClose(
		connection: { id: string; tags: readonly string[] },
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> {
		const member_id = this.memberIdFromTags(connection.tags);
		const now = Date.now();
		this.sql`
			UPDATE ws_connections
			SET closed_at_ms = ${now}
			WHERE connection_id = ${connection.id}
		`;
		await this.recordEvent({
			kind: "member_left",
			member_id: member_id || null,
			payload: { connection_id: connection.id, code, reason, wasClean },
			emitted_at_ms: now,
		});
	}

	private memberIdFromTags(tags: readonly string[]): string | null {
		for (const t of tags) {
			if (t.startsWith(TAG_MEMBER_PREFIX)) {
				return t.slice(TAG_MEMBER_PREFIX.length);
			}
		}
		return null;
	}

	// ─── Scheduler tick (alarm-driven) ───────────────────────────────────

	async onSchedulerTick(): Promise<void> {
		if (this.state.status !== "active") return;
		// Phase 4 — wrap each scheduler tick in a Fiber so a worker death
		// mid-tick doesn't leave half-applied assignments. Stash schedule:
		//   1. After buildSchedulerInput → `{ now, input }`
		//   2. After tickScheduler        → `{ now, input, output }`
		//   3. After applySchedulerOutput → `{ now, input, output, applied: true }`
		// Recovery: replay applySchedulerOutput (idempotent on PK).
		try {
			await this.runFiber("scheduler_tick", async (fiberCtx) => {
				await this.runSchedulerTickFiber(fiberCtx);
			});
		} catch (err) {
			console.warn(`[cooking-lead-agent] scheduler_tick fiber failed:`, err);
			// Even on failure, re-arm the next tick so the cadence survives.
			await this.schedule(
				new Date(Date.now() + SCHEDULER_TICK_MS),
				"onSchedulerTick",
				{},
			);
		}
	}

	/**
	 * Phase 4 — fiber body for `onSchedulerTick`. Lifts the build/decide/
	 * apply path so it's checkpointable and recoverable.
	 */
	private async runSchedulerTickFiber(
		ctx: { stash(d: unknown): void; snapshot: unknown | null },
	): Promise<void> {
		const snap = (ctx.snapshot ?? {}) as Partial<SchedulerTickFiberSnapshot>;
		const now = snap.now ?? Date.now();
		this.setState({ ...this.state, last_tick_at_ms: now });

		// Wave 8B-C: manual pause short-circuits.
		if (this.state.paused) {
			await this.recordEvent({
				kind: "scheduler_tick",
				member_id: null,
				payload: { paused: true, reason: this.state.last_pause_reason || null },
				emitted_at_ms: now,
			});
			await this.schedule(
				new Date(now + SCHEDULER_TICK_MS),
				"onSchedulerTick",
				{},
			);
			return;
		}

		const input: BrigadeSchedulerInput = snap.input ?? (await this.buildSchedulerInput(now));
		ctx.stash({ now, input } satisfies SchedulerTickFiberSnapshot);

		const output: BrigadeSchedulerOutput = snap.output ?? tickScheduler(input);
		ctx.stash({ now, input, output } satisfies SchedulerTickFiberSnapshot);

		if (!snap.applied) {
			await this.applySchedulerOutput(now, output);
		}
		ctx.stash({ now, input, output, applied: true } satisfies SchedulerTickFiberSnapshot);

		// Reschedule the next tick.
		await this.schedule(
			new Date(now + SCHEDULER_TICK_MS),
			"onSchedulerTick",
			{},
		);
	}

	private async buildSchedulerInput(now: number): Promise<BrigadeSchedulerInput> {
		const completed_task_ids = this.readCompletedTaskIds();
		return {
			graph: {
				recipe_id: "",
				meal_id: this.state.meal_id,
				tasks: [],
				critical_path_min: 0,
				total_active_min: 0,
				total_passive_min: 0,
				parallelism_max: 0,
			},
			members: [],
			completed_task_ids,
			in_flight_assignments: this.readInFlightAssignments(),
			now_ms: now,
			current_equipment_claims: await this.readCurrentEquipmentClaims(now),
			recently_completed: this.readRecentlyCompleted(now),
			member_completed_dag_neighbors: this.readMemberCompletedTaskMap(),
		};
	}

	private async applySchedulerOutput(
		now: number,
		decision: BrigadeSchedulerOutput,
	): Promise<void> {
		await this.recordEvent({
			kind: "scheduler_tick",
			member_id: null,
			payload: {
				new_assignments: decision.new_assignments,
				ready_for_completion_check: decision.ready_for_completion_check,
				notes: decision.notes,
			},
			emitted_at_ms: now,
		});

		for (const assignment of decision.new_assignments) {
			this.sql`
				INSERT OR REPLACE INTO task_assignments
					(task_id, member_id, assigned_at_ms, started_at_ms, completed_at_ms, outcome)
				VALUES (${assignment.task_id}, ${assignment.member_id}, ${now}, NULL, NULL, NULL)
			`;
			this.sendToMember(assignment.member_id, {
				kind: "task_assigned",
				emitted_at_ms: now,
				cook_session_id: this.state.cook_session_id,
				member_id: assignment.member_id,
				data: { task_id: assignment.task_id, reason: assignment.reason },
			});
			await this.recordEvent({
				kind: "task_assigned",
				member_id: assignment.member_id,
				payload: { task_id: assignment.task_id, reason: assignment.reason },
				emitted_at_ms: now,
			});
		}
	}

	async onHardTimeout(): Promise<void> {
		if (this.state.status !== "active") return;
		const now = Date.now();
		this.setState({
			...this.state,
			status: "abandoned",
			completed_at_ms: now,
		});
		await this.recordEvent({
			kind: "session_abandoned",
			member_id: null,
			payload: { cook_session_id: this.state.cook_session_id, reason: "hard_timeout_4h" },
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "session_ended",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: { reason: "hard_timeout_4h" },
		});
	}

	// ─── Inbound message handlers ────────────────────────────────────────

	private async recordTaskStarted(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : "";
		if (!task_id) return;
		this.sql`
			UPDATE task_assignments
			SET started_at_ms = ${now}
			WHERE task_id = ${task_id} AND member_id = ${member_id}
		`;
		await this.recordEvent({
			kind: "task_started",
			member_id,
			payload: { task_id },
			emitted_at_ms: now,
		});
	}

	private async recordTaskCompleted(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : "";
		if (!task_id) return;
		const outcome = typeof data?.outcome === "string" ? data.outcome : "succeeded";
		this.sql`
			UPDATE task_assignments
			SET completed_at_ms = ${now}, outcome = ${outcome}
			WHERE task_id = ${task_id} AND member_id = ${member_id}
		`;
		await this.recordEvent({
			kind: "task_completed",
			member_id,
			payload: { task_id, outcome },
			emitted_at_ms: now,
		});
	}

	/**
	 * Inbound WS `photo_uploaded` notification — the phone tells us a photo
	 * is up. The actual bytes arrive via the HTTP /upload-photo route; this
	 * is a heads-up envelope when the phone wants to associate metadata with
	 * an already-uploaded blob (rare path). The HTTP route is the canonical
	 * upload entry point and writes the row itself.
	 */
	private async recordPhotoUploaded(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const id = generateAgentId("ph");
		const task_id = typeof data?.task_id === "string" ? data.task_id : null;
		const r2_key = typeof data?.r2_key === "string" ? data.r2_key : null;
		const mime = typeof data?.mime === "string" ? data.mime : null;
		this.sql`
			INSERT INTO photo_uploads
				(id, member_id, task_id, r2_key, mime, size_bytes, uploaded_at_ms,
				 vision_pending, vision_response_json, vision_response_at_ms,
				 iteration_action, iteration_detail)
			VALUES (${id}, ${member_id}, ${task_id}, ${r2_key}, ${mime}, NULL,
				${now}, 1, NULL, NULL, NULL, NULL)
		`;
		await this.recordEvent({
			kind: "photo_uploaded",
			member_id,
			payload: { id, task_id, r2_key, source: "ws" },
			emitted_at_ms: now,
		});
	}

	// ─── Broadcast helpers ───────────────────────────────────────────────

	private broadcastBrigade(message: BrigadeMessage, excludeMemberIds: string[] = []): void {
		const payload = JSON.stringify(message);
		try {
			for (const conn of this.getConnections(TAG_MEMBER)) {
				if (excludeMemberIds.length) {
					const mid = this.memberIdFromTags(conn.tags);
					if (mid && excludeMemberIds.includes(mid)) continue;
				}
				try {
					conn.send(payload);
				} catch (err) {
					console.warn(`[cooking-lead] send failed for ${conn.id}: ${err}`);
				}
			}
		} catch (err) {
			console.warn(`[cooking-lead] broadcast failed: ${err}`);
		}
	}

	private sendToMember(member_id: string, message: BrigadeMessage): void {
		const payload = JSON.stringify(message);
		try {
			for (const conn of this.getConnections(`${TAG_MEMBER_PREFIX}${member_id}`)) {
				try {
					conn.send(payload);
				} catch (err) {
					console.warn(`[cooking-lead] send-to-member failed for ${conn.id}: ${err}`);
				}
			}
		} catch (err) {
			console.warn(`[cooking-lead] send-to-member iter failed: ${err}`);
		}
	}

	// ─── Persistence helpers ─────────────────────────────────────────────

	private async recordEvent(args: {
		kind: BrigadeEventKind;
		member_id: string | null;
		payload: Record<string, unknown>;
		emitted_at_ms: number;
	}): Promise<void> {
		const id = generateAgentId("ev");
		const payloadJson = JSON.stringify(args.payload);
		// Local — embedded SQLite mirror.
		this.sql`
			INSERT INTO lead_events (id, kind, member_id, payload_json, emitted_at_ms)
			VALUES (${id}, ${args.kind}, ${args.member_id}, ${payloadJson}, ${args.emitted_at_ms})
		`;
		// Durable — D1.mise_brigade_events. Best-effort — never throws.
		try {
			await this.env.DB.prepare(`
				INSERT INTO mise_brigade_events
					(id, cook_session_id, kind, member_id, payload_json, emitted_at_ms)
				VALUES (?, ?, ?, ?, ?, ?)
			`).bind(
				id,
				this.state.cook_session_id,
				args.kind,
				args.member_id,
				payloadJson,
				args.emitted_at_ms,
			).run();
		} catch (err) {
			console.warn(`[cooking-lead] event D1 insert failed (${args.kind}): ${err}`);
		}
	}

	private readInFlightAssignments(): InFlightAssignment[] {
		const rows = this.sql<{
			task_id: string;
			member_id: string;
			assigned_at_ms: number;
			started_at_ms: number | null;
		}>`
			SELECT task_id, member_id, assigned_at_ms, started_at_ms
			FROM task_assignments
			WHERE completed_at_ms IS NULL
			ORDER BY assigned_at_ms ASC
		`;
		return rows.map(r => ({
			task_id: r.task_id,
			member_id: r.member_id,
			assigned_at_ms: r.assigned_at_ms,
			started_at_ms: r.started_at_ms,
		}));
	}

	// ─── Wave 8B Track A — scheduler input hydration ─────────────────────
	//
	// All of these are best-effort reads. If a query fails, return empty —
	// the scheduler treats every additive field as optional and degrades
	// gracefully to the skill-fit-only path.

	private readCompletedTaskIds(): Set<string> {
		try {
			const rows = this.sql<{ task_id: string }>`
				SELECT DISTINCT task_id FROM task_assignments
				WHERE completed_at_ms IS NOT NULL
			`;
			return new Set(rows.map(r => r.task_id));
		} catch {
			return new Set();
		}
	}

	private readRecentlyCompleted(now_ms: number): Array<{
		task_id: string;
		member_id: string;
		completed_at_ms: number;
	}> {
		try {
			const cutoff = now_ms - 60_000; // 60s window covers churn (30s) + slack
			const rows = this.sql<{
				task_id: string;
				member_id: string;
				completed_at_ms: number;
			}>`
				SELECT task_id, member_id, completed_at_ms
				FROM task_assignments
				WHERE completed_at_ms IS NOT NULL
				  AND completed_at_ms >= ${cutoff}
			`;
			return rows.map(r => ({
				task_id: r.task_id,
				member_id: r.member_id,
				completed_at_ms: r.completed_at_ms,
			}));
		} catch {
			return [];
		}
	}

	private readMemberCompletedTaskMap(): Map<string, Set<string>> {
		const out = new Map<string, Set<string>>();
		try {
			const rows = this.sql<{ task_id: string; member_id: string }>`
				SELECT task_id, member_id FROM task_assignments
				WHERE completed_at_ms IS NOT NULL
			`;
			for (const r of rows) {
				const set = out.get(r.member_id) ?? new Set<string>();
				set.add(r.task_id);
				out.set(r.member_id, set);
			}
		} catch {
			/* swallow — degrade to no DAG-affinity bonus */
		}
		return out;
	}

	private async readCurrentEquipmentClaims(now_ms: number): Promise<Array<{
		slug: string;
		start_ts: number;
		end_ts: number;
		claim_for_id: string;
	}>> {
		const cook_session_id = this.state.cook_session_id;
		const meal_id = this.state.meal_id;
		if (!cook_session_id && !meal_id) return [];
		try {
			// Pull every active claim for either THIS cook_session OR the meal
			// it's covering. The scheduler ignores claims belonging to another
			// session entirely (no slug overlap → no conflict), so it's safe to
			// also include claims for the meal_id (those are "ours" too).
			const rows = await this.env.DB.prepare(`
				SELECT equipment_slug AS slug, start_ts, end_ts, claim_for_id
				FROM mise_equipment_claims
				WHERE status = 'held'
				  AND end_ts > ?
				  AND (claim_for_id = ? OR claim_for_id = ?)
			`).bind(now_ms, cook_session_id || "", meal_id || "")
				.all<{ slug: string; start_ts: number; end_ts: number; claim_for_id: string }>();
			return (rows.results ?? []).map(r => ({
				slug: r.slug,
				start_ts: r.start_ts,
				end_ts: r.end_ts,
				claim_for_id: r.claim_for_id,
			}));
		} catch (err) {
			console.warn(`[cooking-lead] readCurrentEquipmentClaims failed: ${err}`);
			return [];
		}
	}

	private computeStatusSummary(): {
		status: BrigadeStatus;
		started_at_ms: number | null;
		completed_at_ms: number | null;
		connected_member_count: number;
		assignments: TaskAssignmentRow[];
	} {
		const assignments = this.sql<TaskAssignmentRow>`
			SELECT task_id, member_id, assigned_at_ms, started_at_ms, completed_at_ms, outcome
			FROM task_assignments
			ORDER BY assigned_at_ms ASC
		`;
		let connectedCount = 0;
		try {
			for (const _conn of this.getConnections(TAG_MEMBER)) connectedCount++;
		} catch {
			connectedCount = 0;
		}
		return {
			status: this.state.status,
			started_at_ms: this.state.started_at_ms,
			completed_at_ms: this.state.completed_at_ms,
			connected_member_count: connectedCount,
			assignments,
		};
	}

	// ──── Wave 8B-C: Manual control + WS dispatch ────────────────────────
	//
	// All methods below are append-only — they coexist with the foundation
	// HTTP routes (init/state/grant-token/status/events/complete) and the
	// foundation WS dispatch. They add the brigade-mode manual surface +
	// extended WS message kinds.

	// ── HTTP: manual scheduler override ───────────────────────────────

	private async handleManualAssign(body: ManualAssignBody): Promise<Response> {
		const task_id = (body.task_id || "").trim();
		const member_id = (body.member_id || "").trim();
		if (!task_id || !member_id) {
			return json({ ok: false, error: "task_id and member_id required" }, 400);
		}
		const trace = beginTrace({
			tool_name: "cooking_lead_agent.manual_assign",
			tool_args: { task_id, member_id, reason: body.reason },
			caller_kind: "agent",
			caller_id: `cooking_lead:${this.state.cook_session_id}`,
			plan_id: this.state.plan_id || undefined,
			household_id: this.state.household_id || undefined,
		});
		try {
			const now = Date.now();
			this.sql`
				INSERT OR REPLACE INTO task_assignments
					(task_id, member_id, assigned_at_ms, started_at_ms, completed_at_ms, outcome)
				VALUES (${task_id}, ${member_id}, ${now}, NULL, NULL, NULL)
			`;
			const reason = body.reason || "manual_override";
			this.sendToMember(member_id, {
				kind: "task_assigned",
				emitted_at_ms: now,
				cook_session_id: this.state.cook_session_id,
				member_id,
				data: { task_id, reason, manual: true },
			});
			await this.recordEvent({
				kind: "task_assigned",
				member_id,
				payload: { task_id, reason, manual: true },
				emitted_at_ms: now,
			});
			await completeTrace(this.env, trace, {
				ok: true,
				result: { task_id, member_id },
				result_summary: `manual_assign ${task_id} -> ${member_id}`,
			});
			return json({ ok: true, task_id, member_id, assigned_at_ms: now, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ ok: false, error: message }, 500);
		}
	}

	private async handleManualUnassign(body: ManualUnassignBody): Promise<Response> {
		const task_id = (body.task_id || "").trim();
		if (!task_id) return json({ ok: false, error: "task_id required" }, 400);
		const trace = beginTrace({
			tool_name: "cooking_lead_agent.manual_unassign",
			tool_args: { task_id, reason: body.reason },
			caller_kind: "agent",
			caller_id: `cooking_lead:${this.state.cook_session_id}`,
			plan_id: this.state.plan_id || undefined,
			household_id: this.state.household_id || undefined,
		});
		try {
			const now = Date.now();
			const rows = this.sql<{ task_id: string; member_id: string }>`
				SELECT task_id, member_id FROM task_assignments
				WHERE task_id = ${task_id} AND completed_at_ms IS NULL
			`;
			for (const r of rows) {
				this.sql`
					UPDATE task_assignments
					SET completed_at_ms = ${now}, outcome = 'reassigned'
					WHERE task_id = ${r.task_id} AND member_id = ${r.member_id}
				`;
				this.sendToMember(r.member_id, {
					kind: "task_unassigned",
					emitted_at_ms: now,
					cook_session_id: this.state.cook_session_id,
					member_id: r.member_id,
					data: { task_id, reason: body.reason || "manual_unassign" },
				});
				await this.recordEvent({
					kind: "task_unassigned",
					member_id: r.member_id,
					payload: { task_id, reason: body.reason || "manual_unassign" },
					emitted_at_ms: now,
				});
			}
			await completeTrace(this.env, trace, {
				ok: true,
				result: { task_id, freed: rows.length },
				result_summary: `manual_unassign ${task_id} (freed ${rows.length})`,
			});
			return json({ ok: true, task_id, freed: rows.length, trace_id: trace.trace_id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await completeTrace(this.env, trace, { ok: false, error: message });
			return json({ ok: false, error: message }, 500);
		}
	}

	private async handleManualCompleteTask(body: ManualCompleteBody): Promise<Response> {
		const task_id = (body.task_id || "").trim();
		if (!task_id) return json({ ok: false, error: "task_id required" }, 400);
		const member_id = (body.member_id || "").trim() || null;
		const outcome = (body.outcome || "succeeded").trim();
		const now = Date.now();
		if (member_id) {
			this.sql`
				UPDATE task_assignments
				SET completed_at_ms = ${now}, outcome = ${outcome}
				WHERE task_id = ${task_id} AND member_id = ${member_id}
			`;
		} else {
			this.sql`
				UPDATE task_assignments
				SET completed_at_ms = ${now}, outcome = ${outcome}
				WHERE task_id = ${task_id} AND completed_at_ms IS NULL
			`;
		}
		await this.recordEvent({
			kind: "task_completed",
			member_id,
			payload: {
				task_id,
				outcome,
				notes: body.notes || null,
				marked_by: "lead",
			},
			emitted_at_ms: now,
		});
		if (member_id && this.state.household_id) {
			await this.fanOutSkillOutcome(member_id, task_id, outcome, body.notes || null);
		}
		return json({ ok: true, task_id, member_id, outcome, completed_at_ms: now });
	}

	private async handleSendMessage(body: SendMessageBody): Promise<Response> {
		const text = (body.message || "").trim();
		if (!text) return json({ ok: false, error: "message required" }, 400);
		const now = Date.now();
		const target_member = (body.member_id || "").trim() || null;
		const envelope: BrigadeMessage = {
			kind: "lead_message",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			member_id: target_member || undefined,
			correlation_id: body.correlation_id,
			data: { message: text },
		};
		if (target_member) {
			this.sendToMember(target_member, envelope);
		} else {
			this.broadcastBrigade(envelope);
		}
		await this.recordEvent({
			kind: "phase_progress",
			member_id: target_member,
			payload: { lead_message: text, broadcast: !target_member },
			emitted_at_ms: now,
		});
		return json({ ok: true, sent_to: target_member || "broadcast", at_ms: now });
	}

	private async handlePause(): Promise<Response> {
		if (this.state.paused) return json({ ok: true, paused: true, already: true });
		const now = Date.now();
		this.setState({
			...this.state,
			paused: true,
			paused_at_ms: now,
			last_pause_reason: "manual_pause",
		});
		await this.recordEvent({
			kind: "phase_progress",
			member_id: null,
			payload: { paused: true, at_ms: now },
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "lead_message",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: { message: "Brigade paused.", control: "pause" },
		});
		return json({ ok: true, paused: true, at_ms: now });
	}

	private async handleResume(): Promise<Response> {
		if (!this.state.paused) return json({ ok: true, paused: false, already: true });
		const now = Date.now();
		this.setState({
			...this.state,
			paused: false,
			paused_at_ms: null,
			last_pause_reason: null,
		});
		await this.recordEvent({
			kind: "phase_progress",
			member_id: null,
			payload: { paused: false, at_ms: now },
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "lead_message",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: { message: "Brigade resumed.", control: "resume" },
		});
		return json({ ok: true, paused: false, at_ms: now });
	}

	private async handleEndSession(body: EndSessionBody): Promise<Response> {
		if (this.state.status === "completed" || this.state.status === "abandoned") {
			return json({ ok: true, state: this.state, already: true });
		}
		const outcome = body.outcome === "abandoned" ? "abandoned" : "completed";
		const now = Date.now();
		this.setState({
			...this.state,
			status: outcome,
			completed_at_ms: now,
		});
		await this.recordEvent({
			kind: outcome === "completed" ? "session_completed" : "session_abandoned",
			member_id: null,
			payload: {
				cook_session_id: this.state.cook_session_id,
				notes: body.notes || null,
				ended_by: "lead",
			},
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "session_ended",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: { reason: outcome, notes: body.notes || null },
		});
		return json({ ok: true, state: this.state, outcome, at_ms: now });
	}

	// ── Read helpers ──────────────────────────────────────────────────

	private computeBrigadeSummary(): {
		paused: boolean;
		connected_member_count: number;
		connected_member_ids: string[];
		in_flight_assignments: TaskAssignmentRow[];
		completed_count: number;
		total_assignments: number;
		expected_completion_at_ms: number | null;
	} {
		const allAssignments = this.sql<TaskAssignmentRow>`
			SELECT task_id, member_id, assigned_at_ms, started_at_ms, completed_at_ms, outcome
			FROM task_assignments
			ORDER BY assigned_at_ms ASC
		`;
		const inFlight = allAssignments.filter(a => a.completed_at_ms === null);
		const completed = allAssignments.filter(a => a.completed_at_ms !== null);
		const ids = new Set<string>();
		try {
			for (const conn of this.getConnections(TAG_MEMBER)) {
				const mid = this.memberIdFromTags(conn.tags);
				if (mid) ids.add(mid);
			}
		} catch { /* hibernation safe */ }
		const expected_completion_at_ms = (this.state.started_at_ms && this.state.expected_duration_min)
			? this.state.started_at_ms + this.state.expected_duration_min * 60_000
			: null;
		return {
			paused: !!this.state.paused,
			connected_member_count: ids.size,
			connected_member_ids: Array.from(ids).sort(),
			in_flight_assignments: inFlight,
			completed_count: completed.length,
			total_assignments: allAssignments.length,
			expected_completion_at_ms,
		};
	}

	private readEventsSince(since_ms: number, limit: number): Array<{
		id: string; kind: string; member_id: string | null;
		payload: Record<string, unknown>; emitted_at_ms: number;
	}> {
		const rows = this.sql<{
			id: string; kind: string; member_id: string | null;
			payload_json: string; emitted_at_ms: number;
		}>`
			SELECT id, kind, member_id, payload_json, emitted_at_ms
			FROM lead_events
			WHERE emitted_at_ms > ${since_ms}
			ORDER BY emitted_at_ms ASC
			LIMIT ${limit}
		`;
		return rows.map(r => ({
			id: r.id,
			kind: r.kind,
			member_id: r.member_id,
			payload: safeParse(r.payload_json),
			emitted_at_ms: r.emitted_at_ms,
		}));
	}

	// ── WS handlers (Wave 8B-C extensions) ────────────────────────────

	private async handlePing(
		connection: { send: (msg: string) => void },
		member_id: string,
		now: number,
	): Promise<void> {
		try {
			connection.send(JSON.stringify({
				kind: "pong",
				emitted_at_ms: now,
				cook_session_id: this.state.cook_session_id,
				member_id,
			}));
		} catch (err) {
			console.warn(`[cooking-lead] pong send failed: ${err}`);
		}
	}

	private async handlePresenceUpdate(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const state = typeof data?.state === "string" ? data.state : "in_kitchen_idle";
		await this.recordEvent({
			kind: "phase_progress",
			member_id,
			payload: { presence: state },
			emitted_at_ms: now,
		});
		const ns = (this.env as { MEMBER_AGENT?: DurableObjectNamespace }).MEMBER_AGENT;
		if (!ns || !this.state.household_id) return;
		try {
			const stub = ns.get(ns.idFromName(memberAgentName(this.state.household_id, member_id)));
			await stub.fetch(new Request("https://agent/internal/ping-presence", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					state,
					current_session_id: this.state.cook_session_id,
				}),
			}));
		} catch (err) {
			console.warn(`[cooking-lead] presence forward failed: ${err}`);
		}
	}

	private async handleAckTask(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : "";
		if (!task_id) return;
		this.sql`
			UPDATE task_assignments
			SET started_at_ms = ${now}
			WHERE task_id = ${task_id} AND member_id = ${member_id}
		`;
		await this.recordEvent({
			kind: "task_started",
			member_id,
			payload: { task_id, ack: true },
			emitted_at_ms: now,
		});
	}

	private async handleCompleteTaskMsg(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : "";
		if (!task_id) return;
		const outcomeRaw = typeof data?.outcome === "string" ? data.outcome : "success";
		const outcome = ["success", "partial", "retry", "failure"].includes(outcomeRaw)
			? outcomeRaw
			: "success";
		const notes = typeof data?.notes === "string" ? data.notes : null;
		this.sql`
			UPDATE task_assignments
			SET completed_at_ms = ${now}, outcome = ${outcome}
			WHERE task_id = ${task_id} AND member_id = ${member_id}
		`;
		await this.recordEvent({
			kind: "task_completed",
			member_id,
			payload: { task_id, outcome, notes },
			emitted_at_ms: now,
		});
		await this.fanOutSkillOutcome(member_id, task_id, outcome, notes);
	}

	private async handleRequestHelp(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : null;
		const reason = typeof data?.reason === "string" ? data.reason : "unspecified";
		await this.recordEvent({
			kind: "task_help_requested",
			member_id,
			payload: { task_id, reason },
			emitted_at_ms: now,
		});
		this.broadcastBrigade({
			kind: "lead_message",
			emitted_at_ms: now,
			cook_session_id: this.state.cook_session_id,
			data: {
				message: `${member_id} needs help${task_id ? ` on ${task_id}` : ""}: ${reason}`,
				kind: "help_request",
				from_member_id: member_id,
				task_id,
				reason,
			},
		}, [member_id]);
	}

	private async handleDeclineTask(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : "";
		if (!task_id) return;
		const reason = typeof data?.reason === "string" ? data.reason : "declined";
		this.sql`
			UPDATE task_assignments
			SET completed_at_ms = ${now}, outcome = 'reassigned'
			WHERE task_id = ${task_id} AND member_id = ${member_id} AND completed_at_ms IS NULL
		`;
		await this.recordEvent({
			kind: "task_unassigned",
			member_id,
			payload: { task_id, reason, declined: true },
			emitted_at_ms: now,
		});
	}

	private async handleIterationResponse(
		data: Record<string, unknown> | undefined,
		member_id: string,
		now: number,
	): Promise<void> {
		const task_id = typeof data?.task_id === "string" ? data.task_id : null;
		const accepted = data?.accepted === true;
		await this.recordEvent({
			kind: "recipe_iteration_suggested",
			member_id,
			payload: { task_id, accepted, response: true },
			emitted_at_ms: now,
		});
	}

	// ── Skill outcome fan-out ─────────────────────────────────────────
	//
	// When a member completes a task we POST to the MemberAgent's
	// `/skill-outcome` route. Best-effort — the brigade event log is
	// authoritative; the MemberAgent fan-out is a sidecar so the long-lived
	// member skill model can update its confidence.

	private async fanOutSkillOutcome(
		member_id: string,
		task_id: string,
		outcome: string,
		notes: string | null,
	): Promise<void> {
		await fanOutBrigadeSkillOutcome({
			env: this.env as { MEMBER_AGENT?: DurableObjectNamespace },
			household_id: this.state.household_id,
			member_id,
			task_id,
			outcome,
			meal_id: this.state.meal_id,
			notes,
		});
	}

	// ─── Phase 4 — Fiber recovery ────────────────────────────────────────

	/**
	 * If the worker died mid-tick, replay the side-effect step (idempotent
	 * via INSERT OR REPLACE on task_assignments). If the snapshot is stale
	 * (older than 2 ticks), drop it — the next live tick will produce a
	 * fresher decision.
	 */
	async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
		if (ctx.name === "scheduler_tick") {
			const snap = (ctx.snapshot ?? {}) as Partial<SchedulerTickFiberSnapshot>;
			if (snap.applied) return;
			const stale = Date.now() - (snap.now ?? ctx.createdAt) > SCHEDULER_TICK_MS * 2;
			try {
				if (snap.output && !stale && typeof snap.now === "number") {
					await this.applySchedulerOutput(snap.now, snap.output);
				}
				// Always re-arm the next tick so the cadence recovers.
				await this.schedule(
					new Date(Date.now() + SCHEDULER_TICK_MS),
					"onSchedulerTick",
					{},
				);
			} catch (err) {
				console.warn(`[cooking-lead-agent] onFiberRecovered(scheduler_tick) failed:`, err);
			}
			return;
		}
		await super.onFiberRecovered(ctx);
	}

	// ─── Test seam ────────────────────────────────────────────────────────
	//
	// Public read of the embedded event log. The bridge route /events covers
	// this for HTTP callers; this method is for in-process tests that hold
	// the DO stub directly. Returns parsed events.
	listEvents(limit = 100): BrigadeEvent[] {
		const rows = this.sql<{
			id: string; kind: string; member_id: string | null;
			payload_json: string; emitted_at_ms: number;
		}>`
			SELECT id, kind, member_id, payload_json, emitted_at_ms
			FROM lead_events
			ORDER BY emitted_at_ms ASC
			LIMIT ${limit}
		`;
		return rows.map(r => ({
			id: r.id,
			cook_session_id: this.state.cook_session_id,
			kind: r.kind as BrigadeEventKind,
			member_id: r.member_id,
			payload: safeParse(r.payload_json),
			emitted_at_ms: r.emitted_at_ms,
		}));
	}
}

function safeParse(s: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(s);
		return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
