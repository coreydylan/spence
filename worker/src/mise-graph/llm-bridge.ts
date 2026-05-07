// Mesh-Claude bridge client.
//
// Routes Worker prompts to the claude-bridge daemon running on officemac
// (Tailscale 100.96.0.10:8484). The daemon proxies through Corey's
// Claude Code subscription via @anthropic-ai/claude-agent-sdk, so this
// path is free of API spend. Same pattern Reeve uses.
//
// Wiring:
//   - vpc_networks binding `MESH` (cf1:network, remote)
//   - vars BRIDGE_HOST="100.96.0.10", BRIDGE_PORT="8484"
//   - secret BRIDGE_SECRET (HMAC key, field id f1c21b51-…)
//
// Daemon contract (POST /v1/messages, body HMAC-signed in X-Bridge-Signature):
//   { prompt, system?, model?, allowedTools?, cwd? }
//   → { sessionId, elapsedMs, text, result, messageCount, toolCalls, yieldDetected, reason? }

export interface MeshClaudeEnv {
	MESH: { fetch: typeof fetch };
	BRIDGE_HOST: string;
	BRIDGE_PORT: string;
	BRIDGE_SECRET: string;
}

export interface MeshClaudeRequest {
	prompt: string;
	system?: string;
	model?: string;
	allowedTools?: string[];
	cwd?: string;
}

export interface MeshClaudeResponse {
	ok: boolean;
	sessionId: string | null;
	text: string | null;
	elapsedMs: number;
	messageCount: number;
	toolCalls: number;
	yieldDetected: boolean;
	reason?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	cost_usd?: number;
	error?: string;
	raw?: unknown;
}

