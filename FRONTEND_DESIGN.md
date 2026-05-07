# Spence Frontend — End-to-End Design

> A chef-of-staff lives on your phone. It onboarded you the first night you met. Now it texts you a morning plan, walks you through tonight's cook, and quietly learns what you actually like.

---

## Core principles

1. **Conversational entry point, ambient surfaces.** Chat with Spence is the front door. Every "screen" is an artifact of a conversation — today's plan, a recipe card, a shopping list. You can navigate to them directly, but they're never the goal; the conversation is.
2. **Mobile-first, PWA-native.** Installs to home screen. Looks and feels like a real app. Fits in your hand at the stove.
3. **Progressive onboarding feels like meeting a chef, not filling out a form.** Three questions on day 1. Three more in week 1. Spence learns by watching, not by interrogating.
4. **Identity-led visual language.** Typography-first. Big quiet numbers. Earthy palette. Photographs of food, not stock illustrations. No dashboards-of-dashboards.
5. **The agent talks back in components, not just text.** When Spence proposes a meal, the agent's reply IS the recipe card. When it asks a question, the reply IS the answer chips. UI is generated, not rendered as static markup.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router) | Server Components + Server Actions + streaming |
| Language | TypeScript strict | Same DNA as the worker |
| Styling | Tailwind v4 + custom design tokens | Fast iteration, kitchen-readable |
| Components | shadcn/ui as base, custom primitives on top | Owned source, no vendor lock |
| Deploy | **Cloudflare Pages** + edge runtime | Same edge as `mise-graph` worker, low latency |
| Auth | Magic-link via Resend, cookie session | No passwords, phone-friendly |
| LLM | Claude via Anthropic SDK | Streaming, tool use, MCP-compatible |
| State | Server-first (RSC) + small client islands | No global store; URL is the state |
| WS | Native browser WebSocket for brigade | Already wired to CookingLeadAgent |
| PWA | next-pwa + custom install prompt | Home-screen install on iOS/Android |
| Analytics | Cloudflare Analytics + custom event log to D1 | No third-party tracking |
| Vision capture | Browser camera + R2 upload via existing brigade route | Already shipped on the worker |

Repository layout:

```
spence/
├── worker/             ← (existing) Cloudflare Worker, MCP backend
├── web/                ← (new) Next.js 15 app, Cloudflare Pages
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (chat)/
│   │   ├── (today)/
│   │   ├── (plan)/
│   │   ├── (recipe)/[meal_id]/
│   │   ├── (shop)/
│   │   ├── (pantry)/
│   │   ├── (members)/
│   │   ├── (cook)/[cook_session_id]/
│   │   ├── (settings)/
│   │   └── api/
│   │       ├── chef/route.ts          ← LLM agent loop endpoint
│   │       ├── mcp-proxy/route.ts     ← thin proxy to worker MCP
│   │       └── auth/...
│   ├── components/
│   │   ├── primitives/                ← Button, Card, Input, etc.
│   │   ├── chef/                      ← chat bubble, tool-call card, etc.
│   │   ├── meal/                      ← MealCard, RecipeStepList, etc.
│   │   └── onboarding/
│   ├── lib/
│   │   ├── mcp.ts                     ← MCP client wrapper
│   │   ├── chef-agent.ts              ← LLM agent loop (server-side)
│   │   ├── auth.ts                    ← cookie session helpers
│   │   └── design-tokens.ts
│   └── styles/
└── ios/                ← (existing) reference app, future native wrapper
```

---

## Auth model (MVP)

- **Phase 1**: magic-link email. User enters email → Resend sends a token URL → click → cookie set with `{user_id, household_id}` (24h refresh).
- **Phase 2**: Apple/Google sign-in for iOS native wrap.
- Each user belongs to one `household_id`. Multi-household / household-switching is Phase 3.
- All API routes check session cookie, attach `household_id` to MCP calls automatically.
- `household_id` is the only identity Spence cares about for tool calls.

---

## The screens

### P0 — Day-1 essentials (build first)

#### `/` — Landing & auth
Single hero: "**Hi. I'm Spence — your chef-of-staff. Tell me your email and I'll get to know you.**" Email input, magic-link sent. After click-through, drops user into `/onboarding` if tier 0 incomplete, else `/today`.

#### `/onboarding`
Full-screen guided flow. ONE question per page. Big typography, big buttons.

- Page 1: household name (or auto-suggest)
- Page 2: who else lives here (chip add)
- Page 3: dietary / avoidances (chip select + free-text)
- Page 4: **the dinner ritual question** (4 cards: table / TV / desk / varies)
- Page 5: cook frequency (3 cards: most / sometimes / rarely)
- Page 6: pantry intake (3 cards: bulk paste / take a photo / build over time)
- Page 7 (conditional): pantry paste textarea OR camera roll picker
- Page 8: equipment quick-tap grid (16 common slugs as toggle chips)
- Page 9: traditions (Friday pizza? Sunday roast? optional, can skip)
- Final: "**Got it. Want me to draft a week of dinners?**" → chat

