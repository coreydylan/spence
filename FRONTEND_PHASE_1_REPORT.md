# Spence Frontend — Phase 1 Report

> Foundation for the Spence web app. Next.js 15 (App Router) + Tailwind v4 +
> Anthropic SDK. Talks to the existing `mise-graph` Cloudflare Worker over
> JSON-RPC/MCP. Deploys to Cloudflare Pages via `@opennextjs/cloudflare`.

---

## What landed

A **clickable end-to-end vertical** runs against the deployed worker:

1. `npm run dev` → Next.js dev server on `localhost:3000`.
2. Auto-auth via `DEV_USER_EMAIL` (no CF Access locally).
3. `/chat` → user types → `/api/chef` POST → agent loop fires
   `chef_status_check` against the real worker → streams Server-Sent Events
   back → chat surface renders text + tool-call chips + (when applicable) a
   `MealCard` or `OnboardingQuestionCard` from the tool result.
4. `wrangler.web.toml` + README cover the one-time CF setup for Pages
   deployment (project create + Access policy + secret + `npm run pages:deploy`).

**Verified live**: with the DEV_USER_EMAIL set, posting to `/api/chef` with
`{message: "what should I cook tonight?"}` returns a real
`chef_status_check` payload from the worker (the household is fresh, so
tier 0 is incomplete and the agent emits an `onboarding_question` UI event
before returning `done`). End-to-end wiring proven.

**Tests**: 3/3 passing in `__tests__/agent-loop-smoke.test.ts`. Covers
status-check-first, blocked-on-onboarding short-circuit, and tool-use →
tool-result round trip. `tsc --noEmit` clean.

---

## Files created

| Path | Lines | Role |
|---|---:|---|
| `web/package.json` | 42 | deps (next 15, react 19, anthropic SDK, tailwind v4, @opennextjs/cloudflare, vitest, storybook) |
| `web/tsconfig.json` | 23 | strict TS, `@/*` path alias |
| `web/next.config.ts` | 12 | minimal Next config |
| `web/tailwind.config.ts` | 18 | content globs (Tailwind v4 reads tokens from `@theme`) |
| `web/postcss.config.mjs` | 8 | `@tailwindcss/postcss` |
| `web/wrangler.web.toml` | 24 | Cloudflare Pages config |
| `web/vitest.config.ts` | 14 | vitest with `@/*` alias |
| `web/.env.example` | 13 | dev fallback envs |
| `web/.gitignore` | 11 | standard |
| `web/next-env.d.ts` | 5 | Next ambient types |
| `web/README.md` | 130 | run/deploy/agent-handoff |
| `web/COMPONENT_LIBRARY.md` | 200+ | primitive + chat component reference |
| `web/app/globals.css` | 77 | Tailwind v4 + `@theme` tokens + animations |
| `web/app/layout.tsx` | 40 | root layout, fonts, Shell |
| `web/app/page.tsx` | 61 | landing |
| `web/app/chat/page.tsx` | 253 | streaming chat surface |
| `web/app/api/chef/route.ts` | 87 | SSE agent endpoint |
| `web/app/api/mcp-proxy/route.ts` | 63 | thin worker MCP proxy |
| `web/app/today/page.tsx` | 5 | placeholder |
| `web/app/plan/page.tsx` | 5 | placeholder |
| `web/app/shop/page.tsx` | 5 | placeholder |
| `web/app/more/page.tsx` | 5 | placeholder |
| `web/lib/auth.ts` | 68 | CF Access reader + DEV_USER_EMAIL fallback |
| `web/lib/mcp.ts` | 290 | typed MCP client (~7 tools + escape hatch) |
| `web/lib/chef-agent.ts` | 458 | agent loop with Anthropic streaming + tool execution |
| `web/lib/tool-renderers.ts` | 40 | tool-name → React component registry |
| `web/lib/design-tokens.ts` | 45 | TS mirror of CSS tokens |
| `web/lib/cn.ts` | 7 | `clsx` + `tailwind-merge` helper |
| `web/components/primitives/button.tsx` | 63 | Button (4 variants × 3 sizes) |
| `web/components/primitives/card.tsx` | 95 | Card + Header/Title/Subtitle/Content/Footer |
| `web/components/primitives/input.tsx` | 41 | Input + Textarea |
| `web/components/primitives/chip.tsx` | 49 | Chip (5 variants) |
| `web/components/primitives/badge.tsx` | 33 | Badge (5 tones) |
| `web/components/primitives/sheet.tsx` | 61 | Sheet (bottom/right drawer) |
| `web/components/chef/chef-bubble.tsx` | 56 | Spence's chat bubble + typing indicator |
| `web/components/chef/user-bubble.tsx` | 21 | user's right-aligned bubble |
| `web/components/chef/tool-call-chip.tsx` | 74 | running/done/error tool pill |
| `web/components/chef/chef-input.tsx` | 78 | auto-growing chat composer |
| `web/components/chef/onboarding-question-card.tsx` | 122 | inline onboarding question |
| `web/components/meal/meal-card.tsx` | 117 | MealCard (compact + hero) |
| `web/components/layout/shell.tsx` | 35 | top bar + main + tab bar |
| `web/components/layout/tab-bar.tsx` | 99 | mobile bottom 5-tab nav |
| `web/components/layout/coming-soon.tsx` | 31 | placeholder for unbuilt routes |
| `web/stories/ChefBubble.stories.tsx` | 59 | 4 stories (typing, text, tool calls, with MealCard) |
| `web/stories/MealCard.stories.tsx` | 73 | 5 stories (compact, hero, conflict, no-meta, pasta) |
| `web/__tests__/agent-loop-smoke.test.ts` | 259 | 3 vitest assertions |

