// Wave 8B Track B — vision call wrapper.
//
// The text bridge in `llm-bridge.ts` is a chat-only client (POST /v1/messages,
// returns {text, ...}). The vision pipeline needs to send image bytes alongside
// a prompt and parse a structured analysis envelope back. We POST to a sibling
// endpoint on the same daemon: `/v1/vision`. Same HMAC signing, same MESH
// binding — the bridge daemon is responsible for routing image_b64 + prompt to
// a vision-capable model and returning the JSON envelope below.
//
// Bridge contract (POST /v1/vision):
//   request body  = {kind: "vision", model?, image_b64, image_mime, prompt}
//   response body = {ok, analysis: VisionAnalysis, raw_response?, cost_usd?, error?}
//
// All failures are returned as `{ok: false, ...}` — never thrown. The DO
// upload-photo flow is best-effort: if vision is unavailable, the photo still
// lands in R2 and we surface a `vision_pending=true` row that ops can re-run
// later. NOT a critical-path dependency.

import type { MeshClaudeEnv } from "./llm-bridge";

/**
 * Same env shape as MeshClaudeEnv but every binding is optional. The
 * CookingLeadAgent sees `this.env.MESH` as `MESH?: { fetch }` (optional)
 * because it derives from MiseGraphEnv. This loose alias lets us accept
 * that without a cast at every call site, and we still validate the
 * presence of each piece at runtime in `callBridgeVision`.
 */
export type VisionBridgeEnv = Partial<MeshClaudeEnv>;

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Action recommendation from the vision model. The DO uses the action kind
 * to decide what to do with the assignment row:
 *
 *   wait            → no change, just inform the cook to keep going
 *   add_ingredient  → write iteration_note to the assignment, broadcast
 *                     a `recipe_iteration_suggested` event
 *   adjust_temp     → same — note + broadcast
 *   stop_now        → broadcast iteration; DO does NOT touch task state
 *                     (the cook decides whether to mark complete)
 *   redo            → mark the task as un-completed (drop completed_at_ms)
 *                     and broadcast iteration so the cook restarts
 */
export type VisionIterationAction =
	| "wait"
	| "add_ingredient"
	| "adjust_temp"
	| "stop_now"
	| "redo";

export interface VisionIterationSuggestion {
	action: VisionIterationAction;
	detail: string;
	ingredient_to_add?: { name: string; qty: number; unit: string };
	temp_adjust_pct?: number;
	additional_min?: number;
}

export interface VisionAnalysis {
	on_track: boolean;
	confidence: number;          // 0..1
	observed: string;            // free-text observation
	concerns: string[];
	iteration_suggestion?: VisionIterationSuggestion;
}

export interface VisionResult {
	ok: boolean;
	analysis: VisionAnalysis;
	raw_response?: string;
	cost_usd?: number;
	elapsed_ms?: number;
	error?: string;
}

export interface VisionRequest {
	image_bytes: ArrayBuffer | Uint8Array;
	image_mime: string;          // "image/jpeg" | "image/png" | "image/webp"
	prompt: string;
	model?: string;
}

const DEFAULT_VISION_MODEL = "claude-3-7-sonnet-20250219";

const FALLBACK_ANALYSIS: VisionAnalysis = {
	on_track: true,
	confidence: 0,
	observed: "(no analysis available — vision bridge unavailable)",
	concerns: [],
};

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Send an image + per-task prompt to the vision bridge. PURE-ish — the only
 * external side-effect is the MESH fetch. Returns a VisionResult; never throws.
 *
 * Caller is the CookingLeadAgent's photo-upload flow. The DO awaits the result
 * inline (a few seconds is acceptable for the MVP), then writes the structured
 * analysis to embedded SQLite + emits the `vision_response_received` event.
 */