Each page hits `household_onboarding_answer` or the bulk tools. State machine driven by `chef_status_check` after each step.

Visual treatment: animated transitions between cards, ratio of about 1:2 (image/illustration : input). Soft warmth, not clinical.

#### `/chat` (and `/`)
The chef-of-staff conversational interface. Streaming responses. Tool calls render as cards inline.

- User says: "plan me dinners for the next 4 days"
- Agent streams: "Got it — 4 dinners, vegetarian, no pasta..."
- Tool call: `inspire_read_weather` → renders as small weather chip
- Tool call: `inspire_read_seasonality` → renders as "spring produce" card
- Tool call: `plan_create` → renders as week scaffold
- Tool calls: `plan_compose_meal` × 4 → render as meal cards as they appear
- Tool call: `plan_audit` → renders any preference grievances as soft warnings
- Final: "Here's the week. Tap any meal to see the recipe."

The chat input is voice-capable on mobile (browser SpeechRecognition).

#### `/today`
The morning brief, made beautiful.

```
┌─────────────────────────────────────────────────┐
│  Thursday                                       │
│  May 7                                          │
│                                                 │
│  ☁  74°F  /  55°F                                │
│  Mild and dry. Good day for grill or oven.      │
│                                                 │
│  ──────────────────────────────────             │
│                                                 │
│  TONIGHT'S DINNER                               │
│  ╭───────────────────────────────────────╮      │
│  │  General Tso tofu                     │      │
│  │  with broccoli over jasmine rice      │      │
│  │                                       │      │
│  │  donburi · korean · serves 2          │      │
│  │  start cooking at 17:55               │      │
│  │  35 min active                        │      │
│  │                          [open recipe]│      │
│  ╰───────────────────────────────────────╯      │
│                                                 │
│  COMING UP                                      │
│  ┌─────────────────────────────────────┐        │
│  │ Fri 5/8 — asparagus mezze     5pm   │        │
│  │ ⚠  conflicts with calendar at 5:30   │        │
│  └─────────────────────────────────────┘        │
│  ┌─────────────────────────────────────┐        │
│  │ Sat 5/9 — black bean tacos    6pm   │        │
│  └─────────────────────────────────────┘        │
│                                                 │
│  ─────                                          │
│                                                 │
│  ▷ Question for you:                            │
│    "Tofu's shown up 4 times in 2 weeks —        │
│     constant or phase?"                         │
│    [it's a constant]  [phase]  [skip]           │
│                                                 │
└─────────────────────────────────────────────────┘
```

Pulls from: `inspire_read_weather`, `plan_read_meal` for today, MealAgent state for next-3-days, `chef_status_check` for the day's question.

#### `/plan`
Week view. 7 days, 4 slots each (breakfast / lunch / snack / dinner). Long-press a meal to swap, drag to reschedule. Quick "+ add meal" inline.

Renders the same data as `plan_read_map` but visual.

#### `/recipe/[meal_id]`
Full recipe view. Components, ingredients, cook timeline (the per-format estimated steps), equipment, photo (if user has cooked it before), notes. "Start cooking" CTA at bottom triggers brigade hand-off.

### P1 — Week-1 fillers

#### `/shop`
Shopping list. Auto-generated from `plan_read_shop_runs` + `plan_read_shopping_list`. Group by category, check off items. Persists check state to D1 (new schema OR just localStorage for MVP).

#### `/pantry`
Inventory view. List items by category, expiration tier (Tier 1/2/3 from earlier work), quick-add via chip. "Did you finish X?" prompts on items at expiration.

#### `/members`
Roster. Each member has: name, age group, dietary, skill confidence per skill kind, presence state (in_kitchen_idle / busy / stepped_away). Tap a member to see their per-member trait deltas.

#### `/inbox`
History of daily briefs + notifications. Each is a card; tap to expand. Timeline of what Spence has been thinking.

### P2 — Brigade & deep config

#### `/cook/[cook_session_id]`
Kitchen mode. Big text, dark mode, screen-on-while-active. Connected to CookingLeadAgent via WebSocket. Shows:
- Current task assignment for THIS member
- Other members' current tasks (small cards)
- "Mark done" / "Need help" / "Decline" buttons
- Photo upload button (camera intent)
- Vision feedback inline ("the sear looks too pale — give it 2 more min")
- Recipe steps as a vertical timeline with active-step highlight

#### `/settings`
Profile, traditions, equipment list (full editor), calendar integration, push notification toggle, debug (trait values, engagement signal, recent observations).

#### Voice mode
Tap-and-hold mic button on chat = streaming voice input → transcribe → Claude → speech response (browser SpeechSynthesis). Works while cooking with messy hands.

---

## The LLM agent loop (server-side)

Lives in `/api/chef/route.ts`. Streams Server-Sent Events (SSE) to the client.