**Total**: 47 source files, ~3.2k LOC.

---

## How to run locally

```bash
cd /Users/coreydylan/Developer/spence/web
cp .env.example .env.local
# edit .env.local — set DEV_USER_EMAIL (any email works locally)
# optional: set ANTHROPIC_API_KEY (without it the agent emits a canned reply)
npm install
npm run dev
```

Open http://localhost:3000.

- `/` — landing.
- `/chat` — chat. Type "what should I cook tonight?" — the agent fires
  `chef_status_check` against the deployed worker and streams the result.
- `/today`, `/plan`, `/shop`, `/more` — "Coming in Phase X" placeholders.

---

## How to deploy

One-time CF Pages setup (the user runs these manually):

```bash
# 1. Create the Pages project
wrangler pages project create spence-web

# 2. Set up Cloudflare Access on the Pages domain
#    Dashboard → Zero Trust → Access → Applications → Add an application.
#    Point at the Pages domain. Allow your team email or a specific list.

# 3. Add the Anthropic API key as a Pages secret
wrangler pages secret put ANTHROPIC_API_KEY --project-name spence-web
```

Deploy (after that):

```bash
cd web
npm run pages:build      # @opennextjs/cloudflare → .open-next/dist
npm run pages:deploy
```

**Why CF Access not magic-link**: the user locked it in. CF Access fronts
the Pages domain, injects `Cf-Access-Authenticated-User-Email`, and Spence
trusts that header end-to-end. No password infra to run.

---

## Screen catalog for Phase 2+ agents

| Route | Phase | Notes for the agent picking it up |
|---|---|---|
| `/onboarding` (new) | 2 | Full-screen wizard. Use `<OnboardingQuestionCard>` per page; drive state via `chef_status_check` between pages. Spec is in `ONBOARDING_DESIGN.md`. |
| `/today` | 2 | Morning brief. Hit `household_read_brief({household_id, date})` (already in worker). Render: weather strip, tonight's MealCard (hero), "coming up" cards, the day's onboarding question. |
| `/plan` | 3 | Week view. 7 days × 4 slots (breakfast/lunch/snack/dinner). Source data from `plan_read_map`. Long-press to swap, drag to reschedule. |
| `/recipe/[meal_id]` (new) | 3 | Full recipe. `plan_read_meal` for the meal, `plan_read_dependency_edges` for the cook timeline, `<MealCard variant="hero">` at the top. "Start cooking" CTA → `/cook/[id]` (Phase 5). |
| `/shop` | 3 | Shopping list from `plan_read_shopping_list` + `plan_read_shop_runs`. Group by category, check items off (localStorage for MVP, D1 schema later). |
| `/pantry` (new) | 4 | `inspire_read_household_signals` for top items + a richer pantry tool TBD. Tier 1/2/3 expiration grouping. |
| `/members` (new) | 4 | Roster. Per-member dietary/skills/presence. New worker tool may be needed. |
| `/inbox` (new) | 4 | History of daily briefs. Each brief from `household_read_brief({date})`. |
| `/cook/[cook_session_id]` (new) | 5 | Brigade WebSocket UI. Big text, dark mode, screen-on-while-active. Hit `brigade_grant_token` → ws_url with token. |
| `/settings` (new) | 6 | Profile, traditions, equipment editor, debug surface. |

Routes already stubbed (`today`, `plan`, `shop`, `more`) just render
`<ComingSoon>`. Replace `app/<route>/page.tsx` with the real screen when
your agent ships.

---

## Component reference (for parallel agents)

See `web/COMPONENT_LIBRARY.md` for the full reference. Quick index:

**Primitives** (`components/primitives/`):

