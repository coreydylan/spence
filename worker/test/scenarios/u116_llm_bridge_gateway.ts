// U116 — Phase 5: AI Gateway shim for the mesh-claude bridge.
//
// Verifies the gateway-routing layer added to llm-bridge in Phase 5:
//
//   1. readGatewayConfig parses env vars correctly:
//      • disabled when account id or name is missing
//      • enabled when both are set
//      • cache TTL defaults to 60, parses int, falls back on bad input
//      • skip-cache marker defaults to "nonce" but is overridable
//
//   2. fetchUpstream takes the DIRECT path when gateway is unconfigured:
//      • calls env.MESH.fetch(url, init) — same as today
//      • does NOT touch global fetch
//
//   3. fetchUpstream takes the GATEWAY path when configured:
//      • posts to https://gateway.ai.cloudflare.com/v1/<acct>/<name>
//      • body is the universal-endpoint envelope
//        [{ provider: "compat", endpoint: <bridge_url>, headers, query, method }]
//      • sets cf-aig-cache-ttl header to the configured TTL
//      • sets cf-aig-metadata header with tenant+surface
//      • adds cf-aig-skip-cache when the skip marker is in the body
//      • does NOT skip cache when the marker is absent
//      • adds cf-aig-authorization Bearer header when AI_GATEWAY_TOKEN is set
//
//   4. callMeshClaude (the public bridge entry point) routes through
//      fetchUpstream — gateway env vars set means the global fetch is used,
//      not env.MESH. We stub global fetch and assert the request shape.
//
// All assertions are pure — no D1, no DOs, no wall-clock timers.

import type { Scenario } from "../lib/types";
import {
	readGatewayConfig,
	fetchUpstream,
} from "../../src/mise-graph/llm-bridge-gateway";
import { callMeshClaude, type MeshClaudeEnv } from "../../src/mise-graph/llm-bridge";

interface CapturedFetch {
	url: string;
	init: RequestInit;
}

/**
 * Run `fn` with global fetch stubbed. Returns the captured calls plus the
 * function's result. Always restores the original fetch.
 */