```typescript
async function chefAgent(userMessage: string, householdId: string) {
  // 1. Status check FIRST every turn
  const status = await mcp("chef_status_check", { household_id });

  // 2. If onboarding blocks, return the next question as a UI component
  if (status.recommendation.primary_action === "answer_onboarding_question"
      && status.onboarding.blocked_actions.length > 0) {
    return { kind: "onboarding_question", question: status.recommendation.next_question };
  }

  // 3. Otherwise, run the agent loop with Claude
  const tools = filterToolsByOnboardingState(ALL_TOOLS, status);
  const systemPrompt = buildSystemPrompt(status.signals, status.recommendation);

  const stream = await anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools,
    max_tokens: 4096,
  });

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      yield { kind: "tool_call_start", tool_name: event.content_block.name };
    }
    if (event.type === "content_block_stop" && event.content_block.type === "tool_use") {
      const result = await mcp(event.content_block.name, event.content_block.input);
      yield { kind: "tool_call_result", tool_name: event.content_block.name, result };
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { kind: "text", delta: event.delta.text };
    }
  }
}
```

The system prompt absorbs `signals.personality.summary` so Claude inherits the household's voice automatically. Tool use is automatic — when Claude calls `plan_compose_meal`, the server proxies to the worker MCP, returns the result, and Claude continues.

The client renders each event:
- `text` → typed-out text in the chat bubble
- `tool_call_start` → small "looking up weather..." chip with spinner
- `tool_call_result` → renders as a UI component if known kind (meal card, recipe card, brief card), else as a collapsed JSON block

---

## Component design system

### Tokens
- **Colors**: warm earth palette. Primary `#E07856` (terracotta), surface `#F8F3EC` (cream), ink `#2A1E15`, accent `#3F6E4A` (sage).
- **Type**: Inter for UI, "Source Serif 4" for recipe titles + headings, monospace only for technical detail (trait values, IDs).
- **Spacing**: 4px base, 8/12/16/24/32/48 scale.
- **Radius**: 12px default, 24px for big cards, full-circle for avatars.
- **Shadow**: very soft, single layer, 12px blur 4% black.

### Primitives (shadcn-rooted)
`Button`, `Card`, `Input`, `Chip`, `Badge`, `Sheet`, `Dialog`, `Select`, `Tabs`. All built on Radix.

### App-specific
- `ChefBubble` — the chat bubble. Spence's bubble has a small terracotta dot avatar; user's is right-aligned plain.
- `MealCard` — meal title, format, cuisine, cook duration, suggested-start-time. Tap to open recipe.
- `RecipeStepRow` — timeline-style with timestamp + step text + small icon.
- `OnboardingQuestionCard` — full-bleed question + answer chips.
- `BriefCard` — daily brief in card form (the today screen renders one).
- `IngredientChip` — name + qty, tap to remove or sub.
- `EquipmentChip` — slug + status (idle / claimed / unavailable).
- `WeatherStrip` — compact 1-line weather summary.
- `PreferenceWarning` — soft amber inline warning for preference grievances ("this conflicts with Friday pizza night").

---

## Routing & navigation

Bottom tab bar on mobile (5 tabs):
- Today (home)
- Plan
- Chat
- Shop
- More (members / pantry / settings)

Cook mode (`/cook/[id]`) is full-screen, hides the tab bar. The "Start cooking" CTA from a recipe page navigates here.

Onboarding (`/onboarding`) also full-screen, gated by `chef_status_check`. Once tier 0 done, user can exit but the agent will keep nudging tier 1 questions during chats.

---

## Build phases

### Phase 1 — Foundation (next session)
- Scaffold Next.js + Cloudflare Pages config + Tailwind + design tokens
- MCP client wrapper (typed against the worker's tool schemas)
- Auth stub (cookie + household_id, magic-link UI but no email send yet)
- Layout shell with bottom tab bar
- One end-to-end vertical: chat with `/api/chef` → streams text + a single tool call → renders MealCard

### Phase 2 — Onboarding flow + Today
- Full onboarding wizard
- `/today` screen with morning brief render
- Hooks into `chef_status_check` for question surface

### Phase 3 — Plan + Recipe + Shop
- Week view
- Recipe detail
- Shopping list
- Swap/cancel meal interactions

### Phase 4 — Members + Pantry + Inbox
- Roster
- Inventory
- Notifications timeline

### Phase 5 — Cook mode (brigade)
- WS client to CookingLeadAgent
- Big-text kitchen UI
- Photo capture + upload
- Vision feedback inline

### Phase 6 — Polish
- Real magic-link auth
- Push notifications
- Calendar integration
- iOS native wrapper (Capacitor or pure Swift consuming same API)

---

## Open design questions

1. **Auth provider**: Resend for magic-link, or just use Cloudflare Access for MVP?
2. **Voice mode**: ship in Phase 1 or defer?
3. **Web Push** for daily briefs — phase 6 or earlier?
4. **Storybook** for the component library — yes/no?
5. **Color palette**: is the warm terracotta+sage right, or do you have something specific in mind?
6. **Recipe imagery**: photographs from the canonical_recipes_v2 corpus, or commission illustrations?

---

## Recommendation for next move

Build **Phase 1** start to finish: scaffold + auth shell + chat with one streaming tool call. That's the proof the architecture works end-to-end and gives you a clickable thing within an hour. Then iterate by phase.