export async function callBridgeVision(
	env: VisionBridgeEnv,
	request: VisionRequest,
): Promise<VisionResult> {
	if (!env.MESH || typeof env.MESH.fetch !== "function") {
		return errResult("MESH binding missing — cannot reach vision bridge.");
	}
	if (!env.BRIDGE_HOST || !env.BRIDGE_PORT) {
		return errResult("BRIDGE_HOST / BRIDGE_PORT not set in vars.");
	}
	if (!env.BRIDGE_SECRET) {
		return errResult("BRIDGE_SECRET not set — wrangler secret put BRIDGE_SECRET.");
	}
	if (!request.prompt || typeof request.prompt !== "string") {
		return errResult("vision: prompt (string) required.");
	}
	if (!request.image_bytes) {
		return errResult("vision: image_bytes required.");
	}

	const startedAt = Date.now();
	const image_b64 = bytesToBase64(request.image_bytes);
	const body = JSON.stringify({
		kind: "vision",
		model: request.model || DEFAULT_VISION_MODEL,
		image_b64,
		image_mime: request.image_mime || "image/jpeg",
		prompt: request.prompt,
	});

	const sig = await hmacHex(env.BRIDGE_SECRET, body);
	const url = `http://${env.BRIDGE_HOST}:${env.BRIDGE_PORT}/v1/vision`;

	let resp: Response | null = null;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			resp = await env.MESH.fetch(url, {
				method: "POST",
				headers: {
					"X-Bridge-Signature": sig,
					"Content-Type": "application/json",
				},
				body,
			});
			break;
		} catch (error) {
			lastErr = error;
			const msg = error instanceof Error ? error.message : String(error);
			if (!/connection lost|reset|timeout|aborted/i.test(msg)) break;
			await new Promise(r => setTimeout(r, 750));
		}
	}

	if (!resp) {
		return errResult(`vision mesh fetch failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
	}

	const text = await resp.text();
	if (!resp.ok) {
		return errResult(`bridge ${resp.status}: ${text.slice(0, 400)}`);
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return errResult(`vision bridge returned non-JSON: ${text.slice(0, 200)}`);
	}

	const elapsed_ms = Date.now() - startedAt;
	const bridgeError = typeof json.error === "string" ? json.error : undefined;

	if (bridgeError) {
		return {
			ok: false,
			analysis: FALLBACK_ANALYSIS,
			error: bridgeError,
			elapsed_ms,
			raw_response: typeof json.raw_response === "string" ? json.raw_response : undefined,
		};
	}

	const analysis = normalizeAnalysis(json.analysis);
	if (!analysis) {
		return {
			ok: false,
			analysis: FALLBACK_ANALYSIS,
			error: "vision response missing valid `analysis` envelope",
			elapsed_ms,
			raw_response: typeof json.raw_response === "string" ? json.raw_response : undefined,
		};
	}

	return {
		ok: true,
		analysis,
		raw_response: typeof json.raw_response === "string" ? json.raw_response : undefined,
		cost_usd: typeof json.cost_usd === "number" ? json.cost_usd : undefined,
		elapsed_ms,
	};
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function errResult(message: string): VisionResult {
	return {
		ok: false,
		analysis: FALLBACK_ANALYSIS,
		error: message,
	};
}

/**
 * Defensive parse of the analysis envelope. Bridges can drift — we accept
 * partial shapes and fill in defaults rather than reject the whole response.
 * Returns null only when the envelope is missing entirely.
 */
export function normalizeAnalysis(raw: unknown): VisionAnalysis | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	const on_track = typeof r.on_track === "boolean" ? r.on_track : true;
	const confidenceRaw = typeof r.confidence === "number" ? r.confidence : 0;
	const confidence = Math.max(0, Math.min(1, confidenceRaw));
	const observed = typeof r.observed === "string" ? r.observed : "";
	const concerns: string[] = Array.isArray(r.concerns)
		? r.concerns.filter((c): c is string => typeof c === "string")
		: [];

	let iteration_suggestion: VisionIterationSuggestion | undefined;
	if (r.iteration_suggestion && typeof r.iteration_suggestion === "object") {
		const sug = r.iteration_suggestion as Record<string, unknown>;
		const action = normalizeAction(sug.action);
		if (action) {
			const detail = typeof sug.detail === "string" ? sug.detail : "";
			iteration_suggestion = { action, detail };
			if (sug.ingredient_to_add && typeof sug.ingredient_to_add === "object") {
				const ing = sug.ingredient_to_add as Record<string, unknown>;
				if (
					typeof ing.name === "string" &&
					typeof ing.qty === "number" &&
					typeof ing.unit === "string"
				) {
					iteration_suggestion.ingredient_to_add = {
						name: ing.name, qty: ing.qty, unit: ing.unit,
					};
				}
			}
			if (typeof sug.temp_adjust_pct === "number") {
				iteration_suggestion.temp_adjust_pct = sug.temp_adjust_pct;
			}
			if (typeof sug.additional_min === "number") {
				iteration_suggestion.additional_min = sug.additional_min;
			}
		}
	}

	return {
		on_track,
		confidence,
		observed,
		concerns,
		...(iteration_suggestion ? { iteration_suggestion } : {}),
	};
}

function normalizeAction(raw: unknown): VisionIterationAction | null {
	if (typeof raw !== "string") return null;
	const candidates: VisionIterationAction[] = [
		"wait", "add_ingredient", "adjust_temp", "stop_now", "redo",
	];
	return (candidates as string[]).includes(raw) ? raw as VisionIterationAction : null;
}

/**
 * Convert raw image bytes to base64. Workerd and modern Node both expose
 * `btoa` on globalThis. We build the binary string in chunks so large
 * images don't blow the call stack.
 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < u8.length; i += CHUNK) {
		const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length));
		binary += String.fromCharCode.apply(null, Array.from(slice));
	}
	const g = globalThis as { btoa?: (s: string) => string };
	if (typeof g.btoa === "function") {
		return g.btoa(binary);
	}
	// Last-resort fallback for environments without btoa (e.g. very old
	// Node). Use an inline base64 encoder to avoid depending on Buffer.
	return manualBase64(u8);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function manualBase64(u8: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < u8.length; i += 3) {
		const a = u8[i], b = u8[i + 1], c = u8[i + 2];
		out += B64_ALPHABET[a >> 2];
		out += B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
		out += B64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
		out += B64_ALPHABET[c & 0x3f];
	}
	if (i < u8.length) {
		const a = u8[i];
		const b = i + 1 < u8.length ? u8[i + 1] : 0;
		out += B64_ALPHABET[a >> 2];
		out += B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
		if (i + 1 < u8.length) {
			out += B64_ALPHABET[(b & 0x0f) << 2];
			out += "=";
		} else {
			out += "==";
		}
	}
	return out;
}

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return Array.from(new Uint8Array(sig))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}