async function withFetchStub<T>(
	respFactory: () => Response,
	fn: () => Promise<T>,
): Promise<{ result: T; calls: CapturedFetch[] }> {
	const calls: CapturedFetch[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init: init ?? {} });
		return respFactory();
	}) as typeof globalThis.fetch;
	try {
		const result = await fn();
		return { result, calls };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

const u116: Scenario = {
	id: "u116",
	name: "Phase 5: AI Gateway shim wraps mesh-bridge fetches when configured",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. readGatewayConfig ──────────────────────────────────────────
		const cfgEmpty = readGatewayConfig({});
		ctx.assert.eq(cfgEmpty.enabled, false, "config disabled when no env vars");
		ctx.assert.eq(cfgEmpty.cacheTtlSeconds, 60, "default cache TTL is 60s");
		ctx.assert.eq(cfgEmpty.skipCacheMarker, "nonce", "default skip marker is 'nonce'");

		const cfgPartial = readGatewayConfig({ AI_GATEWAY_ACCOUNT_ID: "acct" });
		ctx.assert.eq(cfgPartial.enabled, false, "disabled when only account id is set");

		const cfgFull = readGatewayConfig({
			AI_GATEWAY_ACCOUNT_ID: "acct_xyz",
			AI_GATEWAY_NAME: "spence-mesh",
			AI_GATEWAY_CACHE_TTL: "120",
			AI_GATEWAY_SKIP_CACHE_MARKER: "fresh-please",
			AI_GATEWAY_TOKEN: "tok_abc",
		});
		ctx.assert.eq(cfgFull.enabled, true, "enabled when both account+name set");
		ctx.assert.eq(cfgFull.accountId, "acct_xyz", "accountId parsed");
		ctx.assert.eq(cfgFull.gatewayName, "spence-mesh", "gatewayName parsed");
		ctx.assert.eq(cfgFull.token, "tok_abc", "token parsed");
		ctx.assert.eq(cfgFull.cacheTtlSeconds, 120, "TTL parsed as int");
		ctx.assert.eq(cfgFull.skipCacheMarker, "fresh-please", "skip marker overridden");

		const cfgBadTtl = readGatewayConfig({
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_NAME: "g",
			AI_GATEWAY_CACHE_TTL: "not-a-number",
		});
		ctx.assert.eq(cfgBadTtl.cacheTtlSeconds, 60, "bad TTL falls back to 60");

		// Whitespace-only values count as unset.
		const cfgBlank = readGatewayConfig({
			AI_GATEWAY_ACCOUNT_ID: "   ",
			AI_GATEWAY_NAME: "g",
		});
		ctx.assert.eq(cfgBlank.enabled, false, "whitespace-only account id is treated as unset");

		// ── 2. fetchUpstream — direct MESH path when disabled ─────────────
		const meshCalls: CapturedFetch[] = [];
		const meshEnvDirect = {
			MESH: {
				fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = typeof input === "string" ? input : (input as URL).toString();
					meshCalls.push({ url, init: init ?? {} });
					return new Response(JSON.stringify({ ok: true, text: "from-mesh" }), { status: 200 });
				}) as typeof fetch,
			},
		} as Partial<MeshClaudeEnv>;

		// Stub global fetch so we can prove gateway path is NOT hit when disabled.
		const direct = await withFetchStub(
			() => new Response("should-not-be-called", { status: 500 }),
			async () => fetchUpstream(meshEnvDirect, "http://100.96.0.10:8484/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "hi" }),
			}),
		);
		ctx.assert.eq(direct.calls.length, 0, "direct path does NOT touch global fetch");
		ctx.assert.eq(meshCalls.length, 1, "direct path calls env.MESH.fetch exactly once");
		ctx.assert.eq(meshCalls[0].url, "http://100.96.0.10:8484/v1/messages", "direct path forwards bridge url unchanged");
		ctx.assert.eq(direct.result.status, 200, "direct path returns the bridge response");

		// ── 3. fetchUpstream — gateway path when configured ───────────────
		const gatewayEnv = {
			AI_GATEWAY_ACCOUNT_ID: "acct_xyz",
			AI_GATEWAY_NAME: "spence-mesh",
			AI_GATEWAY_CACHE_TTL: "60",
			MESH: {
				fetch: (async () => {
					throw new Error("MESH must NOT be called when gateway is configured");
				}) as typeof fetch,
			},
		} as Partial<MeshClaudeEnv>;

		const gw1 = await withFetchStub(
			() => new Response(JSON.stringify({ ok: true, text: "from-gateway" }), { status: 200 }),
			async () => fetchUpstream(gatewayEnv, "http://100.96.0.10:8484/v1/messages", {
				method: "POST",
				headers: { "X-Bridge-Signature": "sig123", "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "what's tonight" }),
			}),
		);

		ctx.assert.eq(gw1.calls.length, 1, "gateway path makes exactly one global fetch");
		ctx.assert.eq(
			gw1.calls[0].url,
			"https://gateway.ai.cloudflare.com/v1/acct_xyz/spence-mesh",
			"gateway URL is universal-endpoint shape",
		);
		const gwInit1 = gw1.calls[0].init;
		ctx.assert.eq(gwInit1.method, "POST", "gateway request is POST");
		const headers1 = gwInit1.headers as Record<string, string>;
		ctx.assert.eq(headers1["cf-aig-cache-ttl"], "60", "cf-aig-cache-ttl header set to configured TTL");
		ctx.assert.contains(headers1["cf-aig-metadata"] ?? "", "spence", "cf-aig-metadata names the tenant");
		ctx.assert.eq(headers1["cf-aig-skip-cache"], undefined, "skip-cache header NOT set when marker absent");
		ctx.assert.eq(headers1["cf-aig-authorization"], undefined, "no auth header when AI_GATEWAY_TOKEN unset");

		// Verify body is the universal-endpoint envelope.
		const envelope = JSON.parse(gwInit1.body as string) as Array<{
			provider: string;
			endpoint: string;
			method: string;
			headers: Record<string, string>;
			query: Record<string, unknown>;
		}>;
		ctx.assert.eq(envelope.length, 1, "envelope is a one-element array");
		ctx.assert.eq(envelope[0].provider, "compat", "envelope uses compat provider");
		ctx.assert.eq(envelope[0].endpoint, "http://100.96.0.10:8484/v1/messages", "envelope preserves bridge url");
		ctx.assert.eq(envelope[0].method, "POST", "envelope preserves method");
		ctx.assert.eq(envelope[0].headers["X-Bridge-Signature"], "sig123", "envelope preserves HMAC header");
		ctx.assert.eq(envelope[0].query.prompt, "what's tonight", "envelope preserves request body as query");
		ctx.assert.eq(gw1.result.status, 200, "gateway returns upstream status");

		// ── 3b. skip-cache marker triggers cf-aig-skip-cache ──────────────
		const gw2 = await withFetchStub(
			() => new Response(JSON.stringify({ ok: true }), { status: 200 }),
			async () => fetchUpstream(gatewayEnv, "http://100.96.0.10:8484/v1/messages", {
				method: "POST",
				headers: { "X-Bridge-Signature": "sigZ", "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "fresh", nonce: "abc123" }),
			}),
		);
		const headers2 = gw2.calls[0].init.headers as Record<string, string>;
		ctx.assert.eq(headers2["cf-aig-skip-cache"], "true", "skip-cache header set when nonce in body");

		// ── 3c. AI_GATEWAY_TOKEN sets cf-aig-authorization ────────────────
		const authEnv = {
			...gatewayEnv,
			AI_GATEWAY_TOKEN: "tok_secret_xyz",
		} as Partial<MeshClaudeEnv>;
		const gw3 = await withFetchStub(
			() => new Response(JSON.stringify({ ok: true }), { status: 200 }),
			async () => fetchUpstream(authEnv, "http://100.96.0.10:8484/v1/messages", {
				method: "POST",
				headers: { "X-Bridge-Signature": "sigA", "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "auth test" }),
			}),
		);
		const headers3 = gw3.calls[0].init.headers as Record<string, string>;
		ctx.assert.eq(
			headers3["cf-aig-authorization"],
			"Bearer tok_secret_xyz",
			"cf-aig-authorization Bearer header set when token configured",
		);

		// ── 4. callMeshClaude end-to-end with gateway enabled ─────────────
		const meshEnvWithGateway: MeshClaudeEnv = {
			MESH: {
				fetch: (async () => {
					throw new Error("MESH must NOT be called when gateway is configured");
				}) as typeof fetch,
			},
			BRIDGE_HOST: "100.96.0.10",
			BRIDGE_PORT: "8484",
			BRIDGE_SECRET: "test_secret_abc",
			AI_GATEWAY_ACCOUNT_ID: "acct_xyz",
			AI_GATEWAY_NAME: "spence-mesh",
			AI_GATEWAY_CACHE_TTL: "60",
		};

		const callResult = await withFetchStub(
			() => new Response(
				JSON.stringify({
					sessionId: "sess_gw_1",
					text: "Routed through the gateway.",
					elapsedMs: 42,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
					result: { usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.0001 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
			async () => callMeshClaude(meshEnvWithGateway, { prompt: "hello gateway" }),
		);

		ctx.assert.eq(callResult.calls.length, 1, "callMeshClaude routes one fetch through gateway");
		ctx.assert.contains(
			callResult.calls[0].url,
			"gateway.ai.cloudflare.com/v1/acct_xyz/spence-mesh",
			"callMeshClaude hits the gateway URL when env vars are set",
		);
		ctx.assert.eq(callResult.result.ok, true, "wrapped response parses ok");
		ctx.assert.eq(callResult.result.text, "Routed through the gateway.", "wrapped text round-trips");
		ctx.assert.eq(callResult.result.sessionId, "sess_gw_1", "wrapped sessionId round-trips");

		// ── 4b. callMeshClaude end-to-end without gateway → MESH path ────
		let meshHits = 0;
		const meshEnvNoGateway: MeshClaudeEnv = {
			MESH: {
				fetch: (async () => {
					meshHits++;
					return new Response(
						JSON.stringify({
							sessionId: "sess_mesh",
							text: "Direct mesh.",
							elapsedMs: 10,
							messageCount: 1,
							toolCalls: 0,
							yieldDetected: false,
						}),
						{ status: 200 },
					);
				}) as typeof fetch,
			},
			BRIDGE_HOST: "100.96.0.10",
			BRIDGE_PORT: "8484",
			BRIDGE_SECRET: "test_secret_abc",
		};

		const directResult = await withFetchStub(
			() => new Response("global-fetch-should-not-fire", { status: 500 }),
			async () => callMeshClaude(meshEnvNoGateway, { prompt: "direct" }),
		);
		ctx.assert.eq(directResult.calls.length, 0, "no global fetch when gateway env vars unset");
		ctx.assert.eq(meshHits, 1, "MESH.fetch called exactly once on direct path");
		ctx.assert.eq(directResult.result.text, "Direct mesh.", "direct path text passes through unchanged");

		ctx.notes.push("u116: gateway shim wires correctly + direct path unchanged");
	},
};

export default u116;
