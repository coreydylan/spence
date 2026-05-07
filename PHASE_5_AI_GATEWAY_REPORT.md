# Phase 5 — AI Gateway in front of the mesh-claude bridge

## What shipped

A **transparent, opt-in shim** in front of `callMeshClaude` that routes bridge
requests through Cloudflare AI Gateway when env vars are set, and falls through
to the direct MESH path when they're not.

- `worker/src/mise-graph/llm-bridge-gateway.ts` — `readGatewayConfig()` + `fetchUpstream()`
- `worker/src/mise-graph/llm-bridge.ts` — `MeshClaudeEnv` extended; `env.MESH.fetch` swapped for `fetchUpstream(env, url, init)`
- `worker/wrangler.mise.toml` — `AI_GATEWAY_*` vars stubbed (commented)
- `worker/test/scenarios/u116_llm_bridge_gateway.ts` — 40 assertions

## API

```ts
fetchUpstream(env, url, init)
// disabled: env.MESH.fetch(url, init)             // unchanged
// enabled : POST https://gateway.ai.cloudflare.com/v1/<acct>/<name>
//           body = [{ provider: "compat", endpoint: url, method, headers, query: <body> }]
//           cf-aig-cache-ttl: 60
//           cf-aig-metadata: {tenant:"spence",surface:"mesh-bridge"}
//           cf-aig-skip-cache: true   (when body contains "nonce")
//           cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>  (if set)
```

## Defaults

- Cache TTL: **60s** (`AI_GATEWAY_CACHE_TTL`)
- Skip-cache marker: **`nonce`** (`AI_GATEWAY_SKIP_CACHE_MARKER`) — any request body containing this substring bypasses cache
- Rate limit: **60 req / 5 min per IP** (set on the dashboard, not in code)

## Dashboard setup (one-time)

1. Cloudflare Dashboard → AI → AI Gateway → Create gateway → name `spence-mesh`
2. Settings → cache TTL 60s, rate limit 60/5min, logging off (privacy)
3. Uncomment in `wrangler.mise.toml`:
   ```toml
   AI_GATEWAY_ACCOUNT_ID = "8276973f31803dc6a1597c1396d64c4c"
   AI_GATEWAY_NAME = "spence-mesh"
   ```
4. (auth gateway only) `wrangler secret put AI_GATEWAY_TOKEN --config wrangler.mise.toml`
5. `npx wrangler deploy --config wrangler.mise.toml`

## Operational caveat

The bridge daemon currently runs on Tailscale (`100.96.0.10:8484`) and is **not
publicly reachable**. The gateway can't proxy to it until a Cloudflare Tunnel
fronts the daemon. The shim is in place; flip the vars when the tunnel lands.

## Tests

- `u116_llm_bridge_gateway.ts` — 40 assertions, all pass
- Full suite: **132 pass, 0 fail** (was 131; +1 new scenario)
- `npx tsc --noEmit`: clean for Phase-5 files (pre-existing fiber errors in `meal-agent.ts` / `cooking-lead-agent.ts` are out of scope)
- `wrangler --dry-run`: clean