- `<Button variant size loading>` — `primary | secondary | ghost | outline` × `sm | md | lg`
- `<Card variant>` + `CardHeader` / `CardTitle` / `CardSubtitle` / `CardContent` / `CardFooter`
- `<Input>` / `<Textarea>`
- `<Chip variant onClick>` — `default | selected | muted | warning | active`
- `<Badge tone>` — non-interactive label, 5 tones
- `<Sheet open onClose side>` — bottom/right drawer

**Chef surface** (`components/chef/`):

- `<ChefBubble typing>` — Spence's bubble (terracotta `S` avatar)
- `<UserBubble>` — right-aligned plain
- `<ToolCallChip toolName status>` — running/done/error pill
- `<ChefInput onSubmit disabled>` — auto-growing composer
- `<OnboardingQuestionCard question onAnswer>` — inline onboarding card

**Meal** (`components/meal/`):

- `<MealCard meal variant onOpen>` — `compact | hero`

**Layout** (`components/layout/`):

- `<Shell>` — already mounted at root layout
- `<TabBar>` — already mounted in Shell
- `<ComingSoon screen phase>` — placeholder

---

## MCP client API surface

Imported as: `import { mcp, mcp_call_any, listTools } from "@/lib/mcp"`.

Typed tools (in `ToolMap`):

- `chef_status_check` → `ChefStatus`
- `chef_dispatch` → `{ status, turn_plan }`
- `plan_create` → `{ plan: { id, … } }`
- `plan_read_meal` → `{ meal }`
- `plan_compose_meal` → `{ meal, plan_id }`
- `inspire_read_household_signals` → `HouseholdSignals`
- `household_onboarding_start` → `{ state, next_question, tier_progress }`
- `household_onboarding_answer` → `{ next_question, tier_advanced }`

For any tool not in `ToolMap`, use `mcp_call_any(name, args, ctx)`.

The client auto-injects `household_id` into `args` when the tool expects it,
so callers passing `{}` for tools that take only `household_id` work
correctly. Trace headers (`x-spence-trace-caller-kind`, `-id`, `-parent`)
are sent on every call.

`listTools(ctx)` returns the worker's full schema list — useful for an
agent that wants to drive a dynamic tool catalog.

---

## Open issues / known stubs

1. **`<Sheet>` is minimal.** No portal, no focus trap, no scroll-lock. Phase
   2/3 agents touching modal-heavy flows (cook mode, deep config) should
   swap in Radix Dialog or react-aria's Modal.
2. **Tool catalog is hand-rolled.** `lib/chef-agent.ts` `PHASE_1_TOOLS` is
   a curated subset of ~7 tools. Phase 2+ agents should add entries as new
   screens demand them — or, better, have the agent fetch via `listTools()`
   on cold start and cache.
3. **Anthropic model is `claude-sonnet-4-5`.** Switch to `claude-sonnet-4-7`
   when it's GA (or stick with sonnet for cost). The current model string is
   pinned in `chef-agent.ts` `DEFAULT_MODEL`.
4. **Tailwind v4 is in beta.** The `@tailwindcss/postcss@4.0.0-beta.8` package
   pin is intentional. When v4 GAs, drop `-beta.N`.
5. **No Suspense / streaming RSC** in the chat page. The chat surface is a
   single client component because the SSE consumer needs `useState`. That's
   fine for Phase 1; if Phase 3 adds a "history" tab fetched at request
   time, it should be its own RSC.
6. **Voice mode** is a TODO comment in `chef-input.tsx`. Phase 6.
7. **Web Push** for daily briefs — Phase 6.
8. **No magic-link auth.** Locked decision: CF Access only. If CF Access
   doesn't ship for some reason, `lib/auth.ts` is the only file to touch.
9. **`chef-agent.ts` history threading is text-only.** When the user message
   includes UI components (e.g. answering an onboarding question via tap),
   the assistant turn that follows needs to thread the answer through
   `household_onboarding_answer` — Phase 2's `/onboarding` will own that.
10. **No persistent conversation history.** Each `/api/chef` call has the
    full history sent from the client; nothing is saved. Phase 2's chat
    page should persist messages in `mise_conversation_threads` (worker
    schema already exists) so a refresh doesn't lose the conversation.

---

## Hand-off checklist for the next agent

- Read `web/COMPONENT_LIBRARY.md`.
- Run `cd web && npm install && npm run dev` and click around to verify the
  baseline works on your machine.
- Pick a screen from the catalog above. Replace
  `app/<route>/page.tsx` with your implementation.
- For new tool result UIs: add component under `components/<area>/`,
  register in `lib/tool-renderers.ts`, extend `UiComponent` union in
  `lib/chef-agent.ts`, add a Storybook story.
- For new MCP tools you need typed: add an entry to `ToolMap` in
  `lib/mcp.ts`. For one-off calls, use `mcp_call_any`.
- Don't touch `worker/` (the backend) and don't break `lib/auth.ts`'s CF
  Access contract.