export async function callMeshClaude(env: MeshClaudeEnv, request: MeshClaudeRequest): Promise<MeshClaudeResponse> {
	if (!env.MESH || typeof env.MESH.fetch !== "function") {
		return errorResponse("MESH binding missing — add vpc_networks binding to wrangler config.");
	}
	if (!env.BRIDGE_HOST || !env.BRIDGE_PORT) {
		return errorResponse("BRIDGE_HOST / BRIDGE_PORT not set in vars.");
	}
	if (!env.BRIDGE_SECRET) {
		return errorResponse("BRIDGE_SECRET not set — wrangler secret put BRIDGE_SECRET.");
	}
	if (!request.prompt || typeof request.prompt !== "string") {
		return errorResponse("prompt (string) required.");
	}

	const body = JSON.stringify({
		prompt: request.prompt,
		...(request.system ? { system: request.system } : {}),
		...(request.model ? { model: request.model } : {}),
		...(request.allowedTools ? { allowedTools: request.allowedTools } : {}),
		...(request.cwd ? { cwd: request.cwd } : {}),
	});

	const sig = await hmacHex(env.BRIDGE_SECRET, body);
	const url = `http://${env.BRIDGE_HOST}:${env.BRIDGE_PORT}/v1/messages`;
	const startedAt = Date.now();

	// Retry once on transient "Network connection lost" — long composer calls
	// (~3 min) sometimes drop the keep-alive while the daemon is still working.
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
			// Only retry on connection-loss-ish errors; not on bad URL etc.
			if (!/connection lost|reset|timeout|aborted/i.test(msg)) break;
			// Brief wait before retry — let any bridge-side state settle.
			await new Promise(r => setTimeout(r, 1500));
		}
	}
	if (!resp) {
		return errorResponse(`mesh fetch failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
	}

	const text = await resp.text();
	if (!resp.ok) {
		return errorResponse(`bridge ${resp.status}: ${text.slice(0, 400)}`, resp.status);
	}

	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return errorResponse(`bridge returned non-JSON: ${text.slice(0, 200)}`);
	}

	const result = (json.result || {}) as Record<string, unknown>;
	const usage = (result.usage || {}) as Record<string, number>;

	// Daemon now keeps the socket alive with heartbeats and ALWAYS returns 200,
	// so SDK-level errors surface as `error` in the body, not via HTTP status.
	// Surface that error string so the planner doesn't silently fall back to
	// deterministic without a clear reason.
	const bodyError = typeof json.error === "string" ? json.error : undefined;

	return {
		ok: typeof json.text === "string" && json.text.length > 0,
		sessionId: typeof json.sessionId === "string" ? json.sessionId : null,
		text: typeof json.text === "string" ? json.text : null,
		elapsedMs: Number(json.elapsedMs ?? Date.now() - startedAt),
		messageCount: Number(json.messageCount || 0),
		toolCalls: Number(json.toolCalls || 0),
		yieldDetected: Boolean(json.yieldDetected),
		reason: typeof json.reason === "string" ? json.reason : undefined,
		error: bodyError,
		usage: {
			input_tokens: usage.input_tokens,
			output_tokens: usage.output_tokens,
			cache_read_input_tokens: usage.cache_read_input_tokens,
			cache_creation_input_tokens: usage.cache_creation_input_tokens,
		},
		cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
	};
}

/**
 * Convenience wrapper for prompts that expect a JSON object back. Wraps the
 * model with a strict-JSON system prompt and parses the first {...} block.
 * Falls back gracefully when parsing fails.
 */
export async function callMeshClaudeJSON<T = unknown>(
	env: MeshClaudeEnv,
	request: MeshClaudeRequest,
): Promise<{ ok: boolean; data: T | null; raw: MeshClaudeResponse }> {
	const systemPrefix = "You are a deterministic JSON generator. Reply with ONE valid JSON object and nothing else — no markdown fences, no commentary, no preamble. Make every field machine-parseable.";
	const merged: MeshClaudeRequest = {
		...request,
		system: request.system ? `${systemPrefix}\n\n${request.system}` : systemPrefix,
	};
	const raw = await callMeshClaude(env, merged);
	if (!raw.ok || !raw.text) return { ok: false, data: null, raw };
	const parsed = extractJsonObject<T>(raw.text);
	return { ok: parsed !== null, data: parsed, raw };
}

function extractJsonObject<T>(text: string): T | null {
	const stripped = stripMarkdownFences(text.trim());
	const candidate = stripped.startsWith("{") ? stripped : sliceFirstJsonBlock(stripped);
	if (!candidate) return null;
	try {
		return JSON.parse(candidate) as T;
	} catch {
		// Try the raw stripped text in case the slicer was too eager.
		try {
			return JSON.parse(stripped) as T;
		} catch {
			// Best-effort: the stream may have been truncated mid-emit.
			// Try to repair by closing open brackets/braces and trimming the
			// last incomplete value. This recovers most of the meals when
			// the bridge connection drops late in the stream.
			const repaired = repairTruncatedJson(stripped);
			if (repaired) {
				try {
					return JSON.parse(repaired) as T;
				} catch {
					return null;
				}
			}
			return null;
		}
	}
}

function repairTruncatedJson(text: string): string | null {
	if (!text.startsWith("{")) return null;
	// Walk the string tracking strings/escapes, brace+bracket depth.
	const stack: string[] = [];
	let inString = false;
	let escape = false;
	let lastSafeIndex = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escape) { escape = false; continue; }
		if (inString) {
			if (ch === "\\") { escape = true; continue; }
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") stack.pop();
		else if (ch === "," && stack.length > 0 && (stack[stack.length - 1] === "}" || stack[stack.length - 1] === "]")) {
			lastSafeIndex = i;
		}
	}
	if (stack.length === 0) return null; // wasn't actually truncated
	// Cut at the last safe comma boundary inside an object/array,
	// then close all remaining open scopes.
	let truncated = text;
	if (lastSafeIndex > 0) truncated = text.slice(0, lastSafeIndex);
	// If we cut inside an open string, abort.
	if (inString && lastSafeIndex < 0) return null;
	const closing = [...stack].reverse().join("");
	return truncated + closing;
}

function stripMarkdownFences(text: string): string {
	if (!text) return text;
	// Common pattern: ```json\n{...}\n``` or ```\n{...}\n```
	const fenceMatch = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
	if (fenceMatch) return fenceMatch[1].trim();
	// Loose: text contains a closing fence somewhere — take whatever's between.
	const looseMatch = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
	if (looseMatch) return looseMatch[1].trim();
	// Truncated output: leading ```json with no closing fence (model ran out of
	// tokens). Strip just the opening fence so the truncated-JSON repair can
	// recover the partial object.
	const leadingFence = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*)$/);
	if (leadingFence) return leadingFence[1].trim();
	return text;
}

function sliceFirstJsonBlock(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\" && inString) { escape = true; continue; }
		if (ch === "\"") { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
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

function errorResponse(message: string, status?: number): MeshClaudeResponse {
	return {
		ok: false,
		sessionId: null,
		text: null,
		elapsedMs: 0,
		messageCount: 0,
		toolCalls: 0,
		yieldDetected: false,
		error: status ? `[${status}] ${message}` : message,
	};
}
