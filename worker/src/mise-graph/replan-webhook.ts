// HTTP entrypoint for the real-time replan webhook.
//
// Wave 5F's integrator wires this into mise-graph-worker.ts at
// `POST /mise-graph/replan` (and a sibling `GET /mise-graph/replan/log`).
// Until it lands the route, this module is consumable directly via tests
// and via callers that own their own router.

import type { MiseGraphEnv } from "./types";
import {
	applyReplanEvent,
	type ReplanEvent,
	type ReplanResult,
} from "./replan-events";
import {
	recordReplanEvent,
	listReplanEvents,
	type ReplanEventRow,
} from "./replan-audit-log";

interface ReplanRequestBody {
	plan_id?: unknown;
	event?: unknown;
	dry_run?: unknown;
}

/**
 * Handle a `POST /mise-graph/replan` request.
 *
 * Body shape:
 *   { plan_id: string; event: ReplanEvent; dry_run?: boolean }
 *
 * Response: ReplanResult as JSON, or { error: string } on validation failure.
 */
export async function handleReplanRequest(request: Request, env: MiseGraphEnv): Promise<Response> {
	if (request.method === "GET") {
		return json({
			service: "spence-replan-webhook",
			methods: ["POST"],
			body_shape: { plan_id: "string", event: "ReplanEvent", dry_run: "boolean (optional)" },
		});
	}
	if (request.method !== "POST") {
		return json({ error: "Method not allowed" }, 405);
	}
	let body: ReplanRequestBody | null;
	try {
		body = await request.json() as ReplanRequestBody;
	} catch {
		return json({ error: "invalid JSON body" }, 400);
	}
	if (!body || typeof body !== "object") {
		return json({ error: "expected an object body" }, 400);
	}
	const planId = typeof body.plan_id === "string" ? body.plan_id : "";
	if (!planId) return json({ error: "plan_id is required" }, 400);
	const event = validateEvent(body.event);
	if (!event.ok) return json({ error: event.message }, 400);
	const dry_run = body.dry_run === true;

	let result: ReplanResult;
	try {
		result = await applyReplanEvent(env, planId, event.event, { dry_run });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}

	// Best-effort audit logging — never blocks the response on a logging error.
	try {
		await recordReplanEvent(env, result);
	} catch {
		// swallow — audit logging is non-essential for the user's response
	}
	return json(result);
}

/**
 * Handle a `GET /mise-graph/replan/log?plan_id=...` request — returns recent
 * audit-log entries for a plan.
 */
export async function handleReplanLogRequest(request: Request, env: MiseGraphEnv): Promise<Response> {
	if (request.method !== "GET") {
		return json({ error: "Method not allowed" }, 405);
	}
	const url = new URL(request.url);
	const planId = url.searchParams.get("plan_id");
	if (!planId) return json({ error: "plan_id query param is required" }, 400);
	const limitRaw = url.searchParams.get("limit");
	const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 500) : 50;
	let entries: ReplanEventRow[];
	try {
		entries = await listReplanEvents(env, planId, limit);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
	return json({ plan_id: planId, count: entries.length, entries });
}

// ---------------------------------------------------------------------------
// Minimal runtime validation for ReplanEvent
// ---------------------------------------------------------------------------

type ValidationOk = { ok: true; event: ReplanEvent };
type ValidationFail = { ok: false; message: string };
type ValidationResult = ValidationOk | ValidationFail;

function validateEvent(value: unknown): ValidationResult {
	if (!value || typeof value !== "object") {
		return { ok: false, message: "event must be an object" };
	}
	const obj = value as Record<string, unknown>;
	const kind = obj.kind;
	if (typeof kind !== "string") {
		return { ok: false, message: "event.kind is required and must be a string" };
	}
	switch (kind) {
		case "skip_meal":
		case "lock_slot":
		case "mark_cooked":
		case "add_meal": {
			const slot = validateSlot(obj.slot);
			if (!slot) return { ok: false, message: `event.slot is required for ${kind}` };
			if (kind === "lock_slot" && typeof obj.reason !== "string") {
				return { ok: false, message: "lock_slot requires a string reason" };
			}
			return { ok: true, event: value as ReplanEvent };
		}
		case "move_meal": {
			const from = validateSlot(obj.from);
			const to = validateSlot(obj.to);
			if (!from || !to) return { ok: false, message: "move_meal requires from and to slots" };
			return { ok: true, event: value as ReplanEvent };
		}
		case "cancel_cook":
		case "move_cook": {
			if (typeof obj.cook_id !== "string") return { ok: false, message: `${kind} requires cook_id` };
			if (kind === "move_cook" && typeof obj.new_date !== "string") {
				return { ok: false, message: "move_cook requires new_date" };
			}
			return { ok: true, event: value as ReplanEvent };
		}
		case "skip_shop":
		case "move_shop": {
			if (typeof obj.run_id !== "string") return { ok: false, message: `${kind} requires run_id` };
			if (kind === "move_shop" && typeof obj.new_date !== "string") {
				return { ok: false, message: "move_shop requires new_date" };
			}
			return { ok: true, event: value as ReplanEvent };
		}
		case "change_anchors":
			return { ok: true, event: value as ReplanEvent };
		case "change_people":
			if (typeof obj.new_count !== "number" || !Number.isFinite(obj.new_count) || obj.new_count <= 0) {
				return { ok: false, message: "change_people requires positive new_count" };
			}
			return { ok: true, event: value as ReplanEvent };
		case "report_inventory":
			if (!Array.isArray(obj.items)) return { ok: false, message: "report_inventory requires items array" };
			return { ok: true, event: value as ReplanEvent };
		default:
			return { ok: false, message: `unknown event kind: ${kind}` };
	}
}

function validateSlot(value: unknown): { date: string; slot: string } | null {
	if (!value || typeof value !== "object") return null;
	const o = value as Record<string, unknown>;
	if (typeof o.date !== "string" || typeof o.slot !== "string") return null;
	return { date: o.date, slot: o.slot };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}
