# Phase 6 — MCP Server Portal setup

> Cloudflare's managed MCP front door. Replaces our admin-token + ad-hoc CF Access pattern with audit, prompt filtering, and per-tool rate limits.

This phase is **mostly dashboard configuration**, not code. The worker already exposes the MCP surface; we just put it behind the managed portal.

---

## What you get

- **Cloudflare Access** in front of every MCP request (already partially configured for spence-web)
- **Audit log** of every tool call with caller email + arguments
- **Prompt filtering** — block known prompt-injection patterns at the edge
- **Per-tool rate limits** — e.g. cap `plan_compose_meal` at 30/hour to prevent runaway agent loops
- **Discovery endpoint** — clients can list available tools without per-tool round-trips

---

## One-time dashboard setup

### 1. Create the MCP Server Portal

Cloudflare Dashboard → Zero Trust → Access → Applications → **Add application** →
**MCP Server Portal** (Open Beta tab; if you don't see it, request beta access via your account team).

- **Name**: `spence-mcp`
- **Upstream URL**: `https://mise-graph.<account>.workers.dev/mcp/plan-world`
- **Discovery endpoint**: enabled
- **Prompt logging**: opt-in, with PII redaction enabled

### 2. Cloudflare Access policy

Same form as for `spence-web`:
- Allow `me@coreydylan.net` (or `*@experialstudio.com`)
- Session duration: 24h
- Identity provider: One-time PIN or your existing IdP

### 3. Per-tool rate limits

Set conservative defaults. The portal exposes a simple per-tool config:

| Tool | Rate limit |
|---|---|
| `plan_compose_meal` | 30 / hour |
| `plan_replace_meal` | 30 / hour |
| `plan_create` | 10 / hour |
| `plan_finalize` | 10 / hour |
| `member_update_preferences` | 20 / hour |
| `household_set_pantry_bulk` | 60 / hour |
| All `inspire_read_*` | 1000 / hour |
| All others | 200 / hour |

These are starting points. The portal dashboard shows per-tool histograms; tune from real traffic.

### 4. Prompt filtering

Enable the default Cloudflare prompt-injection ruleset. It blocks:
- Common jailbreak patterns ("ignore previous instructions", "you are now DAN", etc.)
- Tool-name spoofing (`__tool_call__` etc.)
- Encoded-payload sneaks (base64 with shell-style commands)

Add a custom rule for our domain:
- **Block** any prompt containing `BRIDGE_SECRET`, `wrangler secret`, `process.env`, or other secret-extraction patterns

### 5. Switch the worker to require portal-issued credentials

The portal issues short-lived JWTs to authorized clients. The worker's MCP route should validate the JWT instead of the current admin-token check.

```typescript
// worker/src/mise-graph-worker.ts — replace the admin-token check on /mcp/*
async function authorizeMcp(req: Request, env: Env): Promise<{ ok: true; user: string } | { ok: false }> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return { ok: false };
  // Cloudflare validates the JWT signature in the portal layer; we just
  // extract the email claim for audit.
  const claims = decodeJwt(jwt);
  return { ok: true, user: claims.email };
}
```

(Cloudflare's portal does signature verification; we just trust the header presence + extract claims for audit.)

---

## How clients connect post-portal

### Web app

Already routes through `spence-web` (which is gated by CF Access). The chef agent on the worker calls MCP via in-process `callPlanWorldTool`, so it doesn't go through the portal. **The portal protects EXTERNAL MCP clients** — Cursor, Claude Desktop, third-party agents.

### Cursor / Claude Desktop / external agents

Configure their MCP client with:
```json
{
  "mcpServers": {
    "spence": {
      "url": "https://spence-mcp.<account>.workers.dev/mcp",
      "auth": { "type": "cloudflare_access" }
    }
  }
}
```

First request triggers CF Access auth flow → user logs in → portal issues JWT → tools available.

### Reeve / other Cloudflare-side agents

Use the portal's internal endpoint with service-account auth. Configured in Reeve's Field secrets.

---

## What this replaces

| Before | After |
|---|---|
| `X-Spence-Admin: dev` header on admin routes | CF Access JWT validation |
| No audit log of MCP tool calls | Portal logs every call with caller email |
| No rate limiting on tools | Per-tool limits configurable from dashboard |
| No prompt-injection filtering | Default ruleset + custom rules |
| Brittle `dev` token shared everywhere | Short-lived per-user tokens |

---

## When to do this

**Not blocking for solo use.** While you're the only user, the admin-token + CF Access on the spence-web domain is sufficient. The portal becomes important when:
1. You add other household members who'll authenticate as themselves
2. You connect external MCP clients (Cursor, Claude Desktop)
3. You publish to the wider Experial Studio team

For now, the worker still has the admin-token path; the portal can be layered on top without removing it.

---

## Verification checklist

After setup:
- [ ] Portal application created with correct upstream URL
- [ ] CF Access policy allows your email
- [ ] Discovery endpoint returns the tool catalog (curl with browser cookie or service-account token)
- [ ] Custom prompt-filter rule for `BRIDGE_SECRET` is active
- [ ] Per-tool rate limits saved
- [ ] Worker code updated to validate `Cf-Access-Jwt-Assertion` (defer until you actually want to enforce)

The portal is **passive observability** until you flip the worker to require its JWTs. You can run it in audit-only mode for a week before enforcing.
