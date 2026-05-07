# Spence — Web

Next.js 15 (App Router) frontend for Spence, the chef-of-staff. Deploys to
Cloudflare Pages via `@opennextjs/cloudflare`. Talks to the existing
`mise-graph` Cloudflare Worker over MCP/JSON-RPC.

## Run locally

```bash
cd web
cp .env.example .env.local       # then fill in DEV_USER_EMAIL + ANTHROPIC_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

- The landing page lives at `/`.
- Chat lives at `/chat` — type "what should I cook tonight?" and watch the
  agent loop call `chef_status_check` against the deployed worker.
- Tab bar links: Today / Plan / Chat / Shop / More — non-chat routes show
  "Coming in Phase X" placeholders for now.

### Auth

In production, Cloudflare Access fronts the Pages domain and injects the
`Cf-Access-Authenticated-User-Email` header on every request. `lib/auth.ts`
reads that header and derives `household_id` deterministically.

For local dev there's no CF Access; set `DEV_USER_EMAIL=…` in `.env.local`
and that string is treated as the canonical identity.

### Anthropic API key

The chef agent loop is server-side and uses the Anthropic SDK. Without
`ANTHROPIC_API_KEY` the loop still runs the status-check round-trip and
returns a canned reply explaining the key is missing — useful for verifying
the wiring without burning credits.

## Tests

```bash
npm run test
```

There's one smoke test (`__tests__/agent-loop-smoke.test.ts`) that exercises
the agent loop with fake MCP + fake Anthropic streams. Three assertions:

1. `chef_status_check` always fires first.
2. Onboarding-blocked households short-circuit with a `ui_component` event.
3. Tool-use → tool-result round trips correctly.

## Storybook

```bash
npm run storybook
```

Stories live in `stories/`. Phase 1 covers `ChefBubble` and `MealCard`; the
parallel screen agents add stories for their components as they go.

## Deploy to Cloudflare Pages

One-time setup:

```bash
# 1. Create the Pages project (uses `wrangler pages project create`).
wrangler pages project create spence-web

# 2. Set up Cloudflare Access on the Pages domain.
#    Dashboard → Zero Trust → Access → Applications → Add an application.
#    Point at the *.pages.dev domain (or a custom domain). Allow your team
#    email or a specific email list.

# 3. Add the Anthropic API key as a Pages secret.
wrangler pages secret put ANTHROPIC_API_KEY --project-name spence-web
```

Deploy:

```bash
npm run pages:build      # @opennextjs/cloudflare adapter, outputs to .open-next/dist
npm run pages:deploy     # wrangler pages deploy under the hood
```

`wrangler.web.toml` lists the project name and `NEXT_PUBLIC_WORKER_URL`. If
you stand up a separate worker environment, override `NEXT_PUBLIC_WORKER_URL`
on the Pages project.

## Repository layout

```
web/
├── app/                          ← Next.js app router
│   ├── layout.tsx                ← root layout, fonts, theme
│   ├── globals.css               ← Tailwind + @theme tokens
│   ├── page.tsx                  ← landing
│   ├── chat/page.tsx             ← chat surface (streaming)
│   └── api/
│       ├── chef/route.ts         ← agent loop, streams SSE
│       └── mcp-proxy/route.ts    ← thin proxy to worker MCP
├── components/
│   ├── primitives/               ← Button, Card, Input, Chip, Badge, Sheet
│   ├── chef/                     ← chat bubbles, tool-call chip, input
│   ├── meal/                     ← MealCard
│   └── layout/                   ← Shell, TabBar, ComingSoon
├── lib/
│   ├── mcp.ts                    ← typed MCP client
│   ├── chef-agent.ts             ← agent loop (server-side)
│   ├── auth.ts                   ← CF Access reader
│   ├── tool-renderers.ts         ← tool-name → React component map
│   ├── design-tokens.ts          ← TS mirror of CSS tokens
│   └── cn.ts                     ← clsx + tailwind-merge helper
├── stories/                      ← Storybook
└── __tests__/                    ← vitest smoke tests
```

## Hand-off notes for parallel agents

- Read `COMPONENT_LIBRARY.md` for the primitive + chef/meal component reference.
- Read `../FRONTEND_PHASE_1_REPORT.md` for what landed in Phase 1 and what's
  expected next.
- The MCP client (`lib/mcp.ts`) only types ~7 tools by name. Add new entries
  to `ToolMap` as you wire screens; for one-off calls use `mcp_call_any`.
- The `tool-renderers.ts` registry is how new tool results bind to UI
  components. Add an entry there + a component in `components/<area>/` and
  the chat surface picks it up automatically.
- `app/today`, `app/plan`, `app/shop`, `app/more` are placeholders. Replace
  the body of `page.tsx` in each with your screen.
- Don't touch `worker/` from this side — that's the backend.
