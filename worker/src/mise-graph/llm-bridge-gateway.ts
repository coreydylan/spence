// Phase 5 — Cloudflare AI Gateway shim for the mesh-claude bridge.
//
// Purpose
// -------
// Wraps the direct `env.MESH.fetch(url, init)` call in `callMeshClaude` so that
// when AI Gateway env vars are configured, the request is routed through
// Cloudflare AI Gateway's universal endpoint for:
//
//   • Caching (identical prompts → cached response, configurable TTL)
//   • Rate limiting (set on the gateway dashboard, not in code)
//   • Cost dashboard (token + dollar tracking per provider/model)
//   • Prompt logging (privacy-controlled, opt-in per gateway)
//
// When the gateway env vars are NOT set, the call falls through to the direct
// MESH path unchanged. This keeps the shim opt-in and zero-risk for the
// default deployment.
//
// Universal endpoint contract
// ---------------------------
// POST https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_name>
// Body: [{ provider, endpoint, headers, query }]
//
// Our bridge daemon is a custom HTTP service, not a supported provider — but
// AI Gateway's "compat" provider acts as a generic OpenAI/Anthropic-shape
// passthrough. The universal endpoint also accepts standard cf-aig-* control
// headers (cf-aig-cache-ttl, cf-aig-skip-cache, cf-aig-cache-key) which we
// pass along to control caching policy from the worker side.
//
// Operational caveat
// ------------------
// The bridge daemon currently runs on Tailscale (100.96.0.10:8484) and is
// NOT reachable from Cloudflare's public gateway infrastructure. To actually
// route through the gateway end-to-end, the daemon needs a Cloudflare Tunnel
// in front of it. Until that lands, leave AI_GATEWAY_ACCOUNT_ID unset — the
// shim will keep using the direct MESH path. The shim is in place so the
// switch flips with one wrangler vars edit when the tunnel is ready.
//
// See PHASE_5_AI_GATEWAY_REPORT.md for dashboard setup steps.

import type { MeshClaudeEnv } from "./llm-bridge";

export interface GatewayConfig {
	enabled: boolean;
	accountId?: string;
	gatewayName?: string;
	token?: string;
	cacheTtlSeconds: number;
	skipCacheMarker: string;
}

export function readGatewayConfig(env: Partial<MeshClaudeEnv>): GatewayConfig {
	const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim() || undefined;
	const gatewayName = env.AI_GATEWAY_NAME?.trim() || undefined;
	const token = env.AI_GATEWAY_TOKEN?.trim() || undefined;
	const ttlRaw = env.AI_GATEWAY_CACHE_TTL?.trim();
	const ttl = ttlRaw && /^\d+$/.test(ttlRaw) ? parseInt(ttlRaw, 10) : 60;
	const marker = env.AI_GATEWAY_SKIP_CACHE_MARKER?.trim() || "nonce";
	return {
		enabled: Boolean(accountId && gatewayName),
		accountId,
		gatewayName,
		token,
		cacheTtlSeconds: ttl,
		skipCacheMarker: marker,
	};
}

/**
 * Route a single bridge request. Returns the bridge's Response.
 *
 * Behavior:
 *   • If gateway is configured (account id + name set), wraps the request
 *     through https://gateway.ai.cloudflare.com/v1/<acct>/<name>/.
 *   • Otherwise, calls env.MESH.fetch(url, init) directly (unchanged path).
 *
 * Cache policy:
 *   • Default cache TTL = AI_GATEWAY_CACHE_TTL seconds (default 60).
 *   • If the request body contains the skip-cache marker (default "nonce"),
 *     emits cf-aig-skip-cache: true so dev/replay traffic bypasses the cache.
 *
 * Note: the function is intentionally untyped at the env level (accepts any
 * env shape with the optional gateway fields) so the agent-chef route's
 * Partial<MeshClaudeEnv> compiles without casts.
 */
export async function fetchUpstream(
	env: Partial<MeshClaudeEnv>,
	url: string,
	init: RequestInit & { body: string; headers: Record<string, string>; method: string },
): Promise<Response> {
	const cfg = readGatewayConfig(env);

	if (!cfg.enabled) {
		// Direct MESH path — exactly as before.
		const mesh = env.MESH;
		if (!mesh || typeof mesh.fetch !== "function") {
			throw new Error("MESH binding missing — cannot reach bridge");
		}
		return mesh.fetch(url, init);
	}

	// Gateway path. Wrap the bridge request through the universal endpoint.
	// The "compat" provider tells AI Gateway to treat our daemon as a generic
	// passthrough rather than a known provider with a fixed schema.
	const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayName}`;
	const skipCache = cfg.skipCacheMarker.length > 0 && init.body.includes(cfg.skipCacheMarker);

	const cfHeaders: Record<string, string> = {
		"content-type": "application/json",
		"cf-aig-cache-ttl": String(cfg.cacheTtlSeconds),
		"cf-aig-metadata": JSON.stringify({ tenant: "spence", surface: "mesh-bridge" }),
	};
	if (skipCache) cfHeaders["cf-aig-skip-cache"] = "true";
	if (cfg.token) cfHeaders["cf-aig-authorization"] = `Bearer ${cfg.token}`;

	// Universal-endpoint payload: an array with one upstream descriptor.
	// We forward the bridge URL as `endpoint` and the original body as `query`,
	// preserving the X-Bridge-Signature header so HMAC verification still works
	// at the daemon side.
	const upstreamBody = JSON.parse(init.body);
	const payload = [{
		provider: "compat",
		endpoint: url,
		method: init.method,
		headers: init.headers,
		query: upstreamBody,
	}];

	// IMPORTANT: gateway calls go out over normal fetch (public internet),
	// not env.MESH. The gateway then proxies to the upstream. For this to
	// actually work end-to-end, the bridge daemon must be exposed via a
	// Cloudflare Tunnel — see operational caveat at top of file.
	return fetch(gatewayUrl, {
		method: "POST",
		headers: cfHeaders,
		body: JSON.stringify(payload),
	});
}
